// Earliest-reset-first burn-down routing strategy (v6).
//
// Selects the provider account whose quota is most urgent to drain before
// reset — i.e. has the largest "T_pts × Q_remain" product. v6 supersedes v4
// after production observation revealed four regressions:
//   F1: self-hosted/openai-compatible (no quota cache) returned excluded
//   F2: per-model weekly windows (Omelette/Sonnet) split routing per request
//   F3: 100% fresh accounts (resetAt=null until first request) were excluded
//   F4: additive S = 0.85·T + 0.15·min(Q,30) kept exhausted-but-urgent
//       accounts winning over abundant-but-cool accounts
//
// See `.sisyphus/plans/routing-strategy-v6.md` for derivation, hand-math, and
// Oracle / Momus review history.

import { getQuotaWindowStatus, isAccountQuotaExhausted } from "@/domain/quotaCache";
import {
  getSessionConnection,
  getSessionInfo,
  touchSession,
} from "@omniroute/open-sse/services/sessionManager.ts";
import { isTerminalConnectionStatus } from "@/sse/services/accountTerminalStatus";

interface ConnectionLike {
  id: string;
  isActive?: boolean;
  rateLimitedUntil?: string | null;
  testStatus?: string | null;
  backoffLevel?: number;
  lastError?: string | null;
}

type TrackKind = "known" | "missing" | "excluded" | "degraded";

interface TrackKnown {
  kind: "known";
  score: number;
  remainingPct: number;
  resetAt: string | null;
  secondsToReset: number;
  windowName?: string;
}

interface TrackMissing {
  kind: "missing";
}

interface TrackDegraded {
  kind: "degraded";
  reason: string;
}

interface TrackExcluded {
  kind: "excluded";
  reason: string;
  resetAt: string | null;
}

type TrackResult = TrackKnown | TrackMissing | TrackDegraded | TrackExcluded;

interface ScoredCandidate {
  conn: ConnectionLike;
  excluded: boolean;
  reason?: string;
  resetAt?: string | null;
  score?: number;
  earliestReset?: string | null;
  breakdown?: {
    s: TrackResult;
    w: TrackResult;
    P_error: number;
    P_backoff: number;
    degraded_pen: number;
    baseScore: number;
  };
}

export interface AffinityValidity {
  valid: boolean;
  reason?: string;
}

export interface AllExcludedResult {
  allExcluded: true;
  retryAfter: number | null;
  retryAfterIso: string | null;
  excludedBreakdown: Array<{
    connectionId: string;
    reason: string;
    resetAt: string | null;
  }>;
}

export interface SelectionTrace {
  affinity: { hit: boolean; boundId: string | null; reason?: string };
  scored: ScoredCandidate[];
  selected: ConnectionLike | null;
  allExcluded: AllExcludedResult | null;
}

const SESSION_AFFINITY_WINDOW_MS = 5 * 60 * 1000;
const SCORE_TIE_EPSILON = 1e-9;
const MIN_USABLE_REMAINING_PCT = 5;

// v6 multiplicative score range is [0, 10000] (T_pts ∈ [10,100] × Q ∈ [5,100]).
// Penalties scale 100× from v4 to keep their relative impact: the strongest
// backoff (level 4) still subtracts ~baseScore from a typical mid-range
// account, and a single degraded track still costs ~25% of a typical score.
const PENALTY_ERROR_WEIGHT = 40;
const PENALTY_BACKOFF_WEIGHT = 100;
const PENALTY_BACKOFF_CAP = 100;
const PENALTY_BACKOFF_PER_LEVEL = 25;
const PENALTY_DEGRADED = 2500;
const ERROR_RATE_WINDOW_MS = 15 * 60 * 1000;

