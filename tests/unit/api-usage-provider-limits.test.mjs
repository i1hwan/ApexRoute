import test from "node:test";
import assert from "node:assert/strict";

const route = await import("../../src/app/api/usage/provider-limits/route.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

const { computeRouting, mergeIntoResponseBody } = route;
const { setQuotaCache } = quotaCache;

function freshSetup(prefix) {
  setQuotaCache(`${prefix}-a`, "claude", {
    session: { remainingPercentage: 80, resetAt: new Date(Date.now() + 60_000).toISOString() },
    weekly: {
      remainingPercentage: 50,
      resetAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    },
  });
  setQuotaCache(`${prefix}-b`, "claude", {
    session: {
      remainingPercentage: 30,
      resetAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
    },
    weekly: {
      remainingPercentage: 20,
      resetAt: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
    },
  });
}

test("computeRouting (ERF): assigns dense per-provider ranks for eligible accounts", () => {
  const prefix = `erf-dense-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: true },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  const a = out[`${prefix}-a`];
  const b = out[`${prefix}-b`];
  assert.ok(a, "entry for a");
  assert.ok(b, "entry for b");
  const ranks = [a.rank, b.rank].sort();
  assert.deepEqual(ranks, [1, 2], "dense ranks 1,2");
  const next = a.isNext ? a : b.isNext ? b : null;
  assert.ok(next, "exactly one isNext entry");
});

test("computeRouting (ERF): inactive connection is excluded with reason 'inactive' and no rank", () => {
  const prefix = `erf-inactive-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: false },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  assert.equal(out[`${prefix}-a`].rank, 1);
  assert.equal(out[`${prefix}-a`].isNext, true);
  assert.equal(out[`${prefix}-b`].excluded, true);
  assert.equal(out[`${prefix}-b`].excludedReason, "inactive");
  assert.equal(out[`${prefix}-b`].rank, null);
});

test("computeRouting (ERF): isActive numeric 0 is treated as inactive", () => {
  const prefix = `erf-num-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: 0 },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  assert.equal(out[`${prefix}-b`].excludedReason, "inactive");
});

test("computeRouting (ERF): rate-limited connection (string future date) excluded with reason 'rate_limited'", () => {
  const prefix = `erf-rl-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: true, rateLimitedUntil: future },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  assert.equal(out[`${prefix}-b`].excludedReason, "rate_limited");
  assert.equal(out[`${prefix}-b`].excluded, true);
});

test("computeRouting (ERF): rate-limited connection accepts epoch number for rateLimitedUntil", () => {
  const prefix = `erf-rl-num-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  const futureEpoch = Date.now() + 5 * 60 * 1000;
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: true, rateLimitedUntil: futureEpoch },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  assert.equal(out[`${prefix}-b`].excludedReason, "rate_limited");
});

test("computeRouting (ERF): terminal status (banned) excluded with reason 'terminal'", () => {
  const prefix = `erf-term-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: true, testStatus: "banned" },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  assert.equal(out[`${prefix}-b`].excludedReason, "terminal");
});

test("computeRouting (ERF): groups by provider; ranks are independent per provider", () => {
  const prefix = `erf-multi-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  setQuotaCache(`${prefix}-glm-a`, "glm", {
    session: { remainingPercentage: 90, resetAt: new Date(Date.now() + 60_000).toISOString() },
    weekly: {
      remainingPercentage: 90,
      resetAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    },
  });
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: true },
    { id: `${prefix}-glm-a`, provider: "glm", isActive: true },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  const claudeRanks = [out[`${prefix}-a`].rank, out[`${prefix}-b`].rank].sort();
  assert.deepEqual(claudeRanks, [1, 2]);
  assert.equal(out[`${prefix}-glm-a`].rank, 1);
  assert.equal(out[`${prefix}-glm-a`].isNext, true);
});

test("computeRouting (ERF): breakdown.baseScore equals avg(known track scores) per earliestResetFirst.ts:331", () => {
  const prefix = `erf-break-${Math.random().toString(36).slice(2, 8)}`;
  freshSetup(prefix);
  const conns = [{ id: `${prefix}-a`, provider: "claude", isActive: true }];
  const out = computeRouting(conns, "earliest-reset-first");
  const entry = out[`${prefix}-a`];
  assert.ok(entry.breakdown, "breakdown present");
  const sp = entry.breakdown.sessionPoints;
  const wp = entry.breakdown.weeklyPoints;
  // baseScore = trackScores.reduce((a,b) => a+b, 0) / trackScores.length
  // where each trackScore is the points value (NOT pct-weighted).
  // See gateway/src/sse/services/strategies/earliestResetFirst.ts line 331.
  const trackScores = [];
  if (sp != null) trackScores.push(sp);
  if (wp != null) trackScores.push(wp);
  if (trackScores.length > 0) {
    const expectedBase = trackScores.reduce((a, b) => a + b, 0) / trackScores.length;
    const actualBase = entry.breakdown.baseScore;
    assert.ok(
      typeof actualBase === "number" && Number.isFinite(actualBase),
      "baseScore is a finite number"
    );
    assert.ok(
      Math.abs(actualBase - expectedBase) < 1e-9,
      `baseScore ${actualBase} should equal avg(${trackScores.join(",")}) = ${expectedBase}`
    );
  } else {
    assert.equal(entry.breakdown.baseScore, 0, "baseScore is 0 when no track has a score");
  }
});

test("computeRouting (non-ERF strategy): every connection has rank:null but rate-limited surface as excluded", () => {
  const prefix = `nrr-${Math.random().toString(36).slice(2, 8)}`;
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-b`, provider: "claude", isActive: true, rateLimitedUntil: future },
    { id: `${prefix}-c`, provider: "claude", isActive: false },
  ];
  const out = computeRouting(conns, "round-robin");
  assert.equal(out[`${prefix}-a`].rank, null);
  assert.equal(out[`${prefix}-a`].excluded, false);
  assert.equal(out[`${prefix}-b`].excluded, true);
  assert.equal(out[`${prefix}-b`].excludedReason, "rate_limited");
  assert.equal(out[`${prefix}-c`].excluded, true);
  assert.equal(out[`${prefix}-c`].excludedReason, "inactive");
});

