import test from "node:test";
import assert from "node:assert/strict";

const earliestResetFirst = await import("../../src/sse/services/strategies/earliestResetFirst.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const sessionManager = await import("../../open-sse/services/sessionManager.ts");
const accountTerminalStatus = await import("../../src/sse/services/accountTerminalStatus.ts");

const {
  sessionTimePoints,
  weeklyTimePoints,
  scoreSessionTrack,
  scoreWeeklyTrack,
  scoreAccount,
  candidateComparator,
  isAffinityValid,
  selectByEarliestResetFirst,
  pressure,
  W_SESSION_SEC,
  W_WEEKLY_SEC,
  URGENCY_CAP,
  URGENCY_FLOOR,
  __resetAffinityHeuristicCooldownForTesting,
} = earliestResetFirst;

function expectedPressure(Q, sec, W) {
  if (Q < 5) return -Infinity;
  if (sec === null || !Number.isFinite(sec)) return Q * URGENCY_CAP;
  if (sec <= 0) return Q * URGENCY_CAP;
  return Q * Math.max(URGENCY_FLOOR, Math.min(W / sec, URGENCY_CAP));
}

// Pressure values from two calls computed via different live `Date.now()`
// readings can differ by one floor() step in deltaSec() in either direction
// (the second call may see sec-1 OR sec+1 depending on which call happened
// first relative to the millisecond rollover). Build an inclusive [lo, hi]
// band that tolerates ±1 second of drift so CI hosts with slower clocks
// don't trip 1e-9 equality assertions.
function pressureDriftBand(Q, sec, W) {
  const candidates = [
    expectedPressure(Q, sec - 1, W),
    expectedPressure(Q, sec, W),
    expectedPressure(Q, sec + 1, W),
  ];
  return [Math.min(...candidates), Math.max(...candidates)];
}

// True when `actual` is inside any of the per-track drift bands AFTER taking
// the max() across tracks. Used for assertions on `scoreAccount(...).score`
// where the test cannot read the exact secondsToReset the scorer used.
function withinPressureMaxBand(actual, tracks) {
  let lo = -Infinity;
  let hi = -Infinity;
  for (const [Q, sec, W] of tracks) {
    const [tLo, tHi] = pressureDriftBand(Q, sec, W);
    if (tLo > lo) lo = tLo;
    if (tHi > hi) hi = tHi;
  }
  return actual >= lo - 1e-9 && actual <= hi + 1e-9;
}

const { setQuotaCache, markAccountExhaustedFrom429 } = quotaCache;
const { isTerminalConnectionStatus, normalizeStatus } = accountTerminalStatus;
const { clearSessions, touchSession, generateSessionId } = sessionManager;

function resetCacheState() {
  // The quotaCache module exposes no clear() helper. We seed deterministic
  // entries per-test by overwriting via setQuotaCache. Sessions are wiped via
  // sessionManager.clearSessions().
  clearSessions();
}

function isoIn(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// v6 fixture: only session + weekly windows are seeded. Per-model windows
// (Omelette/Sonnet) are intentionally absent — v6 ignores them entirely.
function seedClaudeAccount(connId, opts) {
  const quotas = {
    "session (5h)": {
      remainingPercentage: opts.sessionRem,
      resetAt: opts.sessionResetSec === null ? null : isoIn(opts.sessionResetSec),
    },
    "weekly (7d)": {
      remainingPercentage: opts.weeklyRem,
      resetAt: opts.weeklyResetSec === null ? null : isoIn(opts.weeklyResetSec),
    },
  };
  setQuotaCache(connId, "claude", quotas);
}

function seedSingleWeeklyAccount(connId, provider, opts) {
  const quotas = {
    "weekly (7d)": {
      remainingPercentage: opts.weeklyRem,
      resetAt: opts.weeklyResetSec === null ? null : isoIn(opts.weeklyResetSec),
    },
  };
  setQuotaCache(connId, provider, quotas);
}

const claudeConn = (id, extras = {}) => ({
  id,
  isActive: extras.isActive ?? true,
  rateLimitedUntil: extras.rateLimitedUntil ?? null,
  testStatus: extras.testStatus ?? "active",
  backoffLevel: extras.backoffLevel ?? 0,
  lastError: extras.lastError ?? null,
});

test.beforeEach(() => {
  resetCacheState();
  __resetAffinityHeuristicCooldownForTesting();
});

// ─── 1. Stepwise boundary tests ──────────────────────────────────────────────

test("sessionTimePoints: <= 5*60 returns 100", () => {
  assert.equal(sessionTimePoints(0), 100);
  assert.equal(sessionTimePoints(1), 100);
  assert.equal(sessionTimePoints(300), 100);
});

test("sessionTimePoints: just past 5min returns 85", () => {
  assert.equal(sessionTimePoints(301), 85);
  assert.equal(sessionTimePoints(900), 85);
});

test("sessionTimePoints: just past 15min returns 65", () => {
  assert.equal(sessionTimePoints(901), 65);
  assert.equal(sessionTimePoints(3600), 65);
});

test("sessionTimePoints: just past 1h returns 40", () => {
  assert.equal(sessionTimePoints(3601), 40);
  assert.equal(sessionTimePoints(10800), 40);
  assert.equal(sessionTimePoints(4080), 40, "1h 8m ≡ 4080s should be in >1h~3h band");
});

test("sessionTimePoints: just past 3h returns 20", () => {
  assert.equal(sessionTimePoints(10801), 20);
  assert.equal(sessionTimePoints(21600), 20);
  assert.equal(sessionTimePoints(16680), 20, "4h 38m ≡ 16680s should be in >3h~6h band");
  assert.equal(sessionTimePoints(18000), 20, "5h ≡ 18000s should still be in <=6h band");
});

test("sessionTimePoints: past 6h returns 10", () => {
  assert.equal(sessionTimePoints(21601), 10);
  assert.equal(sessionTimePoints(86400), 10);
});

test("sessionTimePoints: null returns null, negative returns 100", () => {
  assert.equal(sessionTimePoints(null), null);
  assert.equal(sessionTimePoints(-1), 100, "past resets => max urgency for refresh");
  assert.equal(sessionTimePoints(-100), 100);
});

test("weeklyTimePoints: boundary table", () => {
  assert.equal(weeklyTimePoints(0), 100);
  assert.equal(weeklyTimePoints(3600), 100);
  assert.equal(weeklyTimePoints(3601), 85);
  assert.equal(weeklyTimePoints(21600), 85);
  assert.equal(weeklyTimePoints(21601), 65);
  assert.equal(weeklyTimePoints(86400), 65);
  assert.equal(weeklyTimePoints(86401), 40);
  assert.equal(weeklyTimePoints(259200), 40);
  assert.equal(weeklyTimePoints(241200), 40, "2d 19h ≡ 241200s in >1d~3d band");
  assert.equal(weeklyTimePoints(259201), 20);
  assert.equal(weeklyTimePoints(396000), 20, "4d 14h ≡ 396000s in >3d~7d band");
  assert.equal(weeklyTimePoints(435600), 20, "5d 1h ≡ 435600s in >3d~7d band");
  assert.equal(weeklyTimePoints(320400), 20, "3d 17h ≡ 320400s in >3d~7d band");
  assert.equal(weeklyTimePoints(604800), 20);
  assert.equal(weeklyTimePoints(604801), 10);
  assert.equal(weeklyTimePoints(null), null);
  assert.equal(weeklyTimePoints(-1), 100);
});

// ─── 2. Multiplicative track scoring (v6 §2.4) ───────────────────────────────

test("v7 scoreSessionTrack: pressure(Q=10, sec, W_SESSION)", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 10,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  const s = scoreSessionTrack("gnumax");
  assert.equal(s.kind, "known");
  const expected = expectedPressure(10, s.secondsToReset, W_SESSION_SEC);
  assert.ok(
    Math.abs(s.score - expected) < 1e-9,
    `score=${s.score} expected=${expected} (sec=${s.secondsToReset})`
  );
  assert.equal(s.remainingPct, 10);
});

test("v7 scoreWeeklyTrack: pressure(Q=62, sec, W_WEEKLY); ignores per-model windows", () => {
  setQuotaCache("gnumax", "claude", {
    "weekly (7d)": {
      remainingPercentage: 62,
      resetAt: isoIn(435600),
    },
    "weekly Sonnet (7d)": {
      remainingPercentage: 88,
      resetAt: isoIn(435600),
    },
    "weekly Omelette (7d)": {
      remainingPercentage: 0,
      resetAt: isoIn(435600),
    },
  });
  const w = scoreWeeklyTrack("gnumax");
  assert.equal(w.kind, "known");
  assert.equal(w.remainingPct, 62, "uses overall weekly only, not bottleneck");
  const expected = expectedPressure(62, w.secondsToReset, W_WEEKLY_SEC);
  assert.ok(Math.abs(w.score - expected) < 1e-9);
});

test("v7 scoreWeeklyTrack: signature does not accept modelHint", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  const w = scoreWeeklyTrack("gnumax");
  assert.equal(w.kind, "known");
  const expected = expectedPressure(62, w.secondsToReset, W_WEEKLY_SEC);
  assert.ok(Math.abs(w.score - expected) < 1e-9);
});

