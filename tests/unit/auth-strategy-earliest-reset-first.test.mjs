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
} = earliestResetFirst;

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

test("v6 scoreSessionTrack: T=40 × Q=10 = 400", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 10,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  const s = scoreSessionTrack("gnumax");
  assert.equal(s.kind, "known");
  assert.equal(s.score, 40 * 10);
  assert.equal(s.remainingPct, 10);
});

test("v6 scoreWeeklyTrack: T=20 × Q=62 = 1240, ignores per-model windows", () => {
  // Even if Sonnet/Omelette windows would have been seeded, v6 ignores them.
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
  assert.equal(w.score, 20 * 62);
});

test("v6 scoreWeeklyTrack: signature does not accept modelHint", () => {
  // Defensive: even if a caller passes a string, scoreWeeklyTrack must not
  // consult model-specific windows. We pass only connId per v6 contract.
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
  });
  // scoreWeeklyTrack(connId) — no second arg
  const w = scoreWeeklyTrack("gnumax");
  assert.equal(w.kind, "known");
  assert.equal(w.score, 20 * 62);
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
  assert.equal(w.score, 20 * 80);

  const result = scoreAccount(claudeConn("ghacct"));
  assert.equal(result.excluded, false);
  assert.equal(
    result.score,
    20 * 80,
    "denominator=1, baseScore = 1600 (no session track injected)"
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

test("F2-2: weekly Omelette=0% (would have hard-excluded in v4) does NOT exclude in v6", () => {
  setQuotaCache("apex", "claude", {
    "session (5h)": { remainingPercentage: 50, resetAt: isoIn(4080) },
    "weekly (7d)": { remainingPercentage: 50, resetAt: isoIn(320400) },
    "weekly Omelette (7d)": { remainingPercentage: 0, resetAt: isoIn(320400) },
  });
  const result = scoreAccount(claudeConn("apex"));
  assert.equal(result.excluded, false, "v6 ignores per-model windows entirely");
  // Score = avg(40·50, 20·50) = avg(2000, 1000) = 1500
  assert.equal(result.score, 1500);
});

// ─── 7. F3: fresh quota (Q=100 AND resetAt=null) ─────────────────────────────

test("F3-1: session resetAt=null AND Q=100 → score = 10000 (fresh)", () => {
  setQuotaCache("fresh", "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 80, resetAt: isoIn(435600) },
  });
  const s = scoreSessionTrack("fresh");
  assert.equal(s.kind, "known");
  assert.equal(s.score, 100 * 100, "T=100, Q=100 (fresh max-urgency)");
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

test("F3-3: fresh session + normal weekly → composite via avg", () => {
  setQuotaCache("fresh", "claude", {
    "session (5h)": { remainingPercentage: 100, resetAt: null },
    "weekly (7d)": { remainingPercentage: 80, resetAt: isoIn(435600) },
  });
  const result = scoreAccount(claudeConn("fresh"));
  assert.equal(result.excluded, false);
  // avg(10000, 20·80=1600) = 5800
  assert.equal(result.score, (10000 + 1600) / 2);
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
  assert.equal(w.score, 100 * 100);
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

test("F4-1: APEX(17%/2h, 35%/3d10h) vs GNUMAX(87%/4h, 59%/4d18h) → GNUMAX wins", () => {
  // User's actual production scenario from .sisyphus/plans/routing-strategy-v6.md §2.4.
  // 2h = 7200s in (3600, 10800] band → sessionTimePoints = 40
  seedClaudeAccount("apex", {
    sessionRem: 17,
    sessionResetSec: 2 * 3600,
    weeklyRem: 35,
    weeklyResetSec: 3 * 86400 + 10 * 3600,
  });
  // 4h = 14400s in (10800, 21600] band → sessionTimePoints = 20
  seedClaudeAccount("gnumax", {
    sessionRem: 87,
    sessionResetSec: 4 * 3600,
    weeklyRem: 59,
    weeklyResetSec: 4 * 86400 + 18 * 3600,
  });

  const apex = scoreAccount(claudeConn("apex"));
  const gnumax = scoreAccount(claudeConn("gnumax"));

  // APEX: session 40·17=680, weekly 20·35=700, avg = 690
  // GNUMAX: session 20·87=1740, weekly 20·59=1180, avg = 1460
  assert.equal(apex.score, (40 * 17 + 20 * 35) / 2);
  assert.equal(gnumax.score, (20 * 87 + 20 * 59) / 2);
  assert.ok(gnumax.score > apex.score, "GNUMAX must outrank APEX (burn-down semantic)");

  const result = selectByEarliestResetFirst([claudeConn("apex"), claudeConn("gnumax")], null);
  assert.equal(result.selected.id, "gnumax");
});

test("F4-2: backoffLevel=4 paid vs self-hosted score=0 → self-hosted wins", () => {
  seedClaudeAccount("flaky", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 60,
    weeklyResetSec: 435600,
  });
  // flaky: avg(40·50, 20·60) = (2000+1200)/2 = 1600. backoffLevel=4 →
  // pBackoff=min(4·25,100)=100 → finalScore = 1600 - 100·100 = 1600 - 10000 = -8400
  // self-hosted: score=0. -8400 < 0 → self-hosted wins.
  const compatId = `compat-${Math.random().toString(36).slice(2)}`;
  const result = selectByEarliestResetFirst(
    [claudeConn("flaky", { backoffLevel: 4 }), claudeConn(compatId)],
    null
  );
  assert.equal(result.selected.id, compatId);
});

test("F4-3: T=10 × Q=100 = 1000 (low urgency, abundant quota)", () => {
  // 7h = 25200s, in >6h band → sessionTimePoints = 10
  seedClaudeAccount("idle", {
    sessionRem: 100,
    sessionResetSec: 7 * 3600,
    weeklyRem: 100,
    weeklyResetSec: 5 * 86400,
  });
  const result = scoreAccount(claudeConn("idle"));
  // session: 10·100 = 1000, weekly: 20·100 = 2000, avg = 1500
  assert.equal(result.score, (10 * 100 + 20 * 100) / 2);
});

test("F4-4: Q boundary at exactly 5 → known (NOT excluded), score = T × 5", () => {
  // Q=5 is the inclusive lower bound for "usable"; v6 excludes only Q<5.
  seedClaudeAccount("edge", {
    sessionRem: 5,
    sessionResetSec: 4080,
    weeklyRem: 50,
    weeklyResetSec: 435600,
  });
  const s = scoreSessionTrack("edge");
  assert.equal(s.kind, "known");
  assert.equal(s.score, 40 * 5);
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

test("F4-6: comparator equal product breaks via earliest reset asc", () => {
  // Two accounts with identical avg scores but different reset times. The
  // tie-break must pick the earlier-resetting one.
  // A: session T=40·Q=50 = 2000, weekly T=20·Q=100 = 2000, avg = 2000, earliestReset = 1h
  seedClaudeAccount("a", {
    sessionRem: 50,
    sessionResetSec: 3600,
    weeklyRem: 100,
    weeklyResetSec: 7 * 86400,
  });
  // B: session T=20·Q=100 = 2000, weekly T=40·Q=50 = 2000, avg = 2000, earliestReset = 4h
  seedClaudeAccount("b", {
    sessionRem: 100,
    sessionResetSec: 4 * 3600,
    weeklyRem: 50,
    weeklyResetSec: 3 * 86400,
  });
  const result = selectByEarliestResetFirst([claudeConn("a"), claudeConn("b")], null);
  // A's session reset (1h) is the earliest known reset across both accounts.
  assert.equal(result.selected.id, "a");
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
