"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

const LS_ENABLED = "omniroute:limits:autoRefresh:enabled";
const LS_INTERVAL = "omniroute:limits:autoRefresh:intervalMs";

const INTERVAL_OPTIONS_MS = [60_000, 120_000, 300_000, 600_000] as const;
const DEFAULT_INTERVAL_MS: number = 60_000;

const SAME_TICK_GUARD_MS = 1000;

interface AutoRefreshControlProps {
  onTrigger: () => Promise<void>;
}

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LS_ENABLED) === "true";
  } catch {
    return false;
  }
}

function readInterval(): number {
  if (typeof window === "undefined") return DEFAULT_INTERVAL_MS;
  try {
    const raw = window.localStorage.getItem(LS_INTERVAL);
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && (INTERVAL_OPTIONS_MS as readonly number[]).includes(parsed)) {
      return parsed;
    }
  } catch {
    // localStorage unavailable; fall through to default
  }
  return DEFAULT_INTERVAL_MS;
}

function persistEnabled(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_ENABLED, value ? "true" : "false");
  } catch {
    // best-effort persistence
  }
}

function persistInterval(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_INTERVAL, String(value));
  } catch {
    // best-effort persistence
  }
}

function intervalI18nKey(ms: number): string {
  switch (ms) {
    case 60_000:
      return "autoRefreshInterval1m";
    case 120_000:
      return "autoRefreshInterval2m";
    case 300_000:
      return "autoRefreshInterval5m";
    case 600_000:
      return "autoRefreshInterval10m";
    default:
      return "autoRefreshInterval1m";
  }
}

export default function AutoRefreshControl({ onTrigger }: AutoRefreshControlProps) {
  const t = useTranslations("usage");
  const [enabled, setEnabled] = useState<boolean>(false);
  const [intervalMs, setIntervalMs] = useState<number>(DEFAULT_INTERVAL_MS);
  const inFlightRef = useRef<boolean>(false);
  const lastTriggerAtRef = useRef<number>(0);
  const onTriggerRef = useRef(onTrigger);

  useEffect(() => {
    setEnabled(readEnabled());
    setIntervalMs(readInterval());
  }, []);

  useEffect(() => {
    onTriggerRef.current = onTrigger;
  }, [onTrigger]);

  const safeTrigger = useCallback(async () => {
    if (inFlightRef.current) return;
    if (Date.now() - lastTriggerAtRef.current < SAME_TICK_GUARD_MS) return;
    inFlightRef.current = true;
    lastTriggerAtRef.current = Date.now();
    try {
      await onTriggerRef.current();
    } catch {
      // upstream errors are surfaced by onTrigger's own state; we just clear flight
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;

    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void safeTrigger();
    };

    const intervalHandle = setInterval(tick, intervalMs);

    const onVis = () => {
      if (document.visibilityState === "visible") void safeTrigger();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      clearInterval(intervalHandle);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, intervalMs, safeTrigger]);

  const handleToggle = (next: boolean) => {
    setEnabled(next);
    persistEnabled(next);
  };

  const handleIntervalChange = (next: number) => {
    setIntervalMs(next);
    persistInterval(next);
  };

  return (
    <div className="flex items-center gap-2 text-[12px]">
      <label className="flex items-center gap-1.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => handleToggle(e.target.checked)}
          className="cursor-pointer"
        />
        <span className="text-text-muted">{t("autoRefreshLabel")}</span>
      </label>
      <select
        value={intervalMs}
        onChange={(e) => handleIntervalChange(parseInt(e.target.value, 10))}
        disabled={!enabled}
        aria-label={t("autoRefreshIntervalLabel")}
        className="px-2 py-1 rounded border border-border bg-bg-subtle text-text-main text-[12px] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {INTERVAL_OPTIONS_MS.map((ms) => (
          <option key={ms} value={ms}>
            {t(intervalI18nKey(ms))}
          </option>
        ))}
      </select>
    </div>
  );
}
