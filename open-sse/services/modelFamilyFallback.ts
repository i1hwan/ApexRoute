/**
 * Model Family Fallback — Phase 2 Feature (T5)
 *
 * Implements two-phase model resolution:
 *   Phase 1 (static, pre-request): already done by model.ts alias resolution.
 *   Phase 2 (dynamic, post-error): when a provider returns a model-not-available
 *   error (400 with specific message or 404), we try sibling models within the
 *   same "family" before giving up.
 *
 * Inspired by Antigravity Manager's account-aware dynamic model remapping
 * (commit 6cea566, Mar 8 2026).
 */

import { getTokenLimit } from "./contextManager.ts";
import { parseModel } from "./model.ts";
import { CONTEXT_OVERFLOW_REGEX } from "./errorClassifier.ts";
import {
  getModelTargetFormat,
  isValidModel,
  PROVIDER_ID_TO_ALIAS,
} from "../config/providerModels.ts";

// ── Model Family Definitions ─────────────────────────────────────────────────

/**
 * Ordered candidate lists per model family.
 * First entry is the most preferred; fallback proceeds in order.
 */
const MODEL_FAMILIES: Record<string, string[]> = {
  // Gemini 3 / 3.1 Pro family — ordered by preference
  "gemini-3-pro": [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-high",
    "gemini-3-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low",
  ],
  "gemini-3.1-pro": [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-high",
    "gemini-3-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low",
  ],
  "gemini-3-pro-preview": [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-high",
    "gemini-3.1-pro-high",
    "gemini-3-pro-low",
    "gemini-3.1-pro-low",
  ],
  "gemini-3.1-pro-preview": [
    "gemini-3-pro-preview",
    "gemini-3.1-pro-high",
    "gemini-3-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low",
  ],
  "gemini-3-pro-high": [
    "gemini-3.1-pro-high",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-low",
    "gemini-3.1-pro-low",
  ],
  "gemini-3.1-pro-high": [
    "gemini-3-pro-high",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-low",
    "gemini-3-pro-low",
  ],

  // Gemini 2.5 Pro family
  "gemini-2.5-pro": ["gemini-2.5-pro-preview-06-05", "gemini-2.5-pro-exp-03-25"],
  "gemini-2.5-pro-preview-06-05": ["gemini-2.5-pro", "gemini-2.5-pro-exp-03-25"],

  // Claude Opus family
  "claude-opus-4-7": ["claude-opus-4-6", "claude-sonnet-4-6"],
  "claude-opus-4-6": ["claude-opus-4-7", "claude-opus-4-6-thinking", "claude-sonnet-4-6"],
  "claude-opus-4-6-thinking": ["claude-opus-4-7", "claude-opus-4-6"],

  // Claude Sonnet family
  "claude-sonnet-4-6": ["claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514"],
  "claude-sonnet-4-5-20250929": ["claude-sonnet-4-6", "claude-sonnet-4-20250514"],

  // GPT-5 family
  "gpt-5": ["gpt-5-mini", "gpt-4o"],
  "gpt-5.1": ["gpt-5.1-codex-mini", "gpt-5", "gpt-4o"],
};

const GPT_5_EFFORT_SUFFIXES = ["xhigh", "high", "medium", "low", "none"];

function effortVariants(baseModel: string): string[] {
  return GPT_5_EFFORT_SUFFIXES.map((suffix) => `${baseModel}-${suffix}`);
}

function registerModelFamily(model: string, candidates: string[]): void {
  MODEL_FAMILIES[model] = candidates.filter((candidate) => candidate !== model);
}

function registerEffortModelFamily(baseModel: string, candidates: string[]): void {
  for (const variant of effortVariants(baseModel)) {
    registerModelFamily(variant, [baseModel, ...candidates]);
  }
}

const GPT_5_5_FAMILY = [
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  ...effortVariants("gpt-5.5"),
];
registerModelFamily("gpt-5.5", GPT_5_5_FAMILY);
registerModelFamily("gpt-5.5-pro", ["gpt-5.5", "gpt-5.4-pro", "gpt-5.4", "gpt-5.3-codex"]);
registerEffortModelFamily("gpt-5.5", GPT_5_5_FAMILY);

