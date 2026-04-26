import test from "node:test";
import assert from "node:assert/strict";

const earliestResetFirst = await import("../../src/sse/services/strategies/earliestResetFirst.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const sessionManager = await import("../../open-sse/services/sessionManager.ts");
const modelWindowMapping = await import("../../src/sse/services/strategies/modelWindowMapping.ts");
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

const { setQuotaCache } = quotaCache;
const { mapModelToRequiredWeekly } = modelWindowMapping;
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
  if (typeof opts.sonnetRem === "number") {
    quotas["weekly Sonnet (7d)"] = {
      remainingPercentage: opts.sonnetRem,
      resetAt: opts.weeklyResetSec === null ? null : isoIn(opts.weeklyResetSec),
    };
  }
  if (typeof opts.omeletteRem === "number") {
    quotas["weekly Omelette (7d)"] = {
      remainingPercentage: opts.omeletteRem,
      resetAt: opts.weeklyResetSec === null ? null : isoIn(opts.weeklyResetSec),
    };
  }
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

// ─── 1. Stepwise boundary tests (Plan v4 §6 #1) ──────────────────────────────

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

// ─── 2. Intermediate value asserts (Plan v4 §6 #2 + §4 simulations) ─────────

test("Sonnet on Claude pool: GNUMAX (1h8m,10%) S_session = 35.5", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 10,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  const s = scoreSessionTrack("gnumax");
  assert.equal(s.kind, "known");
  assert.equal(s.score, 0.85 * 40 + 0.15 * 10, "T=40, Q_capped=10");
  assert.equal(Math.round(s.score * 10) / 10, 35.5);
});

test("Sonnet on Claude pool: GNUMAX S_weekly bottleneck=overall 62 → 21.5", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 10,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  const w = scoreWeeklyTrack("gnumax", "claude-sonnet-4.5");
  assert.equal(w.kind, "known");
  assert.equal(w.remainingPct, 62, "bottleneck overall 62 < sonnet 100");
  assert.equal(w.score, 0.85 * 20 + 0.15 * 30, "T=20, Q_capped=30");
  assert.equal(Math.round(w.score * 10) / 10, 21.5);
});

test("Sonnet on Claude pool: APEXATGNU (4h38m,100%) S_session = 21.5", () => {
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });
  const s = scoreSessionTrack("apex");
  assert.equal(s.kind, "known");
  assert.equal(s.score, 0.85 * 20 + 0.15 * 30, "T=20, Q_capped=30 (cap at 30 from 100)");
  assert.equal(Math.round(s.score * 10) / 10, 21.5);
});

test("Sonnet on Claude pool: APEXATGNU S_weekly bottleneck=overall 49 → 21.5", () => {
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });
  const w = scoreWeeklyTrack("apex", "claude-sonnet-4.5");
  assert.equal(w.kind, "known");
  assert.equal(w.remainingPct, 49, "bottleneck overall 49 < sonnet 92");
  assert.equal(Math.round(w.score * 10) / 10, 21.5);
});

test("Sonnet on Claude pool: composite scores GNUMAX 28.5, APEXATGNU 21.5", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 10,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });

  const gnumax = scoreAccount(claudeConn("gnumax"), "claude-sonnet-4.5");
  const apex = scoreAccount(claudeConn("apex"), "claude-sonnet-4.5");

  assert.equal(gnumax.excluded, false);
  assert.equal(apex.excluded, false);
  assert.equal(Math.round(gnumax.score * 10) / 10, 28.5);
  assert.equal(Math.round(apex.score * 10) / 10, 21.5);
});

// ─── 3. Hard exclusion (Plan v4 §6 #3) ───────────────────────────────────────

test("Opus request excludes APEXATGNU when weekly Omelette 0%", () => {
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
    omeletteRem: 0,
  });
  const result = scoreAccount(claudeConn("apex"), "claude-opus-4-7");
  assert.equal(result.excluded, true);
  assert.match(result.reason, /weekly Omelette/);
});

