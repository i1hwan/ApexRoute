import test from "node:test";
import assert from "node:assert/strict";

import {
  CodexExecutor,
  getCodexModelScope,
  getCodexRateLimitKey,
  getCodexResetTime,
  parseCodexQuotaHeaders,
  setDefaultFastServiceTierEnabled,
} from "../../open-sse/executors/codex.ts";

const CODEX_ENV_KEYS = ["CODEX_CLIENT_VERSION", "CODEX_USER_AGENT", "CODEX_USER_AGENT_OVERRIDE"];

async function withCodexEnv(updates, fn) {
  const original = Object.fromEntries(CODEX_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of CODEX_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== null && value !== undefined) process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of CODEX_ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
}

test("Codex helper functions isolate rate-limit scopes and parse quota headers", () => {
  const quota = parseCodexQuotaHeaders(
    new Headers({
      "x-codex-5h-usage": "100",
      "x-codex-5h-limit": "500",
      "x-codex-5h-reset-at": new Date(Date.now() + 60_000).toISOString(),
      "x-codex-7d-usage": "1000",
      "x-codex-7d-limit": "5000",
      "x-codex-7d-reset-at": new Date(Date.now() + 120_000).toISOString(),
    })
  );

  assert.equal(getCodexModelScope("codex-spark-mini"), "spark");
  assert.equal(getCodexModelScope("gpt-5.3-codex-spark"), "spark");
  assert.equal(getCodexModelScope("gpt-5.3-codex"), "codex");
  assert.equal(getCodexRateLimitKey("acct-1", "codex-spark-mini"), "acct-1:spark");
  assert.equal(quota.usage5h, 100);
  assert.equal(quota.limit7d, 5000);
  assert.ok(getCodexResetTime(quota) >= new Date(quota.resetAt7d).getTime());
});

test("CodexExecutor.buildUrl honors /responses subpaths and compact mode", () => {
  const executor = new CodexExecutor();

  assert.equal(
    executor.buildUrl("gpt-5.3-codex", true, 0, {}),
    "https://chatgpt.com/backend-api/codex/responses"
  );
  assert.equal(
    executor.buildUrl("gpt-5.3-codex", true, 0, { requestEndpointPath: "/responses" }),
    "https://chatgpt.com/backend-api/codex/responses"
  );
  assert.equal(
    executor.buildUrl("gpt-5.3-codex", true, 0, { requestEndpointPath: "/responses/compact" }),
    "https://chatgpt.com/backend-api/codex/responses/compact"
  );
});

test("CodexExecutor.buildHeaders binds workspace ids and disables SSE accept for compact responses", async () => {
  await withCodexEnv({}, async () => {
    const executor = new CodexExecutor();
    const standardHeaders = executor.buildHeaders(
      {
        accessToken: "codex-token",
        providerSpecificData: { workspaceId: "workspace-1" },
      },
      true
    );
    const compactHeaders = executor.buildHeaders(
      {
        accessToken: "codex-token",
        requestEndpointPath: "/responses/compact",
      },
      true
    );

    assert.equal(standardHeaders.Authorization, "Bearer codex-token");
    assert.equal(standardHeaders.Accept, "text/event-stream");
    assert.equal(standardHeaders.Version, "0.130.0");
    assert.equal(standardHeaders["X-Codex-Beta-Features"], "responses_websockets");
    assert.equal(standardHeaders["User-Agent"], "codex-cli/0.130.0 (Windows 10.0.26200; x64)");
    assert.equal(standardHeaders["chatgpt-account-id"], "workspace-1");
    assert.equal(compactHeaders.Accept, undefined);
  });
});

test("CodexExecutor.buildHeaders supports explicit Codex client identity override", async () => {
  await withCodexEnv(
    {
      CODEX_CLIENT_VERSION: "0.131.0",
      CODEX_USER_AGENT_OVERRIDE: "custom-codex-client/1.0",
    },
    async () => {
      const executor = new CodexExecutor();
      const headers = executor.buildHeaders({ accessToken: "codex-token" }, true);

      assert.equal(headers.Version, "0.131.0");
      assert.equal(headers["User-Agent"], "custom-codex-client/1.0");
    }
  );
});

test("CodexExecutor.buildHeaders normalizes stale legacy Codex user agents", async () => {
  await withCodexEnv(
    {
      CODEX_CLIENT_VERSION: "0.130.0",
      CODEX_USER_AGENT: "codex-cli/0.92.0 (Windows 10.0.26100; x64)",
    },
    async () => {
      const executor = new CodexExecutor();
      const headers = executor.buildHeaders({ accessToken: "codex-token" }, true);

      assert.equal(headers.Version, "0.130.0");
      assert.equal(headers["User-Agent"], "codex-cli/0.130.0 (Windows 10.0.26100; x64)");
    }
  );
});