// Stepwise time-urgency tables. `null` input (missing resetAt) is handled by
// callers via the F3 fresh-quota branch. Past resets (s <= 0) report maximal
// urgency so stale entries route quickly to refresh on the next cache tick.
export function sessionTimePoints(secondsRemaining: number | null): number | null {
  if (secondsRemaining === null) return null;
  if (secondsRemaining <= 0) return 100;
  if (secondsRemaining <= 5 * 60) return 100;
  if (secondsRemaining <= 15 * 60) return 85;
  if (secondsRemaining <= 60 * 60) return 65;
  if (secondsRemaining <= 3 * 60 * 60) return 40;
  if (secondsRemaining <= 6 * 60 * 60) return 20;
  return 10;
}

export function weeklyTimePoints(secondsRemaining: number | null): number | null {
  if (secondsRemaining === null) return null;
  if (secondsRemaining <= 0) return 100;
  if (secondsRemaining <= 1 * 60 * 60) return 100;
  if (secondsRemaining <= 6 * 60 * 60) return 85;
  if (secondsRemaining <= 24 * 60 * 60) return 65;
  if (secondsRemaining <= 3 * 24 * 60 * 60) return 40;
  if (secondsRemaining <= 7 * 24 * 60 * 60) return 20;
  return 10;
}

function deltaSec(resetAt: string | null | undefined): number | null {
  if (resetAt === null || resetAt === undefined) return null;
  const ms = new Date(resetAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms - Date.now()) / 1000);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function scoreSessionTrack(connId: string): TrackResult {
  const status = getQuotaWindowStatus(connId, "session", 90);
  if (!status) return { kind: "missing" };

  const Q = status.remainingPercentage;
  if (Q < MIN_USABLE_REMAINING_PCT) {
    return { kind: "excluded", reason: "session<5%", resetAt: status.resetAt };
  }

  const sec = deltaSec(status.resetAt);

  // F3 fresh quota: Anthropic omits resetAt only when the session is at 100%
  // and the timer hasn't started. Treat as max urgency so the very first
  // request to that account starts the 5h timer rather than letting an
  // already-burning account exhaust further. Q≠100 with null resetAt is
  // ambiguous (API hiccup, stale cache, unsupported window) — keep missing.
  if (sec === null && Q === 100) {
    return {
      kind: "known",
      score: 100 * 100,
      remainingPct: Q,
      resetAt: null,
      secondsToReset: Number.POSITIVE_INFINITY,
      windowName: "session",
    };
  }
  if (sec === null) return { kind: "missing" };

  const T = sessionTimePoints(sec);
  if (T === null) return { kind: "missing" };

  return {
    kind: "known",
    score: T * Q,
    remainingPct: Q,
    resetAt: status.resetAt,
    secondsToReset: sec,
    windowName: "session",
  };
}

// F2: model-specific weekly windows (Omelette/Sonnet) are deliberately ignored
// in v6 per user instruction. Routing reads only the overall `weekly` window —
// model-aware quota separation is not modelled. If Anthropic 429s an opus
// request because per-model quota is exhausted, accountFallback handles retry.
export function scoreWeeklyTrack(connId: string): TrackResult {
  const overall = getQuotaWindowStatus(connId, "weekly", 90);
  if (!overall) return { kind: "missing" };

  if (overall.remainingPercentage < MIN_USABLE_REMAINING_PCT) {
    return { kind: "excluded", reason: "weekly<5%", resetAt: overall.resetAt };
  }

  const sec = deltaSec(overall.resetAt);
  const Q = overall.remainingPercentage;

  // F3 fresh quota for weekly track (same semantics as session).
  if (sec === null && Q === 100) {
    return {
      kind: "known",
      score: 100 * 100,
      remainingPct: Q,
      resetAt: null,
      secondsToReset: Number.POSITIVE_INFINITY,
      windowName: "weekly",
    };
  }
  if (sec === null) return { kind: "missing" };

  const T = weeklyTimePoints(sec);
  if (T === null) return { kind: "missing" };

  return {
    kind: "known",
    score: T * Q,
    remainingPct: Q,
    resetAt: overall.resetAt,
    secondsToReset: sec,
    windowName: "weekly",
  };
}