// ─── 3. Hard exclusion ───────────────────────────────────────────────────────

test("Session < 5% excludes account regardless of weekly", () => {
  seedClaudeAccount("dryacct", {
    sessionRem: 4,
    sessionResetSec: 4080,
    weeklyRem: 80,
    weeklyResetSec: 435600,
  });
  const result = scoreAccount(claudeConn("dryacct"));
  assert.equal(result.excluded, true);
  assert.match(result.reason, /session<5%/);
});

test("Weekly < 5% excludes account regardless of session", () => {
  seedClaudeAccount("dryweekly", {
    sessionRem: 80,
    sessionResetSec: 4080,
    weeklyRem: 3,
    weeklyResetSec: 435600,
  });
  const result = scoreAccount(claudeConn("dryweekly"));
  assert.equal(result.excluded, true);
  assert.match(result.reason, /weekly<5%/);
});

test("All candidates excluded → returns retryAfter from earliest excluded reset", () => {
  seedClaudeAccount("a", {
    sessionRem: 4,
    sessionResetSec: 1000,
    weeklyRem: 50,
    weeklyResetSec: 5000,
  });
  seedClaudeAccount("b", {
    sessionRem: 3,
    sessionResetSec: 2000,
    weeklyRem: 50,
    weeklyResetSec: 5000,
  });
  const result = selectByEarliestResetFirst([claudeConn("a"), claudeConn("b")], null);
  assert.equal(result.allExcluded, true);
  assert.equal(result.excludedBreakdown.length, 2);
  // Earliest reset should come from "a" (sessionResetSec=1000)
  const aReset = new Date(result.retryAfterIso).getTime();
  const expected = Date.now() + 1000 * 1000;
  assert.ok(Math.abs(aReset - expected) < 5000, "retryAfter ~ a's session reset");
});

// ─── 4. Reweighting / missing tracks ─────────────────────────────────────────

