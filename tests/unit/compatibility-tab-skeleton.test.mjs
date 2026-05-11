import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");

const PAGE_TSX = join(ROOT, "src", "app", "(dashboard)", "dashboard", "settings", "page.tsx");
const TAB_TSX = join(
  ROOT,
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "settings",
  "components",
  "CompatibilityTab.tsx"
);
const EN_JSON = join(ROOT, "src", "i18n", "messages", "en.json");
const KO_JSON = join(ROOT, "src", "i18n", "messages", "ko.json");

const pageSource = readFileSync(PAGE_TSX, "utf8");
const tabSource = readFileSync(TAB_TSX, "utf8");
const en = JSON.parse(readFileSync(EN_JSON, "utf8"));
const ko = JSON.parse(readFileSync(KO_JSON, "utf8"));

test("page.tsx registers the compatibility tab in tabs array", () => {
  assert.match(pageSource, /id:\s*["']compatibility["']/);
  assert.match(pageSource, /labelKey:\s*["']compatibility["']/);
});

test("page.tsx renders CompatibilityTab when activeTab === compatibility", () => {
  assert.match(pageSource, /activeTab === "compatibility" && <CompatibilityTab \/>/);
});

test("CompatibilityTab renders 4 subsections", () => {
  assert.match(tabSource, /ToolArgumentModeSection/);
  assert.match(tabSource, /LowQuotaBypassSection/);
  assert.match(tabSource, /SSEDiagnosticsSection/);
  assert.match(tabSource, /TerminalRecoverySection/);
});

const REQUIRED_KEYS = [
  "compatibility",
  "compatibilityToolArgsTitle",
  "compatibilityToolArgsDescription",
  "compatibilityToolArgsModeStreamNormalized",
  "compatibilityToolArgsModeBufferedFinal",
  "compatibilityToolArgsDefaultLabel",
  "compatibilityToolArgsByProviderLabel",
  "compatibilityToolArgsByLaneLabel",
  "compatibilityToolArgsByLaneHint",
  "compatibilityLowQuotaTitle",
  "compatibilityLowQuotaDescription",
  "compatibilityLowQuotaDefaultLabel",
  "compatibilityLowQuotaModeExclude",
  "compatibilityLowQuotaModeBypass",
  "compatibilityLowQuotaByProviderLabel",
  "compatibilityLowQuotaByLaneLabel",
  "compatibilitySseDiagnosticsTitle",
  "compatibilitySseDiagnosticsDescription",
  "compatibilitySseDiagnosticsRawLines",
  "compatibilitySseDiagnosticsParsedEvents",
  "compatibilitySseDiagnosticsTranslatedChunks",
  "compatibilitySseDiagnosticsKeepLastN",
  "compatibilitySseDiagnosticsMaxBundleSize",
  "compatibilitySseDiagnosticsMaxActiveBundles",
  "compatibilitySseDiagnosticsClear",
  "compatibilitySseDiagnosticsClearConfirm",
  "compatibilityTerminalRecoveryTitle",
  "compatibilityTerminalRecoveryDescription",
  "compatibilityTerminalRecoveryDisabled",
  "compatibilityProviderColumn",
  "compatibilityLaneColumn",
  "compatibilityModeColumn",
  "compatibilityRemoveAction",
  "compatibilityAddProviderOverride",
  "compatibilityAddLaneOverride",
  "compatibilitySelectProvider",
  "compatibilitySelectLane",
  "compatibilityNoOverrides",
];

test("en.json contains every compatibility i18n key", () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(
      typeof en.settings?.[key] === "string" && en.settings[key].length > 0,
      `missing/empty en.settings.${key}`
    );
  }
});

test("ko.json contains every compatibility i18n key", () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(
      typeof ko.settings?.[key] === "string" && ko.settings[key].length > 0,
      `missing/empty ko.settings.${key}`
    );
  }
});

test("ko.json compatibility keys are not just english fallback (sanity)", () => {
  assert.notEqual(ko.settings.compatibility, en.settings.compatibility);
  assert.notEqual(ko.settings.compatibilityToolArgsTitle, en.settings.compatibilityToolArgsTitle);
});
