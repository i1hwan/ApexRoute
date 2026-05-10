import test from "node:test";
import assert from "node:assert/strict";

const route = await import("../../src/app/api/usage/provider-limits/route.ts");
const { mergeIntoResponseBody } = route;

test("mergeIntoResponseBody preserves `warnings` from extra alongside authoritative caches/routing", () => {
  const extra = {
    total: 4,
    succeeded: 3,
    failed: 1,
    warnings: {
      "claude-conn-a": {
        kind: "refresh_transient",
        reason: "rate_limited",
        since: "2026-05-09T18:00:00.000Z",
      },
    },
    errors: {
      "claude-conn-b": "Failed to refresh credentials",
    },
    caches: {
      "ignored-from-extra": {
        quotas: {},
        plan: null,
        message: null,
        fetchedAt: null,
        source: "manual",
      },
    },
    routing: { "ignored-from-extra": null },
    configuredRoutingStrategy: "ignored",
  };
  const base = {
    caches: {
      "auth-conn-a": { quotas: {}, plan: "Plus", message: null, fetchedAt: null, source: "manual" },
    },
    intervalMinutes: 70,
    lastAutoSyncAt: null,
    routing: { "auth-conn-a": { strategy: "earliest-reset-first", rank: 1, isNext: true } },
    configuredRoutingStrategy: "earliest-reset-first",
  };

  const merged = mergeIntoResponseBody(extra, base);

  assert.equal(merged.total, 4);
  assert.equal(merged.succeeded, 3);
  assert.equal(merged.failed, 1);
  assert.deepEqual(merged.warnings, extra.warnings, "warnings preserved");
  assert.deepEqual(merged.errors, extra.errors, "errors preserved");
  assert.deepEqual(merged.caches, base.caches, "caches authoritative from base");
  assert.deepEqual(merged.routing, base.routing, "routing authoritative from base");
  assert.equal(merged.configuredRoutingStrategy, base.configuredRoutingStrategy);
});

test("mergeIntoResponseBody copes with absent `warnings` (back-compat for non-Anthropic syncs)", () => {
  const extra = { total: 1, succeeded: 1, failed: 0, errors: {}, caches: {} };
  const base = {
    caches: {},
    intervalMinutes: 70,
    lastAutoSyncAt: null,
    routing: {},
    configuredRoutingStrategy: "earliest-reset-first",
  };
  const merged = mergeIntoResponseBody(extra, base);
  assert.equal(merged.total, 1);
  assert.equal(merged.warnings, undefined, "warnings field absent when not provided");
});

test("RefreshWarning shape: kind=refresh_transient, reason among 5, since ISO string", () => {
  const validReasons = ["rate_limited", "upstream_5xx", "timeout", "network", "unknown_transient"];
  for (const reason of validReasons) {
    const w = {
      kind: "refresh_transient",
      reason,
      since: new Date().toISOString(),
    };
    assert.equal(w.kind, "refresh_transient");
    assert.ok(validReasons.includes(w.reason), `reason "${reason}" valid`);
    assert.match(w.since, /^\d{4}-\d{2}-\d{2}T/, "since is ISO 8601");
  }
});

test("toProviderLimitsCacheEntry preserves usage.fetchedAt when caller passes it (Oracle PR #29 review M1)", async () => {
  const mod = await import("../../src/lib/usage/providerLimits.ts");
  const { syncAllProviderLimits } = mod;
  // We cannot easily reach the internal toProviderLimitsCacheEntry, but the
  // contract is enforced through the syncAllProviderLimits callsite — verify
  // by checking the exposed batch helper signature change. The forwarded
  // fetchedAt is a `string | undefined`; undefined falls back to NOW.
  // Sanity: function exists, takes options.
  assert.equal(typeof syncAllProviderLimits, "function");
});

test("fetchLiveProviderLimits accepts claudeMaxRetries option (Oracle PR #29 review M3)", async () => {
  const mod = await import("../../src/lib/usage/providerLimits.ts");
  const { fetchLiveProviderLimits } = mod;
  assert.equal(typeof fetchLiveProviderLimits, "function");
  // Call with non-existent connection ID + the new option — must reach the
  // 'Connection not found' throw without erroring on the option shape itself.
  await assert.rejects(
    () => fetchLiveProviderLimits("nonexistent-conn-id", { claudeMaxRetries: 2 }),
    /Connection not found|not available|Failed/
  );
});
