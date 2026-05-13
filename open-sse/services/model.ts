import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../config/providerModels.ts";
import { resolveWildcardAlias } from "./wildcardRouter.ts";

// Derive alias→provider mapping from the single source of truth (PROVIDER_ID_TO_ALIAS)
// This prevents the two maps from drifting out of sync
const ALIAS_TO_PROVIDER_ID = {};
for (const [id, alias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
  if (ALIAS_TO_PROVIDER_ID[alias]) {
    console.log(
      `[MODEL] Warning: alias "${alias}" maps to both "${ALIAS_TO_PROVIDER_ID[alias]}" and "${id}". Using "${id}".`
    );
  }
  ALIAS_TO_PROVIDER_ID[alias] = id;
}

// Provider-scoped legacy model aliases. Used to normalize provider/model inputs
// and keep backward compatibility when upstream IDs change.
const PROVIDER_MODEL_ALIASES = {
  codex: {
    "gpt5.5": "gpt-5.5",
    "gpt5.5-pro": "gpt-5.5-pro",
    "gpt5.5-xhigh": "gpt-5.5-xhigh",
    "gpt5.5-high": "gpt-5.5-high",
    "gpt5.5-medium": "gpt-5.5-medium",
    "gpt5.5-low": "gpt-5.5-low",
    "gpt5.5-none": "gpt-5.5-none",
    "gpt5.4": "gpt-5.4",
    "gpt5.4-pro": "gpt-5.4-pro",
    "gpt5.4-mini": "gpt-5.4-mini",
    "gpt5.4-nano": "gpt-5.4-nano",
  },
  github: {
    "claude-4.5-opus": "claude-opus-4.6",
    "claude-opus-4.5": "claude-opus-4.6",
    "gemini-3-pro": "gemini-3.1-pro-preview",
    "gemini-3-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3-flash": "gemini-3-flash-preview",
    "raptor-mini": "oswe-vscode-prime",
  },
  gemini: {
    "gemini-3.1-pro-preview": "gemini-3.1-pro",
    "gemini-3-1-pro": "gemini-3.1-pro",
  },
  "gemini-cli": {
    "gemini-3.1-pro-preview": "gemini-3.1-pro",
    "gemini-3-1-pro": "gemini-3.1-pro",
  },
  nvidia: {
    "gpt-oss-120b": "openai/gpt-oss-120b",
    "nvidia/gpt-oss-120b": "openai/gpt-oss-120b",
  },
  antigravity: {},
};

const CODEX_PREFERRED_BARE_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.5-xhigh",
  "gpt-5.5-high",
  "gpt-5.5-medium",
  "gpt-5.5-low",
  "gpt-5.5-none",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.3-codex-xhigh",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex-medium",
  "gpt-5.3-codex-low",
  "gpt-5.3-codex-none",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex-spark-xhigh",
  "gpt-5.3-codex-spark-high",
  "gpt-5.3-codex-spark-medium",
  "gpt-5.3-codex-spark-low",
  "gpt-5.3-codex-spark-none",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-mini-high",
  "gpt-5.1-codex-max",
  "gpt-5-codex",
  "gpt-5-codex-mini",
]);

const OPENAI_PREFERRED_BARE_MODELS = new Set([
  "gpt-5",
  "gpt-5-chat-latest",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1-chat-latest",
  "gpt-5.2-chat-latest",
  "gpt-5.2-pro",
  "gpt-5.3-chat-latest",
]);
const OPENAI_PREFERRED_BARE_MODEL_PATTERNS = [/^gpt-4(?:\.|o|-|$)/i, /^gpt-3\.5-/i];

function isOpenAIPreferredBareModel(modelId) {
  return (
    OPENAI_PREFERRED_BARE_MODELS.has(modelId) ||
    OPENAI_PREFERRED_BARE_MODEL_PATTERNS.some((pattern) => pattern.test(modelId))
  );
}

const ANTHROPIC_PREFERRED_BARE_MODELS = new Set(["claude-opus-4-7"]);

// Reverse index: modelId -> providerIds that expose this model
const MODEL_TO_PROVIDERS = new Map();
for (const [aliasOrId, models] of Object.entries(PROVIDER_MODELS)) {
  const providerId = ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
  for (const modelEntry of models || []) {
    const modelId = modelEntry?.id;
    if (!modelId) continue;
    const providers = MODEL_TO_PROVIDERS.get(modelId) || [];
    if (!providers.includes(providerId)) {
      providers.push(providerId);
      MODEL_TO_PROVIDERS.set(modelId, providers);
    }
  }
}

