/**
 * Session Fingerprinting — Phase 5
 *
 * Generates stable session IDs for sticky routing,
 * prompt caching, and per-session tracking.
 */

import { createHash } from "node:crypto";

import * as log from "@/sse/utils/logger";

interface SessionEntry {
  createdAt: number;
  lastActive: number;
  requestCount: number;
  connectionId: string | null;
}

interface SessionFingerprintOptions {
  provider?: string;
  connectionId?: string;
}

interface SessionMessage {
  role?: string;
  content?: unknown;
}

interface SessionBody {
  model?: string;
  system?: unknown;
  tools?: Array<{ name?: string; function?: { name?: string } }>;
  messages?: SessionMessage[];
  input?: SessionMessage[];
}

// In-memory session store with metadata
// key: sessionId → { createdAt, lastActive, requestCount, connectionId? }
const sessions = new Map<string, SessionEntry>();

// Auto-cleanup sessions older than 30 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastActive > SESSION_TTL_MS) {
      sessions.delete(key);
      for (const [apiKeyId, sessionSet] of activeSessionsByKey) {
        sessionSet.delete(key);
        if (sessionSet.size === 0) activeSessionsByKey.delete(apiKeyId);
      }
    }
  }
}, 60_000);
_cleanupTimer.unref();

/**
 * Generate a stable session fingerprint from request characteristics.
 * Same client + same conversation → same session ID.
 *
 * Fingerprint factors:
 * - System prompt hash (stable per conversation/tool)
 * - First user message hash (stable per conversation)
 * - Model name
 * - Provider (optional)
 * - Tools signature (sorted tool names)
 *
 * @param {object} body - Request body
 * @param {object} [options] - Extra context
 * @returns {string} Session ID (hex hash)
 */
export function generateSessionId(
  body: SessionBody | null | undefined,
  options: SessionFingerprintOptions = {}
): string | null {
  if (!body || typeof body !== "object") return null;
  const parts: string[] = [];

  // Model contributes to fingerprint
  if (body.model) parts.push(`model:${body.model}`);

  // Provider binding
  if (options.provider) parts.push(`provider:${options.provider}`);

  // System prompt hash (first 32 chars of system content)
  const systemPrompt = extractSystemPrompt(body);
  if (systemPrompt) {
    parts.push(`sys:${hashShort(systemPrompt)}`);
  }

  // First user message hash (identifies the conversation)
  const firstUser = extractFirstUserMessage(body);
  if (firstUser) {
    parts.push(`user0:${hashShort(firstUser)}`);
  }

  // Tools signature (sorted names)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const toolNames = body.tools
      .map((t) => t.name || t.function?.name || "")
      .filter(Boolean)
      .sort()
      .join(",");
    if (toolNames) parts.push(`tools:${hashShort(toolNames)}`);
  }

  // Connection ID for sticky routing
  if (options.connectionId) parts.push(`conn:${options.connectionId}`);

  if (parts.length === 0) return null;

  const fingerprint = parts.join("|");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
}

// Affinity binding window — must match earliestResetFirst.SESSION_AFFINITY_WINDOW_MS.
// Duplicated here as a constant rather than imported to avoid a circular dependency
// (earliestResetFirst already imports from this module). PR #28 invariant — keep
// in lockstep with the strategy module.
const SESSION_AFFINITY_WINDOW_MS = 5 * 60 * 1000;

let warnedAboutTouchSessionDeprecatedArg = false;

/**
 * Touch a session (activity update only).
 *
 * Updates `lastActive` and increments `requestCount`. CREATES a new session
 * entry if one did not exist (with `connectionId: null`). DOES NOT mutate
 * `connectionId` on existing entries — that is reserved for
 * `bindSessionConnection()` so binding mutations are explicit and traceable.
 *
 * Backwards-compat overload: a few legacy call sites and tests still pass a
 * second `connectionId` argument. When seen, this function emits a one-shot
 * structured warning and forwards to `bindSessionConnection` so the binding
 * still happens but the caller is flagged for migration.
 *
 * Oracle audit ses_1fa7165c0ffeFFU8rjU82y0ItO + ses_1f85345c8ffebTdtpTaQ5aeN8J.
 */
