"use client";

import { useState } from "react";
import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import OverrideTable from "./OverrideTable";

const SUPPORTED_LANES = ["claude-oauth-prefixed"] as const;

export default function LowQuotaBypassSection() {
  const t = useTranslations("settings");
  const [defaultBypass, setDefaultBypass] = useState<boolean>(false);
  const [byProvider, setByProvider] = useState<Record<string, boolean>>({});
  const [byLane, setByLane] = useState<Record<string, boolean>>({});

  const boolOptions = [
    { value: false, label: t("compatibilityLowQuotaModeExclude") },
    { value: true, label: t("compatibilityLowQuotaModeBypass") },
  ];

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
                onClick={() => setDefaultBypass(opt.value)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all text-left ${
                  defaultBypass === opt.value
                    ? "border-amber-500/50 bg-amber-500/5 ring-1 ring-amber-500/20"
                    : "border-border/50 hover:border-border hover:bg-surface/30"
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${
                    defaultBypass === opt.value ? "text-amber-400" : "text-text-muted"
                  }`}
                >
                  {defaultBypass === opt.value ? "radio_button_checked" : "radio_button_unchecked"}
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
          <OverrideTable<boolean>
            overrides={byProvider}
            availableKeys={USAGE_SUPPORTED_PROVIDERS}
            valueOptions={boolOptions}
            defaultNewValue={true}
            keyColumnLabel={t("compatibilityProviderColumn")}
            valueColumnLabel={t("compatibilityModeColumn")}
            addButtonLabel={t("compatibilityAddProviderOverride")}
            selectKeyPlaceholder={t("compatibilitySelectProvider")}
            emptyStateLabel={t("compatibilityNoOverrides")}
            onChange={setByProvider}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">
            {t("compatibilityLowQuotaByLaneLabel")}
          </label>
          <p className="text-xs text-text-muted mb-2">{t("compatibilityToolArgsByLaneHint")}</p>
          <OverrideTable<boolean>
            overrides={byLane}
            availableKeys={SUPPORTED_LANES}
            valueOptions={boolOptions}
            defaultNewValue={true}
            keyColumnLabel={t("compatibilityLaneColumn")}
            valueColumnLabel={t("compatibilityModeColumn")}
            addButtonLabel={t("compatibilityAddLaneOverride")}
            selectKeyPlaceholder={t("compatibilitySelectLane")}
            emptyStateLabel={t("compatibilityNoOverrides")}
            onChange={setByLane}
          />
        </div>
      </div>
    </Card>
  );
}
