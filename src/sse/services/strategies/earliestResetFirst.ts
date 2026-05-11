// Earliest-reset-first burn-down routing strategy (v7).
//
// Selects the provider account whose quota is most urgent to drain before
// reset. v7 supersedes v6 after production observation revealed that v6's
// arithmetic-mean cross-track combination dilutes the more-urgent track's
// signal with the calmer track. v7 uses a timescale-normalized burn-rate
// pressure and combines across tracks with max() rather than mean().
//
//   pressure(Q, t, W) = Q × clamp(W/t, 1, URGENCY_CAP)
//   trackScore = pressure(...)
//   baseScore  = max(sessionPressure, weeklyPressure)
//
// See `.sisyphus/plans/routing-strategy-v7.md` for derivation, hand-math,
// edge-case verification, and Oracle / Momus review history. Also retains
// v6's invariants (preserved verbatim):
//   F1: self-hosted/openai-compatible (no quota cache) → score=0 fallback
//   F2: per-model weekly windows (Omelette/Sonnet) ignored entirely
//   F3: Q=100 with null resetAt → fresh max-urgency
//   F4: penalty layer (with bumped PENALTY_BACKOFF_WEIGHT 100→101 in v7
//       so max-backoff paid is strictly below self-hosted score=0)

import { getQuotaWindowStatus, isAccountQuotaExhausted } from "@/domain/quotaCache";
import {
  getSessionConnection,
  getSessionInfo,
} from "@omniroute/open-sse/services/sessionManager.ts";
import { isTerminalConnectionStatus } from "@/sse/services/accountTerminalStatus";
import * as log from "@/sse/utils/logger";

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

// Anthropic prompt-cache TTL is 5 minutes sliding (refreshed on each cache
// hit at no extra cost). Affinity window matches that exactly so a session's
// cached prefix stays warm for the whole window. See
// .sisyphus/plans/limits-dashboard-polish.md §1.1 for librarian-confirmed
// pricing/TTL semantics.
const SESSION_AFFINITY_WINDOW_MS = 5 * 60 * 1000;
const SCORE_TIE_EPSILON = 1e-9;
const MIN_USABLE_REMAINING_PCT = 5;

// Smart-affinity continuation viability tunables (Oracle bg_79458ad3, plan v8).
// MIN floor sits 3× above the 5% hard-exclusion cliff so we break before
// hitting Q<5%. HEAVY_GAP combines a multiplicative ratio AND an absolute
// delta to avoid misfire near zero (e.g. bound=20, alt=61 trips 3× alone but
// the urgency difference is too small to justify a cache write). Cooldown
// prevents oscillation between two close-pressure accounts.
const MIN_AFFINITY_REMAINING_PCT = 15;
const HEAVY_GAP_FACTOR = 3;
const MIN_HEAVY_GAP_ABSOLUTE_DELTA = 250;
const AFFINITY_HEURISTIC_BREAK_COOLDOWN_MS = 60_000;

// v7 burn-rate pressure score range is [Q × URGENCY_FLOOR, Q × URGENCY_CAP] = [5, 10000].
// Q < 5 is hard-excluded upstream by scoreSession/WeeklyTrack (kind:"excluded").
// Penalty magnitudes are tuned to keep max-backoff paid strictly below self-hosted=0:
//   maxBaseScore - PENALTY_BACKOFF_WEIGHT * PENALTY_BACKOFF_CAP = 10000 - 101*100 = -100
const PENALTY_ERROR_WEIGHT = 40;
const PENALTY_BACKOFF_WEIGHT = 101;
const PENALTY_BACKOFF_CAP = 100;
const PENALTY_BACKOFF_PER_LEVEL = 25;
const PENALTY_DEGRADED = 2500;
const ERROR_RATE_WINDOW_MS = 15 * 60 * 1000;

export const W_SESSION_SEC = 5 * 60 * 60;
export const W_WEEKLY_SEC = 7 * 24 * 60 * 60;
export const URGENCY_CAP = 100;
export const URGENCY_FLOOR = 1;

