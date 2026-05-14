/**
 * Centralized specifications for AI Models.
 * Contains maximum token caps and thinking budgets to prevent API errors
 * when clients request more than the model supports.
 */

export type ThinkingMode = "enabled" | "adaptive" | "disabled";
export type ThinkingDisplay = "summarized" | "omitted";

export interface ModelSpec {
  maxOutputTokens: number;
  contextWindow?: number;
  defaultThinkingBudget?: number;
  thinkingBudgetCap?: number;
  thinkingOverhead?: number; // buffer de tokens para thinking
  adaptiveMaxTokens?: number; // tokens disponíveis para output quando thinking ativo
  aliases?: string[]; // IDs alternativos para este modelo
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  // Opus 4.7+ model constraints
  supportedThinkingModes?: ThinkingMode[]; // which thinking types the model accepts
  supportedEfforts?: string[]; // valid effort levels for this model
  defaultThinkingDisplay?: ThinkingDisplay; // default display mode for thinking blocks
  rejectsSamplingParams?: boolean; // true if non-default temperature/top_p/top_k → 400
}

export const MODEL_SPECS: Record<string, ModelSpec> = {
  // ── OpenAI Codex GPT 5.5 ───────────────────────────────────────
  "gpt-5.5": {
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: [
      "gpt5.5",
      "gpt-5.5-xhigh",
      "gpt-5.5-high",
      "gpt-5.5-medium",
      "gpt-5.5-low",
      "gpt-5.5-none",
    ],
  },
  "gpt-5.5-pro": {
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gpt5.5-pro"],
  },

  // ── OpenAI/Codex GPT 5.x ───────────────────────────────────────
  "gpt-5.4": {
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gpt5.4"],
  },
  "gpt-5.4-pro": {
    maxOutputTokens: 128000,
    contextWindow: 1050000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gpt5.4-pro"],
  },
  "gpt-5.4-mini": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gpt5.4-mini"],
  },
  "gpt-5.4-nano": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gpt5.4-nano"],
  },
  "gpt-5.3-codex-spark": {
    maxOutputTokens: 32000,
    contextWindow: 128000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: [
      "gpt-5.3-codex-spark-xhigh",
      "gpt-5.3-codex-spark-high",
      "gpt-5.3-codex-spark-medium",
      "gpt-5.3-codex-spark-low",
      "gpt-5.3-codex-spark-none",
    ],
  },
  "gpt-5.3-codex": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: [
      "gpt-5.3-codex-xhigh",
      "gpt-5.3-codex-high",
      "gpt-5.3-codex-medium",
      "gpt-5.3-codex-low",
      "gpt-5.3-codex-none",
    ],
  },
  "gpt-5.3-chat-latest": {
    maxOutputTokens: 16384,
    contextWindow: 128000,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5.2-codex": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5.2": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5.2-chat-latest": {
    maxOutputTokens: 16384,
    contextWindow: 128000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5.2-pro": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5.1": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5.1-chat-latest": {
    maxOutputTokens: 16384,
    contextWindow: 128000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5.1-codex": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gpt-5.1-codex-max"],
  },
  "gpt-5.1-codex-mini": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5-chat-latest": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5-mini": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5-nano": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5-pro": {
    maxOutputTokens: 272000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5-codex": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },
  "gpt-5-codex-mini": {
    maxOutputTokens: 128000,
    contextWindow: 400000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
  },

  // ── Gemini 3 Flash series ───────────────────────────────────────
  "gemini-3-flash": {
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    defaultThinkingBudget: 8192,
    thinkingBudgetCap: 32768,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite"],
  },

  // ── Gemini 3 Pro series ─────────────────────────────────────────
  "gemini-3-pro-preview": {
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    defaultThinkingBudget: 24576,
    thinkingBudgetCap: 32768,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gemini-3-pro"],
  },

  // ── Gemini 3.1 Flash Image ──────────────────────────────────────
  "gemini-3.1-flash-image-preview": {
    maxOutputTokens: 32768,
    contextWindow: 131072,
    defaultThinkingBudget: 8192,
    thinkingBudgetCap: 32768,
    supportsThinking: true,
    supportsTools: false,
    supportsVision: true,
    aliases: ["gemini-3.1-flash-image"],
  },

  // ── Gemini 3.1 Pro High ─────────────────────────────────────────
  "gemini-3.1-pro-high": {
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    defaultThinkingBudget: 24576,
    thinkingBudgetCap: 32768,
    thinkingOverhead: 1000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gemini-3-pro-high", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"],
  },

  // ── Gemini 3.1 Pro Low ──────────────────────────────────────────
  "gemini-3.1-pro-low": {
    maxOutputTokens: 65536,
    contextWindow: 1048576,
    defaultThinkingBudget: 8192,
    thinkingBudgetCap: 16000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    aliases: ["gemini-3-pro-low"],
  },

  // ── Claude Opus 4.6 ─────────────────────────────────────────────
  "claude-opus-4-6": {
    maxOutputTokens: 128000,
    contextWindow: 1000000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 128000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["enabled", "adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "max"],
    defaultThinkingDisplay: "summarized",
    aliases: [
      "claude-opus-4.6",
      "claude-opus-4-6-20251031",
      "claude-opus-4-6-thinking",
      "claude-opus-4.6-thinking",
    ],
  },

  // ── Claude Opus 4.7 ─────────────────────────────────────────────
  "claude-opus-4-7": {
    maxOutputTokens: 128000,
    contextWindow: 1000000,
    defaultThinkingBudget: 0,
    thinkingBudgetCap: 0,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultThinkingDisplay: "omitted",
    rejectsSamplingParams: true,
    aliases: ["claude-opus-4.7", "claude-opus-4-7-thinking", "claude-opus-4.7-thinking"],
  },

  // ── Claude Sonnet 4.6 ───────────────────────────────────────────
  "claude-sonnet-4-6": {
    maxOutputTokens: 64000,
    contextWindow: 1000000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 64000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["enabled", "adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "max"],
    aliases: [
      "claude-sonnet-4.6",
      "claude-sonnet-4-6-20251031",
      "claude-sonnet-4-6-thinking",
      "claude-sonnet-4.6-thinking",
    ],
  },

  // ── Claude Sonnet 4.5 ───────────────────────────────────────────
  "claude-sonnet-4-5": {
    maxOutputTokens: 64000,
    contextWindow: 200000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 64000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["enabled", "adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "max"],
    aliases: [
      "claude-sonnet-4.5",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-5@20251101",
      "claude-sonnet-4-5-thinking",
      "claude-sonnet-4.5-thinking",
    ],
  },

  // ── Claude Sonnet 4.0 ───────────────────────────────────────────
  "claude-sonnet-4": {
    maxOutputTokens: 64000,
    contextWindow: 200000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 64000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["enabled", "adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "max"],
    aliases: [
      "claude-sonnet-4-0",
      "claude-sonnet-4.0",
      "claude-sonnet-4-20250514",
      "claude-sonnet-4-thinking",
    ],
  },

  // ── Claude Haiku 4.5 ────────────────────────────────────────────
  "claude-haiku-4-5": {
    maxOutputTokens: 64000,
    contextWindow: 200000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 64000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["enabled", "adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "max"],
    aliases: ["claude-haiku-4.5", "claude-haiku-4-5-20251001"],
  },

  // ── Claude Opus 4.1 ─────────────────────────────────────────────
  "claude-opus-4-1": {
    maxOutputTokens: 32000,
    contextWindow: 200000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 32000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["enabled", "adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "max"],
    aliases: ["claude-opus-4.1", "claude-opus-4-1-20250805"],
  },

  // ── Claude Opus 4.0 ─────────────────────────────────────────────
  "claude-opus-4": {
    maxOutputTokens: 32000,
    contextWindow: 200000,
    defaultThinkingBudget: 10000,
    thinkingBudgetCap: 32000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    supportedThinkingModes: ["enabled", "adaptive", "disabled"],
    supportedEfforts: ["low", "medium", "high", "max"],
    aliases: [
      "claude-opus-4-0",
      "claude-opus-4.0",
      "claude-opus-4-20250514",
      "claude-opus-4-thinking",
    ],
  },

  // Defaults
  __default__: {
    maxOutputTokens: 8192,
  },
};

function getModelSpecLookupIds(modelId: string): string[] {
  const ids = [modelId];
  if (modelId.includes("/")) {
    const lastSegment = modelId.split("/").filter(Boolean).at(-1);
    if (lastSegment) ids.push(lastSegment);
  }
  return [...new Set(ids)];
}

export function getModelSpec(modelId: string): ModelSpec | undefined {
  const lookupIds = getModelSpecLookupIds(modelId);

  for (const lookupId of lookupIds) {
    if (MODEL_SPECS[lookupId]) return MODEL_SPECS[lookupId];
  }

  // Buscas por alias
  for (const [canonical, spec] of Object.entries(MODEL_SPECS)) {
    if (canonical === "__default__") continue;
    if (lookupIds.some((lookupId) => spec.aliases?.includes(lookupId))) return spec;
  }

  // Prefix matching. Check longer keys first so specific IDs like
  // gpt-5.3-codex-spark are not swallowed by gpt-5.3-codex.
  const specsByLongestPrefix = Object.entries(MODEL_SPECS).sort(
    ([left], [right]) => right.length - left.length
  );
  for (const lookupId of lookupIds) {
    for (const [key, spec] of specsByLongestPrefix) {
      if (key !== "__default__" && lookupId.startsWith(key)) return spec;
    }
  }

  return undefined;
}

export function capMaxOutputTokens(modelId: string, requested?: number): number {
  const spec = getModelSpec(modelId);
  const cap = spec?.maxOutputTokens ?? MODEL_SPECS.__default__.maxOutputTokens;
  return requested ? Math.min(requested, cap) : cap;
}

export function getDefaultThinkingBudget(modelId: string): number {
  return getModelSpec(modelId)?.defaultThinkingBudget ?? 0;
}

export function capThinkingBudget(modelId: string, budget: number): number {
  const cap = getModelSpec(modelId)?.thinkingBudgetCap ?? budget;
  return Math.min(budget, cap);
}

export function resolveModelAlias(modelId: string): string {
  const lookupIds = getModelSpecLookupIds(modelId);
  for (const [canonical, spec] of Object.entries(MODEL_SPECS)) {
    if (spec.aliases?.some((alias) => lookupIds.includes(alias))) return canonical;
  }
  return modelId;
}

export function isAdaptiveOnlyModel(modelId: string): boolean {
  const spec = getModelSpec(modelId);
  if (!spec?.supportedThinkingModes) return false;
  return (
    spec.supportedThinkingModes.includes("adaptive") &&
    !spec.supportedThinkingModes.includes("enabled")
  );
}

export function getDefaultThinkingDisplay(modelId: string): ThinkingDisplay | undefined {
  return getModelSpec(modelId)?.defaultThinkingDisplay;
}

export function rejectsSamplingParams(modelId: string): boolean {
  return getModelSpec(modelId)?.rejectsSamplingParams === true;
}

export function isEffortSupported(modelId: string, effort: string): boolean {
  const spec = getModelSpec(modelId);
  if (!spec?.supportedEfforts) return true;
  return spec.supportedEfforts.includes(effort.toLowerCase());
}

export function downgradeEffort(modelId: string, effort: string): string {
  const normalized = effort.toLowerCase();
  if (isEffortSupported(modelId, normalized)) return normalized;
  if (normalized === "xhigh") return "max";
  return normalized;
}
