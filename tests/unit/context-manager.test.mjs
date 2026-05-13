import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-context-manager-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { compressContext, estimateTokens, getTokenLimit } =
  await import("../../open-sse/services/contextManager.ts");
const core = await import("../../src/lib/db/core.ts");
const { getModelSpec } = await import("../../src/shared/constants/modelSpecs.ts");
const { saveModelsDevCapabilities } = await import("../../src/lib/modelsDevSync.ts");

function capabilityEntry(limitContext) {
  return {
    tool_call: true,
    reasoning: true,
    attachment: true,
    structured_output: true,
    temperature: true,
    modalities_input: JSON.stringify(["text"]),
    modalities_output: JSON.stringify(["text"]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: false,
    limit_context: limitContext,
    limit_input: limitContext,
    limit_output: 4096,
    interleaved_field: null,
  };
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── estimateTokens ─────────────────────────────────────────────────────────

test("estimateTokens: estimates from string", () => {
  assert.equal(estimateTokens("hello"), 2); // 5/4 = 2
  assert.ok(estimateTokens("a".repeat(100)) === 25);
});

test("estimateTokens: handles null", () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(""), 0);
});

// ─── getTokenLimit ──────────────────────────────────────────────────────────

test("getTokenLimit: detects claude", () => {
  assert.equal(getTokenLimit("claude", "claude-sonnet-4"), 200000);
});

test("getTokenLimit: detects gemini", () => {
  assert.equal(getTokenLimit("gemini", "gemini-2.5-pro"), 1048576);
});

test("getTokenLimit: uses registry per-model context length before provider default", () => {
  assert.equal(getTokenLimit("codex", "gpt-5.5"), 400000);
});

test("getTokenLimit: registry caps override stale synced alias context", () => {
  saveModelsDevCapabilities({
    cx: {
      "gpt-5.5": capabilityEntry(1050000),
    },
    claude: {
      "claude-opus-4-7": capabilityEntry(200000),
    },
  });

  assert.equal(getTokenLimit("codex", "gpt-5.5"), 400000);
  assert.equal(getTokenLimit("cx", "gpt-5.5"), 400000);
  assert.equal(getTokenLimit("claude", "claude-opus-4-7"), 1000000);
  assert.equal(getTokenLimit("cc", "claude-opus-4-7"), 1000000);
});

test("getTokenLimit: Codex aliases keep provider-scoped caps while generic specs stay public", () => {
  assert.equal(getModelSpec("gpt-5.5").contextWindow, 1050000);
  assert.equal(getTokenLimit("codex", "gpt-5.5"), 400000);
  assert.equal(getTokenLimit("cx", "gpt5.5"), 400000);
  assert.equal(getTokenLimit("cx", "gpt5.5-pro"), 400000);
  assert.equal(getTokenLimit("codex", "gpt-5.3-codex-spark"), 128000);
});

test("getTokenLimit: models.dev alias data still applies to unknown registry models", () => {
  saveModelsDevCapabilities({
    cx: {
      "future-codex-model": capabilityEntry(777000),
    },
  });

  assert.equal(getTokenLimit("codex", "future-codex-model"), 777000);
});

test("getTokenLimit: default fallback", () => {
  assert.equal(getTokenLimit("unknown"), 128000);
});

// ─── compressContext ────────────────────────────────────────────────────────

test("compressContext: returns unchanged if fits", () => {
  const body = {
    model: "claude-sonnet-4",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
  };
  const result = compressContext(body);
  assert.equal(result.compressed, false);
});

test("compressContext: handles null/empty body", () => {
  assert.equal(compressContext(null).compressed, false);
  assert.equal(compressContext({}).compressed, false);
  assert.equal(compressContext({ messages: null }).compressed, false);
});

test("compressContext: Layer 1 — trims long tool messages", () => {
  const longContent = "x".repeat(10000);
  const body = {
    model: "test",
    messages: [
      { role: "user", content: "run tool" },
      { role: "tool", content: longContent, tool_call_id: "t1" },
      { role: "user", content: "done?" },
    ],
  };
  // Use very tight limit to force compression
  const result = compressContext(body, { maxTokens: 500, reserveTokens: 100 });
  assert.ok(result.compressed);
  const toolMsg = result.body.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg.content.length < longContent.length);
  assert.ok(toolMsg.content.includes("[truncated]"));
});

test("compressContext: Layer 2 — compresses thinking in old messages", () => {
  const body = {
    model: "test",
    messages: [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "lots of thinking here ".repeat(500) },
          { type: "text", text: "answer1" },
        ],
      },
      { role: "user", content: "q2" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "more thinking" },
          { type: "text", text: "answer2" },
        ],
      },
    ],
  };
  const result = compressContext(body, { maxTokens: 2000, reserveTokens: 500 });
  // First assistant should have thinking removed
  const firstAssistant = result.body.messages.find((m) => m.role === "assistant");
  if (Array.isArray(firstAssistant.content)) {
    const hasThinking = firstAssistant.content.some((b) => b.type === "thinking");
    assert.equal(hasThinking, false);
  }
});

test("compressContext: Layer 3 — drops old messages to fit", () => {
  const messages = [
    { role: "system", content: "You are helpful" },
    ...Array.from({ length: 100 }, (_, i) => [
      { role: "user", content: `Message ${i}: ${"content ".repeat(50)}` },
      { role: "assistant", content: `Response ${i}: ${"answer ".repeat(50)}` },
    ]).flat(),
  ];
  const body = { model: "test", messages };
  const result = compressContext(body, { maxTokens: 3000, reserveTokens: 500 });
  assert.ok(result.compressed);
  assert.ok(result.body.messages.length < messages.length);
  // System message preserved
  assert.equal(result.body.messages[0].role, "system");
});