/**
 * v7 burn-rate pressure for a single quota track.
 *
 * Concept: "what burn multiple of the normal rate must this account sustain
 * to consume Q% before reset?" Larger multiplier = more perishable.
 *
 * Normal rate is 100/W per second. Required rate to drain Q% in t seconds
 * is Q/t. The pressure score is `Q × W/t` (Q scaled by required burn relative
 * to normal). NOT a literal "expected wasted percentage" — a routing urgency
 * signal calibrated to keep score upper bound at 10000 and lower bound ≥ Q.
 *
 *   t = null OR non-finite (e.g. Number.POSITIVE_INFINITY)
 *                       → fresh quota OR unknown timer; max urgency = Q×CAP.
 *                         scoreSessionTrack/scoreWeeklyTrack only emits this
 *                         path when Q=100 (F3 fresh-quota branch), so this
 *                         conservatively over-prioritizes ambiguous timers.
 *   t ≤ 0               → stale / past reset; saturated to Q×URGENCY_CAP.
 *                         (Defensive — quotaCache.ts:276-283 nullifies expired
 *                         resetAt before scoring, so this branch is unreachable
 *                         via normal cache state today; retained for direct
 *                         callers and regression safety.)
 *   0 < t ≤ W/CAP       → multiplier saturated at URGENCY_CAP (very urgent).
 *   W/CAP < t ≤ W       → multiplier = W/t ∈ (1, CAP].
 *   t > W               → multiplier floored at URGENCY_FLOOR=1, so
 *                         pressure = Q (lower bound).
 *   Q < MIN_USABLE_REMAINING_PCT → returns -Infinity (defensive; in practice
 *                         scoreSession/WeeklyTrack already returns kind:"excluded").
 */
export interface PressureOptions {
  bypassMinUsable?: boolean;
}

export function pressure(
  Q: number,
  t: number | null,
  W: number,
  opts: PressureOptions = {}
): number {
  if (!opts.bypassMinUsable && Q < MIN_USABLE_REMAINING_PCT) return -Infinity;
  if (t === null || !Number.isFinite(t)) return Q * URGENCY_CAP;
  if (t <= 0) return Q * URGENCY_CAP;
  const multiplier = Math.max(URGENCY_FLOOR, Math.min(W / t, URGENCY_CAP));
  return Q * multiplier;
}

/**
 * @deprecated since v7. Returns the v6 stepwise time-urgency point for a
 * session window. v7 scoring uses `pressure()` directly; this function is
 * retained for diagnostic UIs, external callers, and tests that inspect
 * the v6-era band table. NOT used by the v7 scoring path.
 */
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

/**
 * @deprecated since v7. Returns the v6 stepwise time-urgency point for a
 * weekly window. v7 scoring uses `pressure()` directly; this function is
 * retained for diagnostic UIs, external callers, and tests that inspect
 * the v6-era band table. NOT used by the v7 scoring path.
 */
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

export function scoreSessionTrack(connId: string, lowQuotaBypass = false): TrackResult {
  const status = getQuotaWindowStatus(connId, "session", 90);
  if (!status) return { kind: "missing" };

  const Q = status.remainingPercentage;

  if (Q <= 0) {
    return { kind: "excluded", reason: "session<=0%", resetAt: status.resetAt };
  }
  if (!lowQuotaBypass && Q < MIN_USABLE_REMAINING_PCT) {
    return { kind: "excluded", reason: "session<5%", resetAt: status.resetAt };
  }

  const sec = deltaSec(status.resetAt);
  const pOpts: PressureOptions = { bypassMinUsable: lowQuotaBypass };

  if (sec === null && Q === 100) {
    return {
      kind: "known",
      score: pressure(Q, null, W_SESSION_SEC, pOpts),
      remainingPct: Q,
      resetAt: null,
      secondsToReset: Number.POSITIVE_INFINITY,
      windowName: "session",
    };
  }
  if (sec === null) return { kind: "missing" };

  return {
    kind: "known",
    score: pressure(Q, sec, W_SESSION_SEC, pOpts),
    remainingPct: Q,
    resetAt: status.resetAt,
    secondsToReset: sec,
    windowName: "session",
  };
}