test("Session < 5% excludes account regardless of weekly", () => {
  seedClaudeAccount("dryacct", {
    sessionRem: 4,
    sessionResetSec: 4080,
    weeklyRem: 80,
    weeklyResetSec: 435600,
    sonnetRem: 80,
  });
  const result = scoreAccount(claudeConn("dryacct"), "claude-sonnet-4.5");
  assert.equal(result.excluded, true);
  assert.match(result.reason, /session<5%/);
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
  const result = selectByEarliestResetFirst(
    [claudeConn("a"), claudeConn("b")],
    "claude-sonnet-4.5",
    null
  );
  assert.equal(result.allExcluded, true);
  assert.equal(result.excludedBreakdown.length, 2);
  // Earliest reset should come from "a" (sessionResetSec=1000)
  const aReset = new Date(result.retryAfterIso).getTime();
  const expected = Date.now() + 1000 * 1000;
  assert.ok(Math.abs(aReset - expected) < 5000, "retryAfter ~ a's session reset");
});

// ─── 4. Reweighting (Plan v4 §6 #4) ──────────────────────────────────────────

test("github-style account with no session window scores from weekly only", () => {
  seedSingleWeeklyAccount("ghacct", "github", {
    weeklyRem: 80,
    weeklyResetSec: 396000,
  });
  const s = scoreSessionTrack("ghacct");
  assert.equal(s.kind, "missing", "no session window → missing");
  const w = scoreWeeklyTrack("ghacct", null);
  assert.equal(w.kind, "known");
  assert.equal(Math.round(w.score * 10) / 10, 21.5);

  const result = scoreAccount(claudeConn("ghacct"), null);
  assert.equal(result.excluded, false);
  assert.equal(
    Math.round(result.score * 10) / 10,
    21.5,
    "denominator=1, baseScore = 21.5 (no session track injected)"
  );
});

test("Account with no usable quota data is excluded", () => {
  // No setQuotaCache call → session window missing AND no required model
  // window mapping → weekly also missing. Use uniquely-suffixed id to avoid
  // leaks from other tests (quotaCache is module-private).
  const uniqueId = `unknown-${Math.random().toString(36).slice(2)}`;
  // Pass null modelHint so weekly track returns "missing" (not "degraded")
  // when both windows are absent.
  const result = scoreAccount(claudeConn(uniqueId), null);
  assert.equal(result.excluded, true);
  assert.equal(result.reason, "no_quota_data");
});

test("Account with required model window missing → degraded (not excluded)", () => {
  // Defensive sibling test: when modelHint maps to a required window and that
  // window is absent, the weekly track returns "degraded" instead of "missing".
  // This account is therefore scoreable (not excluded), but heavily penalized.
  const uniqueId = `degraded-only-${Math.random().toString(36).slice(2)}`;
  const result = scoreAccount(claudeConn(uniqueId), "claude-sonnet-4.5");
  assert.equal(result.excluded, false);
  assert.equal(result.breakdown.s.kind, "missing");
  assert.equal(result.breakdown.w.kind, "degraded");
  // baseScore = 0 (only degraded contributes, scored as 0); finalScore = -25
  assert.equal(result.breakdown.degraded_pen, 25);
});

// ─── 5. Burn-down behavior (Plan v4 §6 #5) ───────────────────────────────────

test("GNUMAX session 4min,Q=10% beats APEXATGNU session 4h,Q=100% (burn-down)", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 10,
    sessionResetSec: 240,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });

  const gnumax = scoreAccount(claudeConn("gnumax"), "claude-sonnet-4.5");
  const apex = scoreAccount(claudeConn("apex"), "claude-sonnet-4.5");

  // GNUMAX S_session = 0.85*100 + 0.15*10 = 86.5
  // GNUMAX S_weekly = 0.85*20 + 0.15*30 = 21.5
  // GNUMAX baseScore = 54.0
  assert.equal(Math.round(gnumax.score * 10) / 10, 54.0);
  assert.equal(Math.round(apex.score * 10) / 10, 21.5);
  assert.ok(gnumax.score > apex.score, "burn-down: GNUMAX wins");
});

