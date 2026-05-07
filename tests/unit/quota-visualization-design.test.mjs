import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

const QV =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaVisualization.tsx");
const OverallQuotaRow = QV.OverallQuotaRow;
const QuotaVisualization = QV.default;

const MESSAGES = { usage: { sessionQuotaLabel: "Session", weeklyQuotaLabel: "Weekly" } };

function renderWithI18n(node) {
  const wrapped = React.createElement(
    NextIntlClientProvider,
    { locale: "en", messages: MESSAGES },
    node
  );
  return renderToStaticMarkup(wrapped);
}

const FUTURE_RESET = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();

// Assert each Tailwind class appears in the rendered HTML independently, so
// harmless refactors (class reordering, additions of equivalent classes) do
// not break these tests. The brittle full-string match used to fail whenever
// Tailwind's JIT or a className helper changed the class order.
function assertHasClasses(html, classes, context) {
  for (const cls of classes) {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[\\s"])${escaped}(?:[\\s"]|$)`);
    assert.match(html, pattern, `${context}: expected class "${cls}" in rendered HTML`);
  }
}

test("OverallQuotaRow renders the unified per-model bar shape (label pill + countdown + bar + %)", () => {
  const html = renderToStaticMarkup(
    React.createElement(OverallQuotaRow, {
      label: "Session",
      pct: 75,
      resetAt: FUTURE_RESET,
    })
  );

  assertHasClasses(
    html,
    [
      "text-[11px]",
      "font-semibold",
      "py-0.5",
      "px-2",
      "rounded",
      "whitespace-nowrap",
      "min-w-[60px]",
      "text-center",
    ],
    "label pill"
  );
  assert.match(html, />Session</, "label text must appear inside the pill");
  assert.match(html, /⏱ /, "countdown clock glyph must be rendered when resetAt is in the future");
  assertHasClasses(html, ["h-1.5", "rounded-sm"], "bar track");
  assert.equal(/rounded-full/.test(html), false, "OverallQuotaRow must NOT use rounded-full");
  assertHasClasses(
    html,
    ["text-[11px]", "font-semibold", "min-w-[32px]", "text-right"],
    "percentage span"
  );
  assert.equal(/font-mono/.test(html), false, "percentage must NOT use font-mono");
  assert.match(html, />75%</, "percentage value must be rounded and rendered");
});

test("OverallQuotaRow with pct=null renders muted placeholder using the same row vocabulary", () => {
  const html = renderToStaticMarkup(
    React.createElement(OverallQuotaRow, { label: "Weekly", pct: null })
  );

  assertHasClasses(
    html,
    ["flex", "items-center", "gap-1.5", "min-w-[200px]", "shrink-0", "opacity-60"],
    "null-pct row container"
  );
  assertHasClasses(
    html,
    ["text-[11px]", "font-semibold", "py-0.5", "px-2", "rounded"],
    "null-pct label pill"
  );
  assert.match(html, />Weekly</);
  assertHasClasses(html, ["h-1.5", "rounded-sm", "bg-black/[0.06]"], "null-pct bar track");
  assert.match(html, />—</);
});

test("OverallQuotaRow without resetAt omits the countdown span", () => {
  const html = renderToStaticMarkup(
    React.createElement(OverallQuotaRow, { label: "Session", pct: 50 })
  );
  assert.equal(/⏱/.test(html), false, "no resetAt should mean no countdown clock glyph");
  assert.match(html, /h-1\.5 rounded-sm/);
  assert.match(html, />50%</);
});

test("OverallQuotaRow with past resetAt renders no countdown", () => {
  const PAST = new Date(Date.now() - 60_000).toISOString();
  const html = renderToStaticMarkup(
    React.createElement(OverallQuotaRow, { label: "Session", pct: 30, resetAt: PAST })
  );
  assert.equal(/⏱/.test(html), false, "past resetAt produces null countdown");
});

test("OverallQuotaRow clamps pct values into [0, 100] inclusive", () => {
  const above = renderToStaticMarkup(
    React.createElement(OverallQuotaRow, { label: "Session", pct: 150 })
  );
  assert.match(above, />100%</);
  assert.match(above, /width:\s*100%/);

  const below = renderToStaticMarkup(
    React.createElement(OverallQuotaRow, { label: "Session", pct: -10 })
  );
  assert.match(below, />0%</);
  assert.match(below, /width:\s*0%/);
});

test("QuotaVisualization always renders both Session AND Weekly rows when only weekly exists", () => {
  // Oracle audit (ses_1fbb494e4ffe7BxOUFFzU8g6dm — defect C): regression guard.
  const html = renderWithI18n(
    React.createElement(QuotaVisualization, {
      quotas: [{ name: "weekly (7d)", remainingPercentage: 60 }],
    })
  );
  assert.match(html, />Session</, "Session row must render even when only weekly is present");
  assert.match(html, />Weekly</, "Weekly row must render with its data");
  assert.match(html, />—</, "absent Session row must render the em-dash placeholder");
  assert.match(html, />60%</, "present Weekly row must render its percentage");
});

test("QuotaVisualization always renders both rows when only session exists", () => {
  const html = renderWithI18n(
    React.createElement(QuotaVisualization, {
      quotas: [{ name: "session", remainingPercentage: 80 }],
    })
  );
  assert.match(html, />Session</);
  assert.match(html, />Weekly</);
  assert.match(html, />80%</);
  assert.match(html, />—</, "absent Weekly row must render the em-dash placeholder");
});

test("QuotaVisualization returns nothing when neither overall window is present", () => {
  const html = renderWithI18n(
    React.createElement(QuotaVisualization, {
      quotas: [{ name: "weekly Sonnet (7d)", remainingPercentage: 50 }],
    })
  );
  assert.equal(/>Session</.test(html), false);
  assert.equal(/>Weekly</.test(html), false);
});

test("QuotaVisualization handles no-space canonical forms (parity with isOverallWindowName)", () => {
  // Oracle audit (defect B): "weekly(7d)" no-space form must be picked up by
  // pickWindow AND filtered out from per-model bars by isOverallWindowName.
  const html = renderWithI18n(
    React.createElement(QuotaVisualization, {
      quotas: [{ name: "weekly(7d)", remainingPercentage: 75 }],
    })
  );
  assert.match(html, />Weekly</);
  assert.match(html, />75%</);
});
