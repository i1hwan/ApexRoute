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

const { refreshClaudeOAuthTokenWithRetry } =
  await import("../../open-sse/services/tokenRefresh.ts");

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeQueueFetch(responses) {
  let index = 0;
  return async () => {
    if (index >= responses.length) {
      throw new Error(`No more responses queued (consumed ${index})`);
    }
    const r = responses[index++];
    if (typeof r === "function") return r();
    return r;
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status, body) {
  return new Response(body, { status });
}

test("ok on first attempt → no retry, returns ok", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600 });
  };
  const result = await refreshClaudeOAuthTokenWithRetry("RT-OLD", null, null, 3);
  assert.equal(result.status, "ok");
  assert.equal(calls, 1);
});

test("permanent on first attempt → no retry, returns permanent", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse(400, { error: "invalid_grant" });
  };
  const result = await refreshClaudeOAuthTokenWithRetry("RT-OLD", null, null, 3);
  assert.equal(result.status, "permanent");
  if (result.status === "permanent") {
    assert.equal(result.reason, "invalid_grant");
  }
  assert.equal(calls, 1, "no retry on permanent");
});

test("transient → transient → ok → final ok (3 calls)", async () => {
  let calls = 0;
  globalThis.fetch = makeQueueFetch([
    () => {
      calls++;
      return textResponse(429, "rate limited");
    },
    () => {
      calls++;
      return textResponse(503, "upstream");
    },
    () => {
      calls++;
      return jsonResponse(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    },
  ]);
  const result = await refreshClaudeOAuthTokenWithRetry("RT-OLD", null, null, 3);
  assert.equal(result.status, "ok");
  assert.equal(calls, 3);
});

test("transient × 3 → final transient (exhausted)", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return textResponse(429, "rate limited");
  };
  const result = await refreshClaudeOAuthTokenWithRetry("RT-OLD", null, null, 3);
  assert.equal(result.status, "transient");
  if (result.status === "transient") {
    assert.equal(result.reason, "rate_limited");
  }
  assert.equal(calls, 3);
});

test("transient → permanent → no further retry, returns permanent", async () => {
  let calls = 0;
  globalThis.fetch = makeQueueFetch([
    () => {
      calls++;
      return textResponse(429, "rate limited");
    },
    () => {
      calls++;
      return jsonResponse(400, { error: "invalid_grant" });
    },
  ]);
  const result = await refreshClaudeOAuthTokenWithRetry("RT-OLD", null, null, 3);
  assert.equal(result.status, "permanent");
  assert.equal(calls, 2, "stops on permanent (no third attempt)");
});

test("Network throw on every attempt → final transient network (exhausted)", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("fetch failed");
  };
  const result = await refreshClaudeOAuthTokenWithRetry("RT-OLD", null, null, 3);
  assert.equal(result.status, "transient");
  if (result.status === "transient") {
    assert.equal(result.reason, "network");
  }
  assert.equal(calls, 3);
});