/**
 * Resolve provider alias to provider ID
 */
export function resolveProviderAlias(aliasOrId) {
  return ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
}

/**
 * Resolve provider-specific legacy model alias to canonical model ID.
 */
export function resolveProviderModelAlias(providerOrAlias, modelId) {
  if (!modelId || typeof modelId !== "string") return modelId;
  const providerId = resolveProviderAlias(providerOrAlias);
  const aliases = PROVIDER_MODEL_ALIASES[providerId];
  return aliases?.[modelId] || modelId;
}

function findProviderModelAliasMatches(modelId) {
  if (!modelId || typeof modelId !== "string") return [];

  return Object.entries(PROVIDER_MODEL_ALIASES)
    .map(([provider, aliases]) => {
      const canonicalModel = aliases?.[modelId];
      return canonicalModel ? { provider, model: canonicalModel } : null;
    })
    .filter(Boolean);
}

/**
 * Parse model string: "alias/model" or "provider/model" or just alias
 * Supports [1m] suffix for extended 1M context window (e.g. "claude-sonnet-4-6[1m]")
 */
export function parseModel(modelStr) {
  if (!modelStr) {
    return {
      provider: null,
      model: null,
      isAlias: false,
      providerAlias: null,
      extendedContext: false,
    };
  }

  // Sanitize: reject strings with path traversal or control characters
  if (/\.\.[\/\\]/.test(modelStr) || /[\x00-\x1f]/.test(modelStr)) {
    console.log(`[MODEL] Warning: rejected malformed model string: "${modelStr.substring(0, 50)}"`);
    return {
      provider: null,
      model: null,
      isAlias: false,
      providerAlias: null,
      extendedContext: false,
    };
  }

  // Extract [1m] suffix before parsing provider/model
  let extendedContext = false;
  let cleanStr = modelStr;
  if (cleanStr.endsWith("[1m]")) {
    extendedContext = true;
    cleanStr = cleanStr.slice(0, -4);
  }
  cleanStr = cleanStr.trim();

  // Check if standard format: provider/model or alias/model
  if (cleanStr.includes("/")) {
    const firstSlash = cleanStr.indexOf("/");
    const providerOrAlias = cleanStr.slice(0, firstSlash).trim();
    const model = cleanStr.slice(firstSlash + 1).trim();
    const provider = resolveProviderAlias(providerOrAlias);
    return { provider, model, isAlias: false, providerAlias: providerOrAlias, extendedContext };
  }

  // Alias format (model alias, not provider alias)
  return { provider: null, model: cleanStr, isAlias: true, providerAlias: null, extendedContext };
}

/**
 * Resolve model alias from aliases object
 * Format: { "alias": "provider/model" }
 */
export function resolveModelAliasFromMap(alias, aliases) {
  if (!aliases) return null;

  // Check if alias exists
  const resolved = aliases[alias];
  if (!resolved) return null;

  // Resolved value is "provider/model" format
  if (typeof resolved === "string" && resolved.includes("/")) {
    const firstSlash = resolved.indexOf("/");
    const providerOrAlias = resolved.slice(0, firstSlash);
    return {
      provider: resolveProviderAlias(providerOrAlias),
      model: resolved.slice(firstSlash + 1),
    };
  }

  // Or object { provider, model }
  if (typeof resolved === "object" && resolved.provider && resolved.model) {
    return {
      provider: resolveProviderAlias(resolved.provider),
      model: resolved.model,
    };
  }

  return null;
}

/**
 * Get full model info (parse or resolve)
 * @param {string} modelStr - Model string
 * @param {object|function} aliasesOrGetter - Aliases object or async function to get aliases
 */
