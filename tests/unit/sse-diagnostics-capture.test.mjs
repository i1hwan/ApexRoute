import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sse-diag-"));
  process.env.DATA_DIR = tmpDir;
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

function diagDir() {
  return join(tmpDir, "logs", "sse-diagnostics");
}

async function waitForBundleFile(timeoutMs = 1000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(diagDir())) {
      const files = readdirSync(diagDir()).filter((f) => f.endsWith(".json"));
      if (files.length > 0) return files;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [];
}

const DEFAULT_CONFIG = {
  captureProviderRawSSELines: false,
  captureProviderParsedEvents: false,
  captureTranslatedOpenAISSE: false,
  keepLastNDebugRequests: 20,
  maxDebugBundleSizeMB: 100,
  maxActiveDebugBundles: 5,
};

async function loadModule() {
  const mod = await import("../../open-sse/utils/sseDiagnosticsBundle.ts");
  mod._testOnlyResetActiveCount();
  return mod;
}

test("no toggles enabled → tryCreateBundle returns null", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(DEFAULT_CONFIG, {
    provider: "claude",
    model: "claude-opus-4-7",
    targetFormat: "claude",
    sourceFormat: "openai",
  });
  assert.equal(bundle, null);
  await mod.finalizeBundle(bundle, "flush");
  assert.equal(readdirSync(tmpDir).length, 0);
});

test("captureProviderRawSSELines → bundle stores raw lines", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureProviderRawSSELines: true },
    { provider: "claude", model: "claude-opus-4-7" }
  );
  assert.ok(bundle);
  mod.appendRawLine(bundle, 0, 'data: {"type":"message_start"}');
  mod.appendRawLine(bundle, 1, 'data: {"type":"content_block_delta"}');
  await mod.finalizeBundle(bundle, "flush");
  const files = readdirSync(diagDir());
  assert.equal(files.length, 1);
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload.provider_raw_lines.length, 2);
  assert.match(payload.provider_raw_lines[0].data, /message_start/);
  assert.equal(payload.metadata.termination, "flush");
});

test("captureProviderParsedEvents stores full events (no truncation)", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureProviderParsedEvents: true },
    { provider: "claude", model: "claude-opus-4-7" }
  );
  for (let i = 0; i < 500; i++) {
    mod.appendParsedEvent(bundle, { type: "content_block_delta", index: i });
  }
  await mod.finalizeBundle(bundle, "flush");
  const files = readdirSync(diagDir());
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload.provider_parsed_events.length, 500);
  assert.ok(!payload._capture_overflow);
});

test("captureTranslatedOpenAISSE stores translated chunks", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureTranslatedOpenAISSE: true },
    { provider: "claude", model: "claude-opus-4-7" }
  );
  mod.appendTranslatedChunk(bundle, { choices: [{ delta: { content: "hello" } }] });
  await mod.finalizeBundle(bundle, "flush");
  const files = readdirSync(diagDir());
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload.translated_openai_chunks.length, 1);
});

test("keepLastNDebugRequests prunes oldest bundles", async () => {
  const mod = await loadModule();
  for (let i = 0; i < 3; i++) {
    const b = mod.tryCreateBundle(
      { ...DEFAULT_CONFIG, captureProviderRawSSELines: true, keepLastNDebugRequests: 2 },
      { provider: "claude", model: "claude-opus-4-7" }
    );
    mod.appendRawLine(b, 0, `data: req${i}`);
    await mod.finalizeBundle(b, "flush");
    await new Promise((r) => setTimeout(r, 10));
  }
  const files = readdirSync(diagDir()).filter((n) => n.endsWith(".json"));
  assert.equal(files.length, 2);
});

test("maxDebugBundleSizeMB enforcement sets _capture_overflow", async () => {
  const mod = await loadModule();
  const tinyCap = { ...DEFAULT_CONFIG, captureProviderRawSSELines: true, maxDebugBundleSizeMB: 1 };
  const bundle = mod.tryCreateBundle(tinyCap, {
    provider: "claude",
    model: "claude-opus-4-7",
  });
  // 1MB cap with a 2MB line forces overflow on the first append.
  const oversized = "x".repeat(2 * 1024 * 1024);
  mod.appendRawLine(bundle, 0, oversized);
  await mod.finalizeBundle(bundle, "flush");
  const files = readdirSync(diagDir());
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload._capture_overflow, true);
  assert.equal(payload.provider_raw_lines.length, 0);
});

