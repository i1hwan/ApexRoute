import test from "node:test";
import assert from "node:assert/strict";

const mod =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaVisualization.tsx");

const { isOverallWindowName, pickWindow } = mod;

test("isOverallWindowName matches canonical session/weekly labels with or without window suffix", () => {
  assert.equal(isOverallWindowName("session"), true);
  assert.equal(isOverallWindowName("Session"), true);
  assert.equal(isOverallWindowName("weekly"), true);
  assert.equal(isOverallWindowName("session (5h)"), true);
  assert.equal(isOverallWindowName("weekly (7d)"), true);
});

test("isOverallWindowName matches no-space canonical forms (parity with pickWindow)", () => {
  // Oracle audit (ses_1fbb494e4ffe7BxOUFFzU8g6dm — defect B): pickWindow accepts
  // both "weekly (7d)" and "weekly(7d)" via startsWith(`${windowKey}(`), so
  // isOverallWindowName MUST accept the same no-space canonical forms or the
  // parent !isOverallWindowName filter in index.tsx will let "weekly(7d)" leak
  // into per-model rendering AND OverallQuotaRow simultaneously. The parity
  // invariant itself is enforced by the dedicated cross-function test below,
  // independent of any specific implementation line.
  assert.equal(isOverallWindowName("session(5h)"), true);
  assert.equal(isOverallWindowName("weekly(7d)"), true);
  assert.equal(isOverallWindowName("Session(5h)"), true);
  assert.equal(isOverallWindowName("Weekly(7d)"), true);
});

test("isOverallWindowName returns false for per-model variants so they render as per-model bars", () => {
  assert.equal(isOverallWindowName("weekly Sonnet"), false);
  assert.equal(isOverallWindowName("weekly Sonnet (7d)"), false);
  assert.equal(isOverallWindowName("Weekly Opus"), false);
  assert.equal(isOverallWindowName("session Sonnet"), false);
  assert.equal(isOverallWindowName(null), false);
  assert.equal(isOverallWindowName(undefined), false);
  assert.equal(isOverallWindowName(""), false);
});

test("pickWindow returns the canonical overall window when present", () => {
  const quotas = [
    { name: "weekly Sonnet (7d)", remainingPercentage: 50 },
    { name: "weekly (7d)", remainingPercentage: 90 },
    { name: "session", remainingPercentage: 75 },
  ];
  assert.equal(pickWindow(quotas, "weekly")?.remainingPercentage, 90);
  assert.equal(pickWindow(quotas, "session")?.remainingPercentage, 75);
});

test("pickWindow does NOT match per-model variants when the canonical overall window is absent", () => {
  // Regression guard for Oracle audit on PR #26: a previous "Pass 2"
  // fallback that matched any name starting with "weekly " could pull in
  // "weekly Sonnet" when no canonical "weekly" / "weekly (...)" row existed.
  // That double-rendered the per-model quota: once as the overall mini-bar,
  // and again as its own per-model bar (because index.tsx filters per-model
  // bars by !isOverallWindowName, which intentionally returns false for
  // model-specific names).
  const onlyPerModel = [
    { name: "weekly Sonnet (7d)", remainingPercentage: 50 },
    { name: "weekly Opus", remainingPercentage: 70 },
  ];
  assert.equal(pickWindow(onlyPerModel, "weekly"), null);
  assert.equal(pickWindow(onlyPerModel, "session"), null);
});

test("pickWindow handles empty / missing-name entries gracefully", () => {
  const quotas = [
    { remainingPercentage: 10 },
    { name: "", remainingPercentage: 20 },
    { name: "session", remainingPercentage: 30 },
  ];
  assert.equal(pickWindow(quotas, "session")?.remainingPercentage, 30);
  assert.equal(pickWindow(quotas, "weekly"), null);
});

test("pickWindow / isOverallWindowName parity: every name pickWindow accepts must be marked overall", () => {
  // Cross-function invariant guard. If pickWindow returns a quota for windowKey,
  // isOverallWindowName(quota.name) MUST return true; otherwise the parent
  // filter would render that same quota as a per-model bar (double-render).
  const cases = [
    { name: "session", key: "session" },
    { name: "Session", key: "session" },
    { name: "session (5h)", key: "session" },
    { name: "session(5h)", key: "session" },
    { name: "weekly", key: "weekly" },
    { name: "Weekly", key: "weekly" },
    { name: "weekly (7d)", key: "weekly" },
    { name: "weekly(7d)", key: "weekly" },
  ];
  for (const { name, key } of cases) {
    const picked = pickWindow([{ name, remainingPercentage: 50 }], key);
    assert.ok(picked, `pickWindow must accept ${name} for windowKey ${key}`);
    assert.equal(
      isOverallWindowName(name),
      true,
      `isOverallWindowName must agree on ${name} (pickWindow accepted it)`
    );
  }
});
