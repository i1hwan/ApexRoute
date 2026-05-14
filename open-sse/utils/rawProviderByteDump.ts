// One-shot debug helper for capturing raw provider SSE bytes BEFORE TextDecoder.
//
// Why this exists:
//   We have a real production complaint that some Korean codepoints in tool_use
//   inputs (notably proxy_question with deeply-nested + long Korean payloads)
//   arrive at the user's UI as wrong-but-valid Hangul. Detailed logs only store
//   ApexRoute's reconstructed summary, not the wire bytes from the upstream
//   provider, so we cannot tell whether the corruption was already present in
//   the bytes Anthropic sent, or whether something in the byte->summary chain
//   inside ApexRoute mutated the codepoint.
//
// Activation:
//   Set environment variable APEXROUTE_DEBUG_RAW_PROVIDER_BYTES=1 (or "true").
//   When unset (default), this module is a no-op and adds zero work to the
//   hot path beyond a single boolean check.
//
// Output:
//   When active, raw chunk bytes are appended (as hex pairs separated by
//   spaces, prefixed with epoch-ms and a connection id) to:
//     <DATA_DIR or ~/.omniroute>/debug/raw-provider-bytes-<provider>-<id>.log
//
//   One file per (provider, connectionId) pair. The hex format is verbose but
//   trivially safe to grep for byte sequences like "ec eb 9c" (one of the
//   wrong-codepoint suspects) and to feed back into a small decoder for
//   side-by-side comparison against the summary.
//
// Lifetime:
//   This is a temporary diagnostic. Once the corruption source is confirmed
//   we remove the helper and revert the call site.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ENV_FLAG = "APEXROUTE_DEBUG_RAW_PROVIDER_BYTES";
const enabled = (() => {
  const raw = process.env[ENV_FLAG];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
})();

let dumpDirEnsured = false;

function getDumpDir(): string {
  const dataDir = process.env.DATA_DIR || path.join(homedir(), ".omniroute");
  return path.join(dataDir, "debug");
}

function ensureDumpDir() {
  if (dumpDirEnsured) return;
  const dir = getDumpDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  dumpDirEnsured = true;
}

function sanitizeForFilename(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || fallback;
}

function bytesToHex(chunk: Uint8Array): string {
  // Hex pairs separated by spaces. Verbose but unambiguous.
  const out: string[] = new Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) {
    out[i] = chunk[i].toString(16).padStart(2, "0");
  }
  return out.join(" ");
}

export function isRawProviderDumpEnabled(): boolean {
  return enabled;
}

export function dumpRawProviderChunk(
  chunk: Uint8Array | undefined | null,
  metadata: { provider?: string | null; connectionId?: string | null }
): void {
  if (!enabled) return;
  if (!chunk || chunk.length === 0) return;

  try {
    ensureDumpDir();
    const provider = sanitizeForFilename(metadata.provider, "unknown_provider");
    const connectionId = sanitizeForFilename(metadata.connectionId, "unknown_connection");
    const filename = `raw-provider-bytes-${provider}-${connectionId}.log`;
    const filePath = path.join(getDumpDir(), filename);

    const ts = Date.now();
    const hex = bytesToHex(chunk);
    const line = `${ts} len=${chunk.length} hex=${hex}\n`;

    appendFileSync(filePath, line, "utf8");
  } catch (err) {
    // Diagnostic helper must never crash the request. Best-effort.
    if (process.env.NODE_ENV !== "production") {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[raw-provider-byte-dump] write failed: ${message}`);
    }
  }
}