test("maxActiveDebugBundles caps concurrent active bundles", async () => {
  const mod = await loadModule();
  const cfg = { ...DEFAULT_CONFIG, captureProviderRawSSELines: true, maxActiveDebugBundles: 2 };
  const b1 = mod.tryCreateBundle(cfg, { provider: "claude" });
  const b2 = mod.tryCreateBundle(cfg, { provider: "claude" });
  const b3 = mod.tryCreateBundle(cfg, { provider: "claude" });
  assert.ok(b1);
  assert.ok(b2);
  assert.equal(b3, null);
  assert.equal(mod._testOnlyGetActiveCount(), 2);
  await mod.finalizeBundle(b1, "flush");
  await mod.finalizeBundle(b2, "flush");
  assert.equal(mod._testOnlyGetActiveCount(), 0);
});

test("upstream_error termination marker recorded", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureProviderParsedEvents: true },
    { provider: "claude" }
  );
  for (let i = 0; i < 25; i++) {
    mod.appendParsedEvent(bundle, { type: "evt", i });
  }
  await mod.finalizeBundle(bundle, "upstream_error", "timeout after 30s");
  const files = readdirSync(diagDir());
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload.metadata.termination, "upstream_error");
  assert.equal(payload.metadata.terminationDetail, "timeout after 30s");
  assert.equal(payload.provider_parsed_events.length, 25);
});

test("client_abort termination marker recorded", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureTranslatedOpenAISSE: true },
    { provider: "claude" }
  );
  mod.appendTranslatedChunk(bundle, { id: "1" });
  await mod.finalizeBundle(bundle, "client_abort");
  const files = readdirSync(diagDir());
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload.metadata.termination, "client_abort");
});

test("appendRawLine no-op when bundle is null", async () => {
  const mod = await loadModule();
  mod.appendRawLine(null, 0, "data: x");
  mod.appendParsedEvent(null, { type: "evt" });
  mod.appendTranslatedChunk(null, { choices: [] });
  await mod.finalizeBundle(null, "flush");
  assert.equal(existsSync(diagDir()), false);
});

test("tryCreateBundle rejects malformed numeric config (Copilot defensive validation)", async () => {
  const mod = await loadModule();
  const baseConfig = { ...DEFAULT_CONFIG, captureProviderRawSSELines: true };

  assert.equal(
    mod.tryCreateBundle(
      { ...baseConfig, maxDebugBundleSizeMB: Number.NaN },
      { provider: "claude" }
    ),
    null,
    "NaN size cap must not produce a bundle"
  );
  assert.equal(
    mod.tryCreateBundle({ ...baseConfig, keepLastNDebugRequests: -5 }, { provider: "claude" }),
    null,
    "negative keepLastN must not produce a bundle"
  );
  assert.equal(
    mod.tryCreateBundle({ ...baseConfig, maxActiveDebugBundles: 1.5 }, { provider: "claude" }),
    null,
    "non-integer maxActive must not produce a bundle"
  );
  assert.equal(
    mod.tryCreateBundle({ ...baseConfig, maxDebugBundleSizeMB: 99999 }, { provider: "claude" }),
    null,
    "out-of-range size cap must not produce a bundle"
  );
  assert.equal(
    mod.tryCreateBundle({ ...baseConfig, maxActiveDebugBundles: "5" }, { provider: "claude" }),
    null,
    "string-typed numeric field must not produce a bundle"
  );
});

test("tryCreateBundle coerces booleans defensively (truthy non-boolean does not enable capture)", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(
    {
      captureProviderRawSSELines: 1,
      captureProviderParsedEvents: "yes",
      captureTranslatedOpenAISSE: {},
      keepLastNDebugRequests: 20,
      maxDebugBundleSizeMB: 100,
      maxActiveDebugBundles: 5,
    },
    { provider: "claude" }
  );
  assert.equal(bundle, null, "non-boolean truthy values must not silently enable capture");
});

test("client_abort path via createDisconnectAwareStream finalizes the bundle (reviewer change request #1)", async () => {
  const diagMod = await loadModule();
  const { createStreamController, createDisconnectAwareStream } =
    await import("../../open-sse/utils/streamHandler.ts");

  // Build a real bundle, register it on a dummy transformStream object,
  // then route through createDisconnectAwareStream and cancel the readable
  // to assert finalize fires with termination='client_abort'.
  const bundle = diagMod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureProviderRawSSELines: true },
    { provider: "claude" }
  );
  diagMod.appendRawLine(bundle, 0, "data: hello");

  const dummy = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
  diagMod.registerBundle(dummy, bundle);

  const controller = createStreamController({ provider: "claude", model: "claude-opus-4-7" });
  // createDisconnectAwareStream grabs the writer itself, so don't pre-acquire
  // it here. Just consume the readable side and cancel it to trigger the
  // disconnect path.
  const readable = createDisconnectAwareStream(dummy, controller);
  const reader = readable.getReader();
  await reader.cancel("client closed connection");

  const files = await waitForBundleFile();
  assert.equal(files.length, 1);
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload.metadata.termination, "client_abort");
  assert.equal(payload.metadata.terminationDetail, "client closed connection");
  assert.equal(payload.provider_raw_lines.length, 1);
});

