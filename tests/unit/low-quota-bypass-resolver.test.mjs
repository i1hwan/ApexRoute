import test from "node:test";
import assert from "node:assert/strict";

const { resolveLowQuotaBypass } = await import("../../open-sse/services/routing/lowQuotaBypass.ts");

test("empty settings → false", () => {
  assert.equal(resolveLowQuotaBypass(null, "claude"), false);
  assert.equal(resolveLowQuotaBypass(undefined, "claude"), false);
  assert.equal(resolveLowQuotaBypass({}, "claude"), false);
});

test("default: true → true (when no per-provider override)", () => {
  assert.equal(resolveLowQuotaBypass({ default: true }, "claude"), true);
});

test("byProvider.claude: true → true (for claude provider)", () => {
  assert.equal(
    resolveLowQuotaBypass({ default: false, byProvider: { claude: true } }, "claude"),
    true
  );
});

test("byProvider override takes precedence over default", () => {
  assert.equal(
    resolveLowQuotaBypass({ default: true, byProvider: { claude: false } }, "claude"),
    false
  );
  assert.equal(
    resolveLowQuotaBypass({ default: false, byProvider: { claude: true } }, "claude"),
    true
  );
});

test("byProvider.claude: true → falls back to default for non-claude providers", () => {
  assert.equal(
    resolveLowQuotaBypass({ default: false, byProvider: { claude: true } }, "anthropic"),
    false
  );
  assert.equal(
    resolveLowQuotaBypass({ default: true, byProvider: { claude: false } }, "anthropic"),
    true
  );
});

test("provider=null → only default applies (dashboard preview without provider context)", () => {
  assert.equal(
    resolveLowQuotaBypass({ default: false, byProvider: { claude: true } }, null),
    false
  );
  assert.equal(resolveLowQuotaBypass({ default: true, byProvider: { claude: false } }, null), true);
});

test("malformed settings → safe fallback to false", () => {
  assert.equal(resolveLowQuotaBypass({ default: "yes" }, "claude"), false);
  assert.equal(resolveLowQuotaBypass({ byProvider: "garbage" }, "claude"), false);
  assert.equal(
    resolveLowQuotaBypass({ default: true, byProvider: { claude: "yes" } }, "claude"),
    true
  );
});

test("rev3.3 — no byLane field on resolver signature", () => {
  assert.equal(resolveLowQuotaBypass.length, 2);
});
