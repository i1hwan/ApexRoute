"use client";

import { useState } from "react";
import { Card, Input, Button } from "@/shared/components";
import { useTranslations } from "next-intl";

export default function SSEDiagnosticsSection() {
  const t = useTranslations("settings");
  const [captureRawLines, setCaptureRawLines] = useState(false);
  const [captureParsedEvents, setCaptureParsedEvents] = useState(false);
  const [captureTranslatedChunks, setCaptureTranslatedChunks] = useState(false);
  const [keepLastN, setKeepLastN] = useState(20);
  const [maxBundleMb, setMaxBundleMb] = useState(100);
  const [maxActiveBundles, setMaxActiveBundles] = useState(5);

  const toggleRow = (label: string, checked: boolean, onChange: (next: boolean) => void) => (
    <label className="flex items-center gap-3 cursor-pointer py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
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
        {toggleRow(t("compatibilitySseDiagnosticsRawLines"), captureRawLines, setCaptureRawLines)}
        {toggleRow(
          t("compatibilitySseDiagnosticsParsedEvents"),
          captureParsedEvents,
          setCaptureParsedEvents
        )}
        {toggleRow(
          t("compatibilitySseDiagnosticsTranslatedChunks"),
          captureTranslatedChunks,
          setCaptureTranslatedChunks
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t("compatibilitySseDiagnosticsKeepLastN")}
          </label>
          <Input
            type="number"
            min={1}
            max={1000}
            value={keepLastN}
            onChange={(e) => setKeepLastN(Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t("compatibilitySseDiagnosticsMaxBundleSize")}
          </label>
          <Input
            type="number"
            min={1}
            max={1000}
            value={maxBundleMb}
            onChange={(e) => setMaxBundleMb(Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t("compatibilitySseDiagnosticsMaxActiveBundles")}
          </label>
          <Input
            type="number"
            min={1}
            max={50}
            value={maxActiveBundles}
            onChange={(e) => setMaxActiveBundles(Number(e.target.value) || 0)}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          disabled
          onClick={() => {
            window.confirm(t("compatibilitySseDiagnosticsClearConfirm"));
          }}
        >
          <span className="material-symbols-outlined text-[16px] mr-1">delete</span>
          {t("compatibilitySseDiagnosticsClear")}
        </Button>
      </div>
    </Card>
  );
}
