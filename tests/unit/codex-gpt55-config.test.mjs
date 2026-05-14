import test from "node:test";
import assert from "node:assert/strict";

import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { getModelInfoCore } from "../../open-sse/services/model.ts";
import { computeCostFromPricing } from "../../src/lib/usage/costCalculator.ts";
import { capMaxOutputTokens, getModelSpec } from "../../src/shared/constants/modelSpecs.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";

test("Codex registry exposes GPT 5.5 and reasoning variants", async () => {
  const codexModels = REGISTRY.codex.models;
  const ids = codexModels.map((model) => model.id);

  assert.deepEqual(ids.slice(0, 6), [
    "gpt-5.5",
    "gpt-5.5-xhigh",
    "gpt-5.5-high",
    "gpt-5.5-medium",
    "gpt-5.5-low",
    "gpt-5.5-none",
  ]);

  const base = codexModels.find((model) => model.id === "gpt-5.5");
  const pro = codexModels.find((model) => model.id === "gpt-5.5-pro");
  assert.equal(base.targetFormat, "openai-responses");
  assert.equal(base.toolCalling, true);
  assert.equal(base.supportsReasoning, true);
  assert.equal(base.supportsVision, true);
  assert.equal(base.supportsXHighEffort, true);
  assert.equal(base.contextLength, 400000);
  assert.equal(base.maxOutputTokens, 128000);
  assert.equal(pro.contextLength, 400000);
  assert.equal(pro.maxOutputTokens, 128000);

  const resolved = await getModelInfoCore("cx/gpt-5.5", {});
  assert.equal(resolved.provider, "codex");
  assert.equal(resolved.model, "gpt-5.5");

  const noHyphenAlias = await getModelInfoCore("cx/gpt5.5", {});
  assert.equal(noHyphenAlias.provider, "codex");
  assert.equal(noHyphenAlias.model, "gpt-5.5");

  const proAlias = await getModelInfoCore("cx/gpt5.5-pro", {});
  assert.equal(proAlias.provider, "codex");
  assert.equal(proAlias.model, "gpt-5.5-pro");

  const bareNoHyphenAlias = await getModelInfoCore("gpt5.5", {});
  assert.equal(bareNoHyphenAlias.provider, "codex");
  assert.equal(bareNoHyphenAlias.model, "gpt-5.5");
});

test("Codex GPT 5.5 model spec and pricing are available", () => {
  const spec = getModelSpec("gpt-5.5-high");
  const proSpec = getModelSpec("gpt-5.5-pro");
  const pricing = getDefaultPricing();

  assert.equal(spec.contextWindow, 1050000);
  assert.equal(spec.maxOutputTokens, 128000);
  assert.equal(proSpec.contextWindow, 1050000);
  assert.equal(proSpec.maxOutputTokens, 128000);
  assert.equal(capMaxOutputTokens("gpt-5.5", 200000), 128000);
  assert.equal(capMaxOutputTokens("gpt-5.5-pro", 200000), 128000);
  assert.equal(pricing.cx["gpt-5.5"].output, 30.0);
  assert.equal(pricing.cx["gpt-5.5-pro"].input, 30.0);
  assert.equal(pricing.cx["gpt-5.5-xhigh"], pricing.cx["gpt-5.5"]);
});