test("Post-reset GNUMAX (T=20, Q=100) ties APEXATGNU; tie-break by earliest reset → APEX wins", () => {
  // GNUMAX after session reset: session 5h ahead (T=20), Q=100, weekly unchanged 62%
  seedClaudeAccount("gnumax", {
    sessionRem: 100,
    sessionResetSec: 18000,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });

  const result = selectByEarliestResetFirst(
    [claudeConn("gnumax"), claudeConn("apex")],
    "claude-sonnet-4.5",
    null
  );
  assert.equal(
    result.selected.id,
    "apex",
    "tie-break: apex's 3d17h reset is earlier than gnumax 5d1h"
  );
});

// ─── 6. Affinity (Plan v4 §6 #6) ─────────────────────────────────────────────

test("Affinity hit: same account selected within 5min", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });

  const sessionId = "test-affinity-hit";
  touchSession(sessionId, "gnumax");

  const result = selectByEarliestResetFirst(
    [claudeConn("gnumax"), claudeConn("apex")],
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(result.selected.id, "gnumax", "affinity hit overrides cold-start scoring");
});

test("Affinity break on session<5%: bound account no longer valid", () => {
  // Bound account is GNUMAX with session 3% — must break and pick APEX
  seedClaudeAccount("gnumax", {
    sessionRem: 3,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });

  const sessionId = "test-affinity-break-quota";
  touchSession(sessionId, "gnumax");

  const result = selectByEarliestResetFirst(
    [claudeConn("gnumax"), claudeConn("apex")],
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(result.selected.id, "apex", "GNUMAX excluded by quota → APEX selected");
});

test("Affinity break on rate-limited connection (caller filters out)", () => {
  // Per plan v4 §3.1, callers (auth.ts:437-448) pre-filter rate-limited
  // accounts from `candidates`. We replicate that here: bound id is GNUMAX
  // but it is NOT in the candidate list, simulating "filtered out by caller
  // because rate-limited". Affinity must break and APEX is selected.
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });

  const sessionId = "test-affinity-break-rl-caller";
  touchSession(sessionId, "gnumax");

  // GNUMAX excluded by caller (e.g. rateLimitedUntil expired in the meantime).
  const result = selectByEarliestResetFirst([claudeConn("apex")], "claude-sonnet-4.5", sessionId);
  assert.equal(result.selected.id, "apex", "bound id missing from candidates → fall to scoring");
});

test("isAffinityValid detects rate-limited even when caller leaks one through", () => {
  // Defensive double-check (plan v4 §3.3): even if caller passes rate-limited
  // connection through (race window), isAffinityValid catches it.
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });

  const sessionId = "test-isvalid-rl";
  touchSession(sessionId, "gnumax");

  const futureRl = new Date(Date.now() + 60_000).toISOString();
  const out = isAffinityValid(
    claudeConn("gnumax", { rateLimitedUntil: futureRl }),
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(out.valid, false);
  assert.equal(out.reason, "rate_limited");
});