test("client_abort path via pipeWithDisconnect() finalizes the bundle (wrapper key mismatch regression)", async () => {
  const diagMod = await loadModule();
  const { createStreamController, pipeWithDisconnect } =
    await import("../../open-sse/utils/streamHandler.ts");

  const bundle = diagMod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureProviderRawSSELines: true },
    { provider: "claude" }
  );
  diagMod.appendRawLine(bundle, 0, "data: hello");

  const originalTransform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
  diagMod.registerBundle(originalTransform, bundle);

  const providerResponse = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: chunk1\n\n"));
      },
    })
  );

  const controller = createStreamController({ provider: "claude", model: "claude-opus-4-7" });
  const readable = pipeWithDisconnect(providerResponse, originalTransform, controller);
  const reader = readable.getReader();
  await reader.read();
  await reader.cancel("client closed connection");

  const files = await waitForBundleFile();
  assert.equal(files.length, 1, "client_abort must finalize through pipeWithDisconnect wrapper");
  const payload = JSON.parse(readFileSync(join(diagDir(), files[0]), "utf8"));
  assert.equal(payload.metadata.termination, "client_abort");
  assert.equal(payload.metadata.terminationDetail, "client closed connection");
  assert.equal(payload.provider_raw_lines.length, 1);
});

test("finalizeBundle is idempotent — second call is a no-op (defense against double-finalize)", async () => {
  const mod = await loadModule();
  const bundle = mod.tryCreateBundle(
    { ...DEFAULT_CONFIG, captureProviderRawSSELines: true },
    { provider: "claude" }
  );
  mod.appendRawLine(bundle, 0, "data: x");
  await mod.finalizeBundle(bundle, "flush");
  const filesAfterFirst = readdirSync(diagDir()).filter((f) => f.endsWith(".json"));
  assert.equal(filesAfterFirst.length, 1);
  assert.equal(mod._testOnlyGetActiveCount(), 0);

  // Second finalize with different termination — must be skipped entirely.
  await mod.finalizeBundle(bundle, "upstream_error", "should be ignored");
  const filesAfterSecond = readdirSync(diagDir()).filter((f) => f.endsWith(".json"));
  assert.equal(filesAfterSecond.length, 1);
  assert.equal(mod._testOnlyGetActiveCount(), 0);

  // Original termination preserved
  const payload = JSON.parse(readFileSync(join(diagDir(), filesAfterFirst[0]), "utf8"));
  assert.equal(payload.metadata.termination, "flush");
});

test("flush() remaining buffer is captured into diagnostics (reviewer change request #2)", async () => {
  // Static check: stream.ts flush() must wire the same 3 capture hooks the
  // transform() loop uses. Without this, a trailing-newline-less last SSE
  // line is logged into provider_response summary but missed by raw/parsed/
  // translated bundle capture.
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const streamSrc = readFileSync(
    join(__dirname, "..", "..", "open-sse", "utils", "stream.ts"),
    "utf8"
  );
  const flushRe = /\/\/ Translate mode: process remaining buffer[\s\S]*?\n\s{10}\}\n/;
  const flushBlock = streamSrc.match(flushRe);
  assert.ok(flushBlock, "flush() translate-mode remaining-buffer block not found");
  const body = flushBlock[0];
  assert.match(body, /appendRawLine\(diagnosticsBundle/, "flush remaining must capture raw line");
  assert.match(
    body,
    /appendParsedEvent\(diagnosticsBundle/,
    "flush remaining must capture parsed event"
  );
  assert.match(
    body,
    /appendTranslatedChunk\(diagnosticsBundle/,
    "flush remaining must capture translated chunk"
  );
});

test("clear route deletes all bundle files", async () => {
  const mod = await loadModule();
  for (let i = 0; i < 3; i++) {
    const b = mod.tryCreateBundle(
      { ...DEFAULT_CONFIG, captureProviderRawSSELines: true },
      { provider: "claude" }
    );
    mod.appendRawLine(b, 0, `data: ${i}`);
    await mod.finalizeBundle(b, "flush");
  }
  assert.equal(readdirSync(diagDir()).filter((f) => f.endsWith(".json")).length, 3);

  const { POST } = await import("../../src/app/api/settings/sse-diagnostics/clear/route.ts");
  const res = await POST();
  const body = await res.json();
  assert.equal(body.deletedCount, 3);
  assert.equal(readdirSync(diagDir()).length, 0);
});