test("github-style account with no session window scores from weekly only", () => {
  seedSingleWeeklyAccount("ghacct", "github", {
    weeklyRem: 80,
    weeklyResetSec: 396000,
  });
  const s = scoreSessionTrack("ghacct");
  assert.equal(s.kind, "missing", "no session window → missing");
  const w = scoreWeeklyTrack("ghacct");
  assert.equal(w.kind, "known");
  const expectedW = expectedPressure(80, w.secondsToReset, W_WEEKLY_SEC);
  assert.ok(Math.abs(w.score - expectedW) < 1e-9);

  const result = scoreAccount(claudeConn("ghacct"));
  assert.equal(result.excluded, false);
  assert.ok(
    withinPressureMaxBand(result.score, [[80, w.secondsToReset, W_WEEKLY_SEC]]),
    `single track: result.score=${result.score} should be in pressure drift band`
  );
});

// ─── 5. F1: no_quota_data fallback (self-hosted / openai-compatible) ─────────

test("F1-1: openai-compatible (no cache) → score=0, eligible (NOT excluded)", () => {
  // No setQuotaCache call → both tracks "missing" → trackScores empty.
  // v6 distinguishes this from quota-exhausted: cache entry absent → score=0.
  const uniqueId = `openai-compat-${Math.random().toString(36).slice(2)}`;
  const result = scoreAccount(claudeConn(uniqueId));
  assert.equal(result.excluded, false, "self-hosted must remain eligible");
  assert.equal(result.score, 0);
  assert.equal(result.earliestReset, null);
});

test("F1-2: paid (score>0) + openai-compatible (score=0) → paid wins", () => {
  seedClaudeAccount("paid", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 60,
    weeklyResetSec: 435600,
  });
  const compatId = `compat-${Math.random().toString(36).slice(2)}`;
  // No seed for compatId → score=0 fallback
  const result = selectByEarliestResetFirst([claudeConn("paid"), claudeConn(compatId)], null);
  assert.equal(result.selected.id, "paid");
});

test("F1-3: two openai-compatible (both score=0) → lex id smaller wins", () => {
  // No seeds → both fallback to score=0. Tie-break: equal earliestReset (null
  // → +Infinity), then lex id ascending → "aaa" wins.
  const result = selectByEarliestResetFirst(
    [claudeConn("zzz-compat"), claudeConn("aaa-compat")],
    null
  );
  assert.equal(result.selected.id, "aaa-compat");
});

test("F1-4: 429-marked empty cache → excluded (NOT revived as score=0)", () => {
  // markAccountExhaustedFrom429 creates {quotas:{}, exhausted:true} entry.
  // v6 must detect this via isAccountQuotaExhausted and exclude — NOT treat
  // as "self-hosted no-cache" eligible at score=0.
  const exhaustedId = `exhausted-${Math.random().toString(36).slice(2)}`;
  markAccountExhaustedFrom429(exhaustedId, "claude");
  const result = scoreAccount(claudeConn(exhaustedId));
  assert.equal(result.excluded, true);
  assert.equal(result.reason, "quota_exhausted_unknown_reset");
});

// ─── 6. F2: model-specific weekly windows ignored ────────────────────────────

test("F2-1: routing decision is identical for opus/sonnet/haiku", () => {
  // Seed both accounts with model-specific windows that would have caused
  // v4 to split per-model. v6 must produce the SAME selection regardless of
  // whether we pass null or any model name (because modelHint is gone).
  setQuotaCache("apex", "claude", {
    "session (5h)": { remainingPercentage: 50, resetAt: isoIn(4080) },
    "weekly (7d)": { remainingPercentage: 50, resetAt: isoIn(320400) },
    "weekly Sonnet (7d)": { remainingPercentage: 90, resetAt: isoIn(320400) },
    "weekly Omelette (7d)": { remainingPercentage: 10, resetAt: isoIn(320400) },
  });
  setQuotaCache("gnumax", "claude", {
    "session (5h)": { remainingPercentage: 70, resetAt: isoIn(4080) },
    "weekly (7d)": { remainingPercentage: 60, resetAt: isoIn(435600) },
    "weekly Sonnet (7d)": { remainingPercentage: 100, resetAt: isoIn(435600) },
    "weekly Omelette (7d)": { remainingPercentage: 80, resetAt: isoIn(435600) },
  });
  // v6 selectByEarliestResetFirst takes (candidates, sessionId) — no modelHint.
  const r1 = selectByEarliestResetFirst([claudeConn("apex"), claudeConn("gnumax")], null);
  // Same call again to ensure determinism (no global state pollution).
  const r2 = selectByEarliestResetFirst([claudeConn("apex"), claudeConn("gnumax")], null);
  assert.equal(r1.selected.id, r2.selected.id);
});

test("F2-2: weekly Omelette=0% (would have hard-excluded in v4) does NOT exclude in v6/v7", () => {
  setQuotaCache("apex", "claude", {
    "session (5h)": { remainingPercentage: 50, resetAt: isoIn(4080) },
    "weekly (7d)": { remainingPercentage: 50, resetAt: isoIn(320400) },
    "weekly Omelette (7d)": { remainingPercentage: 0, resetAt: isoIn(320400) },
  });
  const result = scoreAccount(claudeConn("apex"));
  assert.equal(result.excluded, false, "v6/v7 ignores per-model windows entirely");
  const s = scoreSessionTrack("apex");
  const w = scoreWeeklyTrack("apex");
  assert.ok(
    withinPressureMaxBand(result.score, [
      [50, s.secondsToReset, W_SESSION_SEC],
      [50, w.secondsToReset, W_WEEKLY_SEC],
    ]),
    `v7 baseScore = max within drift band, got ${result.score}`
  );
});

// ─── 7. F3: fresh quota (Q=100 AND resetAt=null) ─────────────────────────────