// F2: model-specific weekly windows (Omelette/Sonnet) are deliberately ignored
// per user instruction. Routing reads only the overall `weekly` window —
// model-aware quota separation is not modelled. If Anthropic 429s an opus
// request because per-model quota is exhausted, accountFallback handles retry.
export function scoreWeeklyTrack(connId: string, lowQuotaBypass = false): TrackResult {
  const overall = getQuotaWindowStatus(connId, "weekly", 90);
  if (!overall) return { kind: "missing" };

  const Q = overall.remainingPercentage;

  if (Q <= 0) {
    return { kind: "excluded", reason: "weekly<=0%", resetAt: overall.resetAt };
  }
  if (!lowQuotaBypass && Q < MIN_USABLE_REMAINING_PCT) {
    return { kind: "excluded", reason: "weekly<5%", resetAt: overall.resetAt };
  }

  const sec = deltaSec(overall.resetAt);
  const pOpts: PressureOptions = { bypassMinUsable: lowQuotaBypass };

  if (sec === null && Q === 100) {
    return {
      kind: "known",
      score: pressure(Q, null, W_WEEKLY_SEC, pOpts),
      remainingPct: Q,
      resetAt: null,
      secondsToReset: Number.POSITIVE_INFINITY,
      windowName: "weekly",
    };
  }
  if (sec === null) return { kind: "missing" };

  return {
    kind: "known",
    score: pressure(Q, sec, W_WEEKLY_SEC, pOpts),
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

export function scoreAccount(conn: ConnectionLike, lowQuotaBypass = false): ScoredCandidate {
  const s = scoreSessionTrack(conn.id, lowQuotaBypass);
  const w = scoreWeeklyTrack(conn.id, lowQuotaBypass);

  // Terminal connection statuses (banned / expired / credits_exhausted) must
  // be excluded regardless of cached quota state. Without this guard a stale
  // quota snapshot would let a banned/expired account stay eligible in the
  // fall-through path of selectByEarliestResetFirst (isAffinityValid already
  // rejects terminal for the bound branch). Mirrors the auth.ts contract.
  if (isTerminalConnectionStatus(conn)) {
    return {
      conn,
      excluded: true,
      reason: "terminal",
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

  const baseScore = Math.max(...trackScores);

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

// Per-session timestamp of the most recent heuristic affinity break.
// In-memory only; bounded by BOTH age (10 min) AND hard size cap (1000) to
// guarantee bounded memory even if the process sees >1000 distinct sessions
// inside the cooldown window. Map preserves insertion order, so the oldest
// entries are evicted first when the size cap kicks in. Copilot PR #26 review.
const heuristicBreakHistory = new Map<string, number>();
const HEURISTIC_BREAK_GC_MAX_ENTRIES = 1000;
const HEURISTIC_BREAK_GC_MAX_AGE_MS = 10 * 60 * 1000;

function isHeuristicBreakInCooldown(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const last = heuristicBreakHistory.get(sessionId);
  if (last === undefined) return false;
  return Date.now() - last < AFFINITY_HEURISTIC_BREAK_COOLDOWN_MS;
}

function recordHeuristicBreak(sessionId: string | null): void {
  if (!sessionId) return;
  // Re-set deletes + re-inserts so the entry moves to the end of the
  // insertion-ordered Map. Matters for the hard-size eviction below.
  heuristicBreakHistory.delete(sessionId);
  heuristicBreakHistory.set(sessionId, Date.now());

  const cutoff = Date.now() - HEURISTIC_BREAK_GC_MAX_AGE_MS;
  for (const [sid, ts] of heuristicBreakHistory) {
    if (ts < cutoff) heuristicBreakHistory.delete(sid);
  }

  while (heuristicBreakHistory.size > HEURISTIC_BREAK_GC_MAX_ENTRIES) {
    const oldestKey = heuristicBreakHistory.keys().next().value;
    if (oldestKey === undefined) break;
    heuristicBreakHistory.delete(oldestKey);
  }
}

// Test-only: reset the heuristic break history. Used by unit tests to
// avoid cross-test pollution of the module-level cooldown map.
export function __resetAffinityHeuristicCooldownForTesting(): void {
  heuristicBreakHistory.clear();
}

export function isAffinityValid(
  conn: ConnectionLike,
  sessionId: string | null,
  scoredAlternatives?: ScoredCandidate[],
  provider?: string | null,
  lowQuotaBypass = false
): AffinityValidity {
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

  const s = scoreSessionTrack(conn.id, lowQuotaBypass);
  if (s.kind === "excluded") return { valid: false, reason: s.reason };
  const w = scoreWeeklyTrack(conn.id, lowQuotaBypass);
  if (w.kind === "excluded") return { valid: false, reason: w.reason };

  // Smart continuation viability: only checked when caller passes pre-scored
  // alternatives (selectByEarliestResetFirst does). Existing tests that call
  // isAffinityValid(conn, sessionId) without alternatives skip this entirely
  // — backwards compatible.
  if (scoredAlternatives && scoredAlternatives.length > 0) {
    const usable = scoredAlternatives.filter((sc) => !sc.excluded && sc.conn.id !== conn.id);
    if (usable.length === 0) {
      // No alt to switch to — staying is the only choice. Don't break.
      return { valid: true };
    }

    // Heuristic break #1: bound's minimum known remaining track is below the
    // safety floor AND a usable alternative exists (cooldown gates oscillation).
    const knownPcts: number[] = [];
    if (s.kind === "known") knownPcts.push(s.remainingPct);
    if (w.kind === "known") knownPcts.push(w.remainingPct);
    if (knownPcts.length > 0) {
      const minKnownPct = Math.min(...knownPcts);
      if (minKnownPct < MIN_AFFINITY_REMAINING_PCT && !isHeuristicBreakInCooldown(sessionId)) {
        recordHeuristicBreak(sessionId);
        return { valid: false, reason: "affinity_break_low_quota" };
      }
    }

    // Heuristic break #2: a usable alt is so much more urgent that one cache
    // write is cheaper than 5 more minutes of suboptimal routing. Combine
    // multiplicative factor with absolute delta to neutralize misfire near zero.
    // Reuse the precomputed bound score from scoredAlternatives instead of
    // re-running scoreAccount(conn) — which would re-read quota cache and
    // contradict the "score upfront once" intent in selectByEarliestResetFirst.
    const boundScored = scoredAlternatives.find((sc) => sc.conn.id === conn.id);
    if (!boundScored) {
      // Caller passed a scored list that does not include bound. Production
      // selectByEarliestResetFirst always includes it, so this only happens
      // if a future caller misuses the API. Refuse to break on a missing
      // signal: keep affinity rather than falling through to boundScore=0
      // (which would let any positive alt trigger an urgent break).
      return { valid: true };
    }
    const boundScore = boundScored.score ?? 0;
    const bestAltScore = Math.max(...usable.map((sc) => sc.score ?? 0));

    let isHeavyGap: boolean;
    if (boundScore <= 0) {
      // Negative bound score means heavy backoff penalty already wiped its
      // viability; any positive usable alt is strictly better.
      isHeavyGap = bestAltScore > 0;
    } else {
      isHeavyGap =
        bestAltScore >= boundScore * HEAVY_GAP_FACTOR &&
        bestAltScore >= boundScore + MIN_HEAVY_GAP_ABSOLUTE_DELTA;
    }

    // Cache-sensitive provider gate (Oracle audit ses_1fa7165c0ffeFFU8rjU82y0ItO):
    // Anthropic Claude OAuth lane uses 5-minute prompt cache (write 1.25x,
    // read 0.1x). A 147k-token cache rewrite costs ~12.5x what a single read
    // does; the urgent-alt break would have to be amortised over 12+ reads
    // in 5 minutes to pay for itself, which a typical chat workload cannot.
    // For Claude, suppress the urgent-alt break unless the bound is already
    // non-positive score (genuinely unusable via accumulated backoff/error
    // penalty) — in that case any positive alt still escapes via the
    // boundScore <= 0 branch above. Other break paths (terminal, rate_limited,
    // quota_exhausted, low-quota < 15%, session_expired, affinity_window_passed)
    // are unaffected. Other providers (codex, github, etc.) keep the
    // original break behaviour because their cache economics differ.
    const isCacheSensitive = (provider || "").toLowerCase() === "claude";
    const allowUrgentBreak = !isCacheSensitive || boundScore <= 0;

    if (isHeavyGap && allowUrgentBreak && !isHeuristicBreakInCooldown(sessionId)) {
      recordHeuristicBreak(sessionId);
      return { valid: false, reason: "affinity_break_p1_too_urgent" };
    }

    if (isHeavyGap && !allowUrgentBreak) {
      log.debug("AUTH/affinity", "urgent-alt break suppressed by cache-sensitive gate", {
        sessionId,
        provider,
        boundScore,
        bestAltScore,
        gate: "claude_urgent_alt_suppressed",
      });
    }
  }

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
  sessionId: string | null,
  provider?: string | null,
  lowQuotaBypass = false
): { selected: ConnectionLike } | AllExcludedResult {
  const scored: ScoredCandidate[] = candidates.map((c) => scoreAccount(c, lowQuotaBypass));

  if (sessionId) {
    const boundId = getSessionConnection(sessionId);
    if (boundId) {
      const bound = candidates.find((c) => c.id === boundId);
      const affinity = bound
        ? isAffinityValid(bound, sessionId, scored, provider, lowQuotaBypass)
        : null;
      if (bound && affinity?.valid === true) {
        log.debug("AUTH/affinity", "kept", {
          sessionId,
          provider: provider ?? null,
          boundId,
          decision: "kept_affinity",
        });
        return { selected: bound };
      }
      if (bound && affinity && affinity.valid === false) {
        const boundScored = scored.find((sc) => sc.conn.id === boundId);
        const usableAlts = scored.filter((sc) => !sc.excluded && sc.conn.id !== boundId);
        const bestAltScore =
          usableAlts.length > 0 ? Math.max(...usableAlts.map((sc) => sc.score ?? 0)) : null;
        // Heuristic-break reasons are the diagnostic alarm signal — they
        // indicate the smart-affinity logic actively chose to break a
        // healthy binding, which is rare and warrants production attention.
        // Non-heuristic reasons (window expiry, hard exclusions like terminal
        // / rate_limited / quota_exhausted_unknown_reset, inactive, track-
        // excluded) are EXPECTED affinity invalidations during normal
        // routing and should not pollute warn-level production logs.
        const isHeuristicBreak =
          affinity.reason === "affinity_break_low_quota" ||
          affinity.reason === "affinity_break_p1_too_urgent";
        const logLevel = isHeuristicBreak ? "warn" : "debug";
        log[logLevel]("AUTH/affinity", "broken", {
          sessionId,
          provider: provider ?? null,
          oldBound: boundId,
          decision: "fall_through_break",
          reason: affinity.reason,
          boundScore: boundScored?.score ?? null,
          bestAltScore,
        });
      }
    }
  }

  const usable = scored.filter((s) => !s.excluded);

  if (usable.length === 0) return buildAllExcluded(scored);

  usable.sort(candidateComparator);
  const selected = usable[0].conn;

  // Strategy-level binding has been removed (Copilot PR #28 R3-2). The
  // caller (chat.ts:548 → bindSessionConnection with source resolved from
  // runtimeOptions.emergencyFallbackTried) is responsible for the actual
  // session binding decision so the source is accurate. If the strategy
  // bound here with a hard-coded "fall_through" source, the emergency-
  // fallback alarm suppression in bindSessionConnection would never apply
  // because that first bind happens BEFORE the post-credential bind and
  // would always be a within-window rebind with the wrong source.
  if (sessionId) {
    log.debug("AUTH/affinity", "fall-through selected", {
      sessionId,
      provider: provider ?? null,
      selected: selected.id,
    });
  }

  return { selected };
}
