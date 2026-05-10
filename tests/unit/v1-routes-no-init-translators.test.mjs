import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..", "src", "app", "api");

function walk(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, results);
    else if (entry === "route.ts" || entry === "route.js" || entry === "route.tsx") {
      results.push(full);
    }
  }
  return results;
}

function isApiV1Path(absPath) {
  return absPath.includes(`${"api"}/v1/`) || absPath.includes(`${"api"}/v1beta/`);
}

function stripCommentLines(source) {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx >= 0) {
        const before = line.slice(0, idx);
        if (!/["'`]/.test(before)) return before;
      }
      return line;
    })
    .join("\n");
}

test("no /v1* route imports or calls initTranslators (regression guard for #450 / PR #29)", () => {
  const allRoutes = walk(ROOT);
  const v1Routes = allRoutes.filter(isApiV1Path);

  assert.ok(v1Routes.length > 0, "expected at least one /v1* route file");

  const offenders = [];
  for (const file of v1Routes) {
    const raw = readFileSync(file, "utf8");
    const stripped = stripCommentLines(raw);
    if (stripped.includes("initTranslators")) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These /v1* route files still reference initTranslators (must be removed — see /v1/responses/route.ts):\n${offenders.join("\n")}`
  );
});
