type ForwardingKeywordLane = "claude-oauth-prefixed";

type ForwardingKeywordRule = {
  match: string;
  replace: string;
};

type ForwardingTagRule = {
  open: string;
  openReplacement: string;
  close: string;
  closeReplacement: string;
};

type ForwardingKeywordRules = {
  toolNames: ForwardingKeywordRule[];
  text: ForwardingKeywordRule[];
  tags: ForwardingTagRule[];
};

type ForwardingKeywordConfig = Record<ForwardingKeywordLane, ForwardingKeywordRules>;

export const DEFAULT_FORWARDING_KEYWORD_CONFIG: ForwardingKeywordConfig = {
  "claude-oauth-prefixed": {
    toolNames: [
      { match: "background_output", replace: "background_result" },
      { match: "background_cancel", replace: "background_stop" },
    ],
    text: [
      { match: "background_output", replace: "background_result" },
      { match: "background_cancel", replace: "background_stop" },
    ],
    tags: [
      {
        open: "<directories>",
        openReplacement: "directories:\n",
        close: "</directories>",
        closeReplacement: "",
      },
    ],
  },
};

let forwardingKeywordConfig: ForwardingKeywordConfig = cloneForwardingKeywordConfig(
  DEFAULT_FORWARDING_KEYWORD_CONFIG
);

function cloneForwardingKeywordConfig(config: ForwardingKeywordConfig): ForwardingKeywordConfig {
  return JSON.parse(JSON.stringify(config)) as ForwardingKeywordConfig;
}

function normalizeKeywordRule(rule: unknown): ForwardingKeywordRule | null {
  if (!rule || typeof rule !== "object") return null;
  const candidate = rule as Record<string, unknown>;
  if (typeof candidate.match !== "string" || typeof candidate.replace !== "string") return null;
  return { match: candidate.match, replace: candidate.replace };
}

function normalizeTagRule(rule: unknown): ForwardingTagRule | null {
  if (!rule || typeof rule !== "object") return null;
  const candidate = rule as Record<string, unknown>;
  if (
    typeof candidate.open !== "string" ||
    typeof candidate.openReplacement !== "string" ||
    typeof candidate.close !== "string" ||
    typeof candidate.closeReplacement !== "string"
  ) {
    return null;
  }

  return {
    open: candidate.open,
    openReplacement: candidate.openReplacement,
    close: candidate.close,
    closeReplacement: candidate.closeReplacement,
  };
}

export function normalizeForwardingKeywordConfig(value: unknown): ForwardingKeywordConfig {
  const normalized = cloneForwardingKeywordConfig(DEFAULT_FORWARDING_KEYWORD_CONFIG);
  if (!value || typeof value !== "object") return normalized;

  const rawConfig = value as Record<string, unknown>;
  for (const lane of Object.keys(DEFAULT_FORWARDING_KEYWORD_CONFIG) as ForwardingKeywordLane[]) {
    const rawLane = rawConfig[lane];
    if (!rawLane || typeof rawLane !== "object") continue;

    const rawLaneConfig = rawLane as Record<string, unknown>;
    const toolNames = Array.isArray(rawLaneConfig.toolNames)
      ? rawLaneConfig.toolNames.map(normalizeKeywordRule).filter(Boolean)
      : normalized[lane].toolNames;
    const text = Array.isArray(rawLaneConfig.text)
      ? rawLaneConfig.text.map(normalizeKeywordRule).filter(Boolean)
      : normalized[lane].text;
    const tags = Array.isArray(rawLaneConfig.tags)
      ? rawLaneConfig.tags.map(normalizeTagRule).filter(Boolean)
      : normalized[lane].tags;

    normalized[lane] = {
      toolNames,
      text,
      tags,
    };
  }

  return normalized;
}

export function setForwardingKeywordConfig(config: unknown) {
  forwardingKeywordConfig = normalizeForwardingKeywordConfig(config);
}

export function getForwardingKeywordConfig(): ForwardingKeywordConfig {
  return cloneForwardingKeywordConfig(forwardingKeywordConfig);
}

export function getDefaultForwardingKeywordConfig(): ForwardingKeywordConfig {
  return cloneForwardingKeywordConfig(DEFAULT_FORWARDING_KEYWORD_CONFIG);
}

export function rewriteForwardedTextForLane(lane: ForwardingKeywordLane, text: string): string {
  if (!text) return text;

  let rewrittenText = text;
  const rules = forwardingKeywordConfig[lane];

  for (const rule of rules.text) {
    rewrittenText = rewrittenText.replaceAll(rule.match, rule.replace);
  }

  for (const tagRule of rules.tags) {
    rewrittenText = rewrittenText
      .replaceAll(tagRule.open, tagRule.openReplacement)
      .replaceAll(tagRule.close, tagRule.closeReplacement);
  }

  return rewrittenText;
}

export function rewriteForwardedToolNameForLane(
  lane: ForwardingKeywordLane,
  toolName: string
): string {
  const rules = forwardingKeywordConfig[lane];
  const matchingRule = rules.toolNames.find((rule) => rule.match === toolName);
  return matchingRule?.replace ?? toolName;
}

export function getForwardingKeywordRulesForLane(
  lane: ForwardingKeywordLane
): ForwardingKeywordRules {
  return cloneForwardingKeywordConfig(forwardingKeywordConfig)[lane];
}

export type {
  ForwardingKeywordConfig,
  ForwardingKeywordLane,
  ForwardingKeywordRule,
  ForwardingKeywordRules,
  ForwardingTagRule,
};
