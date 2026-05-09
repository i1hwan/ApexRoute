/**
 * Structured Logger — Pino-based logger for OmniRoute
 *
 * Usage:
 *   import { logger } from "@/shared/utils/logger";
 *   const log = logger.child({ module: "proxy" });
 *   log.info({ model: "gpt-4o" }, "Request received");
 *   log.error({ err }, "Connection failed");
 *
 * In development, output is pretty-printed via pino-pretty.
 * In production, output is structured JSON for log aggregation.
 *
 * When APP_LOG_TO_FILE is enabled (default: true), logs are also written
 * as JSON lines to the file specified by APP_LOG_FILE_PATH.
 *
 * Resilience guarantees (PR #29):
 *   - Before the pino transport worker is spawned, the log destination is
 *     write-probed (`verifyLogDirWritable`). On any failure (EROFS,
 *     EACCES, ENOENT, ENOSPC, TARGET_IS_DIR, ...) we fall back to a sync
 *     stdout-only logger built eagerly at module init.
 *   - If the transport worker dies later at runtime ("the worker has
 *     exited"), the surrounding Proxy catches it on the first throwing
 *     log call, swaps a module-scoped flag, and routes ALL subsequent
 *     log calls (root + every existing child) to the eager fallback.
 *     A single notice is written to stderr; the worker-exit error is
 *     never re-thrown to caller code.
 */
import pino from "pino";
import { resolve } from "path";
import { getLogConfig, initLogRotation } from "@/lib/logRotation";
import { getAppLogLevel } from "@/lib/logEnv";

const isDev = process.env.NODE_ENV !== "production";

const baseConfig: pino.LoggerOptions = {
  level: getAppLogLevel(isDev ? "debug" : "info"),
  base: { service: "omniroute" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
};

function getTransportCompatibleConfig(): pino.LoggerOptions {
  const { formatters, ...rest } = baseConfig;
  if (!formatters) return rest;

  const { level: _levelFormatter, ...safeFormatters } = formatters;
  return Object.keys(safeFormatters).length > 0 ? { ...rest, formatters: safeFormatters } : rest;
}

const fallbackLogger: pino.Logger = pino(baseConfig, pino.destination({ dest: 1, sync: true }));

let swapped = false;

const LOG_METHODS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const PASS_THROUGH_METHODS = new Set(["flush", "isLevelEnabled", "bindings", "setBindings"]);

function isWorkerExitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "the worker has exited") return true;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ERR_WORKER_OUT_OF_MEMORY" || code === "ERR_WORKER_NOT_RUNNING";
}

function notifySwapOnce(): void {
  if (swapped) return;
  swapped = true;
  try {
    process.stderr.write(
      "[logger] pino transport worker exited; switched to stdout fallback. " +
        "File logging is OFF until restart.\n"
    );
  } catch {
    /* best-effort */
  }
}

function safeChild(
  parent: pino.Logger,
  bindings: pino.Bindings,
  opts?: pino.ChildLoggerOptions
): pino.Logger {
  try {
    return parent.child(bindings, opts as never);
  } catch (err) {
    if (isWorkerExitError(err)) {
      notifySwapOnce();
      return parent;
    }
    throw err;
  }
}