test("isAffinityValid: rateLimitedUntil ISO string parsed correctly", () => {
  seedClaudeAccount("gnumax", {
    sessionRem: 50,
    sessionResetSec: 4080,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    sonnetRem: 100,
  });
  const sessionId = "test-rl-parse";
  touchSession(sessionId, "gnumax");

  const futureRl = new Date(Date.now() + 60_000).toISOString();
  const out1 = isAffinityValid(
    claudeConn("gnumax", { rateLimitedUntil: futureRl }),
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(out1.valid, false);
  assert.equal(out1.reason, "rate_limited");

  const pastRl = new Date(Date.now() - 60_000).toISOString();
  const out2 = isAffinityValid(
    claudeConn("gnumax", { rateLimitedUntil: pastRl }),
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(out2.valid, true, "past rate limit should not block");

  const out3 = isAffinityValid(
    claudeConn("gnumax", { rateLimitedUntil: null }),
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(out3.valid, true, "null rate limit should not block");

  const out4 = isAffinityValid(
    claudeConn("gnumax", { rateLimitedUntil: "" }),
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(out4.valid, true, "empty string rate limit should not block");
});

// ─── 7. Tie-breaking determinism (Plan v4 §6 #7) ─────────────────────────────

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

// ─── 8. Fingerprint stability (Plan v4 §6 #8) ────────────────────────────────

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

// ─── 9. Pipeline ordering (Plan v4 §6 #9) ────────────────────────────────────

test("modelWindowMapping: claude-opus matches weekly Omelette", () => {
  assert.equal(mapModelToRequiredWeekly("claude-opus-4-7"), "weekly Omelette");
  assert.equal(mapModelToRequiredWeekly("claude-opus-4-5"), "weekly Omelette");
});

test("modelWindowMapping: claude-sonnet matches weekly Sonnet", () => {
  assert.equal(mapModelToRequiredWeekly("claude-sonnet-4.5"), "weekly Sonnet");
  assert.equal(mapModelToRequiredWeekly("claude-sonnet-4-5"), "weekly Sonnet");
});

test("modelWindowMapping: non-claude returns null", () => {
  assert.equal(mapModelToRequiredWeekly("gpt-5.4"), null);
  assert.equal(mapModelToRequiredWeekly("gemini-3.1"), null);
  assert.equal(mapModelToRequiredWeekly(null), null);
  assert.equal(mapModelToRequiredWeekly(""), null);
});

// ─── 10. Degraded scenario (Plan v4 §2.4 + Oracle rev3 #3) ───────────────────

test("Degraded weekly window does not inflate score (Oracle rev3 #3)", () => {
  // GNUMAX session 4min imminent (S_session=86.5) but Sonnet window MISSING
  seedClaudeAccount("gnumax", {
    sessionRem: 10,
    sessionResetSec: 240,
    weeklyRem: 62,
    weeklyResetSec: 435600,
    // omit sonnetRem -> required window missing for Sonnet request
  });
  // APEX has full data
  seedClaudeAccount("apex", {
    sessionRem: 100,
    sessionResetSec: 16680,
    weeklyRem: 49,
    weeklyResetSec: 320400,
    sonnetRem: 92,
  });

  const gnumax = scoreAccount(claudeConn("gnumax"), "claude-sonnet-4.5");
  const apex = scoreAccount(claudeConn("apex"), "claude-sonnet-4.5");

  // Pre-fix v4 inflation would give GNUMAX 86.5 - 25 = 61.5 (incorrectly winning)
  // Post-fix: baseScore = (86.5 + 0)/2 = 43.25; finalScore = 43.25 - 25 = 18.25
  assert.equal(gnumax.excluded, false);
  assert.equal(Math.round(gnumax.score * 100) / 100, 18.25);
  assert.equal(Math.round(apex.score * 10) / 10, 21.5);
  assert.ok(apex.score > gnumax.score, "fully-known APEX must beat degraded GNUMAX");
});

// ─── 11. Single-account pool + Codex/GitHub trivials ─────────────────────────

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
  const result = selectByEarliestResetFirst([claudeConn("codex1")], "gpt-5.4", null);
  assert.equal(result.selected.id, "codex1");
});

// ─── 12. Terminal status excluded from affinity ──────────────────────────────

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
    sonnetRem: 100,
  });

  const sessionId = "test-isvalid-terminal";
  touchSession(sessionId, "gnumax");

  const out = isAffinityValid(
    claudeConn("gnumax", { testStatus: "expired" }),
    "claude-sonnet-4.5",
    sessionId
  );
  assert.equal(out.valid, false);
  assert.equal(out.reason, "terminal");
});