// `degraded` tracks contribute 0 to the average and add a flat penalty.
// `missing` tracks are excluded from the average. `excluded` tracks abort
// scoring before this function runs.
function trackScoreOrZero(t: TrackResult): number | null {
  if (t.kind === "known") return t.score;
  if (t.kind === "degraded") return 0;
  return null;
}

function recentErrorRate(_conn: ConnectionLike, _windowMs: number): number {
  // Plan v4 §2.4 specifies a 15min sliding window of error events with
  // exponential decay. The transport-level error history lives inside
  // `accountFallback.ts` and is not yet exported as a per-connection rate.
  // Until that is wired through (follow-up PR), report 0 — the bounded
  // backoff penalty already deprioritizes recently failed accounts.
  return 0;
}

function earliestKnownReset(tracks: TrackResult[]): string | null {
  const dates: number[] = [];
  for (const t of tracks) {
    if (t.kind === "known" && t.resetAt) {
      const ms = new Date(t.resetAt).getTime();
      if (Number.isFinite(ms)) dates.push(ms);
    }
  }
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates)).toISOString();
}

export function scoreAccount(conn: ConnectionLike): ScoredCandidate {
  const s = scoreSessionTrack(conn.id);
  const w = scoreWeeklyTrack(conn.id);

  if (s.kind === "excluded" || w.kind === "excluded") {
    const ex = s.kind === "excluded" ? s : (w as TrackExcluded);
    return {
      conn,
      excluded: true,
      reason: ex.reason,
      resetAt: ex.resetAt || null,
      breakdown: {
        s,
        w,
        P_error: 0,
        P_backoff: 0,
        degraded_pen: 0,
        baseScore: 0,
      },
    };
  }

  const trackScores: number[] = [];
  for (const t of [s, w]) {
    const v = trackScoreOrZero(t);
    if (v !== null) trackScores.push(v);
  }

  if (trackScores.length === 0) {
    // F1: distinguish "no cache entry exists" (self-hosted / openai-compatible
    // never reports usage → score=0 fallback so paid candidates still beat
    // them but they remain eligible) from "cache says 429-exhausted with no
    // resetAt" (markAccountExhaustedFrom429 → must stay excluded until
    // refresh / TTL).
    if (isAccountQuotaExhausted(conn.id)) {
      return {
        conn,
        excluded: true,
        reason: "quota_exhausted_unknown_reset",
        resetAt: null,
        breakdown: {
          s,
          w,
          P_error: 0,
          P_backoff: 0,
          degraded_pen: 0,
          baseScore: 0,
        },
      };
    }
    return {
      conn,
      excluded: false,
      score: 0,
      earliestReset: null,
      breakdown: {
        s,
        w,
        P_error: 0,
        P_backoff: 0,
        degraded_pen: 0,
        baseScore: 0,
      },
    };
  }

  const baseScore = trackScores.reduce((a, b) => a + b, 0) / trackScores.length;

  const degradedPen =
    (s.kind === "degraded" ? PENALTY_DEGRADED : 0) + (w.kind === "degraded" ? PENALTY_DEGRADED : 0);

  const errorRate = recentErrorRate(conn, ERROR_RATE_WINDOW_MS);
  const pError = clamp(errorRate * 100, 0, 100);
  const pBackoff = Math.min(
    (conn.backoffLevel || 0) * PENALTY_BACKOFF_PER_LEVEL,
    PENALTY_BACKOFF_CAP
  );

  const finalScore =
    baseScore - PENALTY_ERROR_WEIGHT * pError - PENALTY_BACKOFF_WEIGHT * pBackoff - degradedPen;

  return {
    conn,
    excluded: false,
    score: finalScore,
    earliestReset: earliestKnownReset([s, w]),
    breakdown: {
      s,
      w,
      P_error: pError,
      P_backoff: pBackoff,
      degraded_pen: degradedPen,
      baseScore,
    },
  };
}

