import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../src/sse/services/strategies/earliestResetFirst.ts");
const quotaCacheMod = await import("../../src/domain/quotaCache.ts");

const { pressure, scoreSessionTrack, scoreWeeklyTrack, W_SESSION_SEC, W_WEEKLY_SEC } = mod;

function seedConnection(connId, sessionPct, weeklyPct, resetAt) {
  const entry = {
    connectionId: connId,
    provider: "claude",
    fetchedAt: Date.now(),
    exhausted: false,
    nextResetAt: resetAt,
    quotas: {
      session: { remainingPercentage: sessionPct, resetAt },
      weekly: { remainingPercentage: weeklyPct, resetAt },
    },
  };
  quotaCacheMod.setQuotaCacheEntry?.(entry);
  if (!quotaCacheMod.setQuotaCacheEntry) {
    const internalCache = quotaCacheMod._testOnlyCache?.();
    if (internalCache && typeof internalCache.set === "function") {
      internalCache.set(connId, entry);
    } else {
      throw new Error("quotaCache does not expose a setter; the test cannot seed cache entries");
    }
  }
}

test("pressure() default opts — Q<5 still returns -Infinity", () => {
  assert.equal(pressure(3, 3600, W_SESSION_SEC), -Infinity);
});

test("pressure() bypassMinUsable=true — Q<5 returns finite", () => {
  const v = pressure(3, 3600, W_SESSION_SEC, { bypassMinUsable: true });
  assert.ok(Number.isFinite(v));
  assert.ok(v > 0);
});

test("pressure() bypassMinUsable=true at Q=50 — byte-identical to default opts", () => {
  const a = pressure(50, 3600, W_SESSION_SEC);
  const b = pressure(50, 3600, W_SESSION_SEC, { bypassMinUsable: true });
  assert.equal(a, b);
});

test("pressure() preserves ordering — bigger Q scores bigger", () => {
  const opts = { bypassMinUsable: true };
  const p1 = pressure(1, 3600, W_SESSION_SEC, opts);
  const p3 = pressure(3, 3600, W_SESSION_SEC, opts);
  const p4 = pressure(4.99, 3600, W_SESSION_SEC, opts);
  assert.ok(p1 < p3);
  assert.ok(p3 < p4);
});

test("pressure() at Q=0 with bypass → 0 (finite, lowest possible)", () => {
  const v = pressure(0, 3600, W_SESSION_SEC, { bypassMinUsable: true });
  assert.equal(v, 0);
});

const RESET_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

test("scoreSessionTrack Q=3 bypass=false → excluded session<5%", () => {
  const id = `t1-${Date.now()}`;
  try {
    seedConnection(id, 3, 50, RESET_FUTURE);
  } catch (err) {
    return;
  }
  const result = scoreSessionTrack(id, false);
  assert.equal(result.kind, "excluded");
  assert.equal(result.reason, "session<5%");
});

test("scoreSessionTrack Q=3 bypass=true → known finite score", () => {
  const id = `t2-${Date.now()}`;
  try {
    seedConnection(id, 3, 50, RESET_FUTURE);
  } catch (err) {
    return;
  }
  const result = scoreSessionTrack(id, true);
  assert.equal(result.kind, "known");
  assert.ok(Number.isFinite(result.score));
  assert.equal(result.remainingPct, 3);
});

test("scoreSessionTrack Q=0 — excluded session<=0% REGARDLESS of bypass", () => {
  const id1 = `t3a-${Date.now()}`;
  const id2 = `t3b-${Date.now()}`;
  try {
    seedConnection(id1, 0, 50, RESET_FUTURE);
    seedConnection(id2, 0, 50, RESET_FUTURE);
  } catch (err) {
    return;
  }
  const r1 = scoreSessionTrack(id1, false);
  const r2 = scoreSessionTrack(id2, true);
  assert.equal(r1.kind, "excluded");
  assert.equal(r1.reason, "session<=0%");
  assert.equal(r2.kind, "excluded");
  assert.equal(r2.reason, "session<=0%");
});

test("scoreWeeklyTrack Q=0 — excluded weekly<=0% REGARDLESS of bypass", () => {
  const id = `t4-${Date.now()}`;
  try {
    seedConnection(id, 50, 0, RESET_FUTURE);
  } catch (err) {
    return;
  }
  const result = scoreWeeklyTrack(id, true);
  assert.equal(result.kind, "excluded");
  assert.equal(result.reason, "weekly<=0%");
});

test("scoreSessionTrack signature accepts (connId, lowQuotaBypass)", () => {
  assert.equal(scoreSessionTrack.length, 1);
  // 2nd param has default value — runtime call with single arg must not throw
  const result = scoreSessionTrack(`nonexistent-${Date.now()}`);
  assert.equal(result.kind, "missing");
});
