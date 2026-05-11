"use client";

import { useEffect, useState } from "react";
import { Card } from "@/shared/components";
import { useTranslations } from "next-intl";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import OverrideTable from "./OverrideTable";

type Mode = "stream-normalized" | "buffered-final";

interface ToolArgumentModeSettings {
  default: Mode;
  byProvider: Record<string, Mode>;
  byLane: Record<string, Mode>;
}

const ENDPOINT = "/api/settings/tool-argument-mode";

const SUPPORTED_LANES = ["claude-oauth-prefixed"] as const;

const DEFAULT_STATE: ToolArgumentModeSettings = {
  default: "stream-normalized",
  byProvider: {},
  byLane: {},
};

export default function ToolArgumentModeSection() {
  const t = useTranslations("settings");
  const [state, setState] = useState<ToolArgumentModeSettings>(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((res) => res.json())
      .then((data: ToolArgumentModeSettings) => {
        setState(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("ToolArgumentMode: failed to load settings:", err);
        setLoading(false);
      });
  }, []);

  const persist = async (next: ToolArgumentModeSettings) => {
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
        console.error("ToolArgumentMode: PUT failed:", await res.text());
      }
    } catch (err) {
      setState(previous);
      console.error("ToolArgumentMode: PUT error:", err);
    } finally {
      setSaving(false);
    }
  };

  const modeOptions = [
    { value: "stream-normalized" as Mode, label: t("compatibilityToolArgsModeStreamNormalized") },
    { value: "buffered-final" as Mode, label: t("compatibilityToolArgsModeBufferedFinal") },
  ];

  const disabled = loading || saving;

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
                disabled={disabled}
                onClick={() => persist({ ...state, default: opt.value })}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                  state.default === opt.value
                    ? "border-blue-500/50 bg-blue-500/5 ring-1 ring-blue-500/20"
                    : "border-border/50 hover:border-border hover:bg-surface/30"
                } disabled:opacity-60`}
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${
                    state.default === opt.value ? "text-blue-400" : "text-text-muted"
                  }`}
                >
                  {state.default === opt.value ? "radio_button_checked" : "radio_button_unchecked"}
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
            overrides={state.byProvider}
            availableKeys={USAGE_SUPPORTED_PROVIDERS}
            valueOptions={modeOptions}
            defaultNewValue="buffered-final"
            keyColumnLabel={t("compatibilityProviderColumn")}
            valueColumnLabel={t("compatibilityModeColumn")}
            addButtonLabel={t("compatibilityAddProviderOverride")}
            selectKeyPlaceholder={t("compatibilitySelectProvider")}
            emptyStateLabel={t("compatibilityNoOverrides")}
            disabled={disabled}
            onChange={(byProvider) => persist({ ...state, byProvider })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">
            {t("compatibilityToolArgsByLaneLabel")}
          </label>
          <p className="text-xs text-text-muted mb-2">{t("compatibilityToolArgsByLaneHint")}</p>
          <OverrideTable<Mode>
            overrides={state.byLane}
            availableKeys={SUPPORTED_LANES}
            valueOptions={modeOptions}
            defaultNewValue="buffered-final"
            keyColumnLabel={t("compatibilityLaneColumn")}
            valueColumnLabel={t("compatibilityModeColumn")}
            addButtonLabel={t("compatibilityAddLaneOverride")}
            selectKeyPlaceholder={t("compatibilitySelectLane")}
            emptyStateLabel={t("compatibilityNoOverrides")}
            disabled={disabled}
            onChange={(byLane) => persist({ ...state, byLane })}
          />
        </div>
      </div>
    </Card>
  );
}