// Single deterministic comparator used both for primary scoring and tie
// breaking. Order: highest score, then earliest reset, then lex connection id.
export function candidateComparator(a: ScoredCandidate, b: ScoredCandidate): number {
  const sa = a.score ?? -Infinity;
  const sb = b.score ?? -Infinity;
  if (Math.abs(sa - sb) > SCORE_TIE_EPSILON) return sb - sa;

  const aReset = a.earliestReset ? new Date(a.earliestReset).getTime() : Number.POSITIVE_INFINITY;
  const bReset = b.earliestReset ? new Date(b.earliestReset).getTime() : Number.POSITIVE_INFINITY;
  if (aReset !== bReset) return aReset - bReset;

  return a.conn.id.localeCompare(b.conn.id);
}

export function isAffinityValid(conn: ConnectionLike, sessionId: string | null): AffinityValidity {
  if (conn.isActive === false) return { valid: false, reason: "inactive" };

  if (conn.rateLimitedUntil) {
    const rl = new Date(conn.rateLimitedUntil).getTime();
    if (Number.isFinite(rl) && rl > Date.now()) {
      return { valid: false, reason: "rate_limited" };
    }
  }

  if (isTerminalConnectionStatus(conn)) return { valid: false, reason: "terminal" };

  // Mirror the F1 guard from scoreAccount: a connection marked exhausted via
  // markAccountExhaustedFrom429() has empty `quotas:{}` and `exhausted:true`,
  // making both tracks return `missing` (not `excluded`). Without this check,
  // isAffinityValid would keep affinity pinned and the next request to this
  // account would be sent right back to a 429-exhausted endpoint. Copilot
  // review on PR #23.
  if (isAccountQuotaExhausted(conn.id)) {
    return { valid: false, reason: "quota_exhausted_unknown_reset" };
  }

  const session = getSessionInfo(sessionId);
  if (!session) return { valid: false, reason: "session_expired" };
  if (Date.now() - session.lastActive > SESSION_AFFINITY_WINDOW_MS) {
    return { valid: false, reason: "affinity_window_passed" };
  }

  const s = scoreSessionTrack(conn.id);
  if (s.kind === "excluded") return { valid: false, reason: s.reason };
  const w = scoreWeeklyTrack(conn.id);
  if (w.kind === "excluded") return { valid: false, reason: w.reason };

  return { valid: true };
}

function buildAllExcluded(scored: ScoredCandidate[]): AllExcludedResult {
  const excludedBreakdown = scored
    .filter((s) => s.excluded)
    .map((s) => ({
      connectionId: s.conn.id,
      reason: s.reason || "unknown",
      resetAt: s.resetAt || null,
    }));

  let earliestMs: number | null = null;
  for (const e of excludedBreakdown) {
    if (!e.resetAt) continue;
    const ms = new Date(e.resetAt).getTime();
    if (Number.isFinite(ms) && (earliestMs === null || ms < earliestMs)) earliestMs = ms;
  }

  return {
    allExcluded: true,
    retryAfter: earliestMs,
    retryAfterIso: earliestMs !== null ? new Date(earliestMs).toISOString() : null,
    excludedBreakdown,
  };
}

export function selectByEarliestResetFirst(
  candidates: ConnectionLike[],
  sessionId: string | null
): { selected: ConnectionLike } | AllExcludedResult {
  if (sessionId) {
    const boundId = getSessionConnection(sessionId);
    if (boundId) {
      const bound = candidates.find((c) => c.id === boundId);
      const affinity = bound ? isAffinityValid(bound, sessionId) : null;
      if (bound && affinity?.valid === true) {
        return { selected: bound };
      }
    }
  }

  const scored: ScoredCandidate[] = candidates.map((c) => scoreAccount(c));
  const usable = scored.filter((s) => !s.excluded);

  if (usable.length === 0) return buildAllExcluded(scored);

  usable.sort(candidateComparator);
  const selected = usable[0].conn;

  if (sessionId) touchSession(sessionId, selected.id);

  return { selected };
}
