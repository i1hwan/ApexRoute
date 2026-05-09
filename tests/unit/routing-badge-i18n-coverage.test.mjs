import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MESSAGES_DIR = join(__dirname, "..", "..", "src", "i18n", "messages");

const localeFiles = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

test("all locales have routingPriorityExcludedExhausted key", () => {
  const missing = [];
  for (const file of localeFiles) {
    const data = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8"));
    if (!data?.usage?.routingPriorityExcludedExhausted) {
      missing.push(file);
    }
  }
  assert.deepEqual(missing, [], `missing routingPriorityExcludedExhausted: ${missing.join(", ")}`);
});

test("all locales have routingPriorityExcludedLowQuota key", () => {
  const missing = [];
  for (const file of localeFiles) {
    const data = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8"));
    if (!data?.usage?.routingPriorityExcludedLowQuota) {
      missing.push(file);
    }
  }
  assert.deepEqual(missing, [], `missing routingPriorityExcludedLowQuota: ${missing.join(", ")}`);
});

test("no locale carries the deprecated routingPriorityExcludedQuota key (cleaned up)", () => {
  const offenders = [];
  for (const file of localeFiles) {
    const data = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8"));
    if (data?.usage?.routingPriorityExcludedQuota !== undefined) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `deprecated key still present in: ${offenders.join(", ")}`);
});

test("expected locale count (32 total — sanity check)", () => {
  assert.equal(localeFiles.length, 32, "expected 32 locale files");
});
