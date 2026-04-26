// Maps a requested model id to its required Anthropic weekly-quota window.
// When this returns null, no model-specific weekly window is required and only
// the generic "weekly" window applies to scoring.
//
// The patterns here intentionally match Anthropic's quota window labels
// ("weekly Sonnet (7d)", "weekly Omelette (7d)") rather than user-facing model
// names; getQuotaWindowStatus() handles label normalization.

const MODEL_REQUIRED_WEEKLY_WINDOW: Array<{ pattern: RegExp; window: string }> = [
  { pattern: /^claude-opus(-|$)|claude-.*-opus(-|$)|claude-opus-\d/i, window: "weekly Omelette" },
  {
    pattern: /^claude-sonnet(-|$)|claude-.*-sonnet(-|$)|claude-sonnet-\d/i,
    window: "weekly Sonnet",
  },
];

export function mapModelToRequiredWeekly(modelHint: string | null | undefined): string | null {
  if (!modelHint) return null;
  for (const { pattern, window } of MODEL_REQUIRED_WEEKLY_WINDOW) {
    if (pattern.test(modelHint)) return window;
  }
  return null;
}
