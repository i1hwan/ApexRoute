"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";
import type { RoutingPreviewEntry } from "@/shared/contracts/routingPreview";

export type {
  RoutingPreviewBreakdown,
  RoutingPreviewEntry,
} from "@/shared/contracts/routingPreview";

interface RoutingBadgeProps {
  entry?: RoutingPreviewEntry;
}

function formatNum(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function getExcludedI18nKey(reason: string | null): string {
  switch (reason) {
    case "inactive":
      return "routingPriorityExcludedInactive";
    case "rate_limited":
      return "routingPriorityExcludedRateLimited";
    case "terminal":
      return "routingPriorityExcludedTerminal";
    case "quota_exhausted_unknown_reset":
      return "routingPriorityExcludedQuota";
    default:
      return "routingPriorityExcludedUnknown";
  }
}

export default function RoutingBadge({ entry }: RoutingBadgeProps) {
  const t = useTranslations("usage");
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), 80);
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  if (!entry) return null;
  if (entry.rank === null && !entry.excluded) return null;

  const isExcluded = entry.excluded;
  const isNext = entry.isNext;
  const rank = entry.rank ?? 0;

  const label = isExcluded
    ? t(getExcludedI18nKey(entry.excludedReason))
    : isNext
      ? t("routingPriorityNext")
      : t("routingPriorityRank", { rank });

  const variant = isExcluded ? "error" : isNext ? "primary" : "default";

  const wrapperClass = isExcluded
    ? "[background-image:repeating-linear-gradient(135deg,transparent_0_4px,rgba(239,68,68,0.18)_4px_8px)]"
    : "";

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span tabIndex={0} className={wrapperClass}>
        <Badge variant={variant} size="sm" dot className="h-5 leading-none">
          {label}
        </Badge>
      </span>
      {open && (
        <span
          role="tooltip"
          className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-[11px] text-white bg-gray-900/95 rounded-md shadow-lg pointer-events-none border border-white/10 min-w-[220px] whitespace-pre-line"
        >
          <div className="font-semibold mb-1">{t("routingScoreBreakdownTitle")}</div>
          {isExcluded ? (
            <div>{t(getExcludedI18nKey(entry.excludedReason))}</div>
          ) : (
            <div className="space-y-0.5">
              <BreakdownRow
                label={t("routingScoreSession")}
                value={
                  entry.breakdown?.sessionRemainingPct !== null
                    ? `${formatNum(entry.breakdown?.sessionRemainingPct, 0)}%`
                    : "—"
                }
              />
              <BreakdownRow
                label={t("routingScoreWeekly")}
                value={
                  entry.breakdown?.weeklyRemainingPct !== null
                    ? `${formatNum(entry.breakdown?.weeklyRemainingPct, 0)}%`
                    : "—"
                }
              />
              <BreakdownRow
                label={t("routingScoreSessionPoints")}
                value={formatNum(entry.breakdown?.sessionPoints, 1)}
              />
              <BreakdownRow
                label={t("routingScoreWeeklyPoints")}
                value={formatNum(entry.breakdown?.weeklyPoints, 1)}
              />
              <BreakdownRow
                label={t("routingScoreBase")}
                value={formatNum(entry.breakdown?.baseScore, 1)}
              />
              <BreakdownRow
                label={t("routingScorePenaltyError")}
                value={formatNum(entry.breakdown?.penaltyError, 1)}
              />
              <BreakdownRow
                label={t("routingScorePenaltyBackoff")}
                value={formatNum(entry.breakdown?.penaltyBackoff, 1)}
              />
              <BreakdownRow
                label={t("routingScorePenaltyDegraded")}
                value={formatNum(entry.breakdown?.penaltyDegraded, 1)}
              />
              <BreakdownRow
                label={t("routingScoreFinal")}
                value={formatNum(entry.breakdown?.finalScore ?? entry.score, 1)}
              />
            </div>
          )}
        </span>
      )}
    </span>
  );
}

function BreakdownRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="opacity-80">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
