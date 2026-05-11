import { NextResponse } from "next/server";
import {
  getCachedProviderLimitsMap,
  getLastProviderLimitsAutoSyncTime,
  getProviderLimitsSyncIntervalMinutes,
  syncAllProviderLimits,
} from "@/lib/usage/providerLimits";
import { getSettings } from "@/lib/db/settings";
import { getProviderConnections } from "@/lib/db/providers";
import {
  normalizeConfiguredStrategy,
  type RoutingStrategyValue,
} from "@/shared/constants/routingStrategies";
import { scoreAccount, candidateComparator } from "@/sse/services/strategies/earliestResetFirst";
import { isTerminalConnectionStatus } from "@/sse/services/accountTerminalStatus";
import { isAccountUnavailable } from "@omniroute/open-sse/services/accountFallback";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { resolveLowQuotaBypass } from "@omniroute/open-sse/services/routing/lowQuotaBypass.ts";
import type { RoutingPreviewEntry, RoutingPreviewMap } from "@/shared/contracts/routingPreview";

export type { RoutingPreviewEntry, RoutingPreviewMap } from "@/shared/contracts/routingPreview";

const SUPPORTED_PROVIDER_SET = new Set<string>(USAGE_SUPPORTED_PROVIDERS as readonly string[]);

interface ConnectionRow {
  id: string;
  provider: string;
  isActive?: boolean | number | null;
  rateLimitedUntil?: string | number | null;
  testStatus?: string | null;
  backoffLevel?: number;
  lastError?: string | null;
}

function makeExcludedEntry(strategy: string, reason: string): RoutingPreviewEntry {
  return {
    strategy,
    rank: null,
    isNext: false,
    excluded: true,
    excludedReason: reason,
    score: null,
    breakdown: null,
  };
}

function toEntry(
  s: ReturnType<typeof scoreAccount>,
  strategy: string,
  rank: number | null
): RoutingPreviewEntry {
  if (s.excluded) {
    return makeExcludedEntry(strategy, s.reason ?? "unknown");
  }
  const b = s.breakdown;
  if (!b) {
    return {
      strategy,
      rank,
      isNext: rank === 1,
      excluded: false,
      excludedReason: null,
      score: s.score ?? null,
      breakdown: null,
    };
  }
  const sessionKnown = b.s.kind === "known" ? b.s : null;
  const weeklyKnown = b.w.kind === "known" ? b.w : null;
  return {
    strategy,
    rank,
    isNext: rank === 1,
    excluded: false,
    excludedReason: null,
    score: s.score ?? null,
    breakdown: {
      sessionPoints: sessionKnown ? sessionKnown.score : null,
      weeklyPoints: weeklyKnown ? weeklyKnown.score : null,
      sessionRemainingPct: sessionKnown ? sessionKnown.remainingPct : null,
      weeklyRemainingPct: weeklyKnown ? weeklyKnown.remainingPct : null,
      baseScore: b.baseScore,
      penaltyError: b.P_error,
      penaltyBackoff: b.P_backoff,
      penaltyDegraded: b.degraded_pen,
      finalScore: s.score ?? null,
    },
  };
}

function isInactive(c: ConnectionRow): boolean {
  return c.isActive === false || c.isActive === 0;
}

function checkEligibility(c: ConnectionRow, strategy: string): RoutingPreviewEntry | null {
  if (isInactive(c)) return makeExcludedEntry(strategy, "inactive");
  if (c.rateLimitedUntil != null && isAccountUnavailable(c.rateLimitedUntil)) {
    return makeExcludedEntry(strategy, "rate_limited");
  }
  if (isTerminalConnectionStatus(c)) {
    return makeExcludedEntry(strategy, "terminal");
  }
  return null;
}

