export type ToolArgumentMode = "stream-normalized" | "buffered-final";

export type ForwardingLane = "claude-oauth-prefixed";

export interface ToolArgumentModeSettings {
  default?: ToolArgumentMode;
  byProvider?: Record<string, ToolArgumentMode>;
  byLane?: Partial<Record<ForwardingLane, ToolArgumentMode>>;
}

const VALID_MODES = new Set<ToolArgumentMode>(["stream-normalized", "buffered-final"]);
const VALID_LANES = new Set<ForwardingLane>(["claude-oauth-prefixed"]);

function isValidMode(value: unknown): value is ToolArgumentMode {
  return typeof value === "string" && VALID_MODES.has(value as ToolArgumentMode);
}

export function isValidForwardingLane(value: unknown): value is ForwardingLane {
  return typeof value === "string" && VALID_LANES.has(value as ForwardingLane);
}

export function resolveToolArgumentMode(
  settings: ToolArgumentModeSettings | null | undefined,
  provider: string | null,
  forwardingLane: ForwardingLane | null
): ToolArgumentMode {
  if (!settings || typeof settings !== "object") return "stream-normalized";

  if (forwardingLane && settings.byLane && typeof settings.byLane === "object") {
    const laneValue = settings.byLane[forwardingLane];
    if (isValidMode(laneValue)) return laneValue;
  }

  if (provider && settings.byProvider && typeof settings.byProvider === "object") {
    const providerValue = settings.byProvider[provider];
    if (isValidMode(providerValue)) return providerValue;
  }

  if (isValidMode(settings.default)) return settings.default;

  return "stream-normalized";
}
