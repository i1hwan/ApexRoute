export interface LowQuotaBypassSettings {
  default?: boolean;
  byProvider?: Record<string, boolean>;
}

export function resolveLowQuotaBypass(
  settings: LowQuotaBypassSettings | null | undefined,
  provider: string | null
): boolean {
  if (!settings || typeof settings !== "object") return false;

  if (provider && settings.byProvider && typeof settings.byProvider === "object") {
    const providerValue = settings.byProvider[provider];
    if (typeof providerValue === "boolean") return providerValue;
  }

  return typeof settings.default === "boolean" ? settings.default : false;
}