test("F3-1: session resetAt=null AND Q=100 → score = 10000 (fresh)", () => {
  setQuotaCache("fresh", "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 80, resetAt: isoIn(435600) },
  });
  const s = scoreSessionTrack("fresh");
  assert.equal(s.kind, "known");
  assert.equal(s.score, 100 * URGENCY_CAP, "Q=100 × URGENCY_CAP=100 (fresh max-urgency)");
  assert.equal(s.resetAt, null);
});

test("F3-2: session resetAt=null AND Q=80 → kind=missing (NOT fresh)", () => {
  setQuotaCache("ambiguous", "claude", {
    "session (5h)": { remainingPercentage: 80, resetAt: null },
    "weekly (7d)": { remainingPercentage: 80, resetAt: isoIn(435600) },
  });
  const s = scoreSessionTrack("ambiguous");
  assert.equal(s.kind, "missing", "non-100% null resetAt is ambiguous → missing");
});

test("F3-3: fresh session + normal weekly → v7 max(fresh=10000, weekly_pressure)", () => {
  setQuotaCache("fresh", "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 80, resetAt: isoIn(435600) },
  });
  const result = scoreAccount(claudeConn("fresh"));
  assert.equal(result.excluded, false);
  assert.equal(result.score, 100 * URGENCY_CAP, "v7 max: fresh dominates weekly pressure");
});

test("F3-4: fresh account beats burning account", () => {
  // A: fresh session (Q=100, resetAt=null) → s.score=10000, weekly Q=80, T=20 → w.score=1600 → avg 5800
  setQuotaCache("fresh", "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 80, resetAt: isoIn(435600) },
  });
  // B: burning session (Q=87, T=20 since 4h43m=17m ahead → 6h band? actually 17000s in 3h-6h band T=20) → s.score=1740, weekly Q=59 T=20 → w.score=1180 → avg 1460
  setQuotaCache("burning", "claude", {
    "session (5h)": { remainingPercentage: 87, resetAt: isoIn(17000) },
    "weekly (7d)": { remainingPercentage: 59, resetAt: isoIn(414000) },
  });
  const result = selectByEarliestResetFirst([claudeConn("fresh"), claudeConn("burning")], null);
  assert.equal(result.selected.id, "fresh");
});

test("F3-5: weekly resetAt=null AND Q=100 → score = 10000 (fresh weekly)", () => {
  setQuotaCache("freshweekly", "claude", {
    "session (5h)": { remainingPercentage: 80, resetAt: isoIn(4080) },
    "weekly (7d)": { remainingPercentage: 100, resetAt: null },
  });
  const w = scoreWeeklyTrack("freshweekly");
  assert.equal(w.kind, "known");
  assert.equal(w.score, 100 * URGENCY_CAP);
  assert.equal(w.resetAt, null);
});

test("F3-6: weekly resetAt=null AND Q<100 → missing", () => {
  setQuotaCache("ambiguousweekly", "claude", {
    "session (5h)": { remainingPercentage: 80, resetAt: isoIn(4080) },
    "weekly (7d)": { remainingPercentage: 70, resetAt: null },
  });
  const w = scoreWeeklyTrack("ambiguousweekly");
  assert.equal(w.kind, "missing");
});

// ─── 8. F4: multiplicative scoring user scenario ─────────────────────────────

test("F4-1 (v7-1): APEX(17%/2h, 35%/3d10h) vs GNUMAX(87%/4h, 59%/4d18h) → GNUMAX wins", () => {
  seedClaudeAccount("apex", {
    sessionRem: 17,
    sessionResetSec: 2 * 3600,
    weeklyRem: 35,
    weeklyResetSec: 3 * 86400 + 10 * 3600,
  });
  seedClaudeAccount("gnumax", {
    sessionRem: 87,
    sessionResetSec: 4 * 3600,
    weeklyRem: 59,
    weeklyResetSec: 4 * 86400 + 18 * 3600,
  });

  const apex = scoreAccount(claudeConn("apex"));
  const gnumax = scoreAccount(claudeConn("gnumax"));

  assert.ok(gnumax.score > apex.score, "GNUMAX must outrank APEX (burn-down semantic)");

  const result = selectByEarliestResetFirst([claudeConn("apex"), claudeConn("gnumax")], null);
  assert.equal(result.selected.id, "gnumax");
});

test("F4-2 (v7-4): backoffLevel=4 paid (max-backoff strict-loss) vs self-hosted score=0 → self-hosted wins", () => {
  seedClaudeAccount("flaky", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 60,
    weeklyResetSec: 435600,
  });
  const compatId = `compat-${Math.random().toString(36).slice(2)}`;
  const result = selectByEarliestResetFirst(
    [claudeConn("flaky", { backoffLevel: 4 }), claudeConn(compatId)],
    null
  );
  assert.equal(result.selected.id, compatId);
});

test("F4-3 (v7): low urgency abundant quota → max(pressure_session, pressure_weekly)", () => {
  seedClaudeAccount("idle", {
    sessionRem: 100,
    sessionResetSec: 7 * 3600,
    weeklyRem: 100,
    weeklyResetSec: 5 * 86400,
  });
  const result = scoreAccount(claudeConn("idle"));
  const s = scoreSessionTrack("idle");
  const w = scoreWeeklyTrack("idle");
  assert.ok(
    withinPressureMaxBand(result.score, [
      [100, s.secondsToReset, W_SESSION_SEC],
      [100, w.secondsToReset, W_WEEKLY_SEC],
    ])
  );
});

test("F4-4 (v7): Q boundary at exactly 5 → known (NOT excluded), score = pressure(5, sec, W)", () => {
  seedClaudeAccount("edge", {
    sessionRem: 5,
    sessionResetSec: 4080,
    weeklyRem: 50,
    weeklyResetSec: 435600,
  });
  const s = scoreSessionTrack("edge");
  assert.equal(s.kind, "known");
  const expected = expectedPressure(5, s.secondsToReset, W_SESSION_SEC);
  assert.ok(Math.abs(s.score - expected) < 1e-9);
});

