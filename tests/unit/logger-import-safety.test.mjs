import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Module-import safety test (Oracle PR #29 review A2).
 *
 * Spawn a child node process that imports `src/shared/utils/logger.ts`
 * with `APP_LOG_LEVEL` set to an invalid pino level. The previous
 * implementation crashed at module init because `pino({ level: "bogus" })`
 * throws synchronously and the eager fallback was constructed BEFORE
 * sanitization. The fix sanitizes the level first, so import must
 * succeed and then a basic log call must not throw.
 */
function runChild(envOverrides) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "-e",
      `
        const mod = await import("./src/shared/utils/logger.ts");
        if (!mod.logger) {
          process.stderr.write("logger export missing\\n");
          process.exit(1);
        }
        // basic sanity — must not throw, must still be a logger
        try {
          mod.logger.info("test-log-from-import-safety");
          process.exit(0);
        } catch (err) {
          process.stderr.write("logger.info threw: " + (err && err.message) + "\\n");
          process.exit(2);
        }
      `,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...envOverrides, APP_LOG_TO_FILE: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }
  );
  return {
    code: child.status,
    stdout: child.stdout?.toString() ?? "",
    stderr: child.stderr?.toString() ?? "",
  };
}

test("logger module imports cleanly with valid APP_LOG_LEVEL=info", () => {
  const result = runChild({ APP_LOG_LEVEL: "info" });
  assert.equal(result.code, 0, `unexpected exit code, stderr:\n${result.stderr}`);
});

test("logger module imports cleanly with invalid APP_LOG_LEVEL (gracefully sanitizes)", () => {
  const result = runChild({ APP_LOG_LEVEL: "not-a-real-level" });
  assert.equal(result.code, 0, `unexpected exit code, stderr:\n${result.stderr}`);
  assert.match(result.stderr, /APP_LOG_LEVEL=.*is not a valid pino level/);
});

test("logger module imports cleanly with empty APP_LOG_LEVEL", () => {
  const result = runChild({ APP_LOG_LEVEL: "" });
  assert.equal(result.code, 0, `unexpected exit code, stderr:\n${result.stderr}`);
});
