import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BADGE_PATH = join(
  __dirname,
  "..",
  "..",
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "usage",
  "components",
  "ProviderLimits",
  "RoutingBadge.tsx"
);

const source = readFileSync(BADGE_PATH, "utf8");

const FN_BODY_RE = /function getExcludedI18nKey\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/;
const match = source.match(FN_BODY_RE);
if (!match) {
  throw new Error("getExcludedI18nKey body not found in RoutingBadge.tsx");
}
// We evaluate a copy of the function body extracted from the .tsx source so
// the mapping logic can be tested without spinning up React. The body is read
// from a known fixed file under our own repo at test-load time and never from
// user input.
const getExcludedI18nKey = /* eslint-disable-line no-new-func */ new Function("reason", match[1]);

test("quota_exhausted_unknown_reset → Exhausted (true 429-driven)", () => {
  assert.equal(
    getExcludedI18nKey("quota_exhausted_unknown_reset"),
    "routingPriorityExcludedExhausted"
  );
});

test("weekly<5% → LowQuota (routing-only threshold)", () => {
  assert.equal(getExcludedI18nKey("weekly<5%"), "routingPriorityExcludedLowQuota");
});

test("session<5% → LowQuota (routing-only threshold)", () => {
  assert.equal(getExcludedI18nKey("session<5%"), "routingPriorityExcludedLowQuota");
});

test("rate_limited → RateLimited (unchanged)", () => {
  assert.equal(getExcludedI18nKey("rate_limited"), "routingPriorityExcludedRateLimited");
});

test("inactive → Inactive (unchanged)", () => {
  assert.equal(getExcludedI18nKey("inactive"), "routingPriorityExcludedInactive");
});

test("terminal → Terminal (unchanged)", () => {
  assert.equal(getExcludedI18nKey("terminal"), "routingPriorityExcludedTerminal");
});

test("null → Unknown", () => {
  assert.equal(getExcludedI18nKey(null), "routingPriorityExcludedUnknown");
});

test("unknown reason → Unknown (default)", () => {
  assert.equal(getExcludedI18nKey("some_unrecognized_reason"), "routingPriorityExcludedUnknown");
});

test("legacy routingPriorityExcludedQuota key is no longer emitted by any caller path", () => {
  const result = [
    getExcludedI18nKey("quota_exhausted_unknown_reset"),
    getExcludedI18nKey("weekly<5%"),
    getExcludedI18nKey("session<5%"),
    getExcludedI18nKey("rate_limited"),
    getExcludedI18nKey("inactive"),
    getExcludedI18nKey("terminal"),
    getExcludedI18nKey(null),
    getExcludedI18nKey("foo"),
  ];
  assert.ok(
    !result.includes("routingPriorityExcludedQuota"),
    "no caller path should map to the deprecated routingPriorityExcludedQuota key"
  );
});