test("F4-5: Q just under 5 (Q=4.999 rounded to 5 by safePercentage) — boundary check", () => {
  // remainingPercentage is rounded by safePercentage in quotaCache.ts. We
  // exercise the exact-5 boundary here; the <5 path is covered by other
  // hard-exclusion tests.
  seedClaudeAccount("edge2", {
    sessionRem: 5,
    sessionResetSec: 4080,
    weeklyRem: 50,
    weeklyResetSec: 435600,
  });
  const result = scoreAccount(claudeConn("edge2"));
  assert.equal(result.excluded, false, "Q=5 must remain eligible");
});

test("F4-6 (v7): higher pressure account wins; comparator tie-break covered by direct candidateComparator tests", () => {
  // v6 used T·Q with stepwise T_pts; equal-product fixtures collided in mean.
  // v7 pressure(Q,t,W)=Q×W/t is continuous, so seeded fixtures rarely tie at
  // baseScore. Pure tie-break behaviour is verified directly via
  // candidateComparator literal tests below; this integration test now only
  // asserts ordering by score.
  seedClaudeAccount("a", {
    sessionRem: 50,
    sessionResetSec: 3600,
    weeklyRem: 100,
    weeklyResetSec: 7 * 86400,
  });
  seedClaudeAccount("b", {
    sessionRem: 100,
    sessionResetSec: 4 * 3600,
    weeklyRem: 50,
    weeklyResetSec: 3 * 86400,
  });
  const aScore = scoreAccount(claudeConn("a")).score;
  const bScore = scoreAccount(claudeConn("b")).score;
  const result = selectByEarliestResetFirst([claudeConn("a"), claudeConn("b")], null);
  const expected = aScore > bScore ? "a" : bScore > aScore ? "b" : null;
  assert.ok(expected !== null, `v7 fixtures should not tie: a=${aScore}, b=${bScore}`);
  assert.equal(result.selected.id, expected);
});

// ─── 9. Affinity ─────────────────────────────────────────────────────────────

test("Affinity hit: same account selected within 5min", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
  });

  const sessionId = "test-affinity-hit";
  touchSession(sessionId, "gnumax");

  const result = selectByEarliestResetFirst([claudeConn("gnumax"), claudeConn("apex")], sessionId);
  assert.equal(result.selected.id, "gnumax", "affinity hit overrides cold-start scoring");
});

test("Affinity break on session<5%: bound account no longer valid", () => {
  // Bound account is GNUMAX with session 3% — must break and pick APEX
  seedClaudeAccount("gnumax", {
    sessionRem: 3,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
  });

  const sessionId = "test-affinity-break-quota";
  touchSession(sessionId, "gnumax");

  const result = selectByEarliestResetFirst([claudeConn("gnumax"), claudeConn("apex")], sessionId);
  assert.equal(result.selected.id, "apex", "GNUMAX excluded by quota → APEX selected");
});

test("Affinity for self-hosted (no cache) connection remains valid", () => {
  // Defensive regression test for F1: a self-hosted bound connection has
  // both tracks "missing" but isAffinityValid must NOT reject (no excluded
  // hard exclusion). The other affinity gates (session/rate-limit/terminal)
  // still apply.
  const compatId = `compat-${Math.random().toString(36).slice(2)}`;
  const sessionId = "test-affinity-self-hosted";
  touchSession(sessionId, compatId);
  const out = isAffinityValid(claudeConn(compatId), sessionId);
  assert.equal(out.valid, true, "self-hosted (no cache) bound conn keeps affinity");
});

test("Affinity break on 429-marked empty cache (Copilot PR #23 review)", () => {
  // Bound connection was exhausted via markAccountExhaustedFrom429: both
  // tracks return "missing" (empty quotas), but the cache says exhausted=true.
  // isAffinityValid must reject so we don't pin to a 429-burning account.
  const exhaustedId = `exhausted-affinity-${Math.random().toString(36).slice(2)}`;
  markAccountExhaustedFrom429(exhaustedId, "claude");
  const sessionId = "test-affinity-429-exhausted";
  touchSession(sessionId, exhaustedId);
  const out = isAffinityValid(claudeConn(exhaustedId), sessionId);
  assert.equal(out.valid, false);
  assert.equal(out.reason, "quota_exhausted_unknown_reset");
});

test("isAffinityValid detects rate-limited even when caller leaks one through", () => {
  // Defensive double-check: even if caller passes rate-limited connection
  // through (race window), isAffinityValid catches it.
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });

  const sessionId = "test-isvalid-rl";
  touchSession(sessionId, "gnumax");

  const futureRl = new Date(Date.now() + 60_000).toISOString();
  const out = isAffinityValid(claudeConn("gnumax", { rateLimitedUntil: futureRl }), sessionId);
  assert.equal(out.valid, false);
  assert.equal(out.reason, "rate_limited");
});

test("isAffinityValid: rateLimitedUntil ISO string parsed correctly", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  const sessionId = "test-rl-parse";
  touchSession(sessionId, "gnumax");

  const futureRl = new Date(Date.now() + 60_000).toISOString();
  const out1 = isAffinityValid(claudeConn("gnumax", { rateLimitedUntil: futureRl }), sessionId);
  assert.equal(out1.valid, false);
  assert.equal(out1.reason, "rate_limited");

  const pastRl = new Date(Date.now() - 60_000).toISOString();
  const out2 = isAffinityValid(claudeConn("gnumax", { rateLimitedUntil: pastRl }), sessionId);
  assert.equal(out2.valid, true, "past rate limit should not block");

  const out3 = isAffinityValid(claudeConn("gnumax", { rateLimitedUntil: null }), sessionId);
  assert.equal(out3.valid, true, "null rate limit should not block");

  const out4 = isAffinityValid(claudeConn("gnumax", { rateLimitedUntil: "" }), sessionId);
  assert.equal(out4.valid, true, "empty string rate limit should not block");

  const out5 = isAffinityValid(
    claudeConn("gnumax", { rateLimitedUntil: "not-a-real-iso-string" }),
    sessionId
  );
  assert.equal(
    out5.valid,
    true,
    "invalid ISO string parses to NaN, must not be treated as rate-limited"
  );
});