test("computeRouting: skips entries without id or provider (defensive)", () => {
  const prefix = `def-${Math.random().toString(36).slice(2, 8)}`;
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { provider: "claude", isActive: true },
    { id: `${prefix}-b`, isActive: true },
    null,
  ];
  setQuotaCache(`${prefix}-a`, "claude", {
    session: { remainingPercentage: 80, resetAt: new Date(Date.now() + 60_000).toISOString() },
    weekly: {
      remainingPercentage: 50,
      resetAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    },
  });
  const out = computeRouting(conns, "earliest-reset-first");
  assert.equal(Object.keys(out).length, 1);
  assert.ok(out[`${prefix}-a`]);
});

test("computeRouting: skips connections whose provider is not in USAGE_SUPPORTED_PROVIDERS", () => {
  const prefix = `usp-${Math.random().toString(36).slice(2, 8)}`;
  setQuotaCache(`${prefix}-a`, "claude", {
    session: { remainingPercentage: 80, resetAt: new Date(Date.now() + 60_000).toISOString() },
    weekly: {
      remainingPercentage: 50,
      resetAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    },
  });
  const conns = [
    { id: `${prefix}-a`, provider: "claude", isActive: true },
    { id: `${prefix}-qoder`, provider: "qoder", isActive: true },
    { id: `${prefix}-pollinations`, provider: "pollinations", isActive: true },
    { id: `${prefix}-nonexistent`, provider: "totally-fake-provider", isActive: true },
  ];
  const out = computeRouting(conns, "earliest-reset-first");
  assert.equal(Object.keys(out).length, 1, "only the supported claude entry remains");
  assert.ok(out[`${prefix}-a`]);
  assert.equal(out[`${prefix}-qoder`], undefined);
  assert.equal(out[`${prefix}-pollinations`], undefined);
  assert.equal(out[`${prefix}-nonexistent`], undefined);
});

test("mergeIntoResponseBody: authoritative base.caches wins over extra.caches (Copilot PR #25 review)", () => {
  const partialSyncResult = {
    caches: { "conn-a": { quotas: {}, plan: null, fetchedAt: "ts", source: "manual" } },
    errors: { "conn-b": "upstream 500" },
    total: 2,
    succeeded: 1,
    failed: 1,
  };
  const fullCache = {
    "conn-a": { quotas: {}, plan: null, fetchedAt: "ts", source: "manual" },
    "conn-b": { quotas: {}, plan: null, fetchedAt: "ts-old", source: "manual" },
  };
  const out = mergeIntoResponseBody(partialSyncResult, {
    caches: fullCache,
    intervalMinutes: 70,
    lastAutoSyncAt: null,
    routing: {},
    configuredRoutingStrategy: "earliest-reset-first",
  });
  assert.equal(Object.keys(out.caches).length, 2, "both A and B preserved (authoritative wins)");
  assert.ok(out.caches["conn-b"], "conn-b not dropped by partial sync result");
  assert.deepEqual(out.errors, { "conn-b": "upstream 500" }, "errors preserved through restExtra");
  assert.equal(out.total, 2);
  assert.equal(out.succeeded, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.intervalMinutes, 70);
  assert.equal(out.configuredRoutingStrategy, "earliest-reset-first");
  assert.deepEqual(out.routing, {});
});

test("mergeIntoResponseBody: also drops routing/configuredRoutingStrategy from extra (defensive)", () => {
  const adversarialExtra = {
    caches: { phantom: {} },
    routing: { phantom: { strategy: "x", rank: 1, isNext: true } },
    configuredRoutingStrategy: "garbage-strategy",
    errors: { real: "preserved" },
  };
  const out = mergeIntoResponseBody(adversarialExtra, {
    caches: { real: { quotas: {}, plan: null, fetchedAt: "ts", source: "manual" } },
    intervalMinutes: 70,
    lastAutoSyncAt: null,
    routing: {},
    configuredRoutingStrategy: "earliest-reset-first",
  });
  assert.equal(Object.keys(out.caches).length, 1);
  assert.ok(out.caches.real);
  assert.equal(out.caches.phantom, undefined);
  assert.deepEqual(out.routing, {});
  assert.equal(out.configuredRoutingStrategy, "earliest-reset-first");
  assert.deepEqual(out.errors, { real: "preserved" });
});