test("Codex registry exposes current GPT 5.x specs including Spark", async () => {
  const byId = new Map(REGISTRY.codex.models.map((model) => [model.id, model]));

  const gpt54 = byId.get("gpt-5.4");
  assert.equal(gpt54.contextLength, 1050000);
  assert.equal(gpt54.maxOutputTokens, 128000);
  assert.equal(gpt54.supportsReasoning, true);
  assert.equal(gpt54.toolCalling, true);

  const gpt54Pro = byId.get("gpt-5.4-pro");
  assert.equal(gpt54Pro.contextLength, 1050000);
  assert.equal(gpt54Pro.maxOutputTokens, 128000);
  assert.equal(gpt54Pro.supportsReasoning, true);
  assert.equal(gpt54Pro.toolCalling, true);

  const gpt54Mini = byId.get("gpt-5.4-mini");
  assert.equal(gpt54Mini.contextLength, 400000);
  assert.equal(gpt54Mini.maxOutputTokens, 128000);

  const gpt54Nano = byId.get("gpt-5.4-nano");
  assert.equal(gpt54Nano.contextLength, 400000);
  assert.equal(gpt54Nano.maxOutputTokens, 128000);

  const gpt5CodexMini = byId.get("gpt-5-codex-mini");
  assert.equal(gpt5CodexMini.contextLength, 400000);
  assert.equal(gpt5CodexMini.maxOutputTokens, 128000);
  assert.equal(gpt5CodexMini.supportsReasoning, true);
  assert.equal(gpt5CodexMini.toolCalling, true);

  const spark = byId.get("gpt-5.3-codex-spark");
  assert.equal(spark.contextLength, 128000);
  assert.equal(spark.maxOutputTokens, 32000);
  assert.equal(spark.supportsReasoning, true);
  assert.equal(spark.toolCalling, true);
  assert.equal(spark.supportsVision, true);

  for (const suffix of ["xhigh", "high", "medium", "low", "none"]) {
    const sparkVariant = byId.get(`gpt-5.3-codex-spark-${suffix}`);
    assert.equal(sparkVariant.contextLength, 128000);
    assert.equal(sparkVariant.maxOutputTokens, 32000);
  }
  assert.equal(byId.get("gpt-5.3-codex-medium").contextLength, 400000);

  const resolvedSpark = await getModelInfoCore("cx/gpt-5.3-codex-spark", {});
  assert.equal(resolvedSpark.provider, "codex");
  assert.equal(resolvedSpark.model, "gpt-5.3-codex-spark");

  const resolvedGpt54Pro = await getModelInfoCore("cx/gpt5.4-pro", {});
  assert.equal(resolvedGpt54Pro.provider, "codex");
  assert.equal(resolvedGpt54Pro.model, "gpt-5.4-pro");
});

test("OpenAI registry exposes current GPT 5.x API-key catalog entries", () => {
  const byId = new Map(REGISTRY.openai.models.map((model) => [model.id, model]));

  for (const id of [
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex",
    "gpt-5.3-chat-latest",
    "gpt-5.3-codex-spark",
    "gpt-5.2",
    "gpt-5.2-chat-latest",
    "gpt-5.2-codex",
    "gpt-5.2-pro",
    "gpt-5.1",
    "gpt-5.1-chat-latest",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5",
    "gpt-5-chat-latest",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-5-codex",
  ]) {
    const model = byId.get(id);
    assert.ok(model, `missing OpenAI registry model: ${id}`);
    assert.equal(model.supportsReasoning, id !== "gpt-5.3-chat-latest");
    assert.equal(model.supportsVision, true);
    assert.equal(model.toolCalling, true);
    const expectedTargetFormat = id.includes("codex") ? "openai-responses" : null;
    assert.equal(model.targetFormat ?? null, expectedTargetFormat);
  }

  assert.equal(byId.get("gpt-5.5").contextLength, 1050000);
  assert.equal(byId.get("gpt-5.5").maxOutputTokens, 128000);
  assert.equal(byId.get("gpt-5.3-codex-spark").contextLength, 128000);
  assert.equal(byId.get("gpt-5.3-codex-spark").maxOutputTokens, 32000);
  assert.equal(byId.get("gpt-5.3-chat-latest").contextLength, 128000);
  assert.equal(byId.get("gpt-5.3-chat-latest").maxOutputTokens, 16384);
  assert.equal(byId.get("gpt-5-chat-latest").contextLength, 400000);
  assert.equal(byId.get("gpt-5-chat-latest").maxOutputTokens, 128000);
  assert.equal(byId.get("gpt-5-pro").contextLength, 400000);
  assert.equal(byId.get("gpt-5-pro").maxOutputTokens, 272000);
  assert.equal(byId.get("gpt-5.2-pro").contextLength, 400000);
  assert.equal(byId.get("gpt-5.2-pro").maxOutputTokens, 128000);
  assert.equal(byId.get("gpt-5-codex").contextLength, 400000);
  assert.equal(byId.get("gpt-5-codex").maxOutputTokens, 128000);
});

