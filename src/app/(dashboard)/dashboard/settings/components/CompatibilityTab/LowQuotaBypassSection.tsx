"use client";

import { useEffect, useState } from "react";
import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import OverrideTable from "./OverrideTable";

interface LowQuotaBypassSettings {
  default: boolean;
  byProvider: Record<string, boolean>;
}

const ENDPOINT = "/api/settings/low-quota-bypass";

const DEFAULT_STATE: LowQuotaBypassSettings = {
  default: false,
  byProvider: {},
};

export default function LowQuotaBypassSection() {
  const t = useTranslations("settings");
  const [state, setState] = useState<LowQuotaBypassSettings>(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((res) => res.json())
      .then((data: LowQuotaBypassSettings) => {
        setState(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("LowQuotaBypass: failed to load settings:", err);
        setLoading(false);
      });
  }, []);

  const persist = async (next: LowQuotaBypassSettings) => {
    const previous = state;
    setState(next);
    setSaving(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        setState(previous);
        console.error("LowQuotaBypass: PUT failed:", await res.text());
      }
    } catch (err) {
      setState(previous);
      console.error("LowQuotaBypass: PUT error:", err);
    } finally {
      setSaving(false);
    }
  };

  const boolOptions = [
    { value: false, label: t("compatibilityLowQuotaModeExclude") },
    { value: true, label: t("compatibilityLowQuotaModeBypass") },
  ];

  const disabled = loading || saving;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            speed
          </span>
        </div>
        <h3 className="text-lg font-semibold">{t("compatibilityLowQuotaTitle")}</h3>
      </div>
      <p className="text-sm text-text-muted mb-4">{t("compatibilityLowQuotaDescription")}</p>

      <div className="flex flex-col gap-5">
        <div>
          <label className="block text-sm font-medium mb-2">
            {t("compatibilityLowQuotaDefaultLabel")}
          </label>
          <div className="grid grid-cols-1 gap-2">
            {boolOptions.map((opt) => (
              <button
                key={String(opt.value)}
                disabled={disabled}
                onClick={() => persist({ ...state, default: opt.value })}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all text-left ${
                  state.default === opt.value
                    ? "border-amber-500/50 bg-amber-500/5 ring-1 ring-amber-500/20"
                    : "border-border/50 hover:border-border hover:bg-surface/30"
                } disabled:opacity-60`}
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${
                    state.default === opt.value ? "text-amber-400" : "text-text-muted"
                  }`}
                >
                  {state.default === opt.value ? "radio_button_checked" : "radio_button_unchecked"}
                </span>
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">
            {t("compatibilityLowQuotaByProviderLabel")}
          </label>
          <p className="text-xs text-text-muted mb-2">
            {t("compatibilityLowQuotaProviderScopeOnlyHint")}
          </p>
          <OverrideTable<boolean>
            overrides={state.byProvider}
            availableKeys={USAGE_SUPPORTED_PROVIDERS}
            valueOptions={boolOptions}
            defaultNewValue={true}
            keyColumnLabel={t("compatibilityProviderColumn")}
            valueColumnLabel={t("compatibilityModeColumn")}
            addButtonLabel={t("compatibilityAddProviderOverride")}
            selectKeyPlaceholder={t("compatibilitySelectProvider")}
            emptyStateLabel={t("compatibilityNoOverrides")}
            disabled={disabled}
            onChange={(byProvider) => persist({ ...state, byProvider })}
          />
        </div>
      </div>
    </Card>
  );
}
