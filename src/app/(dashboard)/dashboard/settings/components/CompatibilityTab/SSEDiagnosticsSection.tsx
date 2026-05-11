"use client";

import { useEffect, useState } from "react";
import { Card, Input, Button } from "@/shared/components";
import { useTranslations } from "next-intl";

interface SseDiagnosticsSettings {
  captureProviderRawSSELines: boolean;
  captureProviderParsedEvents: boolean;
  captureTranslatedOpenAISSE: boolean;
  keepLastNDebugRequests: number;
  maxDebugBundleSizeMB: number;
  maxActiveDebugBundles: number;
}

const ENDPOINT = "/api/settings/sse-diagnostics";
const CLEAR_ENDPOINT = "/api/settings/sse-diagnostics/clear";

const DEFAULT_STATE: SseDiagnosticsSettings = {
  captureProviderRawSSELines: false,
  captureProviderParsedEvents: false,
  captureTranslatedOpenAISSE: false,
  keepLastNDebugRequests: 20,
  maxDebugBundleSizeMB: 100,
  maxActiveDebugBundles: 5,
};

const NUMBER_BOUNDS = {
  keepLastNDebugRequests: { min: 1, max: 1000 },
  maxDebugBundleSizeMB: { min: 1, max: 1000 },
  maxActiveDebugBundles: { min: 1, max: 50 },
} as const;

function clamp(value: number, key: keyof typeof NUMBER_BOUNDS): number {
  const { min, max } = NUMBER_BOUNDS[key];
  if (!Number.isFinite(value)) return DEFAULT_STATE[key];
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export default function SSEDiagnosticsSection() {
  const t = useTranslations("settings");
  const [state, setState] = useState<SseDiagnosticsSettings>(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    fetch(ENDPOINT)
      .then((res) => res.json())
      .then((data: SseDiagnosticsSettings) => {
        setState(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("SSEDiagnostics: failed to load settings:", err);
        setLoading(false);
      });
  }, []);

  const persist = async (next: SseDiagnosticsSettings) => {
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
        console.error("SSEDiagnostics: PUT failed:", await res.text());
      }
    } catch (err) {
      setState(previous);
      console.error("SSEDiagnostics: PUT error:", err);
    } finally {
      setSaving(false);
    }
  };

  const updateNumber = (key: keyof typeof NUMBER_BOUNDS, raw: string) => {
    const numeric = Number(raw);
    const next = clamp(numeric, key);
    persist({ ...state, [key]: next });
  };

  const clearLogs = async () => {
    if (!window.confirm(t("compatibilitySseDiagnosticsClearConfirm"))) return;
    setClearing(true);
    try {
      const res = await fetch(CLEAR_ENDPOINT, { method: "POST" });
      if (!res.ok) {
        console.error("SSEDiagnostics: clear failed:", await res.text());
      }
    } catch (err) {
      console.error("SSEDiagnostics: clear error:", err);
    } finally {
      setClearing(false);
    }
  };

  const toggleRow = (
    label: string,
    field: keyof Pick<
      SseDiagnosticsSettings,
      "captureProviderRawSSELines" | "captureProviderParsedEvents" | "captureTranslatedOpenAISSE"
    >
  ) => (
    <label className="flex items-center gap-3 cursor-pointer py-2">
      <input
        type="checkbox"
        checked={state[field]}
        disabled={loading || saving}
        onChange={(e) => persist({ ...state, [field]: e.target.checked })}
        className="w-4 h-4 rounded border-border/50 text-blue-500 focus:ring-blue-500/40"
      />
      <span className="text-sm">{label}</span>
    </label>
  );

  return (
    <Card>
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            bug_report
          </span>
        </div>
        <h3 className="text-lg font-semibold">{t("compatibilitySseDiagnosticsTitle")}</h3>
      </div>
      <p className="text-sm text-text-muted mb-4">{t("compatibilitySseDiagnosticsDescription")}</p>

      <div className="flex flex-col gap-1 mb-5">
        {toggleRow(t("compatibilitySseDiagnosticsRawLines"), "captureProviderRawSSELines")}
        {toggleRow(t("compatibilitySseDiagnosticsParsedEvents"), "captureProviderParsedEvents")}
        {toggleRow(t("compatibilitySseDiagnosticsTranslatedChunks"), "captureTranslatedOpenAISSE")}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t("compatibilitySseDiagnosticsKeepLastN")}
          </label>
          <Input
            type="number"
            min={NUMBER_BOUNDS.keepLastNDebugRequests.min}
            max={NUMBER_BOUNDS.keepLastNDebugRequests.max}
            value={state.keepLastNDebugRequests}
            disabled={loading || saving}
            onChange={(e) => updateNumber("keepLastNDebugRequests", e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t("compatibilitySseDiagnosticsMaxBundleSize")}
          </label>
          <Input
            type="number"
            min={NUMBER_BOUNDS.maxDebugBundleSizeMB.min}
            max={NUMBER_BOUNDS.maxDebugBundleSizeMB.max}
            value={state.maxDebugBundleSizeMB}
            disabled={loading || saving}
            onChange={(e) => updateNumber("maxDebugBundleSizeMB", e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t("compatibilitySseDiagnosticsMaxActiveBundles")}
          </label>
          <Input
            type="number"
            min={NUMBER_BOUNDS.maxActiveDebugBundles.min}
            max={NUMBER_BOUNDS.maxActiveDebugBundles.max}
            value={state.maxActiveDebugBundles}
            disabled={loading || saving}
            onChange={(e) => updateNumber("maxActiveDebugBundles", e.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" disabled={loading || clearing} onClick={clearLogs}>
          <span className="material-symbols-outlined text-[16px] mr-1">delete</span>
          {t("compatibilitySseDiagnosticsClear")}
        </Button>
      </div>
    </Card>
  );
}