export function computeRouting(
  connections: ConnectionRow[],
  strategy: RoutingStrategyValue,
  lowQuotaBypassByConn?: Map<string, boolean>
): RoutingPreviewMap {
  const map: RoutingPreviewMap = {};
  const groups = new Map<string, ConnectionRow[]>();
  for (const c of connections) {
    if (!c || typeof c.id !== "string" || typeof c.provider !== "string") continue;
    if (!SUPPORTED_PROVIDER_SET.has(c.provider)) continue;
    if (!groups.has(c.provider)) groups.set(c.provider, []);
    groups.get(c.provider)!.push(c);
  }

  for (const [, group] of groups) {
    if (strategy === "earliest-reset-first") {
      const eligible: ConnectionRow[] = [];
      for (const c of group) {
        const excluded = checkEligibility(c, strategy);
        if (excluded) {
          map[c.id] = excluded;
          continue;
        }
        eligible.push(c);
      }
      const scored = eligible.map((c) => {
        let normalizedRateLimitedUntil: string | null;
        if (typeof c.rateLimitedUntil === "number" && Number.isFinite(c.rateLimitedUntil)) {
          normalizedRateLimitedUntil = new Date(c.rateLimitedUntil).toISOString();
        } else if (typeof c.rateLimitedUntil === "string") {
          normalizedRateLimitedUntil = c.rateLimitedUntil;
        } else {
          normalizedRateLimitedUntil = null;
        }
        return scoreAccount(
          {
            ...c,
            isActive: c.isActive === false || c.isActive === 0 ? false : undefined,
            rateLimitedUntil: normalizedRateLimitedUntil,
          },
          lowQuotaBypassByConn?.get(c.id) ?? false
        );
      });
      const usable = scored.filter((s) => !s.excluded).sort(candidateComparator);
      usable.forEach((s, i) => {
        map[s.conn.id] = toEntry(s, strategy, i + 1);
      });
      for (const s of scored.filter((s) => s.excluded)) {
        map[s.conn.id] = toEntry(s, strategy, null);
      }
    } else {
      for (const c of group) {
        const excluded = checkEligibility(c, strategy);
        if (excluded) {
          map[c.id] = excluded;
          continue;
        }
        map[c.id] = {
          strategy,
          rank: null,
          isNext: false,
          excluded: false,
          excludedReason: null,
          score: null,
          breakdown: null,
        };
      }
    }
  }

  return map;
}

interface ResponseBodyBase {
  caches: ReturnType<typeof getCachedProviderLimitsMap>;
  intervalMinutes: number;
  lastAutoSyncAt: string | null;
  routing: RoutingPreviewMap;
  configuredRoutingStrategy: RoutingStrategyValue;
}

export function mergeIntoResponseBody(
  extra: Record<string, unknown>,
  base: ResponseBodyBase
): Record<string, unknown> {
  // Drop any caches/routing/configuredRoutingStrategy keys from `extra` so a
  // partial-failure result from syncAllProviderLimits cannot override the full
  // disk cache map or stale-overwrite the freshly computed routing preview.
  // Authoritative fields from `base` win.
  const {
    caches: _ignoredExtraCaches,
    routing: _ignoredExtraRouting,
    configuredRoutingStrategy: _ignoredExtraStrategy,
    ...restExtra
  } = extra as {
    caches?: unknown;
    routing?: unknown;
    configuredRoutingStrategy?: unknown;
  } & Record<string, unknown>;
  return { ...restExtra, ...base };
}

async function buildResponseBody(extra: Record<string, unknown> = {}) {
  const settings = await getSettings();
  const configuredStrategy = normalizeConfiguredStrategy(
    (settings as { fallbackStrategy?: string | null }).fallbackStrategy
  );
  const connections = (await getProviderConnections({})) as unknown as ConnectionRow[];
  const lowQuotaBypassSettings = (settings as { lowQuotaBypass?: unknown })?.lowQuotaBypass as
    | Parameters<typeof resolveLowQuotaBypass>[0]
    | undefined;
  const lowQuotaBypassByConn = new Map<string, boolean>();
  for (const c of connections) {
    if (typeof c?.id !== "string" || typeof c?.provider !== "string") continue;
    lowQuotaBypassByConn.set(c.id, resolveLowQuotaBypass(lowQuotaBypassSettings, c.provider));
  }
  const routing = computeRouting(connections, configuredStrategy, lowQuotaBypassByConn);

  return mergeIntoResponseBody(extra, {
    caches: getCachedProviderLimitsMap(),
    intervalMinutes: getProviderLimitsSyncIntervalMinutes(),
    lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    routing,
    configuredRoutingStrategy: configuredStrategy,
  });
}

/**
 * GET /api/usage/provider-limits
 * Returns cached Provider Limits data + per-provider routing preview.
 */
export async function GET() {
  try {
    const body = await buildResponseBody();
    return NextResponse.json(body);
  } catch (error) {
    console.error("[API] GET /api/usage/provider-limits error:", error);
    return NextResponse.json({ error: "Failed to fetch cached provider limits" }, { status: 500 });
  }
}

/**
 * POST /api/usage/provider-limits
 * Manually refresh all supported Provider Limits entries, then return the
 * fresh cache plus routing preview.
 */
export async function POST() {
  try {
    const result = await syncAllProviderLimits({ source: "manual" });
    const body = await buildResponseBody(result as Record<string, unknown>);
    return NextResponse.json(body);
  } catch (error) {
    console.error("[API] POST /api/usage/provider-limits error:", error);
    return NextResponse.json({ error: "Failed to refresh provider limits" }, { status: 500 });
  }
}