export function touchSession(
  sessionId: string | null,
  deprecatedConnectionId: string | null = null
): void {
  if (!sessionId) return;
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastActive = Date.now();
    existing.requestCount++;
  } else {
    sessions.set(sessionId, {
      createdAt: Date.now(),
      lastActive: Date.now(),
      requestCount: 1,
      connectionId: null,
    });
  }
  if (deprecatedConnectionId) {
    if (!warnedAboutTouchSessionDeprecatedArg) {
      warnedAboutTouchSessionDeprecatedArg = true;
      log.warn(
        "SESSION",
        "touchSession(sessionId, connectionId) is deprecated; switch to bindSessionConnection(...)",
        { sessionId, connectionIdSuffix: deprecatedConnectionId.slice(-8) }
      );
    }
    bindSessionConnection(sessionId, deprecatedConnectionId, {
      source: "explicit_post_credential",
    });
  }
}

export type BindReason =
  | "no_session_id"
  | "first_bind"
  | "no_change"
  | "rebind_within_window"
  | "rebind_after_window";

export interface BindResult {
  ok: boolean;
  reason: BindReason;
  oldConnectionId: string | null;
  newConnectionId: string | null;
}

export type BindSource =
  | "affinity_kept"
  | "fall_through"
  | "explicit_post_credential"
  | "emergency_fallback";

/**
 * Bind (or rebind) a session to a connection.
 *
 * This is the ONLY function that mutates `SessionEntry.connectionId`. Every
 * binding mutation carries a declared `source` so production logs can answer
 * "why did this session move from APEXA to GNUMAX?" — the previous
 * implementation silently overwrote on every `touchSession()` call, erasing
 * the original binding evidence (Oracle audit ses_1fa7165c0ffeFFU8rjU82y0ItO).
 *
 * Behaviour:
 * - `sessionId` null/empty → ok:false, reason: "no_session_id"
 * - no existing entry → create with `connectionId`, reason: "first_bind"
 * - existing.connectionId === connectionId → no mutation, reason: "no_change"
 * - existing.connectionId !== connectionId AND within the affinity window
 *   (lastActive within 5 minutes) → mutate + reason: "rebind_within_window"
 *   AND emit `log.warn` (production alarm signal — this should be rare and
 *   only happen when a heuristic break or hard exclusion triggered)
 * - existing.connectionId !== connectionId AND after the affinity window →
 *   mutate + reason: "rebind_after_window" (debug-level, expected)
 */
export function bindSessionConnection(
  sessionId: string | null,
  connectionId: string,
  context: { source: BindSource }
): BindResult {
  if (!sessionId) {
    return { ok: false, reason: "no_session_id", oldConnectionId: null, newConnectionId: null };
  }
  const existing = sessions.get(sessionId);
  const now = Date.now();
  if (!existing) {
    sessions.set(sessionId, {
      createdAt: now,
      lastActive: now,
      requestCount: 1,
      connectionId,
    });
    return {
      ok: true,
      reason: "first_bind",
      oldConnectionId: null,
      newConnectionId: connectionId,
    };
  }
  const oldConnectionId = existing.connectionId;
  if (oldConnectionId === connectionId) {
    existing.lastActive = now;
    return {
      ok: true,
      reason: "no_change",
      oldConnectionId,
      newConnectionId: connectionId,
    };
  }
  // First-bind-after-touch: production flow calls touchSession(sessionId)
  // first (creating an entry with connectionId: null), then this function
  // makes the binding decision. Treat null → real conn as first_bind, NOT
  // rebind_within_window — otherwise every new session's first real bind
  // would emit a within-window warning, drowning the actual diagnostic
  // signal we want to see when a live session jumps connections.
  if (oldConnectionId === null) {
    existing.connectionId = connectionId;
    existing.lastActive = now;
    return {
      ok: true,
      reason: "first_bind",
      oldConnectionId: null,
      newConnectionId: connectionId,
    };
  }
  const withinWindow = now - existing.lastActive <= SESSION_AFFINITY_WINDOW_MS;
  existing.connectionId = connectionId;
  existing.lastActive = now;
  // Suppress the within-window alarm for legitimate emergency fallback
  // rebinds (chat.ts retry path). Those are expected behavior, not a
  // diagnostic anomaly.
  const isEmergencyFallback = context.source === "emergency_fallback";
  if (withinWindow && !isEmergencyFallback) {
    log.warn("SESSION/affinity", "session rebound within affinity window", {
      sessionId,
      oldConnectionId,
      newConnectionId: connectionId,
      source: context.source,
      sessionAgeMs: now - existing.createdAt,
    });
  }
  return {
    ok: true,
    reason: withinWindow ? "rebind_within_window" : "rebind_after_window",
    oldConnectionId,
    newConnectionId: connectionId,
  };
}