registerModelFamily("gpt-5.4", [
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
]);
registerModelFamily("gpt-5.4-pro", ["gpt-5.4", "gpt-5.5-pro", "gpt-5.5", "gpt-5.3-codex"]);
registerModelFamily("gpt-5.4-mini", ["gpt-5.4", "gpt-5.3-codex-spark", "gpt-5.2-codex"]);
registerModelFamily("gpt-5.4-nano", ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.2-codex"]);

const GPT_5_3_CODEX_FAMILY = [
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.4",
  ...effortVariants("gpt-5.3-codex"),
];
registerModelFamily("gpt-5.3-codex", GPT_5_3_CODEX_FAMILY);
registerEffortModelFamily("gpt-5.3-codex", GPT_5_3_CODEX_FAMILY);

const GPT_5_3_CODEX_SPARK_FAMILY = [
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5.2-codex",
  ...effortVariants("gpt-5.3-codex-spark"),
];
registerModelFamily("gpt-5.3-codex-spark", GPT_5_3_CODEX_SPARK_FAMILY);
registerEffortModelFamily("gpt-5.3-codex-spark", GPT_5_3_CODEX_SPARK_FAMILY);

registerModelFamily("gpt-5.2", ["gpt-5.2-codex", "gpt-5.1", "gpt-5.4-mini", "gpt-5"]);
registerModelFamily("gpt-5.2-codex", [
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.1-codex",
  "gpt-5-codex",
]);
registerModelFamily("gpt-5.1", ["gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5", "gpt-5.2"]);
registerModelFamily("gpt-5.1-codex", [
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2-codex",
  "gpt-5-codex",
  "gpt-5.1",
]);
registerModelFamily("gpt-5.1-codex-mini", [
  "gpt-5.1-codex",
  "gpt-5-mini",
  "gpt-5-codex-mini",
  "gpt-5.2-codex",
]);
registerModelFamily("gpt-5.1-codex-max", ["gpt-5.1-codex", "gpt-5.2-codex", "gpt-5-codex"]);
registerModelFamily("gpt-5-codex", ["gpt-5.1-codex", "gpt-5-codex-mini", "gpt-5.2-codex", "gpt-5"]);
registerModelFamily("gpt-5-codex-mini", [
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5.1-codex-mini",
  "gpt-5.2-codex",
]);
registerModelFamily("gpt-5", ["gpt-5-mini", "gpt-4o"]);
registerModelFamily("gpt-5-mini", ["gpt-5", "gpt-5.1-codex-mini", "gpt-5-codex-mini", "gpt-5.2"]);

// ── Error Detection ──────────────────────────────────────────────────────────

/**
 * Error message fragments that indicate the requested model is unavailable
 * for the current account/provider, as opposed to a transient error.
 */
const MODEL_UNAVAILABLE_FRAGMENTS = [
  "model not found",
  "model_not_found",
  "model not available",
  "model is not available",
  "no such model",
  "unsupported model",
  "unknown model",
  "this model does not exist",
  "invalid model",
  "model not supported",
  "does not support",
  "not enabled for",
  "access to model",
  "improperly formed request", // Kiro 400 (model unavailable)
];

/**
 * Returns true if the HTTP status + error message indicates the model
 * itself is not available, not a transient server error.
 */
export function isModelUnavailableError(status: number, errorMessage: string): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 403) return false;

  const msg = errorMessage.toLowerCase();
  return MODEL_UNAVAILABLE_FRAGMENTS.some((fragment) => msg.includes(fragment));
}

export function isContextOverflowError(status: number, errorMessage: string): boolean {
  if (status !== 400) return false;
  return CONTEXT_OVERFLOW_REGEX.test(errorMessage);
}

// ── Fallback Resolution ──────────────────────────────────────────────────────

