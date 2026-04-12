import test from "node:test";
import assert from "node:assert/strict";

const { claudeToOpenAIResponse } =
  await import("../../open-sse/translator/response/claude-to-openai.ts");
const { translateNonStreamingResponse } =
  await import("../../open-sse/handlers/responseTranslator.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

function createState() {
  return {
    toolCalls: new Map(),
    toolNameMap: new Map([["proxy_read_file", "read_file"]]),
  };
}

test("Claude non-stream: text, thinking and tool_use become OpenAI assistant message", () => {
  const result = translateNonStreamingResponse(
    {
      id: "msg_123",
      model: "claude-3-7-sonnet",
      content: [
        { type: "thinking", thinking: "Plan first." },
        { type: "text", text: "Final answer" },
        {
          type: "tool_use",
          id: "tool_1",
          name: "proxy_read_file",
          input: { path: "/tmp/a" },
        },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
      },
    },
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    new Map([["proxy_read_file", "read_file"]])
  );

  assert.equal(result.id, "chatcmpl-msg_123");
  assert.equal(result.model, "claude-3-7-sonnet");
  assert.equal(result.choices[0].message.content, "Final answer");
  assert.equal(result.choices[0].message.reasoning_content, "Plan first.");
  assert.equal(result.choices[0].message.tool_calls[0].id, "tool_1");
  assert.equal(result.choices[0].message.tool_calls[0].function.name, "read_file");
  assert.equal(
    result.choices[0].message.tool_calls[0].function.arguments,
    JSON.stringify({ path: "/tmp/a" })
  );
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(result.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
  });
});

test("Claude non-stream: end_turn becomes stop and empty text is preserved", () => {
  const result = translateNonStreamingResponse(
    {
      id: "msg_empty",
      model: "claude-3-5-haiku",
      content: [{ type: "text", text: "" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    },
    FORMATS.CLAUDE,
    FORMATS.OPENAI
  );

  assert.equal(result.choices[0].message.content, "");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.model, "claude-3-5-haiku");
});

test("Claude stream: message_start emits initial assistant role chunk", () => {
  const result = claudeToOpenAIResponse(
    {
      type: "message_start",
      message: { id: "msg1", model: "claude-3-7-sonnet" },
    },
    createState()
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "chatcmpl-msg1");
  assert.equal(result[0].choices[0].delta.role, "assistant");
});

test("Claude stream: text deltas stream as content", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-3-7-sonnet" } },
    state
  );
  claudeToOpenAIResponse(
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    state
  );

  const result = claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    state
  );

  assert.equal(result[0].choices[0].delta.content, "Hello");
});

test("Claude stream: thinking blocks emit reasoning_content chunks", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-3-7-sonnet" } },
    state
  );

  const started = claudeToOpenAIResponse(
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking" },
    },
    state
  );
  const delta = claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "I should inspect the file." },
    },
    state
  );

  assert.equal(started[0].choices[0].delta.reasoning_content, "");
  assert.equal(delta[0].choices[0].delta.reasoning_content, "I should inspect the file.");
});

test("Claude stream: tool_use start reverses prefixed tool names and streams argument deltas", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-3-7-sonnet" } },
    state
  );

  const started = claudeToOpenAIResponse(
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "tool1", name: "proxy_read_file" },
    },
    state
  );
  const delta1 = claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    },
    state
  );
  const delta2 = claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '"/tmp/a"}' },
    },
    state
  );

  assert.equal(started[0].choices[0].delta.tool_calls[0].id, "tool1");
  assert.equal(started[0].choices[0].delta.tool_calls[0].function.name, "read_file");
  assert.equal(delta1[0].choices[0].delta.tool_calls[0].function.arguments, '{"path":');
  assert.equal(delta2[0].choices[0].delta.tool_calls[0].function.arguments, '"/tmp/a"}');
});

test("Claude stream: message_delta maps stop reason and usage including cache tokens", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-3-7-sonnet" } },
    state
  );

  const result = claudeToOpenAIResponse(
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    },
    state
  );

  assert.equal(result[0].choices[0].finish_reason, "tool_calls");
  assert.equal(result[0].usage.prompt_tokens, 13);
  assert.equal(result[0].usage.completion_tokens, 4);
  assert.equal(result[0].usage.total_tokens, 17);
  assert.equal(result[0].usage.prompt_tokens_details.cached_tokens, 2);
  assert.equal(result[0].usage.prompt_tokens_details.cache_creation_tokens, 1);
});

test("Claude stream: message_stop falls back to tool_calls when tool use already happened", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-3-7-sonnet" } },
    state
  );
  claudeToOpenAIResponse(
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "tool1", name: "proxy_read_file" },
    },
    state
  );

  const result = claudeToOpenAIResponse({ type: "message_stop" }, state);

  assert.equal(result[0].choices[0].finish_reason, "tool_calls");
});

test("Claude stream: unsupported events return null", () => {
  assert.equal(claudeToOpenAIResponse({ type: "error" }, createState()), null);
});

