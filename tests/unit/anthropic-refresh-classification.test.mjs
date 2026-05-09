import test from "node:test";
import assert from "node:assert/strict";

Object.assign(process.env, {
  CLAUDE_OAUTH_CLIENT_ID: "test-claude-client-id",
  CODEX_OAUTH_CLIENT_ID: "app_test_codex",
  GEMINI_OAUTH_CLIENT_ID: "test-gemini-client",
  GEMINI_OAUTH_CLIENT_SECRET: "test-gemini-secret",
  GEMINI_CLI_OAUTH_CLIENT_ID: "test-gemini-cli-client",
  GEMINI_CLI_OAUTH_CLIENT_SECRET: "test-gemini-cli-secret",
  QWEN_OAUTH_CLIENT_ID: "test-qwen-client",
  KIMI_CODING_OAUTH_CLIENT_ID: "test-kimi-client",
  ANTIGRAVITY_OAUTH_CLIENT_ID: "test-antigravity-client",
  ANTIGRAVITY_OAUTH_CLIENT_SECRET: "test-antigravity-secret",
  GITHUB_OAUTH_CLIENT_ID: "test-github-client",
});

const { refreshClaudeOAuthTokenClassified } =
  await import("../../open-sse/services/tokenRefresh.ts");

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler) {
  globalThis.fetch = async (...args) => handler(...args);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status, body) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

test("200 valid body → ok with all fields", async () => {
  mockFetch(() =>
    jsonResponse(200, {
      access_token: "AT-NEW",
      refresh_token: "RT-NEW",
      expires_in: 3600,
    })
  );
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.accessToken, "AT-NEW");
    assert.equal(result.refreshToken, "RT-NEW");
    assert.equal(result.expiresIn, 3600);
  }
});

test("200 with body missing access_token → permanent soft_failure_200", async () => {
  mockFetch(() => jsonResponse(200, { something: "else" }));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "soft_failure_200");
  }
});

test("200 with body containing error → permanent soft_failure_200", async () => {
  mockFetch(() => jsonResponse(200, { error: "invalid_grant", error_description: "expired" }));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "soft_failure_200");
  }
});

test("400 with invalid_grant → permanent invalid_grant", async () => {
  mockFetch(() => jsonResponse(400, { error: "invalid_grant" }));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "invalid_grant");
  }
});

test("400 with unauthorized_client → permanent unauthorized_client", async () => {
  mockFetch(() => jsonResponse(400, { error: "unauthorized_client" }));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "unauthorized_client");
  }
});

test("400 with revoked_token → permanent revoked", async () => {
  mockFetch(() => jsonResponse(400, { error: "revoked_token" }));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "revoked");
  }
});

test("400 with unrecognized error → permanent bad_request", async () => {
  mockFetch(() => jsonResponse(400, { error: "something_weird" }));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "bad_request");
  }
});

test("401 plain → permanent unauthorized", async () => {
  mockFetch(() => textResponse(401, "Unauthorized"));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "unauthorized");
  }
});

test("401 with invalid_grant body → permanent invalid_grant (overrides plain unauthorized)", async () => {
  mockFetch(() => jsonResponse(401, { error: "invalid_grant" }));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "invalid_grant");
  }
});

test("403 → permanent forbidden", async () => {
  mockFetch(() => textResponse(403, "Forbidden"));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "forbidden");
  }
});

test("408 → transient timeout", async () => {
  mockFetch(() => textResponse(408, "Request Timeout"));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "transient");
  if (result.status === "transient") {
    assert.equal(result.reason, "timeout");
  }
});

test("429 → transient rate_limited", async () => {
  mockFetch(() => textResponse(429, "Too Many Requests"));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "transient");
  if (result.status === "transient") {
    assert.equal(result.reason, "rate_limited");
  }
});

test("500 → transient upstream_5xx", async () => {
  mockFetch(() => textResponse(500, "Internal Server Error"));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "transient");
  if (result.status === "transient") {
    assert.equal(result.reason, "upstream_5xx");
  }
});

test("503 → transient upstream_5xx", async () => {
  mockFetch(() => textResponse(503, "Service Unavailable"));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "transient");
});

test("Network throw → transient network", async () => {
  mockFetch(() => {
    throw new Error("fetch failed");
  });
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "transient");
  if (result.status === "transient") {
    assert.equal(result.reason, "network");
  }
});

test("418 (uncommon) → permanent unknown_permanent", async () => {
  mockFetch(() => textResponse(418, "I'm a teapot"));
  const result = await refreshClaudeOAuthTokenClassified("RT-OLD", null);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "unknown_permanent");
  }
});

test("Legacy refreshClaudeOAuthToken returns null on transient (back-compat)", async () => {
  const { refreshClaudeOAuthToken } = await import("../../open-sse/services/tokenRefresh.ts");
  mockFetch(() => textResponse(429, "Too Many Requests"));
  const result = await refreshClaudeOAuthToken("RT-OLD", null);
  assert.equal(result, null);
});

test("Legacy refreshClaudeOAuthToken returns null on permanent (back-compat)", async () => {
  const { refreshClaudeOAuthToken } = await import("../../open-sse/services/tokenRefresh.ts");
  mockFetch(() => jsonResponse(400, { error: "invalid_grant" }));
  const result = await refreshClaudeOAuthToken("RT-OLD", null);
  assert.equal(result, null);
});

test("Legacy refreshClaudeOAuthToken returns object on ok (back-compat)", async () => {
  const { refreshClaudeOAuthToken } = await import("../../open-sse/services/tokenRefresh.ts");
  mockFetch(() =>
    jsonResponse(200, { access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 })
  );
  const result = await refreshClaudeOAuthToken("RT-OLD", null);
  assert.deepEqual(result, {
    accessToken: "AT-NEW",
    refreshToken: "RT-NEW",
    expiresIn: 3600,
  });
});
