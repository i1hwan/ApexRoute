import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");

const MIGRATION = join(ROOT, "src", "lib", "db", "migrations", "021_compatibility_settings.sql");
const SCHEMAS = join(ROOT, "src", "shared", "validation", "settingsSchemas.ts");
const SETTINGS_DB = join(ROOT, "src", "lib", "db", "settings.ts");

const ROUTES = [
  join(ROOT, "src", "app", "api", "settings", "tool-argument-mode", "route.ts"),
  join(ROOT, "src", "app", "api", "settings", "low-quota-bypass", "route.ts"),
  join(ROOT, "src", "app", "api", "settings", "sse-diagnostics", "route.ts"),
  join(ROOT, "src", "app", "api", "settings", "sse-diagnostics", "clear", "route.ts"),
];

test("migration 021 file exists and contains 3 settings rows", () => {
  assert.ok(existsSync(MIGRATION), "021_compatibility_settings.sql is missing");
  const sql = readFileSync(MIGRATION, "utf8");
  assert.ok(sql.includes("toolArgumentMode"));
  assert.ok(sql.includes("lowQuotaBypass"));
  assert.ok(sql.includes("sseDiagnostics"));
  assert.ok(!sql.includes("terminalRecovery"), "rev3.2 fix #5: no terminalRecovery key");

  const insertCount = (sql.match(/INSERT OR IGNORE INTO key_value/g) || []).length;
  assert.equal(insertCount, 3, "expected exactly 3 INSERT OR IGNORE statements");
});

test("migration 021 default for toolArgumentMode is stream-normalized", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /"default":"stream-normalized"/);
});

test("migration 021 default for lowQuotaBypass is false", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /"default":false/);
});

test("migration 021 default for sseDiagnostics has maxActiveDebugBundles", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /"maxActiveDebugBundles":5/);
});

test("Zod schemas + defaults exported from settingsSchemas.ts", () => {
  const source = readFileSync(SCHEMAS, "utf8");
  assert.match(source, /export const toolArgumentModeSettingsSchema/);
  assert.match(source, /export const lowQuotaBypassSettingsSchema/);
  assert.match(source, /export const sseDiagnosticsSettingsSchema/);
  assert.match(source, /export const TOOL_ARGUMENT_MODE_DEFAULT/);
  assert.match(source, /export const LOW_QUOTA_BYPASS_DEFAULT/);
  assert.match(source, /export const SSE_DIAGNOSTICS_DEFAULT/);
});

test("settings.ts getSettings defaults include 3 new keys", () => {
  const source = readFileSync(SETTINGS_DB, "utf8");
  assert.match(source, /toolArgumentMode:\s*TOOL_ARGUMENT_MODE_DEFAULT/);
  assert.match(source, /lowQuotaBypass:\s*LOW_QUOTA_BYPASS_DEFAULT/);
  assert.match(source, /sseDiagnostics:\s*SSE_DIAGNOSTICS_DEFAULT/);
});

test("all 4 API route files exist with required exports", () => {
  for (const path of ROUTES) {
    assert.ok(existsSync(path), `missing route file: ${path}`);
    const source = readFileSync(path, "utf8");
    if (path.endsWith("clear/route.ts")) {
      assert.match(source, /export async function POST/);
    } else {
      assert.match(source, /export async function GET/);
      assert.match(source, /export async function PUT/);
    }
  }
});

test("PUT routes validate body with Zod helper", () => {
  for (const path of ROUTES) {
    if (path.endsWith("clear/route.ts")) continue;
    const source = readFileSync(path, "utf8");
    assert.match(source, /validateBody/, `${path} should validate body with validateBody`);
    assert.match(source, /isValidationFailure/, `${path} should branch on isValidationFailure`);
  }
});

test("clear route uses getSseDiagnosticsDir helper", () => {
  const source = readFileSync(
    join(ROOT, "src", "app", "api", "settings", "sse-diagnostics", "clear", "route.ts"),
    "utf8"
  );
  assert.match(source, /getSseDiagnosticsDir/);
});

test("schemas reject unknown provider keys at type level (canonical id whitelist)", () => {
  const source = readFileSync(SCHEMAS, "utf8");
  assert.match(source, /USAGE_SUPPORTED_PROVIDERS/);
  assert.match(source, /providerOverrideRecord/);
});

test("Subsection components fetch their own endpoint", () => {
  const toolArgs = readFileSync(
    join(
      ROOT,
      "src",
      "app",
      "(dashboard)",
      "dashboard",
      "settings",
      "components",
      "CompatibilityTab",
      "ToolArgumentModeSection.tsx"
    ),
    "utf8"
  );
  assert.match(toolArgs, /\/api\/settings\/tool-argument-mode/);

  const lowQuota = readFileSync(
    join(
      ROOT,
      "src",
      "app",
      "(dashboard)",
      "dashboard",
      "settings",
      "components",
      "CompatibilityTab",
      "LowQuotaBypassSection.tsx"
    ),
    "utf8"
  );
  assert.match(lowQuota, /\/api\/settings\/low-quota-bypass/);

  const sseDiag = readFileSync(
    join(
      ROOT,
      "src",
      "app",
      "(dashboard)",
      "dashboard",
      "settings",
      "components",
      "CompatibilityTab",
      "SSEDiagnosticsSection.tsx"
    ),
    "utf8"
  );
  assert.match(sseDiag, /\/api\/settings\/sse-diagnostics/);
  assert.match(sseDiag, /\/api\/settings\/sse-diagnostics\/clear/);
});
