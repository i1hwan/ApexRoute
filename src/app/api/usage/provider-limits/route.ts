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

export interface RoutingPreviewEntry {
  strategy: string;
  rank: number | null;
  isNext: boolean;
  excluded: boolean;
  excludedReason: string | null;
  score: number | null;
  breakdown: {
    sessionPoints: number | null;
    weeklyPoints: number | null;
    sessionRemainingPct: number | null;
    weeklyRemainingPct: number | null;
    baseScore: number | null;
    penaltyError: number;
    penaltyBackoff: number;
    penaltyDegraded: number;
    finalScore: number | null;
  } | null;
}

export type RoutingPreviewMap = Record<string, RoutingPreviewEntry>;

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

function rateLimitedSentinel(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return new Date(value).toISOString();
  }
  return value;
}

export function computeRouting(
  connections: ConnectionRow[],
  strategy: RoutingStrategyValue
): RoutingPreviewMap {
  const map: RoutingPreviewMap = {};
  const groups = new Map<string, ConnectionRow[]>();
  for (const c of connections) {
    if (!c || typeof c.id !== "string" || typeof c.provider !== "string") continue;
    if (!groups.has(c.provider)) groups.set(c.provider, []);
    groups.get(c.provider)!.push(c);
  }

  for (const [, group] of groups) {
    if (strategy === "earliest-reset-first") {
      const eligible: ConnectionRow[] = [];
      for (const c of group) {
        if (isInactive(c)) {
          map[c.id] = makeExcludedEntry(strategy, "inactive");
          continue;
        }
        const rl = rateLimitedSentinel(c.rateLimitedUntil);
        if (rl !== null && isAccountUnavailable(rl)) {
          map[c.id] = makeExcludedEntry(strategy, "rate_limited");
          continue;
        }
        if (isTerminalConnectionStatus(c as Parameters<typeof isTerminalConnectionStatus>[0])) {
          map[c.id] = makeExcludedEntry(strategy, "terminal");
          continue;
        }
        eligible.push(c);
      }
      const scored = eligible.map((c) => scoreAccount(c));
      const usable = scored.filter((s) => !s.excluded).sort(candidateComparator);
      usable.forEach((s, i) => {
        map[s.conn.id] = toEntry(s, strategy, i + 1);
      });
      for (const s of scored.filter((s) => s.excluded)) {
        map[s.conn.id] = toEntry(s, strategy, null);
      }
    } else {
      for (const c of group) {
        if (isInactive(c)) {
          map[c.id] = makeExcludedEntry(strategy, "inactive");
          continue;
        }
        const rl = rateLimitedSentinel(c.rateLimitedUntil);
        if (rl !== null && isAccountUnavailable(rl)) {
          map[c.id] = makeExcludedEntry(strategy, "rate_limited");
          continue;
        }
        if (isTerminalConnectionStatus(c as Parameters<typeof isTerminalConnectionStatus>[0])) {
          map[c.id] = makeExcludedEntry(strategy, "terminal");
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

async function buildResponseBody(extra: Record<string, unknown> = {}) {
  const settings = await getSettings();
  const configuredStrategy = normalizeConfiguredStrategy(
    (settings as { fallbackStrategy?: string | null }).fallbackStrategy
  );
  const connections = (await getProviderConnections({})) as ConnectionRow[];
  const routing = computeRouting(connections, configuredStrategy);

  return {
    caches: getCachedProviderLimitsMap(),
    intervalMinutes: getProviderLimitsSyncIntervalMinutes(),
    lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    routing,
    configuredRoutingStrategy: configuredStrategy,
    ...extra,
  };
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
