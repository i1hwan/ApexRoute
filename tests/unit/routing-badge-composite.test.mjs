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
const getExcludedI18nKey = /* eslint-disable-line no-new-func */ new Function("reason", match[1]);

test("session<=0% → Exhausted (rev3.2 new reason mapped to existing label)", () => {
  assert.equal(getExcludedI18nKey("session<=0%"), "routingPriorityExcludedExhausted");
});

test("weekly<=0% → Exhausted (rev3.2 new reason mapped to existing label)", () => {
  assert.equal(getExcludedI18nKey("weekly<=0%"), "routingPriorityExcludedExhausted");
});

test("session<5% → LowQuota still maps unchanged (no regression)", () => {
  assert.equal(getExcludedI18nKey("session<5%"), "routingPriorityExcludedLowQuota");
});

test("weekly<5% → LowQuota still maps unchanged (no regression)", () => {
  assert.equal(getExcludedI18nKey("weekly<5%"), "routingPriorityExcludedLowQuota");
});

test("RoutingBadge.tsx composite-badge branch exists (rev3.3 §5B.4)", () => {
  assert.match(source, /nearDepletion/);
  assert.match(source, /routingPriorityRankLowQuota/);
  assert.match(source, /routingPriorityNearDepletionTooltip/);
});

test("RoutingBadge.tsx near-depletion condition uses min(s,w) < 5 with positive floor", () => {
  assert.match(source, /minKnownPct > 0 && minKnownPct < 5/);
});

test("RoutingBadge.tsx uses 'warning' variant for near-depletion (amber styling)", () => {
  assert.match(source, /nearDepletion[\s\S]*?\?\s*"warning"/);
});

test("formatPct preserves sub-1% values as <1 instead of rounding to 0 (Copilot review)", () => {
  const FORMAT_PCT_BODY_RE =
    /export function formatPct\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/;
  const fnMatch = source.match(FORMAT_PCT_BODY_RE);
  if (!fnMatch) {
    throw new Error("formatPct body not found in RoutingBadge.tsx");
  }
  const formatPct = /* eslint-disable-line no-new-func */ new Function("value", fnMatch[1]);

  assert.equal(formatPct(null), "—");
  assert.equal(formatPct(undefined), "—");
  assert.equal(formatPct(Number.NaN), "—");
  assert.equal(formatPct(0), "0");
  assert.equal(formatPct(0.1), "<1", "0.1% must not round to 0% (hard-exclude collision)");
  assert.equal(formatPct(0.9), "<1");
  assert.equal(formatPct(1), "1");
  assert.equal(formatPct(4.3), "4");
  assert.equal(formatPct(95.5), "96");
});

test("ProviderLimits index has Compatibility deep-link", () => {
  const INDEX_PATH = join(
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
    "index.tsx"
  );
  const indexSource = readFileSync(INDEX_PATH, "utf8");
  assert.match(indexSource, /\/dashboard\/settings\?tab=compatibility/);
  assert.match(indexSource, /compatibilitySettingsLink/);
});