test("Claude stream: message_start captures cache tokens from initial usage", () => {
  const state = createState();
  claudeToOpenAIResponse(
    {
      type: "message_start",
      message: {
        id: "msg_cache",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 26,
          output_tokens: 0,
          cache_read_input_tokens: 91945,
          cache_creation_input_tokens: 152,
        },
      },
    },
    state
  );

  assert.equal(state.usage.input_tokens, 26);
  assert.equal(state.usage.cache_read_input_tokens, 91945);
  assert.equal(state.usage.cache_creation_input_tokens, 152);
});

test("Claude stream: message_delta merges output_tokens with existing cache tokens from message_start", () => {
  const state = createState();
  claudeToOpenAIResponse(
    {
      type: "message_start",
      message: {
        id: "msg_merge",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 26,
          output_tokens: 0,
          cache_read_input_tokens: 91945,
          cache_creation_input_tokens: 152,
        },
      },
    },
    state
  );

  const result = claudeToOpenAIResponse(
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 603 },
    },
    state
  );

  assert.equal(result[0].usage.prompt_tokens, 26 + 91945 + 152);
  assert.equal(result[0].usage.completion_tokens, 603);
  assert.equal(result[0].usage.total_tokens, 26 + 91945 + 152 + 603);
  assert.equal(result[0].usage.prompt_tokens_details.cached_tokens, 91945);
  assert.equal(result[0].usage.prompt_tokens_details.cache_creation_tokens, 152);
});

test("Claude stream: message_stop fallback includes cache tokens in prompt_tokens_details", () => {
  const state = createState();
  claudeToOpenAIResponse(
    {
      type: "message_start",
      message: {
        id: "msg_stop",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 50,
          output_tokens: 0,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
        },
      },
    },
    state
  );

  claudeToOpenAIResponse(
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    },
    state
  );
  claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    state
  );
  claudeToOpenAIResponse({ type: "content_block_stop", index: 0 }, state);

  // message_delta carries output_tokens but no stop_reason
  claudeToOpenAIResponse(
    {
      type: "message_delta",
      delta: {},
      usage: { output_tokens: 100 },
    },
    state
  );

  // message_stop emits the final chunk (fallback path since no stop_reason in delta)
  const result = claudeToOpenAIResponse({ type: "message_stop" }, state);

  assert.ok(result, "message_stop should emit a chunk");
  assert.equal(result[0].usage.prompt_tokens, 50 + 1000 + 200);
  assert.equal(result[0].usage.completion_tokens, 100);
  assert.equal(result[0].usage.total_tokens, 50 + 1000 + 200 + 100);
  assert.equal(result[0].usage.prompt_tokens_details.cached_tokens, 1000);
  assert.equal(result[0].usage.prompt_tokens_details.cache_creation_tokens, 200);
});

test("Claude non-stream: cache tokens appear in prompt_tokens_details", () => {
  const result = translateNonStreamingResponse(
    {
      id: "msg_cached",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "Answer" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 26,
        output_tokens: 603,
        cache_read_input_tokens: 91945,
        cache_creation_input_tokens: 152,
      },
    },
    FORMATS.CLAUDE,
    FORMATS.OPENAI
  );

  assert.equal(result.usage.prompt_tokens, 26 + 91945 + 152);
  assert.equal(result.usage.completion_tokens, 603);
  assert.equal(result.usage.total_tokens, 26 + 91945 + 152 + 603);
  assert.deepEqual(result.usage.prompt_tokens_details, {
    cached_tokens: 91945,
    cache_creation_tokens: 152,
  });
});

test("filterUsageForFormat promotes flat Claude cache tokens to OpenAI nested details", async () => {
  const { filterUsageForFormat } = await import("../../open-sse/utils/usageTracking.ts");
  const { FORMATS: FMT } = await import("../../open-sse/translator/formats.ts");

  const claudeUsage = {
    prompt_tokens: 92123,
    completion_tokens: 603,
    total_tokens: 92726,
    cache_read_input_tokens: 91945,
    cache_creation_input_tokens: 152,
  };

  const filtered = filterUsageForFormat(claudeUsage, FMT.OPENAI);

  assert.equal(filtered.prompt_tokens, 92123);
  assert.equal(filtered.completion_tokens, 603);
  assert.equal(filtered.total_tokens, 92726);
  assert.equal(filtered.prompt_tokens_details.cached_tokens, 91945);
  assert.equal(filtered.prompt_tokens_details.cache_creation_tokens, 152);
  assert.equal(filtered.cache_read_input_tokens, undefined);
  assert.equal(filtered.cache_creation_input_tokens, undefined);
});

test("filterUsageForFormat promotes flat reasoning_tokens to completion_tokens_details", async () => {
  const { filterUsageForFormat } = await import("../../open-sse/utils/usageTracking.ts");
  const { FORMATS: FMT } = await import("../../open-sse/translator/formats.ts");

  const usage = {
    prompt_tokens: 100,
    completion_tokens: 500,
    total_tokens: 600,
    reasoning_tokens: 200,
  };

  const filtered = filterUsageForFormat(usage, FMT.OPENAI);

  assert.equal(filtered.completion_tokens_details.reasoning_tokens, 200);
});
