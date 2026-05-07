import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-sessions-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const sessionManager = await import("../../open-sse/services/sessionManager.ts");
const sessionsRoute = await import("../../src/app/api/sessions/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  sessionManager.clearSessions();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  sessionManager.clearSessions();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("GET /api/sessions enriches with accountName + provider when connection exists", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "claude",
    name: "primary-claude-account",
    displayName: "Primary Claude",
    email: "primary@example.com",
    apiKey: "sk-test-secret-should-not-leak",
    isActive: true,
    priority: 0,
  });

  const sessionId = "test-session-enrich-1";
  sessionManager.touchSession(sessionId, conn.id);

  const response = await sessionsRoute.GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 1);
  assert.equal(Array.isArray(body.sessions), true);
  assert.equal(body.sessions.length, 1);

  const enriched = body.sessions[0];
  assert.equal(enriched.connectionId, conn.id);
  assert.equal(enriched.provider, "claude");
  assert.ok(
    typeof enriched.accountName === "string" && enriched.accountName.length > 0,
    "accountName should resolve to a non-empty string when connection metadata is present"
  );

  const serialized = JSON.stringify(body);
  assert.equal(
    serialized.includes("sk-test-secret-should-not-leak"),
    false,
    "API response must NOT include decrypted API key material"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(enriched, "apiKey"),
    false,
    "enriched session must not expose apiKey field"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(enriched, "accessToken"),
    false,
    "enriched session must not expose accessToken field"
  );
});

test("GET /api/sessions falls back to null accountName when connection lookup fails", async () => {
  const sessionId = "test-session-orphan-1";
  sessionManager.touchSession(sessionId, "nonexistent-connection-id");

  const response = await sessionsRoute.GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].connectionId, "nonexistent-connection-id");
  assert.equal(body.sessions[0].accountName, null);
  assert.equal(body.sessions[0].provider, null);
});

test("GET /api/sessions returns empty enrichment when DB lookup throws", async () => {
  const sessionId = "test-session-db-fail-1";
  sessionManager.touchSession(sessionId, "any-connection-id");

  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (typeof sql === "string" && sql.includes("FROM provider_connections")) {
      throw new Error("simulated DB failure");
    }
    return originalPrepare(sql);
  };

  try {
    const response = await sessionsRoute.GET();
    const body = await response.json();

    assert.equal(response.status, 200, "DB failure should not crash the route");
    assert.equal(body.count, 1);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].accountName, null);
    assert.equal(body.sessions[0].provider, null);
  } finally {
    db.prepare = originalPrepare;
  }
});

test("GET /api/sessions skips DB query when there are no active sessions", async () => {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  let providerConnectionsQueried = false;
  db.prepare = (sql) => {
    if (typeof sql === "string" && sql.includes("FROM provider_connections")) {
      providerConnectionsQueried = true;
    }
    return originalPrepare(sql);
  };

  try {
    const response = await sessionsRoute.GET();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.count, 0);
    assert.equal(body.sessions.length, 0);
    assert.equal(
      providerConnectionsQueried,
      false,
      "no active sessions should mean no provider_connections query"
    );
  } finally {
    db.prepare = originalPrepare;
  }
});

test("GET /api/sessions queries metadata only for distinct active session connectionIds", async () => {
  const conn1 = await providersDb.createProviderConnection({
    provider: "claude",
    name: "active-account",
    displayName: "Active Account",
    email: "active@example.com",
    apiKey: "sk-active-secret",
    isActive: true,
    priority: 0,
  });
  await providersDb.createProviderConnection({
    provider: "openai",
    name: "unused-account",
    displayName: "Unused Account",
    email: "unused@example.com",
    apiKey: "sk-unused-secret",
    isActive: true,
    priority: 1,
  });

  sessionManager.touchSession("session-active-a", conn1.id);
  sessionManager.touchSession("session-active-b", conn1.id);

  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  const capturedSql = [];
  db.prepare = (sql) => {
    if (typeof sql === "string" && sql.includes("FROM provider_connections")) {
      capturedSql.push(sql);
    }
    return originalPrepare(sql);
  };

  try {
    const response = await sessionsRoute.GET();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.count, 2);

    const enrichmentSqls = capturedSql.filter((sql) => sql.includes("WHERE id IN"));
    assert.equal(
      enrichmentSqls.length,
      1,
      "exactly one scoped enrichment query should run for the active session connectionIds"
    );
    const placeholderCount = (enrichmentSqls[0].match(/\?/g) || []).length;
    assert.equal(
      placeholderCount,
      1,
      "two sessions sharing one connectionId should collapse to a single bound parameter"
    );

    const serialized = JSON.stringify(body);
    assert.equal(
      serialized.includes("sk-unused-secret"),
      false,
      "unused account secret must never appear in the response"
    );
    assert.equal(
      serialized.includes("unused@example.com"),
      false,
      "unused account metadata must not be fetched / leaked"
    );
  } finally {
    db.prepare = originalPrepare;
  }
});
