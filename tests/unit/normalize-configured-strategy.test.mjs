import test from "node:test";
import assert from "node:assert/strict";

const routingStrategies = await import("../../src/shared/constants/routingStrategies.ts");
const { normalizeConfiguredStrategy, SETTINGS_FALLBACK_STRATEGY_VALUES } = routingStrategies;

test("normalizeConfiguredStrategy: passes through every value declared in SETTINGS_FALLBACK_STRATEGY_VALUES", () => {
  for (const value of SETTINGS_FALLBACK_STRATEGY_VALUES) {
    assert.equal(normalizeConfiguredStrategy(value), value);
  }
});

test("normalizeConfiguredStrategy: SETTINGS_FALLBACK_STRATEGY_VALUES is the expected 13-item set", () => {
  assert.equal(SETTINGS_FALLBACK_STRATEGY_VALUES.length, 13);
});

test("normalizeConfiguredStrategy: null falls back to fill-first", () => {
  assert.equal(normalizeConfiguredStrategy(null), "fill-first");
});

test("normalizeConfiguredStrategy: undefined falls back to fill-first", () => {
  assert.equal(normalizeConfiguredStrategy(undefined), "fill-first");
});

test("normalizeConfiguredStrategy: empty string falls back to fill-first", () => {
  assert.equal(normalizeConfiguredStrategy(""), "fill-first");
});

test("normalizeConfiguredStrategy: unrecognized value falls back to fill-first", () => {
  assert.equal(normalizeConfiguredStrategy("nonexistent-strategy"), "fill-first");
  assert.equal(normalizeConfiguredStrategy("ROUND-ROBIN"), "fill-first");
  assert.equal(normalizeConfiguredStrategy("priority "), "fill-first");
});

test("normalizeConfiguredStrategy: known case sensitivity holds (case-sensitive match)", () => {
  assert.equal(normalizeConfiguredStrategy("Earliest-Reset-First"), "fill-first");
  assert.equal(normalizeConfiguredStrategy("earliest-reset-first"), "earliest-reset-first");
});
