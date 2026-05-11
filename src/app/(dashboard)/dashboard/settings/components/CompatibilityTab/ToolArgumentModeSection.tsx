"use client";

import { useState } from "react";
import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import OverrideTable from "./OverrideTable";

type Mode = "stream-normalized" | "buffered-final";

const SUPPORTED_LANES = ["claude-oauth-prefixed"] as const;

export default function ToolArgumentModeSection() {
  const t = useTranslations("settings");
  const [defaultMode, setDefaultMode] = useState<Mode>("stream-normalized");
  const [byProvider, setByProvider] = useState<Record<string, Mode>>({});
  const [byLane, setByLane] = useState<Record<string, Mode>>({});

  const modeOptions = [
    { value: "stream-normalized" as Mode, label: t("compatibilityToolArgsModeStreamNormalized") },
    { value: "buffered-final" as Mode, label: t("compatibilityToolArgsModeBufferedFinal") },
  ];

  return (
    <Card>
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            data_object
          </span>
        </div>
        <h3 className="text-lg font-semibold">{t("compatibilityToolArgsTitle")}</h3>
      </div>
      <p className="text-sm text-text-muted mb-4">{t("compatibilityToolArgsDescription")}</p>

      <div className="flex flex-col gap-5">
        <div>
          <label className="block text-sm font-medium mb-2">
            {t("compatibilityToolArgsDefaultLabel")}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {modeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDefaultMode(opt.value)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                  defaultMode === opt.value
                    ? "border-blue-500/50 bg-blue-500/5 ring-1 ring-blue-500/20"
                    : "border-border/50 hover:border-border hover:bg-surface/30"
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${
                    defaultMode === opt.value ? "text-blue-400" : "text-text-muted"
                  }`}
                >
                  {defaultMode === opt.value ? "radio_button_checked" : "radio_button_unchecked"}
                </span>
                <span className="text-left">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">
            {t("compatibilityToolArgsByProviderLabel")}
          </label>
          <OverrideTable<Mode>
            overrides={byProvider}
            availableKeys={USAGE_SUPPORTED_PROVIDERS}
            valueOptions={modeOptions}
            defaultNewValue="buffered-final"
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
            {t("compatibilityToolArgsByLaneLabel")}
          </label>
          <p className="text-xs text-text-muted mb-2">{t("compatibilityToolArgsByLaneHint")}</p>
          <OverrideTable<Mode>
            overrides={byLane}
            availableKeys={SUPPORTED_LANES}
            valueOptions={modeOptions}
            defaultNewValue="buffered-final"
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
