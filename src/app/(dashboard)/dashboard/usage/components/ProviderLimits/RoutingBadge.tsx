"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import Badge from "@/shared/components/Badge";
import type { RoutingPreviewEntry } from "@/shared/contracts/routingPreview";

export type {
  RoutingPreviewBreakdown,
  RoutingPreviewEntry,
} from "@/shared/contracts/routingPreview";

// Brief grace period after pointer leave so cursor can travel from badge
// to tooltip without flicker. UX value preserved exactly from PR #25.
const TOOLTIP_CLOSE_DELAY_MS = 80;

// Tooltip portal rendering constants. Matches the codebase's only other
// portal pattern (providers/[id]/page.tsx) — z-index 10040 sits above
// dashboard chrome so the tooltip can escape any overflow-hidden ancestor.
// Width estimate covers the BreakdownRow layout (min-w-[220px] + padding).
const TOOLTIP_Z_INDEX = 10040;
const TOOLTIP_WIDTH_ESTIMATE_PX = 240;
const TOOLTIP_VIEWPORT_PADDING_PX = 8;
const TOOLTIP_GAP_PX = 8;

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
      if (reason && reason.includes("<5%")) return "routingPriorityExcludedQuota";
      return "routingPriorityExcludedUnknown";
  }
}

export default function RoutingBadge({ entry }: RoutingBadgeProps) {
  const t = useTranslations("usage");
  const [open, setOpen] = useState(false);
  // SSR guard: portal target (document.body) is unavailable during the server
  // render. Initialize from window presence so we hydrate without a flicker.
  // No effect-driven flip needed — `useState` initializer runs lazily per
  // render context (server vs client).
  const mounted = typeof window !== "undefined";
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  const show = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), TOOLTIP_CLOSE_DELAY_MS);
  }, []);

  const updateCoords = useCallback(() => {
    if (!wrapperRef.current || typeof window === "undefined") return;
    const r = wrapperRef.current.getBoundingClientRect();
    const idealLeft = r.left + r.width / 2 - TOOLTIP_WIDTH_ESTIMATE_PX / 2;
    const left = Math.max(
      TOOLTIP_VIEWPORT_PADDING_PX,
      Math.min(
        window.innerWidth - TOOLTIP_WIDTH_ESTIMATE_PX - TOOLTIP_VIEWPORT_PADDING_PX,
        idealLeft
      )
    );
    const top = r.top - TOOLTIP_GAP_PX;
    setCoords({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updateCoords();
    window.addEventListener("resize", updateCoords);
    window.addEventListener("scroll", updateCoords, true);
    return () => {
      window.removeEventListener("resize", updateCoords);
      window.removeEventListener("scroll", updateCoords, true);
      setCoords(null);
    };
  }, [open, updateCoords]);

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

  const tooltipNode =
    open && coords ? (
      <span
        id={tooltipId}
        role="tooltip"
        style={{
          position: "fixed",
          left: coords.left,
          top: coords.top,
          transform: "translateY(-100%)",
          zIndex: TOOLTIP_Z_INDEX,
        }}
        className="px-3 py-2 text-[11px] text-white bg-gray-900/95 rounded-md shadow-lg pointer-events-none border border-white/10 min-w-[220px] whitespace-pre-line"
      >
        <div className="font-semibold mb-1">{t("routingScoreBreakdownTitle")}</div>
        {isExcluded ? (
          <div>{t(getExcludedI18nKey(entry.excludedReason))}</div>
        ) : (
          <div className="space-y-0.5">
            <BreakdownRow
              label={t("routingScoreSession")}
              value={
                Number.isFinite(entry.breakdown?.sessionRemainingPct)
                  ? `${formatNum(entry.breakdown?.sessionRemainingPct, 0)}%`
                  : "—"
              }
            />
            <BreakdownRow
              label={t("routingScoreWeekly")}
              value={
                Number.isFinite(entry.breakdown?.weeklyRemainingPct)
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
    ) : null;

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span tabIndex={0} className={wrapperClass} aria-describedby={open ? tooltipId : undefined}>
        <Badge variant={variant} size="sm" dot className="h-5 leading-none">
          {label}
        </Badge>
      </span>
      {mounted && tooltipNode && typeof document !== "undefined"
        ? createPortal(tooltipNode, document.body)
        : null}
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
