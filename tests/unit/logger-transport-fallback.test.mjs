import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;

const logRotation = await import("../../src/lib/logRotation.ts");
const { ensureLogDir, verifyLogDirWritable, initLogRotation } = logRotation;

function tmp(prefix = "pr29-logger-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("verifyLogDirWritable returns ok and cleans up the probe on a writable dir", () => {
  const dir = tmp();
  const target = join(dir, "app.log");
  const result = verifyLogDirWritable(target);
  assert.deepEqual(result, { ok: true });

  const leftover = readdirSync(dir).filter((f) => f.startsWith(".write-probe-"));
  assert.equal(leftover.length, 0, "probe file must be cleaned up after success");

  rmSync(dir, { recursive: true, force: true });
});

test("verifyLogDirWritable rejects when target path is itself a directory (TARGET_IS_DIR)", () => {
  const dir = tmp();
  const targetAsDir = join(dir, "logfile.dir");
  mkdirSync(targetAsDir);
  const result = verifyLogDirWritable(targetAsDir);
  assert.deepEqual(result, { ok: false, reason: "TARGET_IS_DIR" });
  rmSync(dir, { recursive: true, force: true });
});

test("verifyLogDirWritable rejects when parent does not exist (ENOENT)", () => {
  const target = join(tmpdir(), `does-not-exist-${Date.now()}-${Math.random()}/app.log`);
  const result = verifyLogDirWritable(target);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "ENOENT");
  }
});

test(
  "verifyLogDirWritable rejects with EACCES on a read-only parent dir (skipped on root)",
  { skip: isRoot ? "running as root, chmod 0o400 still writable" : false },
  () => {
    const dir = tmp();
    chmodSync(dir, 0o400);
    try {
      const target = join(dir, "app.log");
      const result = verifyLogDirWritable(target);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(
          result.reason === "EACCES" || result.reason === "EROFS",
          `expected EACCES or EROFS, got ${result.reason}`
        );
      }
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("verifyLogDirWritable leaves no probe leftover after success across many calls (cleanup invariant)", () => {
  const dir = tmp();
  const target = join(dir, "app.log");

  for (let i = 0; i < 50; i++) {
    const result = verifyLogDirWritable(target);
    assert.deepEqual(result, { ok: true }, `iteration ${i} must succeed`);
  }

  const leftover = readdirSync(dir).filter((f) => f.startsWith(".write-probe-"));
  assert.equal(
    leftover.length,
    0,
    "no probe file may leak across many calls (try/finally invariant)"
  );

  rmSync(dir, { recursive: true, force: true });
});

test("ensureLogDir returns 'created' when dir does not exist", () => {
  const parent = tmp();
  const target = join(parent, "nested", "deep", "app.log");
  const result = ensureLogDir(target);
  assert.equal(result, "created");
  rmSync(parent, { recursive: true, force: true });
});

test("ensureLogDir returns 'exists' when dir already exists", () => {
  const dir = tmp();
  const target = join(dir, "app.log");
  const result = ensureLogDir(target);
  assert.equal(result, "exists");
  rmSync(dir, { recursive: true, force: true });
});

test("ensureLogDir returns 'failed' when parent path is a regular file (not a dir)", () => {
  const dir = tmp();
  const fileAsDir = join(dir, "blocker");
  writeFileSync(fileAsDir, "not a dir");
  const target = join(fileAsDir, "app.log");
  const result = ensureLogDir(target);
  assert.equal(result, "failed");
  rmSync(dir, { recursive: true, force: true });
});

test("initLogRotation returns disabled when APP_LOG_TO_FILE=false", () => {
  const orig = process.env.APP_LOG_TO_FILE;
  process.env.APP_LOG_TO_FILE = "false";
  try {
    const result = initLogRotation();
    assert.deepEqual(result, { enabled: false, reason: "disabled" });
  } finally {
    if (orig === undefined) delete process.env.APP_LOG_TO_FILE;
    else process.env.APP_LOG_TO_FILE = orig;
  }
});

test("initLogRotation returns enabled:true on a writable path", () => {
  const dir = tmp();
  const target = join(dir, "app.log");
  const origPath = process.env.APP_LOG_FILE_PATH;
  const origToFile = process.env.APP_LOG_TO_FILE;
  process.env.APP_LOG_FILE_PATH = target;
  process.env.APP_LOG_TO_FILE = "true";
  try {
    const result = initLogRotation();
    assert.deepEqual(result, { enabled: true, reason: "ok" });
  } finally {
    if (origPath === undefined) delete process.env.APP_LOG_FILE_PATH;
    else process.env.APP_LOG_FILE_PATH = origPath;
    if (origToFile === undefined) delete process.env.APP_LOG_TO_FILE;
    else process.env.APP_LOG_TO_FILE = origToFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initLogRotation returns not_writable with structured detail when target is itself a dir", () => {
  const dir = tmp();
  const targetAsDir = join(dir, "logfile.dir");
  mkdirSync(targetAsDir);
  const origPath = process.env.APP_LOG_FILE_PATH;
  const origToFile = process.env.APP_LOG_TO_FILE;
  process.env.APP_LOG_FILE_PATH = targetAsDir;
  process.env.APP_LOG_TO_FILE = "true";
  try {
    const result = initLogRotation();
    assert.equal(result.enabled, false);
    if (!result.enabled) {
      assert.equal(result.reason, "not_writable");
      assert.equal(result.detail, "TARGET_IS_DIR");
    }
  } finally {
    if (origPath === undefined) delete process.env.APP_LOG_FILE_PATH;
    else process.env.APP_LOG_FILE_PATH = origPath;
    if (origToFile === undefined) delete process.env.APP_LOG_TO_FILE;
    else process.env.APP_LOG_TO_FILE = origToFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "verifyLogDirWritable rejects an existing read-only target file (Oracle PR #29 review A1)",
  { skip: isRoot ? "root bypasses 0o400" : false },
  () => {
    const dir = tmp();
    const target = join(dir, "app.log");
    writeFileSync(target, "old content\n");
    chmodSync(target, 0o400);
    try {
      const result = verifyLogDirWritable(target);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(
          result.reason === "EACCES" || result.reason === "EROFS",
          `expected EACCES or EROFS, got ${result.reason}`
        );
      }
    } finally {
      chmodSync(target, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("verifyLogDirWritable accepts an existing writable target file (append-mode open)", () => {
  const dir = tmp();
  const target = join(dir, "app.log");
  writeFileSync(target, "existing content\n");
  const result = verifyLogDirWritable(target);
  assert.deepEqual(result, { ok: true });
  rmSync(dir, { recursive: true, force: true });
});