test("CodexExecutor.execute keeps Codex client identity final after upstream header merges", async () => {
  await withCodexEnv(
    {
      CODEX_CLIENT_VERSION: "0.130.0",
      CODEX_USER_AGENT: "codex-cli/0.92.0 (Windows 10.0.26100; x64)",
    },
    async () => {
      const executor = new CodexExecutor();
      const originalFetch = globalThis.fetch;
      let capturedHeaders;

      globalThis.fetch = async (_url, options) => {
        capturedHeaders = options.headers;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      };

      try {
        await executor.execute({
          model: "gpt-5.5",
          body: { messages: [{ role: "user", content: "hello" }] },
          stream: true,
          credentials: {
            accessToken: "codex-token",
            providerSpecificData: { customUserAgent: "codex-cli/0.92.0 (Windows 10.0.26100; x64)" },
          },
          upstreamExtraHeaders: {
            Version: "0.92.0",
            version: "0.92.0",
            "Openai-Beta": "stale",
            "openai-beta": "stale-lower",
            "X-Codex-Beta-Features": "stale",
            "x-codex-beta-features": "stale-lower",
            "user-agent": "codex-cli/0.92.0 (Windows 10.0.26100; x64)",
          },
        });

        assert.equal(capturedHeaders.Version, "0.130.0");
        assert.equal(capturedHeaders["Openai-Beta"], "responses=experimental");
        assert.equal(capturedHeaders["X-Codex-Beta-Features"], "responses_websockets");
        assert.equal(capturedHeaders["User-Agent"], "codex-cli/0.130.0 (Windows 10.0.26100; x64)");
        assert.equal(capturedHeaders.version, undefined);
        assert.equal(capturedHeaders["openai-beta"], undefined);
        assert.equal(capturedHeaders["x-codex-beta-features"], undefined);
        assert.equal(capturedHeaders["user-agent"], undefined);

        const normalizedHeaders = new Headers(capturedHeaders);
        assert.equal(normalizedHeaders.get("version"), "0.130.0");
        assert.equal(normalizedHeaders.get("openai-beta"), "responses=experimental");
        assert.equal(normalizedHeaders.get("x-codex-beta-features"), "responses_websockets");
        assert.equal(
          normalizedHeaders.get("user-agent"),
          "codex-cli/0.130.0 (Windows 10.0.26100; x64)"
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  );
});

test("CodexExecutor.buildHeaders preserves current legacy Codex user agent platform", async () => {
  await withCodexEnv(
    {
      CODEX_CLIENT_VERSION: "0.131.0",
      CODEX_USER_AGENT: "codex-cli/0.131.0 (MacOS; arm64)",
    },
    async () => {
      const executor = new CodexExecutor();
      const headers = executor.buildHeaders({ accessToken: "codex-token" }, true);

      assert.equal(headers.Version, "0.131.0");
      assert.equal(headers["User-Agent"], "codex-cli/0.131.0 (MacOS; arm64)");
    }
  );
});

test("CodexExecutor.transformRequest injects default instructions, clamps reasoning and strips unsupported fields", () => {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "hello" }],
    prompt: "legacy",
    stream_options: { include_usage: true },
    instructions: "",
    reasoning_effort: "xhigh",
    service_tier: "fast",
    temperature: 0.4,
    user: "cursor",
  };

  const result = executor.transformRequest("gpt-5-mini-xhigh", body, false, {
    requestEndpointPath: "/responses",
  });

  assert.equal(result.stream, true);
  assert.equal(result.store, false);
  assert.equal(result.instructions.length > 0, true);
  assert.equal(result.reasoning.effort, "high");
  assert.equal(result.service_tier, "priority");
  assert.equal(result.messages, undefined);
  assert.equal(result.prompt, undefined);
  assert.equal(result.temperature, undefined);
  assert.equal(result.user, undefined);
  assert.equal(result.stream_options, undefined);
});

test("CodexExecutor.transformRequest preserves compact requests and native passthrough semantics", () => {
  const executor = new CodexExecutor();
  setDefaultFastServiceTierEnabled(true);

  try {
    const body = {
      _nativeCodexPassthrough: true,
      instructions: "keep this",
      stream: false,
    };
    const result = executor.transformRequest("gpt-5.3-codex", body, false, {
      requestEndpointPath: "/responses/compact",
    });

    assert.equal(result._nativeCodexPassthrough, undefined);
    assert.equal(result.stream, undefined);
    assert.equal(result.service_tier, "priority");
    assert.equal(result.store, false);
    assert.equal(result.instructions, "keep this");
  } finally {
    setDefaultFastServiceTierEnabled(false);
  }
});

test("CodexExecutor.refreshCredentials refreshes OAuth tokens and returns null without a refresh token", async () => {
  const executor = new CodexExecutor();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /auth\.openai\.com\/oauth\/token$/);
    return new Response(
      JSON.stringify({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    assert.equal(await executor.refreshCredentials({}, null), null);
    const refreshed = await executor.refreshCredentials({ refreshToken: "refresh-me" }, null);
    assert.deepEqual(refreshed, {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresIn: 3600,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