test("isAffinityValid: missing isActive (undefined) should NOT mark as inactive", () => {
  // Copilot review C2: ConnectionLike.isActive is optional. Only an explicit
  // `false` should mark a connection inactive — undefined means "field not
  // populated by the caller", which is common for partial test fixtures.
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  const sessionId = "test-isvalid-isactive-undefined";
  touchSession(sessionId, "gnumax");

  const partialConn = { id: "gnumax" };
  const out = isAffinityValid(partialConn, sessionId);
  assert.equal(out.valid, true, "undefined isActive must not falsely deactivate");
});

// ─── 10. Tie-breaking determinism ────────────────────────────────────────────

test("Tie-break: equal scores fall through to earliest reset asc", () => {
  const a = {
    conn: claudeConn("zzz-acct"),
    excluded: false,
    score: 50.0,
    earliestReset: isoIn(1000),
  };
  const b = {
    conn: claudeConn("aaa-acct"),
    excluded: false,
    score: 50.0,
    earliestReset: isoIn(2000),
  };
  // a has earlier reset → a wins
  assert.ok(candidateComparator(a, b) < 0);
});

test("Tie-break: equal score + equal reset falls through to connectionId lex asc", () => {
  const reset = isoIn(1000);
  const a = {
    conn: claudeConn("aaa-acct"),
    excluded: false,
    score: 50.0,
    earliestReset: reset,
  };
  const b = {
    conn: claudeConn("zzz-acct"),
    excluded: false,
    score: 50.0,
    earliestReset: reset,
  };
  assert.ok(candidateComparator(a, b) < 0);
});

test("Tie-break: epsilon 1e-9 only exact ties trigger fallback", () => {
  const a = {
    conn: claudeConn("a"),
    excluded: false,
    score: 50.0,
    earliestReset: isoIn(2000),
  };
  const b = {
    conn: claudeConn("b"),
    excluded: false,
    score: 50.5,
    earliestReset: isoIn(1000),
  };
  // Score difference 0.5 > epsilon → b wins by score even though a has earlier reset
  assert.ok(candidateComparator(a, b) > 0, "b should win by score primary");
});

// ─── 11. Fingerprint stability ───────────────────────────────────────────────

test("Fingerprint is stable for same conversation (system + first user msg)", () => {
  const body = {
    model: "claude-sonnet-4.5",
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "thanks" },
    ],
  };
  const opts = { provider: "claude" };
  const id1 = generateSessionId(body, opts);
  const id2 = generateSessionId(
    { ...body, messages: [...body.messages, { role: "user", content: "again" }] },
    opts
  );
  assert.equal(id1, id2, "appending turns must not change the fingerprint");
});

test("Fingerprint changes when system prompt changes", () => {
  const opts = { provider: "claude" };
  const id1 = generateSessionId(
    { model: "claude-sonnet-4.5", system: "v1", messages: [{ role: "user", content: "x" }] },
    opts
  );
  const id2 = generateSessionId(
    { model: "claude-sonnet-4.5", system: "v2", messages: [{ role: "user", content: "x" }] },
    opts
  );
  assert.notEqual(id1, id2, "system prompt change must invalidate fingerprint");
});

// ─── 12. Single-account pool ─────────────────────────────────────────────────

test("Single-account pool: codex-style account selected directly", () => {
  setQuotaCache("codex1", "codex", {
    "session (5h)": {
      remainingPercentage: 47,
      resetAt: isoIn(4800),
    },
    "weekly (7d)": {
      remainingPercentage: 50,
      resetAt: isoIn(241200),
    },
  });
  const result = selectByEarliestResetFirst([claudeConn("codex1")], null);
  assert.equal(result.selected.id, "codex1");
});

// ─── 13. Terminal status ─────────────────────────────────────────────────────

test("isTerminalConnectionStatus detects credits_exhausted/banned/expired", () => {
  assert.equal(isTerminalConnectionStatus({ testStatus: "credits_exhausted" }), true);
  assert.equal(isTerminalConnectionStatus({ testStatus: "banned" }), true);
  assert.equal(isTerminalConnectionStatus({ testStatus: "expired" }), true);
  assert.equal(isTerminalConnectionStatus({ testStatus: "active" }), false);
  assert.equal(isTerminalConnectionStatus({ testStatus: "rate_limited" }), false);
  assert.equal(isTerminalConnectionStatus({ testStatus: null }), false);
  assert.equal(isTerminalConnectionStatus({ testStatus: "  CREDITS_EXHAUSTED  " }), true);
});

test("normalizeStatus trims and lowercases", () => {
  assert.equal(normalizeStatus("ACTIVE"), "active");
  assert.equal(normalizeStatus("  banned  "), "banned");
  assert.equal(normalizeStatus(null), "");
  assert.equal(normalizeStatus(undefined), "");
});

test("isAffinityValid detects terminal status defensively", () => {
  // Same defensive contract as rate-limit: even if a terminal connection
  // leaks through caller's filter, isAffinityValid blocks the affinity hit.
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });

  const sessionId = "test-isvalid-terminal";
  touchSession(sessionId, "gnumax");

  const out = isAffinityValid(claudeConn("gnumax", { testStatus: "expired" }), sessionId);
  assert.equal(out.valid, false);
  assert.equal(out.reason, "terminal");
});