test("OpenAI Codex-family models are Responses-only in the registry", () => {
  for (const model of REGISTRY.openai.models) {
    if (!model.id.includes("codex")) continue;
    assert.equal(model.targetFormat, "openai-responses", `${model.id} must use Responses API`);
  }
});

test("Codex GPT 5.x model specs and pricing match current base tiers", () => {
  const sparkSpec = getModelSpec("gpt-5.3-codex-spark-high");
  const gpt53Spec = getModelSpec("gpt-5.3-codex-high");
  const gpt54ProSpec = getModelSpec("gpt-5.4-pro");
  const pricing = getDefaultPricing();

  assert.equal(sparkSpec.contextWindow, 128000);
  assert.equal(sparkSpec.maxOutputTokens, 32000);
  assert.equal(gpt53Spec.contextWindow, 400000);
  assert.equal(gpt53Spec.maxOutputTokens, 128000);
  assert.equal(gpt54ProSpec.contextWindow, 1050000);
  assert.equal(gpt54ProSpec.maxOutputTokens, 128000);
  assert.equal(capMaxOutputTokens("gpt-5.3-codex-spark", 128000), 32000);

  for (const id of [
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-codex",
    "gpt-5-codex-mini",
  ]) {
    const spec = getModelSpec(id);
    assert.equal(spec.contextWindow, 400000, `${id} contextWindow`);
    assert.equal(spec.maxOutputTokens, 128000, `${id} maxOutputTokens`);
    assert.equal(capMaxOutputTokens(id, 200000), 128000, `${id} capped output`);
  }

  assert.equal(pricing.cx["gpt-5.4"].input, 2.5);
  assert.equal(pricing.cx["gpt-5.4-pro"].output, 180.0);
  assert.equal(pricing.cx["gpt-5.4-mini"].cached, 0.075);
  assert.equal(pricing.cx["gpt-5.4-nano"].output, 1.25);
  assert.equal(pricing.cx["gpt-5.3-codex-spark"].output, 14.0);
  assert.equal(pricing.cx["gpt-5.3-codex-spark-high"].input, 1.75);
  assert.equal(pricing.cx["gpt-5.3-codex-medium"].output, 14.0);
  assert.equal(pricing.cx["gpt-5.2-codex"].input, 1.75);
  assert.equal(pricing.cx["gpt-5.1-codex"].output, 10.0);
  assert.equal(pricing.openai["gpt-5.1-codex-max"].output, 10.0);
  assert.equal(pricing.openai["gpt-5-nano"].input, 0.05);
  assert.equal(pricing.openai["gpt-5-pro"].output, 120.0);
  assert.equal(pricing.openai["gpt-5.2-pro"].output, 168.0);
});

test("Codex GPT 5.5 and GPT 5.4 pricing applies long-context multipliers", () => {
  const pricing = getDefaultPricing();

  assert.equal(pricing.cx["gpt-5.5"].long_context_threshold, 272000);
  assert.equal(pricing.cx["gpt-5.4"].long_context_threshold, 272000);

  const shortCost = computeCostFromPricing(pricing.cx["gpt-5.4"], {
    input: 272000,
    cached_tokens: 72000,
    output: 1000,
    reasoning_tokens: 500,
  });
  assert.ok(Math.abs(shortCost - 0.5405) < 1e-12);

  const longCost = computeCostFromPricing(pricing.cx["gpt-5.4"], {
    input: 300000,
    cached_tokens: 100000,
    output: 1000,
    reasoning_tokens: 500,
  });
  assert.ok(Math.abs(longCost - 1.08375) < 1e-12);
});
