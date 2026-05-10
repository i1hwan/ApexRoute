import test from "node:test";
import assert from "node:assert/strict";

/**
 * State-machine extraction tests for the dashboard ProviderLimits warning
 * lifecycle. We extract the same updater logic used in `index.tsx`'s
 * `fetchQuota` / `refreshAll` / 401 / catch paths so the contract can be
 * verified without spinning up React.
 *
 * Reference: gateway/src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.tsx
 *
 * Invariants:
 *   1. Warning success-clear: a non-warning successful row response removes warnings[connId].
 *   2. Warning set without nuking quotaData: warning response keeps last-known quotaData.
 *   3. Permanent 401 clears any pre-existing warnings[connId] (so amber + red never coexist).
 *   4. refreshAll POST replaces full warnings + errors maps (no merge — server is authoritative).
 *   5. Empty warnings response clears all amber badges.
 */

function clearConnId(map, connId) {
  if (!(connId in map)) return map;
  const next = { ...map };
  delete next[connId];
  return next;
}

function applyRowResponse(state, connId, body, status) {
  let { warnings, errors, quotaData } = state;

  if (status === 401) {
    warnings = clearConnId(warnings, connId);
    return { warnings, errors: { ...errors, [connId]: body.error || "unauthorized" }, quotaData };
  }

  if (body.warning && body.warning.kind === "refresh_transient") {
    warnings = { ...warnings, [connId]: body.warning };
    return { warnings, errors: clearConnId(errors, connId), quotaData };
  }

  warnings = clearConnId(warnings, connId);
  errors = clearConnId(errors, connId);
  quotaData = { ...quotaData, [connId]: { quotas: body.quotas || [], plan: body.plan, raw: body } };
  return { warnings, errors, quotaData };
}

function applyRefreshAllResponse(_state, body) {
  return {
    warnings: body.warnings || {},
    errors: body.errors || {},
    quotaData: body.caches
      ? Object.fromEntries(
          Object.entries(body.caches).map(([id, cache]) => [
            id,
            { quotas: [], plan: cache.plan, raw: cache },
          ])
        )
      : {},
  };
}

const initial = { warnings: {}, errors: {}, quotaData: {} };

test("warning row response sets warnings[connId] and keeps quotaData snapshot", () => {
  const prior = {
    warnings: {},
    errors: {},
    quotaData: { c1: { quotas: [{ name: "session", remainingPercentage: 50 }], plan: "Plus" } },
  };
  const next = applyRowResponse(
    prior,
    "c1",
    {
      warning: { kind: "refresh_transient", reason: "rate_limited", since: "2026-05-09T00:00:00Z" },
      quotas: null,
      plan: null,
      message: "Temporarily unavailable",
    },
    200
  );
  assert.ok(next.warnings.c1, "warning set");
  assert.equal(next.warnings.c1.reason, "rate_limited");
  assert.equal(next.errors.c1, undefined, "no error");
  assert.deepEqual(next.quotaData.c1, prior.quotaData.c1, "quotaData unchanged (last-known kept)");
});

test("successful row response clears existing warning", () => {
  const prior = {
    warnings: { c1: { kind: "refresh_transient", reason: "timeout", since: "..." } },
    errors: {},
    quotaData: {},
  };
  const next = applyRowResponse(
    prior,
    "c1",
    {
      quotas: [{ name: "session", remainingPercentage: 70 }],
      plan: "Plus",
    },
    200
  );
  assert.equal(next.warnings.c1, undefined, "warning cleared on success");
  assert.ok(next.quotaData.c1, "quotaData updated");
});

test("permanent 401 clears stale amber warning before setting red error", () => {
  const prior = {
    warnings: { c1: { kind: "refresh_transient", reason: "rate_limited", since: "..." } },
    errors: {},
    quotaData: {},
  };
  const next = applyRowResponse(
    prior,
    "c1",
    { error: "Failed to refresh credentials (invalid_grant)" },
    401
  );
  assert.equal(next.warnings.c1, undefined, "warning cleared (no amber + red coexist)");
  assert.match(next.errors.c1, /Failed to refresh/);
});

test("refreshAll full-replace: server warnings replace local state", () => {
  const prior = {
    warnings: { c1: { kind: "refresh_transient", reason: "rate_limited", since: "old" } },
    errors: { c2: "old error" },
    quotaData: {},
  };
  const next = applyRefreshAllResponse(prior, {
    warnings: {
      c3: { kind: "refresh_transient", reason: "upstream_5xx", since: "new" },
    },
    errors: {},
    caches: {},
  });
  assert.equal(next.warnings.c1, undefined, "old c1 warning gone (full replace)");
  assert.ok(next.warnings.c3, "new c3 warning present");
  assert.deepEqual(next.errors, {}, "errors fully replaced (empty)");
});

test("refreshAll empty warnings clears all amber badges", () => {
  const prior = {
    warnings: {
      c1: { kind: "refresh_transient", reason: "rate_limited", since: "..." },
      c2: { kind: "refresh_transient", reason: "timeout", since: "..." },
    },
    errors: {},
    quotaData: {},
  };
  const next = applyRefreshAllResponse(prior, { caches: {}, errors: {}, warnings: {} });
  assert.deepEqual(next.warnings, {}, "all warnings cleared");
});

test("idempotent: applying the same warning twice does not mutate other connections", () => {
  let state = { ...initial };
  const w = { kind: "refresh_transient", reason: "network", since: "2026-05-09T00:00:00Z" };
  state = applyRowResponse(state, "c1", { warning: w, quotas: null, plan: null }, 200);
  state = applyRowResponse(state, "c1", { warning: w, quotas: null, plan: null }, 200);
  assert.equal(Object.keys(state.warnings).length, 1);
  assert.equal(Object.keys(state.errors).length, 0);
});