// ─── 14. v7 burn-pressure RED tests ──────────────────────────────────────────

test("V7-2: max() not mean() — A(p_s=100, p_w=50) vs B(p_s=80, p_w=80) → A wins by max", () => {
  // Q=20, t=3600 → pressure = 20 × W_S/3600 = 20 × 5 = 100
  // Q=50, t=W_W → pressure = 50 × 1 = 50
  // A v7 max = 100. v7 mean (if used) would be 75 → B (80) would beat A.
  seedClaudeAccount("a", {
    sessionRem: 20,
    sessionResetSec: 3600,
    weeklyRem: 50,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  // Q=80, t=W_S → pressure = 80; Q=80, t=W_W → pressure = 80. v7 max=80.
  seedClaudeAccount("b", {
    sessionRem: 80,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const a = scoreAccount(claudeConn("a"));
  const b = scoreAccount(claudeConn("b"));
  assert.ok(a.score > b.score, `v7 max picks A; got a=${a.score} b=${b.score}`);
  const result = selectByEarliestResetFirst([claudeConn("a"), claudeConn("b")], null);
  assert.equal(result.selected.id, "a");
});

test("V7-3: pressure floor — t > W clamps multiplier to 1, pressure = Q", () => {
  assert.equal(pressure(80, 2 * W_WEEKLY_SEC, W_WEEKLY_SEC), 80);
  assert.equal(pressure(50, 10 * W_SESSION_SEC, W_SESSION_SEC), 50);
});

test("V7-5 (defensive): pressure(Q, t<=0, W) saturates at Q × URGENCY_CAP", () => {
  // Direct unit test — quotaCache.ts:276-283 nullifies expired resetAt before
  // scoring, so this branch is unreachable via real cache state today. We test
  // pressure() directly to keep the defensive branch covered.
  assert.equal(pressure(50, -100, W_SESSION_SEC), 50 * URGENCY_CAP);
  assert.equal(pressure(50, 0, W_SESSION_SEC), 50 * URGENCY_CAP);
  assert.equal(pressure(80, -1, W_WEEKLY_SEC), 80 * URGENCY_CAP);
});

test("V7-6: two fresh accounts (Q=100, t=null) deterministically tie-break by lex connectionId", () => {
  setQuotaCache("zzz-fresh", "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 100, resetAt: null },
  });
  setQuotaCache("aaa-fresh", "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 100, resetAt: null },
  });
  const result = selectByEarliestResetFirst(
    [claudeConn("zzz-fresh"), claudeConn("aaa-fresh")],
    null
  );
  assert.equal(result.selected.id, "aaa-fresh", "lex tie-break picks smaller id");
});

test("V7-7: pressure(Q < MIN_USABLE_REMAINING_PCT, ...) returns -Infinity (defensive)", () => {
  assert.equal(pressure(4, 4080, W_SESSION_SEC), -Infinity);
  assert.equal(pressure(0, 4080, W_SESSION_SEC), -Infinity);
  assert.equal(pressure(4.999, 4080, W_SESSION_SEC), -Infinity);
});

test("V7-8: multiplier saturates at URGENCY_CAP for very small t", () => {
  // Q=80, t=10 → would be 80 × 1800 if uncapped. Cap at 100 → pressure=8000.
  assert.equal(pressure(80, 10, W_SESSION_SEC), 80 * URGENCY_CAP);
  assert.equal(pressure(50, 1, W_WEEKLY_SEC), 50 * URGENCY_CAP);
});

test("V7-direct: pressure() exact values for known fixtures", () => {
  assert.equal(pressure(20, 3600, W_SESSION_SEC), 100);
  assert.equal(pressure(50, W_WEEKLY_SEC, W_WEEKLY_SEC), 50);
  assert.equal(pressure(80, W_SESSION_SEC, W_SESSION_SEC), 80);
  assert.equal(pressure(100, null, W_SESSION_SEC), 10000);
  assert.equal(pressure(100, null, W_WEEKLY_SEC), 10000);
});

// ─── 15. v8 smart affinity continuation viability ────────────────────────────

test("SA-1: bound healthy + alt only 1.5x score → keep affinity (no break)", () => {
  // bound: Q=50, t=W_S (mid pressure). alt: Q=75, t=W_S (1.5× ratio, fails 3× test)
  seedClaudeAccount("bound", {
    sessionRem: 50,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  seedClaudeAccount("alt", {
    sessionRem: 75,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const sessionId = "sa-1-session";
  touchSession(sessionId, "bound");
  const result = selectByEarliestResetFirst([claudeConn("bound"), claudeConn("alt")], sessionId);
  assert.equal(result.selected.id, "bound", "1.5× alt should not break 3× threshold");
});

test("SA-2: alt 4x score AND >250 abs delta → break (heuristic_break_p1_too_urgent)", () => {
  // bound: Q=20, t=W_S → pressure=20. alt: Q=20, t=W_S/100 → pressure=20×100=2000.
  // ratio=100×, delta=1980 → triggers both factor and absolute delta gates
  seedClaudeAccount("bound", {
    sessionRem: 20,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  seedClaudeAccount("alt", {
    sessionRem: 20,
    sessionResetSec: 180, // W_SESSION_SEC / 100 = 180s
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const sessionId = "sa-2-session";
  touchSession(sessionId, "bound");
  const result = selectByEarliestResetFirst([claudeConn("bound"), claudeConn("alt")], sessionId);
  assert.equal(result.selected.id, "alt", "4×+ alt with large abs delta should break affinity");
});

test("SA-3: bound 10% session AND alt usable → break (heuristic_break_low_quota)", () => {
  // bound session=10% < MIN_AFFINITY_REMAINING_PCT=15 → break.
  // alt is given a strictly higher score so the post-break sort picks it
  // deterministically (we're testing that break HAPPENS, not the tie-break).
  seedClaudeAccount("bound", {
    sessionRem: 10,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  seedClaudeAccount("alt", {
    sessionRem: 100,
    sessionResetSec: W_SESSION_SEC / 4,
    weeklyRem: 100,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const sessionId = "sa-3-session";
  touchSession(sessionId, "bound");
  const result = selectByEarliestResetFirst([claudeConn("bound"), claudeConn("alt")], sessionId);
  assert.equal(result.selected.id, "alt", "bound below 15% with healthy alt should break");
});

test("SA-4: bound 10% session + NO usable alt → keep affinity (Oracle edge rule)", () => {
  // bound has low quota but only candidate
  seedClaudeAccount("bound", {
    sessionRem: 10,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const sessionId = "sa-4-session";
  touchSession(sessionId, "bound");
  const result = selectByEarliestResetFirst([claudeConn("bound")], sessionId);
  assert.equal(result.selected.id, "bound", "no usable alt → stay even with low Q");
});

test("SA-5/6: cooldown — first low-Q break records cooldown; re-test within window suppresses break", () => {
  const sessionId = `sa-5-session-${Math.random().toString(36).slice(2)}`;
  seedClaudeAccount("bound", {
    sessionRem: 10,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  seedClaudeAccount("alt", {
    sessionRem: 100,
    sessionResetSec: W_SESSION_SEC / 4,
    weeklyRem: 100,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  touchSession(sessionId, "bound");

  const r1 = selectByEarliestResetFirst([claudeConn("bound"), claudeConn("alt")], sessionId);
  assert.equal(r1.selected.id, "alt", "first break: low quota");

  // Re-bind to bound and re-test in the same tick. Real wall-clock has
  // advanced only a fraction of a millisecond between r1 and r2 — that is
  // strictly inside the 60s cooldown window, so the heuristic break must
  // be suppressed even though bound is still at 10%.
  touchSession(sessionId, "bound");
  const r2 = selectByEarliestResetFirst([claudeConn("bound"), claudeConn("alt")], sessionId);
  assert.equal(r2.selected.id, "bound", "cooldown active: heuristic break suppressed");
});

test("SA-7: hard exclusion (terminal) bypasses cooldown", () => {
  const sessionId = `sa-7-session-${Math.random().toString(36).slice(2)}`;
  seedClaudeAccount("bound", {
    sessionRem: 80,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  seedClaudeAccount("alt", {
    sessionRem: 80,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  touchSession(sessionId, "bound");

  // Bound is terminal → hard exclusion regardless of cooldown
  const result = selectByEarliestResetFirst(
    [claudeConn("bound", { testStatus: "expired" }), claudeConn("alt")],
    sessionId
  );
  assert.equal(result.selected.id, "alt", "terminal bypasses any cooldown");
});

test("SA-8: bound score = 0 (no quota cache) + alt with positive score → break", () => {
  // bound: no quotaCache entry → scoreAccount returns score=0
  // alt: real quota → positive score
  const boundId = `sa-8-bound-${Math.random().toString(36).slice(2)}`;
  seedClaudeAccount("alt", {
    sessionRem: 50,
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const sessionId = `sa-8-session-${Math.random().toString(36).slice(2)}`;
  touchSession(sessionId, boundId);

  const result = selectByEarliestResetFirst([claudeConn(boundId), claudeConn("alt")], sessionId);
  // bound score=0, alt score>0; with score<=0 special case + cooldown empty → break
  // But wait: in this test bound has Q=undefined → scoreSessionTrack returns
  // {kind:"missing"}, so the low-Q heuristic only kicks in when kind:"known".
  // With both tracks missing AND no cache entry, scoreAccount returns score=0.
  // For score<=0 special case: bestAlt > 0 → break.
  assert.equal(result.selected.id, "alt", "score<=0 + positive alt → break");
});

test("SA-9: bound s.kind=missing + w.kind=known low → low-quota check uses weekly only", () => {
  // bound: no session cache, weekly 10% → applies low-quota check to weekly only.
  // alt is given a strictly higher score for deterministic post-break sort.
  seedSingleWeeklyAccount("bound-w-only", "github", {
    weeklyRem: 10,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  seedClaudeAccount("alt", {
    sessionRem: 100,
    sessionResetSec: W_SESSION_SEC / 4,
    weeklyRem: 100,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const sessionId = `sa-9-session-${Math.random().toString(36).slice(2)}`;
  touchSession(sessionId, "bound-w-only");

  const result = selectByEarliestResetFirst(
    [claudeConn("bound-w-only"), claudeConn("alt")],
    sessionId
  );
  assert.equal(
    result.selected.id,
    "alt",
    "weekly < 15% with usable alt should break (session missing skipped)"
  );
});

test("SA-10: isAffinityValid called without scoredAlternatives → backwards compat (no viability check)", () => {
  // Caller: existing tests that pass (conn, sessionId) without third arg.
  // Should NOT trigger viability check; only hard exclusions apply.
  seedClaudeAccount("bound", {
    sessionRem: 10, // would trigger break IF scored alts were passed
    sessionResetSec: W_SESSION_SEC,
    weeklyRem: 80,
    weeklyResetSec: W_WEEKLY_SEC,
  });
  const sessionId = `sa-10-session-${Math.random().toString(36).slice(2)}`;
  touchSession(sessionId, "bound");

  // Direct call without scoredAlternatives
  const out = isAffinityValid(claudeConn("bound"), sessionId);
  assert.equal(out.valid, true, "low-Q without alt list should NOT trigger viability check");
});
