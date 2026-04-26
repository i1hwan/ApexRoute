import test from "node:test";
import assert from "node:assert/strict";

const { claudeToOpenAIResponse } =
  await import("../../open-sse/translator/response/claude-to-openai.ts");

function createState() {
  return {
    toolCalls: new Map(),
    toolNameMap: new Map(),
  };
}

function feedToolUseStart(state, blockIndex, id, name) {
  return claudeToOpenAIResponse(
    {
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "tool_use", id, name },
    },
    state
  );
}

function feedDelta(state, blockIndex, partial_json) {
  return claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: blockIndex,
      delta: { type: "input_json_delta", partial_json },
    },
    state
  );
}

function feedStop(state, blockIndex) {
  return claudeToOpenAIResponse({ type: "content_block_stop", index: blockIndex }, state);
}

function feedMessageStop(state) {
  return claudeToOpenAIResponse({ type: "message_stop" }, state);
}

function flatten(...chunkLists) {
  return chunkLists.filter(Boolean).flat();
}

function concatToolArgs(chunks, openAiIndex) {
  let acc = "";
  for (const c of chunks) {
    const tcs = c?.choices?.[0]?.delta?.tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      // Skip the content_block_start chunk: it shares a reference to
      // state.toolCalls.get(...).function.arguments which mutates as deltas
      // arrive. Detect it by the presence of `id` (only set on start) or
      // function.name (delta chunks omit name).
      if (tc.id || tc.function?.name) continue;
      if (tc.index === openAiIndex && typeof tc.function?.arguments === "string") {
        acc += tc.function.arguments;
      }
    }
  }
  return acc;
}

// ──────────────────────────────────────────────────────────────────────
// 7.8.1 Korean tool_use end-to-end
// ──────────────────────────────────────────────────────────────────────

test("§7.8.1 Korean tool_use → raw UTF-8 in OpenAI tool_calls.arguments", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } },
    state
  );
  const start = feedToolUseStart(state, 0, "toolu_x", "ask");
  const d1 = feedDelta(state, 0, '{"header":"\\u');
  const d2 = feedDelta(state, 0, 'ad6c\\ud604"}');
  const stop = feedStop(state, 0);

  const all = flatten(start, d1, d2, stop);
  const argsConcat = concatToolArgs(all, 0);

  assert.equal(argsConcat, '{"header":"구현"}', "concatenated emitted args");
  assert.equal(
    state.toolCalls.get(0).function.arguments,
    '{"header":"구현"}',
    "accumulated args on state"
  );
  assert.equal(JSON.parse(argsConcat).header, "구현");
});

// ──────────────────────────────────────────────────────────────────────
// 7.8.2 Mid-escape stop boundary
// ──────────────────────────────────────────────────────────────────────

test("§7.8.2 mid-escape stop boundary preserves verbatim partial \\u (truncated/invalid by design)", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } },
    state
  );
  feedToolUseStart(state, 0, "toolu_x", "ask");
  const d1 = feedDelta(state, 0, '{"header":"\\u');
  const stop = feedStop(state, 0);

  const all = flatten(d1, stop);
  const argsConcat = concatToolArgs(all, 0);

  assert.equal(argsConcat, '{"header":"\\u');
  assert.equal(state.toolCalls.get(0).function.arguments, '{"header":"\\u');
});

// ──────────────────────────────────────────────────────────────────────
// 7.8.3 No state leak: emitted chunks must not contain internal normalizer keys
// ──────────────────────────────────────────────────────────────────────