/**
 * Get the next fallback model from the same family.
 *
 * @param currentModel  The model that just failed
 * @param triedModels   Set of model IDs already tried (to avoid cycles)
 * @param providerHint  Provider ID/alias for same-provider fallback filtering
 * @returns             Next model to try, or null if family exhausted
 */
export function getNextFamilyFallback(
  currentModel: string,
  triedModels: Set<string>,
  providerHint?: string | null,
  targetFormatHint?: string | null
): string | null {
  const family = MODEL_FAMILIES[currentModel];
  if (!family) return null;

  for (const candidate of family) {
    if (
      !triedModels.has(candidate) &&
      !isSameCodexWireModel(currentModel, candidate, providerHint) &&
      isFallbackCandidateAvailable(candidate, providerHint, targetFormatHint)
    ) {
      return candidate;
    }
  }

  return null; // family exhausted
}

function resolveProviderKey(provider?: string | null): string | null {
  if (!provider) return null;
  return PROVIDER_ID_TO_ALIAS[provider] || provider;
}

function isCodexProvider(providerHint?: string | null): boolean {
  const provider = resolveProviderKey(providerHint);
  return provider === "cx" || provider === "codex";
}

function toCodexWireModel(model: string): string {
  return model.replace(/-(?:xhigh|high|medium|low|none)$/i, "");
}

function isSameCodexWireModel(
  currentModel: string,
  candidate: string,
  providerHint?: string | null
): boolean {
  return (
    isCodexProvider(providerHint) && toCodexWireModel(currentModel) === toCodexWireModel(candidate)
  );
}

function targetFormatMatches(
  provider: string,
  modelId: string,
  targetFormatHint?: string | null
): boolean {
  if (!targetFormatHint) return true;
  const candidateTargetFormat = getModelTargetFormat(provider, modelId);
  if (candidateTargetFormat) return candidateTargetFormat === targetFormatHint;
  return targetFormatHint !== "openai-responses";
}

function isFallbackCandidateAvailable(
  candidate: string,
  providerHint?: string | null,
  targetFormatHint?: string | null
): boolean {
  if (!providerHint) return true;

  const parsed = parseModel(candidate);
  const provider = resolveProviderKey(parsed.provider || parsed.providerAlias || providerHint);
  const modelId = parsed.model || candidate;
  if (!provider || !modelId) return false;

  return (
    isValidModel(provider, modelId) && targetFormatMatches(provider, modelId, targetFormatHint)
  );
}

/**
 * Check if a model belongs to any registered family.
 */
export function isInModelFamily(model: string): boolean {
  return model in MODEL_FAMILIES;
}

/**
 * Get all members of a model's family (including itself).
 */
export function getModelFamily(model: string): string[] {
  const family = MODEL_FAMILIES[model];
  if (!family) return [model];
  return [model, ...family];
}

/**
 * Find a model with larger context window from a list of candidate models.
 * Uses provider-aware effective context limits to compare candidates. This keeps
 * registry safety caps ahead of stale synced public metadata for OAuth providers.
 */
export function findLargerContextModel(
  currentModel: string,
  availableModels: string[],
  providerHint?: string | null,
  targetFormatHint?: string | null
): string | null {
  const currentParsed = parseModel(currentModel);
  const currentProvider =
    currentParsed.provider || currentParsed.providerAlias || providerHint || "unknown";
  const currentModelId = currentParsed.model || currentModel;
  const currentLimit = getTokenLimit(currentProvider, currentModelId) ?? 0;

  let bestModel: string | null = null;
  let bestLimit = currentLimit;

  for (const candidate of availableModels) {
    if (candidate === currentModel) continue;
    const parsed = parseModel(candidate);
    const provider = parsed.provider || parsed.providerAlias || providerHint || "unknown";
    const modelId = parsed.model || candidate;
    if (!isFallbackCandidateAvailable(candidate, providerHint, targetFormatHint)) continue;
    const limit = getTokenLimit(provider, modelId) ?? 0;

    if (limit > bestLimit) {
      bestLimit = limit;
      bestModel = candidate;
    }
  }

  return bestModel;
}