/**
 * Get session info (for sticky routing decisions)
 */
export function getSessionInfo(sessionId: string | null): SessionEntry | null {
  if (!sessionId) return null;
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.lastActive > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return { ...entry };
}

/**
 * Get the bound connection for a session (sticky routing)
 */
export function getSessionConnection(sessionId: string | null): string | null {
  const info = getSessionInfo(sessionId);
  return info?.connectionId || null;
}

/**
 * Get session count (for dashboard)
 */
export function getActiveSessionCount(): number {
  return sessions.size;
}

/**
 * Get all active sessions (for dashboard)
 */
export function getActiveSessions(): Array<SessionEntry & { sessionId: string; ageMs: number }> {
  const now = Date.now();
  const result: Array<SessionEntry & { sessionId: string; ageMs: number }> = [];
  for (const [id, entry] of sessions) {
    if (now - entry.lastActive <= SESSION_TTL_MS) {
      result.push({ sessionId: id, ...entry, ageMs: now - entry.createdAt });
    }
  }
  return result;
}

/**
 * Clear all sessions (for testing)
 */
export function clearSessions(): void {
  sessions.clear();
  activeSessionsByKey.clear();
}

// ─── T08: Per-API-Key Session Limit ─────────────────────────────────────────
// Tracks concurrent sticky sessions per API key and enforces max_sessions limits.
// Ref: sub2api PR #634 (fix: stabilize session hash + add user-level session limit)

// Map: apiKeyId → Set<sessionId>
const activeSessionsByKey = new Map<string, Set<string>>();

/**
 * T08: Get the number of currently active sessions for an API key.
 * @param apiKeyId - The API key's UUID from the database
 */
export function getActiveSessionCountForKey(apiKeyId: string): number {
  return activeSessionsByKey.get(apiKeyId)?.size ?? 0;
}

/**
 * Snapshot of active session counts per API key.
 */
export function getAllActiveSessionCountsByKey(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [apiKeyId, sessionIds] of activeSessionsByKey) {
    out[apiKeyId] = sessionIds.size;
  }
  return out;
}

/**
 * T08: Register a session as belonging to an API key.
 * Call this after session creation is allowed (i.e., limit check passed).
 */
export function registerKeySession(apiKeyId: string, sessionId: string): void {
  if (!activeSessionsByKey.has(apiKeyId)) {
    activeSessionsByKey.set(apiKeyId, new Set());
  }
  activeSessionsByKey.get(apiKeyId)!.add(sessionId);
}

/**
 * Check whether a given session is already registered for an API key.
 */
export function isSessionRegisteredForKey(apiKeyId: string, sessionId: string): boolean {
  return activeSessionsByKey.get(apiKeyId)?.has(sessionId) === true;
}

/**
 * T08: Unregister a session from an API key's active set.
 * Call this when the request closes or the session TTL expires.
 */
export function unregisterKeySession(apiKeyId: string, sessionId: string): void {
  activeSessionsByKey.get(apiKeyId)?.delete(sessionId);
  // Clean up empty sets to avoid memory leaks
  if (activeSessionsByKey.get(apiKeyId)?.size === 0) {
    activeSessionsByKey.delete(apiKeyId);
  }
}

