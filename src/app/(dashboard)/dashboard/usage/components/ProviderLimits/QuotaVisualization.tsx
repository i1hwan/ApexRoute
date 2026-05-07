"use client";

import { Fragment } from "react";
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
  return (
    lower.startsWith("session (") ||
    lower.startsWith("weekly (") ||
    lower.startsWith("session(") ||
    lower.startsWith("weekly(")
  );
}

export function pickWindow(quotas: QuotaItem[], windowKey: string): QuotaItem | null {
  // Match ONLY canonical overall windows: exact "session"/"weekly", or
  // parenthesised window like "weekly (7d)" / "session (5h)". Per-model
  // variants like "weekly Sonnet (7d)" have a space + word before the paren
  // and must NEVER populate the overall mini-bar — they are rendered as
  // their own per-model bar in index.tsx via the !isOverallWindowName filter.
  // A previous "Pass 2" fallback that matched any name starting with
  // "weekly " could pull in "weekly Sonnet" when no canonical row existed,
  // double-rendering the per-model quota. Removed (Oracle audit on PR #26).
  for (const q of quotas) {
    const name = (q.name || "").toLowerCase();
    if (name === windowKey) return q;
    if (name.startsWith(`${windowKey} (`) || name.startsWith(`${windowKey}(`)) return q;
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

export function OverallQuotaRow({
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
      <div className="flex items-center gap-1.5 min-w-[200px] shrink-0 opacity-60">
        <span className="text-[11px] font-semibold py-0.5 px-2 rounded whitespace-nowrap min-w-[60px] text-center bg-bg-subtle text-text-muted">
          {label}
        </span>
        <div className="flex-1 h-1.5 rounded-sm bg-black/[0.06] dark:bg-white/[0.06] min-w-[60px]" />
        <span className="text-[11px] font-semibold min-w-[32px] text-right text-text-muted">—</span>
      </div>
    );
  }
  const colors = getBarColor(pct);
  const clamped = Math.max(0, Math.min(100, pct));
  const countdown = formatCountdown(resetAt);
  return (
    <div className="flex items-center gap-1.5 min-w-[200px] shrink-0">
      <span
        className="text-[11px] font-semibold py-0.5 px-2 rounded whitespace-nowrap min-w-[60px] text-center"
        style={{ background: colors.bg, color: colors.text }}
      >
        {label}
      </span>
      {countdown ? (
        <span className="text-[10px] text-text-muted whitespace-nowrap">⏱ {countdown}</span>
      ) : null}
      <div className="flex-1 h-1.5 rounded-sm bg-black/[0.06] dark:bg-white/[0.06] min-w-[60px] overflow-hidden">
        <div
          className="h-full rounded-sm transition-[width] duration-300 ease-out"
          style={{ width: `${clamped}%`, background: colors.bar }}
        />
      </div>
      <span
        className="text-[11px] font-semibold min-w-[32px] text-right"
        style={{ color: colors.text }}
      >
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

  // Always render both Session AND Weekly rows whenever either window exists,
  // so the row pair stays visually paired across providers. The OverallQuotaRow
  // pct=null branch handles absent-window cases with a muted em-dash placeholder
  // that keeps the row vocabulary consistent with neighbours. (Oracle audit:
  // ses_1fbb494e4ffe7BxOUFFzU8g6dm — defect C.)
  return (
    <Fragment>
      <OverallQuotaRow
        label={t("sessionQuotaLabel")}
        pct={getRemainingPct(sessionQ)}
        resetAt={sessionQ?.resetAt ?? null}
      />
      <OverallQuotaRow
        label={t("weeklyQuotaLabel")}
        pct={getRemainingPct(weeklyQ)}
        resetAt={weeklyQ?.resetAt ?? null}
      />
    </Fragment>
  );
}
