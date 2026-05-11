import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CHAT_CORE_PATH = join(__dirname, "..", "..", "open-sse", "handlers", "chatCore.ts");
const source = readFileSync(CHAT_CORE_PATH, "utf8");

test("stripInternalMarkers strips client-controllable lane fields (Copilot trust boundary)", () => {
  const STRIP_FN_RE = /function stripInternalMarkers\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n\}/;
  const match = source.match(STRIP_FN_RE);
  assert.ok(match, "stripInternalMarkers helper must exist in chatCore.ts");

  const body = match[1];
  for (const marker of [
    "_forwardingLane",
    "_toolNameMap",
    "_disableToolPrefix",
    "_nativeCodexPassthrough",
  ]) {
    assert.match(
      body,
      new RegExp(`delete\\s+body\\.${marker}\\b`),
      `stripInternalMarkers must delete body.${marker}`
    );
  }
});

test("incoming client body is stripped before any translation branch runs", () => {
  // The strip must happen before the long `try { if (nativeCodexPassthrough) ... }`
  // chain so every translation branch sees a sanitized body, not just one path.
  const stripIdx = source.indexOf("stripInternalMarkers(body);");
  assert.ok(stripIdx > 0, "stripInternalMarkers(body) call must exist");

  const tryIdx = source.indexOf("if (nativeCodexPassthrough) {", stripIdx);
  assert.ok(tryIdx > stripIdx, "strip must precede the nativeCodexPassthrough branch");
});

test("forwardingLane extraction requires both a real Map and a whitelisted lane", () => {
  // Two gates must coexist near the toolNameMap extraction site:
  //   1) translatedToolNameMap instanceof Map && size > 0   → only trusted internal source
  //   2) isValidForwardingLane(candidateLane)               → lane whitelist
  // Without (1) a client could pass _forwardingLane as a plain string.
  // Without (2) future lane names slip through silently.
  assert.match(source, /hasTrustedToolNameMap\s*&&\s*isValidForwardingLane\(candidateLane\)/);
  assert.match(
    source,
    /translatedToolNameMap\s+instanceof\s+Map\s*&&\s*translatedToolNameMap\.size\s*>\s*0/
  );
  assert.match(
    source,
    /import\s*\{\s*isValidForwardingLane\s*\}\s*from\s+["']\.\.\/translator\/helpers\/toolArgumentMode\.ts["']/
  );
});