/**
 * T08: Check whether adding a new session would exceed the key's max_sessions limit.
 * Returns null if allowed, or an error object to return as a 429 response.
 *
 * @param apiKeyId - The API key's UUID
 * @param maxSessions - The limit from the DB (0 = unlimited)
 */
export function checkSessionLimit(
  apiKeyId: string,
  maxSessions: number
): { code: "SESSION_LIMIT_EXCEEDED"; message: string; limit: number; current: number } | null {
  if (!maxSessions || maxSessions <= 0) return null; // unlimited
  const current = getActiveSessionCountForKey(apiKeyId);
  if (current < maxSessions) return null;
  return {
    code: "SESSION_LIMIT_EXCEEDED",
    message:
      `You have reached the maximum number of active sessions (${maxSessions}). ` +
      `Please close unused sessions or wait for them to expire.`,
    limit: maxSessions,
    current,
  };
}

/**
 * T04: Extract an external session ID from request headers.
 *
 * Accepts both hyphenated and underscore forms for Nginx compatibility.
 * Nginx drops headers with underscores by default — use `underscores_in_headers on`
 * in nginx.conf, or use X-Session-Id (hyphenated) which passes cleanly.
 *
 * Header sources are namespaced so the same raw value sent in two different
 * headers does NOT collide as the same internal session. opencode CLI sends
 * `x-session-affinity` with its own session id format (e.g. "ses_..."); a
 * different client sending the same string in `x-session-id` would otherwise
 * pin to the same bound conn. Per-source prefixes prevent that.
 *
 * Trust model: external session IDs share a process-global namespace (no
 * per-API-key isolation yet). Routing remains constrained by the requesting
 * key's candidate pool, so cross-tenant routing cannot occur — but two
 * clients on different keys sending the same header value would observe the
 * same `lastActive`/`requestCount` counters. API-key-scoped IDs are tracked
 * as a separate future change.
 *
 * Ref: sub2api README + PR #634, Oracle audit ses_1f85345c8ffebTdtpTaQ5aeN8J.
 *
 * @param headers - Request headers (Headers object or plain object with .get())
 * @returns External session ID with source-specific prefix, or null
 */
export function extractExternalSessionId(
  headers: Headers | { get?: (n: string) => string | null } | null | undefined
): string | null {
  if (!headers || typeof (headers as Headers).get !== "function") return null;
  const h = headers as Headers;
  // Use top-level (single-colon) prefixes outside the legacy `ext:<raw>`
  // namespace. Earlier draft used `ext:xsa:` which appeared to namespace the
  // value but was structurally identical to a legacy `x-session-id: xsa:foo`
  // value (both produced `ext:xsa:foo`). The hyphenated forms `ext-xsa` /
  // `ext-omr` cannot collide because no legacy generic ID can begin with
  // those (they would have to contain a hyphen in the prefix, which the
  // generic chain cannot produce).
  const sources: Array<readonly [string, string]> = [
    ["x-session-id", "ext"],
    ["x_session_id", "ext"],
    ["x-session-affinity", "ext-xsa"],
    ["x-omniroute-session", "ext-omr"],
    ["session-id", "ext"],
  ];
  for (const [name, prefix] of sources) {
    const raw = h.get(name);
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    return `${prefix}:${trimmed.slice(0, 64)}`;
  }
  return null;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function hashShort(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

function extractSystemPrompt(body: SessionBody | null | undefined): string | null {
  if (!body || typeof body !== "object") return null;
  // Claude format: body.system
  if (body.system) {
    return typeof body.system === "string" ? body.system : JSON.stringify(body.system);
  }
  // OpenAI format: messages[0].role === "system"
  if (Array.isArray(body.messages)) {
    const sys = body.messages.find((m) => m.role === "system" || m.role === "developer");
    if (sys) {
      return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
    }
  }
  return null;
}

function extractFirstUserMessage(body: SessionBody | null | undefined): string | null {
  if (!body || typeof body !== "object") return null;
  const messages = body.messages || body.input || [];
  if (!Array.isArray(messages)) return null;
  for (const msg of messages) {
    if (msg.role === "user") {
      return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    }
  }
  return null;
}