test("§7.8.3 no internal-state leak in emitted chunks", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } },
    state
  );
  const start = feedToolUseStart(state, 0, "toolu_x", "ask");
  const d1 = feedDelta(state, 0, '{"header":"\\uad6c"}');
  const stop = feedStop(state, 0);

  const all = flatten(start, d1, stop);

  for (const chunk of all) {
    const ser = JSON.stringify(chunk);
    for (const forbidden of [
      "unicodeNormalizer",
      "toolArgNormalizer",
      "normalizer",
      "pending",
      "inString",
    ]) {
      assert.ok(!ser.includes(forbidden), `chunk leaks internal key "${forbidden}": ${ser}`);
    }
    const tcs = chunk?.choices?.[0]?.delta?.tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      const fnKeys = tc.function ? Object.keys(tc.function) : [];
      for (const k of fnKeys) {
        assert.ok(
          k === "name" || k === "arguments",
          `tool_calls[*].function has unexpected key "${k}"`
        );
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────
// 7.8.4 Text and thinking deltas pass through unchanged
// ──────────────────────────────────────────────────────────────────────

test("§7.8.4 text and thinking deltas unchanged by normalizer", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } },
    state
  );

  // Text block at index 0
  claudeToOpenAIResponse(
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    state
  );
  const textDelta = claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "한국어 평문 응답 with \\uXXXX literal" },
    },
    state
  );
  // Thinking block at index 1
  claudeToOpenAIResponse(
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking" },
    },
    state
  );
  const thinkingDelta = claudeToOpenAIResponse(
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "thinking_delta", thinking: "사고 과정 \\uad6c" },
    },
    state
  );

  assert.equal(textDelta[0].choices[0].delta.content, "한국어 평문 응답 with \\uXXXX literal");
  assert.equal(thinkingDelta[0].choices[0].delta.reasoning_content, "사고 과정 \\uad6c");
});

// ──────────────────────────────────────────────────────────────────────
// 7.8.5 finish_reason = "tool_calls" preserved after normalizer cleanup
// ──────────────────────────────────────────────────────────────────────

test("§7.8.5 finish_reason='tool_calls' survives normalizer removal at content_block_stop", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } },
    state
  );
  feedToolUseStart(state, 0, "toolu_x", "ask");
  feedDelta(state, 0, '{"header":"\\uad6c"}');
  feedStop(state, 0);

  const finalChunks = feedMessageStop(state);
  assert.equal(finalChunks[0].choices[0].finish_reason, "tool_calls");

  // toolCalls map must NOT have been emptied by content_block_stop.
  assert.equal(state.toolCalls.size, 1);
  assert.equal(state.toolCalls.get(0).function.arguments, '{"header":"구"}');
});

// ──────────────────────────────────────────────────────────────────────
// 7.8.6 Multiple tool_use blocks — per-index isolation
// ──────────────────────────────────────────────────────────────────────

test("§7.8.6 two parallel tool_use blocks isolate normalizer state", () => {
  const state = createState();
  claudeToOpenAIResponse(
    { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } },
    state
  );
  // The first content_block_start gets OpenAI tool_call index 0 (state.toolCallIndex++),
  // the second gets index 1. Anthropic chunk.index (1, 2) is independent.
  feedToolUseStart(state, 1, "toolu_a", "first");
  feedToolUseStart(state, 2, "toolu_b", "second");

  const a1 = feedDelta(state, 1, '{"x":"\\u');
  const b1 = feedDelta(state, 2, '{"y":"\\uD83D');
  const a2 = feedDelta(state, 1, 'ad6c"}');
  const b2 = feedDelta(state, 2, '\\uDE00"}');
  const stopA = feedStop(state, 1);
  const stopB = feedStop(state, 2);

  const allA = flatten(a1, a2, stopA);
  const allB = flatten(b1, b2, stopB);

  // Block-1 emitted under OpenAI tool_call index 0; block-2 under index 1.
  const argsA = concatToolArgs(allA, 0);
  const argsB = concatToolArgs(allB, 1);

  assert.equal(argsA, '{"x":"구"}');
  assert.equal(argsB, '{"y":"\uD83D\uDE00"}');

  // State accumulators (keyed by Anthropic chunk.index) agree.
  assert.equal(state.toolCalls.get(1).function.arguments, '{"x":"구"}');
  assert.equal(state.toolCalls.get(2).function.arguments, '{"y":"\uD83D\uDE00"}');
});
