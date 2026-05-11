import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSseDiagnosticsDir } from "@/lib/logEnv";

export type TerminationReason = "flush" | "upstream_error" | "client_abort";

interface BundleConfig {
  captureProviderRawSSELines: boolean;
  captureProviderParsedEvents: boolean;
  captureTranslatedOpenAISSE: boolean;
  keepLastNDebugRequests: number;
  maxDebugBundleSizeMB: number;
  maxActiveDebugBundles: number;
}

interface BundleMetadata {
  requestId: string;
  startedAt: number;
  endedAt?: number;
  termination?: TerminationReason;
  terminationDetail?: string;
  provider?: string | null;
  model?: string | null;
  targetFormat?: string | null;
  sourceFormat?: string | null;
}

interface CaptureBundle {
  metadata: BundleMetadata;
  config: BundleConfig;
  provider_raw_lines: Array<{ ts: number; lineIdx: number; data: string }>;
  provider_parsed_events: unknown[];
  translated_openai_chunks: unknown[];
  _capture_overflow?: boolean;
  _bytes: number;
  _finalized?: boolean;
}

let activeBundleCount = 0;

// TransformStream → bundle registry. createDisconnectAwareStream consults this
// on cancel/abort to finalize the bundle with termination='client_abort' BEFORE
// the underlying reader.cancel() short-circuits the flush() path.
const bundleByTransformStream = new WeakMap<object, CaptureBundle>();

export function registerBundle(transformStream: object, bundle: CaptureBundle | null): void {
  if (!bundle) return;
  bundleByTransformStream.set(transformStream, bundle);
}

export function lookupBundle(transformStream: object): CaptureBundle | null {
  return bundleByTransformStream.get(transformStream) ?? null;
}

export function isAnyCaptureEnabled(config: BundleConfig): boolean {
  return (
    config.captureProviderRawSSELines ||
    config.captureProviderParsedEvents ||
    config.captureTranslatedOpenAISSE
  );
}

function normalizeIntInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function normalizeBundleConfig(config: BundleConfig): BundleConfig | null {
  const keepLastNDebugRequests = normalizeIntInRange(config.keepLastNDebugRequests, 1, 1000);
  const maxDebugBundleSizeMB = normalizeIntInRange(config.maxDebugBundleSizeMB, 1, 1000);
  const maxActiveDebugBundles = normalizeIntInRange(config.maxActiveDebugBundles, 1, 50);
  if (
    keepLastNDebugRequests === null ||
    maxDebugBundleSizeMB === null ||
    maxActiveDebugBundles === null
  ) {
    return null;
  }
  return {
    captureProviderRawSSELines: config.captureProviderRawSSELines === true,
    captureProviderParsedEvents: config.captureProviderParsedEvents === true,
    captureTranslatedOpenAISSE: config.captureTranslatedOpenAISSE === true,
    keepLastNDebugRequests,
    maxDebugBundleSizeMB,
    maxActiveDebugBundles,
  };
}

export function tryCreateBundle(
  config: BundleConfig,
  meta: Pick<BundleMetadata, "provider" | "model" | "targetFormat" | "sourceFormat">
): CaptureBundle | null {
  const normalized = normalizeBundleConfig(config);
  if (!normalized) return null;
  if (!isAnyCaptureEnabled(normalized)) return null;
  if (activeBundleCount >= normalized.maxActiveDebugBundles) return null;
  activeBundleCount += 1;
  return {
    metadata: {
      requestId: randomUUID(),
      startedAt: Date.now(),
      ...meta,
    },
    config: normalized,
    provider_raw_lines: [],
    provider_parsed_events: [],
    translated_openai_chunks: [],
    _bytes: 0,
  };
}

export function appendRawLine(bundle: CaptureBundle | null, lineIdx: number, data: string): void {
  if (!bundle || !bundle.config.captureProviderRawSSELines) return;
  if (bundle._capture_overflow) return;
  const size = approxByteLen(data) + 64;
  if (overflowGuard(bundle, size)) return;
  bundle.provider_raw_lines.push({ ts: Date.now(), lineIdx, data });
  bundle._bytes += size;
}

export function appendParsedEvent(bundle: CaptureBundle | null, event: unknown): void {
  if (!bundle || !bundle.config.captureProviderParsedEvents) return;
  if (bundle._capture_overflow) return;
  const json = safeJson(event);
  const size = approxByteLen(json) + 16;
  if (overflowGuard(bundle, size)) return;
  bundle.provider_parsed_events.push(event);
  bundle._bytes += size;
}

export function appendTranslatedChunk(bundle: CaptureBundle | null, chunk: unknown): void {
  if (!bundle || !bundle.config.captureTranslatedOpenAISSE) return;
  if (bundle._capture_overflow) return;
  const json = safeJson(chunk);
  const size = approxByteLen(json) + 16;
  if (overflowGuard(bundle, size)) return;
  bundle.translated_openai_chunks.push(chunk);
  bundle._bytes += size;
}

export async function finalizeBundle(
  bundle: CaptureBundle | null,
  termination: TerminationReason,
  terminationDetail?: string
): Promise<void> {
  if (!bundle) return;
  if (bundle._finalized) return;
  bundle._finalized = true;
  bundle.metadata.endedAt = Date.now();
  bundle.metadata.termination = termination;
  if (terminationDetail) bundle.metadata.terminationDetail = terminationDetail;

  try {
    const dir = getSseDiagnosticsDir();
    await mkdir(dir, { recursive: true });
    const filename = `${formatTimestamp(bundle.metadata.startedAt)}_${bundle.metadata.requestId}.json`;
    const fullPath = join(dir, filename);
    const payload = JSON.stringify(bundle, null, 2);
    await writeFile(fullPath, payload, "utf8");
    await pruneOldBundles(dir, bundle.config.keepLastNDebugRequests);
  } catch (err) {
    console.warn("[sse-diagnostics] failed to write bundle:", err);
  } finally {
    activeBundleCount = Math.max(0, activeBundleCount - 1);
  }
}

function overflowGuard(bundle: CaptureBundle, addedBytes: number): boolean {
  const cap = bundle.config.maxDebugBundleSizeMB * 1024 * 1024;
  if (bundle._bytes + addedBytes > cap) {
    bundle._capture_overflow = true;
    return true;
  }
  return false;
}

function approxByteLen(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(
    d.getUTCHours()
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function pruneOldBundles(dir: string, keepLastN: number): Promise<void> {
  if (keepLastN <= 0) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const files: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (info && info.isFile()) files.push({ name, mtimeMs: info.mtimeMs });
  }
  if (files.length <= keepLastN) return;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = files.slice(keepLastN);
  for (const entry of toDelete) {
    try {
      await rm(join(dir, entry.name));
    } catch (err) {
      console.warn(`[sse-diagnostics] prune failed for ${entry.name}:`, err);
    }
  }
}

export function _testOnlyResetActiveCount(): void {
  activeBundleCount = 0;
}

export function _testOnlyGetActiveCount(): number {
  return activeBundleCount;
}
