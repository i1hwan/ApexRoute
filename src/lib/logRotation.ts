/**
 * Log Rotation & Cleanup — manages application log file rotation.
 *
 * Handles:
 *   - Rotating log files when they exceed max size
 *   - Cleaning up old log files past retention period
 *   - Capping the number of rotated log files kept on disk
 *   - Creating the log directory on startup
 *   - Probing the log destination for actual writability before the pino
 *     transport worker starts (avoids the worker dying on first write and
 *     flooding chat requests with `Error: the worker has exited` — PR #29)
 *
 * Configuration via env vars:
 *   - APP_LOG_TO_FILE: enable file logging (default: true)
 *   - APP_LOG_FILE_PATH: path to log file (default: <DATA_DIR>/logs/application/app.log)
 *   - APP_LOG_MAX_FILE_SIZE: max file size before rotation (default: 50MB)
 *   - APP_LOG_RETENTION_DAYS: days to keep old logs (default: 7)
 *   - APP_LOG_MAX_FILES: max number of rotated log files to keep (default: 20)
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { randomBytes } from "crypto";
import { dirname, join, basename, extname } from "path";
import {
  getAppLogFilePath,
  getAppLogMaxFiles,
  getAppLogMaxFileSize,
  getAppLogRetentionDays,
  getAppLogToFile,
} from "./logEnv";

export function getLogConfig() {
  const logToFile = getAppLogToFile();
  const logFilePath = getAppLogFilePath() || join(process.cwd(), "logs/application/app.log");
  const maxFileSize = getAppLogMaxFileSize();
  const retentionDays = getAppLogRetentionDays();
  const maxFiles = getAppLogMaxFiles();

  return { logToFile, logFilePath, maxFileSize, retentionDays, maxFiles };
}

export type LogDirEnsureResult = "created" | "exists" | "failed";

export function ensureLogDir(logFilePath: string): LogDirEnsureResult {
  const dir = dirname(logFilePath);
  try {
    if (existsSync(dir)) {
      const st = statSync(dir);
      if (!st.isDirectory()) return "failed";
      return "exists";
    }
    mkdirSync(dir, { recursive: true });
    return "created";
  } catch {
    return "failed";
  }
}

export type WritableProbeFailReason =
  | "EACCES"
  | "EROFS"
  | "ENOENT"
  | "ENOSPC"
  | "ENOTDIR"
  | "EEXIST_FILE"
  | "TARGET_IS_DIR"
  | "UNKNOWN";

export type WritableProbeResult = { ok: true } | { ok: false; reason: WritableProbeFailReason };

/**
 * Verify that the parent directory of `logFilePath` accepts a real one-byte
 * write. Catches read-only mounts (EROFS), missing permissions (EACCES),
 * full filesystems (ENOSPC), and the case where the target path itself is
 * a directory (TARGET_IS_DIR — pino/file would error on first write).
 *
 * Uses exclusive create (`openSync(probe, "wx")`) to avoid clobbering any
 * concurrent file. Cleans up the probe in `finally` whether write
 * succeeded or failed.
 */
export function verifyLogDirWritable(logFilePath: string): WritableProbeResult {
  try {
    if (existsSync(logFilePath)) {
      const st = statSync(logFilePath);
      if (st.isDirectory()) return { ok: false, reason: "TARGET_IS_DIR" };
    }
  } catch {
    // ignore — fall through to write probe
  }

  const dir = dirname(logFilePath);
  const probe = join(
    dir,
    `.write-probe-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`
  );

  let fd: number | null = null;
  let opened = false;
  try {
    fd = openSync(probe, "wx");
    opened = true;
    writeSync(fd, Buffer.from("0"));
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    let reason: WritableProbeFailReason;
    if (
      code === "EACCES" ||
      code === "EROFS" ||
      code === "ENOENT" ||
      code === "ENOSPC" ||
      code === "ENOTDIR"
    ) {
      reason = code;
    } else if (code === "EEXIST") {
      reason = "EEXIST_FILE";
    } else {
      reason = "UNKNOWN";
    }
    return { ok: false, reason };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
    if (opened) {
      try {
        unlinkSync(probe);
      } catch {
        /* best-effort — file may have been removed by another process */
      }
    }
  }
}

export function rotateIfNeeded(logFilePath: string, maxFileSize: number): void {
  try {
    if (!existsSync(logFilePath)) return;
    const stats = statSync(logFilePath);
    if (stats.size < maxFileSize) return;

    const dir = dirname(logFilePath);
    const ext = extname(logFilePath);
    const base = basename(logFilePath, ext);
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes()
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;

    const rotatedPath = join(dir, `${base}.${ts}${ext}`);
    renameSync(logFilePath, rotatedPath);
  } catch {
    // If rotation fails, continue writing to the same file
  }
}

export function cleanupOldLogs(logFilePath: string, retentionDays: number): void {
  try {
    const dir = dirname(logFilePath);
    if (!existsSync(dir)) return;

    const ext = extname(logFilePath);
    const base = basename(logFilePath, ext);
    const files = readdirSync(dir);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (file.startsWith(base + ".") && file.endsWith(ext) && file !== basename(logFilePath)) {
        const filePath = join(dir, file);
        try {
          const stats = statSync(filePath);
          if (stats.mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Cleanup is best-effort
  }
}

export function cleanupOverflowLogs(logFilePath: string, maxFiles: number): void {
  try {
    const dir = dirname(logFilePath);
    if (!existsSync(dir) || maxFiles < 1) return;

    const ext = extname(logFilePath);
    const base = basename(logFilePath, ext);
    const rotatedFiles = readdirSync(dir)
      .filter(
        (file) =>
          file !== basename(logFilePath) && file.startsWith(base + ".") && file.endsWith(ext)
      )
      .map((file) => {
        const filePath = join(dir, file);
        try {
          return { filePath, mtimeMs: statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { filePath: string; mtimeMs: number } => !!entry)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const entry of rotatedFiles.slice(maxFiles)) {
      try {
        unlinkSync(entry.filePath);
      } catch {
        // Best effort only.
      }
    }
  } catch {
    // Cleanup is best-effort
  }
}

export type LogRotationInitResult =
  | { enabled: true; reason: "ok" }
  | {
      enabled: false;
      reason: "disabled" | "mkdir_failed" | "not_writable";
      detail?: WritableProbeFailReason;
    };

/**
 * Initialize log rotation — call once at application startup.
 * Returns a structured outcome so the logger build path can branch
 * deterministically (file transport vs sync stdout fallback) without
 * relying on later transport-worker death.
 */
export function initLogRotation(): LogRotationInitResult {
  const config = getLogConfig();
  if (!config.logToFile) return { enabled: false, reason: "disabled" };

  const ensure = ensureLogDir(config.logFilePath);
  if (ensure === "failed") return { enabled: false, reason: "mkdir_failed" };

  const v = verifyLogDirWritable(config.logFilePath);
  if (!v.ok) return { enabled: false, reason: "not_writable", detail: v.reason };

  rotateIfNeeded(config.logFilePath, config.maxFileSize);
  cleanupOldLogs(config.logFilePath, config.retentionDays);
  cleanupOverflowLogs(config.logFilePath, config.maxFiles);
  return { enabled: true, reason: "ok" };
}