function wrapWithProxy(inner: pino.Logger, fallback: pino.Logger): pino.Logger {
  const handler: ProxyHandler<pino.Logger> = {
    get(target, prop, receiver) {
      const active: pino.Logger = swapped ? fallback : target;

      if (prop === "child") {
        return (bindings: pino.Bindings, opts?: pino.ChildLoggerOptions): pino.Logger => {
          const innerChild: pino.Logger = swapped ? fallback : safeChild(target, bindings, opts);
          const fbChild: pino.Logger = fallback.child(bindings, opts as never);
          return wrapWithProxy(innerChild, fbChild);
        };
      }

      if (prop === "level") {
        return active.level;
      }

      if (typeof prop === "string" && LOG_METHODS.has(prop)) {
        return (...args: unknown[]) => {
          if (swapped) {
            (fallback as unknown as Record<string, (...a: unknown[]) => void>)[prop].apply(
              fallback,
              args
            );
            return;
          }
          try {
            (target as unknown as Record<string, (...a: unknown[]) => void>)[prop].apply(
              target,
              args
            );
          } catch (err) {
            if (isWorkerExitError(err)) {
              notifySwapOnce();
              try {
                (fallback as unknown as Record<string, (...a: unknown[]) => void>)[prop].apply(
                  fallback,
                  args
                );
              } catch {
                /* swallow — fallback failure must not propagate */
              }
            } else {
              throw err;
            }
          }
        };
      }

      if (typeof prop === "string" && PASS_THROUGH_METHODS.has(prop)) {
        const fn = Reflect.get(active, prop, receiver);
        if (typeof fn !== "function") return fn;
        return (...args: unknown[]) => {
          try {
            return (fn as (...a: unknown[]) => unknown).apply(active, args);
          } catch (err) {
            if (isWorkerExitError(err)) {
              notifySwapOnce();
              const fbFn = Reflect.get(fallback, prop);
              return typeof fbFn === "function"
                ? (fbFn as (...a: unknown[]) => unknown).apply(fallback, args)
                : undefined;
            }
            throw err;
          }
        };
      }

      return Reflect.get(active, prop, receiver);
    },
    set(target, prop, value) {
      if (prop === "level") {
        try {
          (target as { level: string }).level = value;
        } catch {
          /* swallow if worker exit */
        }
        try {
          (fallback as { level: string }).level = value;
        } catch {
          /* swallow */
        }
        return true;
      }
      return Reflect.set(target, prop, value);
    },
  };
  return new Proxy(inner, handler) as pino.Logger;
}

function buildLogger(): pino.Logger {
  const logConfig = getLogConfig();
  const logLevel = (baseConfig.level as string) || "info";
  const transportConfig = getTransportCompatibleConfig();

  const rot = initLogRotation();
  if (!rot.enabled) {
    if (rot.reason !== "disabled") {
      try {
        const detail = rot.reason === "not_writable" && rot.detail ? `/${rot.detail}` : "";
        process.stderr.write(
          `[logger] file logging disabled (${rot.reason}${detail}). ` +
            `Falling back to stdout-only sync destination.\n`
        );
      } catch {
        /* best-effort */
      }
    }
    return wrapWithProxy(fallbackLogger, fallbackLogger);
  }

  const absLogPath = resolve(logConfig.logFilePath);

  try {
    const inner = isDev
      ? pino({
          ...transportConfig,
          transport: {
            targets: [
              {
                target: "pino-pretty",
                options: {
                  colorize: true,
                  translateTime: "HH:MM:ss.l",
                  ignore: "pid,hostname,service",
                  messageFormat: "[{module}] {msg}",
                  destination: 1,
                },
                level: logLevel,
              },
              {
                target: "pino/file",
                options: { destination: absLogPath, mkdir: true },
                level: logLevel,
              },
            ],
          },
        })
      : pino({
          ...transportConfig,
          transport: {
            targets: [
              {
                target: "pino/file",
                options: { destination: 1 },
                level: logLevel,
              },
              {
                target: "pino/file",
                options: { destination: absLogPath, mkdir: true },
                level: logLevel,
              },
            ],
          },
        });
    return wrapWithProxy(inner, fallbackLogger);
  } catch (err) {
    try {
      process.stderr.write(
        `[logger] Failed to set up file transport, using sync stdout fallback: ${
          (err as Error)?.message || err
        }\n`
      );
    } catch {
      /* best-effort */
    }
    return wrapWithProxy(fallbackLogger, fallbackLogger);
  }
}

export const logger = buildLogger();

export function createLogger(module: string) {
  return logger.child({ module });
}

export default logger;
