"use client";

import { useTranslations } from "next-intl";
import { calculatePercentage, formatCountdown } from "./utils";
import { getBarColor } from "./quotaColors";

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

/**
 * True for canonical overall windows like "session (5h)" / "weekly (7d)" /
 * exact "session" / "weekly". Returns false for model-specific variants
 * such as "weekly Sonnet (7d)" so per-model bars still render those.
 * Used by the parent Provider Limits row to avoid double-rendering session
 * and weekly windows that already appear in the dual mini-bar pair.
 */
export function isOverallWindowName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower === "session" || lower === "weekly") return true;
  return lower.startsWith("session (") || lower.startsWith("weekly (");
}

function pickWindow(quotas: QuotaItem[], windowKey: string): QuotaItem | null {
  // Pass 1: exact match or "<key> (..." parenthesised window. This catches
  // canonical labels like "weekly (7d)" / "session (5h)" but NOT model-specific
  // variants like "weekly Sonnet (7d)" — those have a space + word before "(".
  for (const q of quotas) {
    const name = (q.name || "").toLowerCase();
    if (name === windowKey) return q;
    if (name.startsWith(`${windowKey} (`) || name.startsWith(`${windowKey}(`)) return q;
  }
  // Pass 2: fallback for legacy unparenthesised forms. Only reached when no
  // canonical match exists, so per-model windows still cannot collide with
  // the overall window when the overall window is present in the cache.
  for (const q of quotas) {
    const name = (q.name || "").toLowerCase();
    if (name.startsWith(`${windowKey} `)) return q;
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

function MiniBar({
  label,
  pct,
  resetAt,
}: {
  label: string;
  pct: number | null;
  resetAt?: string | null;
}) {
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
  const countdown = formatCountdown(resetAt);
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-14 shrink-0 text-text-muted">{label}</span>
      {countdown ? (
        <span className="shrink-0 font-mono text-text-muted whitespace-nowrap">⏱ {countdown}</span>
      ) : null}
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
    <div className="flex flex-col gap-1 min-w-[260px] mr-3 pr-3 border-r border-border/60">
      <MiniBar
        label={t("sessionRemaining")}
        pct={getRemainingPct(sessionQ)}
        resetAt={sessionQ?.resetAt}
      />
      <MiniBar
        label={t("weeklyRemaining")}
        pct={getRemainingPct(weeklyQ)}
        resetAt={weeklyQ?.resetAt}
      />
    </div>
  );
}
