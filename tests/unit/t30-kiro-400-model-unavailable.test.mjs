import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-family-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const {
  isModelUnavailableError,
  getNextFamilyFallback,
  getModelFamily,
  isInModelFamily,
  findLargerContextModel,
} = await import("../../open-sse/services/modelFamilyFallback.ts");
const core = await import("../../src/lib/db/core.ts");
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

test("T30: Kiro 'improperly formed request' 400 is treated as model-unavailable", () => {
  const unavailable = isModelUnavailableError(
    400,
    "Bad Request: improperly formed request for selected model"
  );
  assert.equal(unavailable, true);
});

test("T30: generic 400 without model-unavailable signal is not treated as unavailable", () => {
  const unavailable = isModelUnavailableError(400, "Bad Request: malformed JSON body");
  assert.equal(unavailable, false);
});

test("T30: 404 still maps to model-unavailable", () => {
  const unavailable = isModelUnavailableError(404, "not found");
  assert.equal(unavailable, true);
});

test("T30: model family helper returns a sibling candidate when available", () => {
  const next = getNextFamilyFallback("gemini-3.1-pro-high", new Set(["gemini-3.1-pro-high"]));
  assert.equal(typeof next, "string");
  assert.notEqual(next, "gemini-3.1-pro-high");
});

test("T30: GPT 5.x Codex family fallback covers current GPT 5.5, 5.4, and Spark models", () => {
  assert.equal(isInModelFamily("gpt-5.5"), true);
  assert.equal(isInModelFamily("gpt-5.4"), true);
  assert.equal(isInModelFamily("gpt-5.3-codex-spark"), true);
  assert.equal(isInModelFamily("gpt-5.3-codex-spark-high"), true);
  assert.equal(isInModelFamily("gpt-5.2"), true);
  assert.equal(isInModelFamily("gpt-5.2-codex"), true);
  assert.equal(isInModelFamily("gpt-5.1"), true);
  assert.equal(isInModelFamily("gpt-5.1-codex"), true);
  assert.equal(isInModelFamily("gpt-5.1-codex-mini"), true);
  assert.equal(isInModelFamily("gpt-5.1-codex-max"), true);
  assert.equal(isInModelFamily("gpt-5-codex"), true);
  assert.equal(isInModelFamily("gpt-5-codex-mini"), true);

  assert.equal(getNextFamilyFallback("gpt-5.5", new Set(["gpt-5.5-high"])), "gpt-5.5-pro");
  assert.equal(getNextFamilyFallback("gpt-5.5-high", new Set(), "codex"), "gpt-5.5-pro");
  assert.equal(getNextFamilyFallback("gpt-5.3-codex-spark", new Set()), "gpt-5.3-codex");
  assert.equal(getNextFamilyFallback("gpt-5.3-codex-spark-high", new Set(), "cx"), "gpt-5.3-codex");
  assert.equal(getNextFamilyFallback("gpt-5.1", new Set()), "gpt-5.1-codex");
  assert.equal(getNextFamilyFallback("gpt-5.1", new Set(), "openai", "openai"), "gpt-5");
  assert.equal(
    getNextFamilyFallback("gpt-5.1-codex", new Set(), "openai", "openai-responses"),
    "gpt-5.1-codex-max"
  );
  assert.equal(getNextFamilyFallback("gpt-5.1-codex", new Set()), "gpt-5.1-codex-max");
  assert.equal(getNextFamilyFallback("gpt-5-codex-mini", new Set()), "gpt-5-codex");
  assert.equal(
    getNextFamilyFallback("gpt-5-codex", new Set(["gpt-5.1-codex"]), "openai"),
    "gpt-5.2-codex"
  );

  const sparkFamily = getModelFamily("gpt-5.3-codex-spark");
  assert.ok(sparkFamily.includes("gpt-5.3-codex"));
  assert.ok(sparkFamily.includes("gpt-5.4-mini"));

  const codexMiniFamily = getModelFamily("gpt-5-codex-mini");
  assert.ok(codexMiniFamily.includes("gpt-5-codex"));
  assert.ok(codexMiniFamily.includes("gpt-5.1-codex-mini"));
});

test("T30: larger-context fallback uses provider-aware registry caps before stale synced aliases", () => {
  saveModelsDevCapabilities({
    cx: {
      "gpt-5.3-codex-spark": capabilityEntry(999999),
      "gpt-5.4": capabilityEntry(64000),
    },
  });

  const next = findLargerContextModel("cx/gpt-5.3-codex-spark", [
    "cx/gpt-5.3-codex-spark",
    "cx/gpt-5.4",
  ]);

  assert.equal(next, "cx/gpt-5.4");
});

test("T30: larger-context fallback preserves provider caps for bare Codex live models", () => {
  saveModelsDevCapabilities({
    cx: {
      "gpt-5.3-codex-spark": capabilityEntry(999999),
      "gpt-5.3-codex": capabilityEntry(64000),
    },
  });

  const next = findLargerContextModel(
    "gpt-5.3-codex-spark",
    ["gpt-5.3-codex-spark", "gpt-5.3-codex"],
    "codex"
  );

  assert.equal(next, "gpt-5.3-codex");
});
