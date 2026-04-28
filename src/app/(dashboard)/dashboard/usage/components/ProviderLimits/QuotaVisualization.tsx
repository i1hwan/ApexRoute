"use client";

import { useTranslations } from "next-intl";
import { calculatePercentage } from "./utils";

interface QuotaItem {
  name?: string;
  remainingPercentage?: number | null;
  used?: number | null;
  total?: number | null;
  unlimited?: boolean;
  resetAt?: string | null;
}

interface QuotaVisualizationProps {
  quotas: QuotaItem[] | null | undefined;
}

function getBarColor(remainingPct: number): { bar: string; bg: string; text: string } {
  if (remainingPct > 50) {
    return { bar: "#22c55e", bg: "rgba(34,197,94,0.12)", text: "#22c55e" };
  }
  if (remainingPct > 20) {
    return { bar: "#eab308", bg: "rgba(234,179,8,0.12)", text: "#eab308" };
  }
  return { bar: "#ef4444", bg: "rgba(239,68,68,0.12)", text: "#ef4444" };
}

function pickWindow(quotas: QuotaItem[], windowKey: string): QuotaItem | null {
  for (const q of quotas) {
    const name = (q.name || "").toLowerCase();
    if (name === windowKey) return q;
    if (name.startsWith(`${windowKey} `) || name.startsWith(`${windowKey}(`)) return q;
  }
  return null;
}

function getRemainingPct(q: QuotaItem | null): number | null {
  if (!q) return null;
  if (q.unlimited) return 100;
  if (typeof q.remainingPercentage === "number" && Number.isFinite(q.remainingPercentage)) {
    return q.remainingPercentage;
  }
  if (typeof q.used === "number" && typeof q.total === "number" && q.total > 0) {
    return calculatePercentage(q.used, q.total);
  }
  return null;
}

function MiniBar({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-text-muted opacity-60">
        <span className="w-14 shrink-0">{label}</span>
        <span>—</span>
      </div>
    );
  }
  const colors = getBarColor(pct);
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-14 shrink-0 text-text-muted">{label}</span>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: colors.bg }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${clamped}%`, background: colors.bar }}
        />
      </div>
      <span className="w-9 text-right font-mono" style={{ color: colors.text }}>
        {Math.round(clamped)}%
      </span>
    </div>
  );
}

export default function QuotaVisualization({ quotas }: QuotaVisualizationProps) {
  const t = useTranslations("usage");
  if (!quotas || quotas.length === 0) return null;

  const sessionQ = pickWindow(quotas, "session");
  const weeklyQ = pickWindow(quotas, "weekly");

  if (!sessionQ && !weeklyQ) return null;

  return (
    <div className="flex flex-col gap-1 min-w-[220px] mr-3 pr-3 border-r border-border/60">
      <MiniBar label={t("sessionRemaining")} pct={getRemainingPct(sessionQ)} />
      <MiniBar label={t("weeklyRemaining")} pct={getRemainingPct(weeklyQ)} />
    </div>
  );
}