export async function getModelInfoCore(modelStr, aliasesOrGetter) {
  const parsed = parseModel(modelStr);
  const { extendedContext } = parsed;

  if (!parsed.isAlias) {
    const canonicalModel = resolveProviderModelAlias(parsed.provider, parsed.model);
    return {
      provider: parsed.provider,
      model: canonicalModel,
      extendedContext,
    };
  }

  // Get aliases (from object or function)
  const aliases = typeof aliasesOrGetter === "function" ? await aliasesOrGetter() : aliasesOrGetter;

  // Resolve exact alias
  const resolved = resolveModelAliasFromMap(parsed.model, aliases);
  if (resolved) {
    const canonicalModel = resolveProviderModelAlias(resolved.provider, resolved.model);
    return {
      provider: resolved.provider,
      model: canonicalModel,
      extendedContext,
    };
  }

  // T13: Try wildcard alias (glob patterns like "claude-sonnet-*" → "anthropic/claude-sonnet-4-...")
  if (aliases && typeof aliases === "object") {
    const aliasEntries = Object.entries(aliases).map(([pattern, target]) => ({ pattern, target }));
    const wildcardMatch = resolveWildcardAlias(parsed.model, aliasEntries);
    if (wildcardMatch) {
      const target = wildcardMatch.target as string;
      if (target.includes("/")) {
        const firstSlash = target.indexOf("/");
        const providerOrAlias = target.slice(0, firstSlash);
        const targetModel = target.slice(firstSlash + 1);
        const provider = resolveProviderAlias(providerOrAlias);
        const canonicalModel = resolveProviderModelAlias(provider, targetModel);
        return {
          provider,
          model: canonicalModel,
          extendedContext,
          wildcardPattern: wildcardMatch.pattern,
        };
      }
    }
  }

  const modelId = parsed.model;
  const providerAliasMatches = findProviderModelAliasMatches(modelId);
  if (providerAliasMatches.length === 1) {
    return {
      provider: providerAliasMatches[0].provider,
      model: providerAliasMatches[0].model,
      extendedContext,
    };
  }
  if (providerAliasMatches.length > 1) {
    const aliasesForHint = providerAliasMatches.map(
      (match) => PROVIDER_ID_TO_ALIAS[match.provider] || match.provider
    );
    const hints = providerAliasMatches
      .slice(0, 2)
      .map((match) => `${PROVIDER_ID_TO_ALIAS[match.provider] || match.provider}/${modelId}`);
    const message = `Ambiguous model alias '${modelId}'. Use provider/model prefix (ex: ${hints.join(" or ")}).`;
    console.warn(`[MODEL] ${message} Candidates: ${aliasesForHint.join(", ")}`);
    return {
      provider: null,
      model: modelId,
      errorType: "ambiguous_model_alias",
      errorMessage: message,
      candidateProviders: providerAliasMatches.map((match) => match.provider),
      candidateAliases: aliasesForHint,
    };
  }

  const providers = MODEL_TO_PROVIDERS.get(modelId) || [];

  if (providers.includes("codex") && CODEX_PREFERRED_BARE_MODELS.has(modelId)) {
    return {
      provider: "codex",
      model: resolveProviderModelAlias("codex", modelId),
      extendedContext,
    };
  }

  // Preserve historical behavior for classic OpenAI chat model IDs.
  if (providers.includes("openai") && isOpenAIPreferredBareModel(modelId)) {
    return {
      provider: "openai",
      model: modelId,
      extendedContext,
    };
  }

  if (providers.includes("anthropic") && ANTHROPIC_PREFERRED_BARE_MODELS.has(modelId)) {
    return {
      provider: "anthropic",
      model: modelId,
      extendedContext,
    };
  }

  if (providers.length === 1) {
    const provider = providers[0];
    const canonicalModel = resolveProviderModelAlias(provider, modelId);
    return { provider, model: canonicalModel, extendedContext };
  }

  if (providers.length > 1) {
    const aliasesForHint = providers.map((p) => PROVIDER_ID_TO_ALIAS[p] || p);
    const hints = aliasesForHint.slice(0, 2).map((alias) => `${alias}/${modelId}`);
    const message = `Ambiguous model '${modelId}'. Use provider/model prefix (ex: ${hints.join(" or ")}).`;
    console.warn(`[MODEL] ${message} Candidates: ${aliasesForHint.join(", ")}`);
    return {
      provider: null,
      model: modelId,
      errorType: "ambiguous_model",
      errorMessage: message,
      candidateProviders: providers,
      candidateAliases: aliasesForHint,
    };
  }

  // Fallback: infer provider from known model name prefixes before defaulting to openai
  // FIX #73: Models like claude-haiku-4-5-20251001 sent without provider prefix
  // would incorrectly route to OpenAI. Use heuristic prefix detection first.
  if (/^claude-/i.test(modelId)) {
    // Claude models → Anthropic provider (canonical source for Claude models)
    return { provider: "anthropic", model: modelId, extendedContext };
  }
  if (/^gemini-/i.test(modelId) || /^gemma-/i.test(modelId)) {
    // Gemini/Gemma models → Gemini provider
    return { provider: "gemini", model: modelId, extendedContext };
  }

  // Last resort: treat as openai model
  return {
    provider: "openai",
    model: modelId,
    extendedContext,
  };
}
