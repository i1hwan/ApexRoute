import test from "node:test";
import assert from "node:assert/strict";

const { claudeToOpenAIResponse } =
  await import("../../open-sse/translator/response/claude-to-openai.ts");

function createState(toolArgumentMode = "buffered-final") {
  return {
    toolCalls: new Map(),
    toolNameMap: new Map(),
    toolArgumentMode,
  };
}

function feed(state, event) {
  return claudeToOpenAIResponse(event, state);
}

function feedToolUseStart(state, blockIndex, id, name) {
  return feed(state, {
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "tool_use", id, name },
  });
}

function feedDelta(state, blockIndex, partial_json) {
  return feed(state, {
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "input_json_delta", partial_json },
  });
}

function feedStop(state, blockIndex) {
  return feed(state, { type: "content_block_stop", index: blockIndex });
}

function feedMessageDelta(state, stop_reason) {
  return feed(state, { type: "message_delta", delta: { stop_reason } });
}

function feedMessageStop(state) {
  return feed(state, { type: "message_stop" });
}

function flatten(...lists) {
  return lists.filter(Boolean).flat();
}

// stream-normalized's first emitted tool_calls chunk holds a live reference to
// state.toolCalls[i].function (arguments mutate as deltas arrive). To simulate
// the OpenAI SSE wire — where each chunk is serialized at emit time and the
// client never sees subsequent mutations — we snapshot chunks at capture time.
function snapshotChunks(...lists) {
  return JSON.parse(JSON.stringify(flatten(...lists)));
}

// Wraps a feed* call so the emitted chunks are JSON-snapshotted at emit time.
// Without this, stream-normalized mode's first emit holds a live reference to
// state.toolCalls[i].function.arguments which subsequent deltas mutate — the
// captured array is unusable for client-style accumulator simulation.
function feedAndSnapshot(fn) {
  const result = fn();
  return result ? JSON.parse(JSON.stringify(result)) : result;
}

function accumulateOpenAIToolCalls(chunks) {
  const calls = new Map();
  let finishReason = null;
  for (const chunk of chunks) {
    const tcs = chunk?.choices?.[0]?.delta?.tool_calls;
    if (tcs) {
      for (const tc of tcs) {
        const idx = tc.index;
        if (!calls.has(idx)) {
          calls.set(idx, {
            id: tc.id ?? null,
            type: tc.type ?? "function",
            function: { name: "", arguments: "" },
          });
        }
        const cur = calls.get(idx);
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name = tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      }
    }
    const fr = chunk?.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr;
  }
  return { calls: Array.from(calls.values()), finishReason };
}

function findChunkIndexWithFullArgs(chunks, expected) {
  for (let i = 0; i < chunks.length; i++) {
    const tcs = chunks[i]?.choices?.[0]?.delta?.tool_calls;
    if (!tcs) continue;
    for (const tc of tcs) {
      if (tc.function?.arguments === expected) return i;
    }
  }
  return -1;
}

function findFinishReasonIndex(chunks, reason) {
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]?.choices?.[0]?.finish_reason === reason) return i;
  }
  return -1;
}

test("§7.2.1 buffered-final emits single chunk at content_block_stop with full args", () => {
  const state = createState("buffered-final");
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });
  const start = feedToolUseStart(state, 0, "toolu_x", "save_doc");
  const d1 = feedDelta(state, 0, '{"title":"\\u');
  const d2 = feedDelta(state, 0, 'ad6c\\ud604"}');
  const stop = feedStop(state, 0);
  const md = feedMessageDelta(state, "tool_use");
  const ms = feedMessageStop(state);

  const chunks = flatten(start, d1, d2, stop, md, ms);

  const midToolCallEmits = flatten(start, d1, d2).filter((c) =>
    c?.choices?.[0]?.delta?.tool_calls?.some(
      (tc) => typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0
    )
  );
  assert.equal(
    midToolCallEmits.length,
    0,
    "buffered-final must NOT emit tool_calls.arguments before content_block_stop"
  );

  const fullEmits = stop.filter((c) =>
    c?.choices?.[0]?.delta?.tool_calls?.some((tc) => tc.function?.arguments)
  );
  assert.equal(fullEmits.length, 1, "exactly one tool_calls chunk emitted at content_block_stop");

  const fullChunk = fullEmits[0];
  const tc = fullChunk.choices[0].delta.tool_calls[0];
  assert.equal(tc.id, "toolu_x");
  assert.equal(tc.type, "function");
  assert.equal(tc.function.name, "save_doc");
  assert.equal(tc.function.arguments, '{"title":"\\uad6c\\ud604"}');

  assert.equal(state.toolCalls.get(0).function.arguments, '{"title":"\\uad6c\\ud604"}');
  assert.deepEqual(JSON.parse(state.toolCalls.get(0).function.arguments), { title: "구현" });
});

test("§7.2.2 stream-normalized mode unchanged when mode flag absent (regression guard)", () => {
  const state = { toolCalls: new Map(), toolNameMap: new Map() };
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });
  const start = feedToolUseStart(state, 0, "toolu_x", "save_doc");
  const d1 = feedDelta(state, 0, '{"title":"\\u');
  const d2 = feedDelta(state, 0, 'ad6c\\ud604"}');
  const stop = feedStop(state, 0);

  const startChunkEmittedToolCall = start.some(
    (c) => c?.choices?.[0]?.delta?.tool_calls?.[0]?.id === "toolu_x"
  );
  assert.ok(
    startChunkEmittedToolCall,
    "stream-normalized must emit the tool_calls placeholder at content_block_start"
  );

  assert.equal(state.toolCalls.get(0).function.arguments, '{"title":"구현"}');
});

test("§7.2.3 multiple tool_use blocks emit independently", () => {
  const state = createState("buffered-final");
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });

  const s1 = feedToolUseStart(state, 1, "toolu_a", "f1");
  feedDelta(state, 1, '{"x":1}');
  const stop1 = feedStop(state, 1);

  const s2 = feedToolUseStart(state, 2, "toolu_b", "f2");
  feedDelta(state, 2, '{"y":2}');
  const stop2 = feedStop(state, 2);

  assert.equal(
    flatten(s1, s2).filter((c) => c?.choices?.[0]?.delta?.tool_calls).length,
    0,
    "no tool_calls emitted at start"
  );

  const e1 = stop1.filter((c) => c?.choices?.[0]?.delta?.tool_calls);
  const e2 = stop2.filter((c) => c?.choices?.[0]?.delta?.tool_calls);
  assert.equal(e1.length, 1);
  assert.equal(e2.length, 1);
  assert.equal(e1[0].choices[0].delta.tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(e2[0].choices[0].delta.tool_calls[0].function.arguments, '{"y":2}');
});

test("§7.2.4 mid-escape stop preserves verbatim partial buffer", () => {
  const state = createState("buffered-final");
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });
  feedToolUseStart(state, 0, "toolu_y", "f");
  feedDelta(state, 0, '{"x":"\\u');
  const stop = feedStop(state, 0);

  const fullEmit = stop.find((c) => c?.choices?.[0]?.delta?.tool_calls);
  assert.equal(fullEmit.choices[0].delta.tool_calls[0].function.arguments, '{"x":"\\u');
  assert.throws(() => JSON.parse('{"x":"\\u'), SyntaxError);
});

test("§7.2.5 mixed text + tool_use — text deltas pass through, tool emits once at stop", () => {
  const state = createState("buffered-final");
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });

  feed(state, { type: "content_block_start", index: 0, content_block: { type: "text" } });
  const t1 = feed(state, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "안녕" },
  });
  feedStop(state, 0);

  feedToolUseStart(state, 1, "toolu_z", "f");
  feedDelta(state, 1, '{"a":1}');
  const stop1 = feedStop(state, 1);

  const textContents = t1.flatMap((c) => {
    const v = c?.choices?.[0]?.delta?.content;
    return typeof v === "string" ? [v] : [];
  });
  assert.deepEqual(textContents, ["안녕"]);

  const toolEmits = stop1.filter((c) => c?.choices?.[0]?.delta?.tool_calls);
  assert.equal(toolEmits.length, 1);
});

test("§7.2.6 no internal-state keys leak into emitted chunks", () => {
  const state = createState("buffered-final");
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });
  feedToolUseStart(state, 0, "toolu_x", "f");
  feedDelta(state, 0, '{"a":1}');
  const stop = feedStop(state, 0);

  const all = flatten(stop);
  for (const c of all) {
    const json = JSON.stringify(c);
    assert.ok(!json.includes("toolArgumentMode"));
    assert.ok(!json.includes("toolArgNormalizers"));
    assert.ok(!json.includes("toolNameMap"));
    assert.ok(!json.includes("forwardingLane"));
  }
});

test("§7.2.7 final tool_calls chunk emits BEFORE finish_reason in buffered-final", () => {
  const state = createState("buffered-final");
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });
  const start = feedToolUseStart(state, 0, "toolu_q", "f");
  const d = feedDelta(state, 0, '{"x":1}');
  const stop = feedStop(state, 0);
  const md = feedMessageDelta(state, "tool_use");
  const ms = feedMessageStop(state);

  const chunks = flatten(start, d, stop, md, ms);
  const tFinal = findChunkIndexWithFullArgs(chunks, '{"x":1}');
  const tFinish = findFinishReasonIndex(chunks, "tool_calls");

  assert.notEqual(tFinal, -1, "must emit final tool_calls chunk with full arguments");
  assert.notEqual(tFinish, -1, "must emit finish_reason: tool_calls");
  assert.ok(
    tFinal < tFinish,
    `final tool_calls chunk (idx ${tFinal}) must precede finish_reason chunk (idx ${tFinish})`
  );
});

test("§7.2.7 same invariant under stream-normalized mode (regression guard)", () => {
  const state = createState("stream-normalized");
  feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } });
  const start = feedToolUseStart(state, 0, "toolu_q", "f");
  const d1 = feedDelta(state, 0, '{"x":');
  const d2 = feedDelta(state, 0, "1}");
  const stop = feedStop(state, 0);
  const md = feedMessageDelta(state, "tool_use");
  const ms = feedMessageStop(state);

  const chunks = flatten(start, d1, d2, stop, md, ms);
  let lastToolDeltaIdx = -1;
  for (let i = 0; i < chunks.length; i++) {
    const tcs = chunks[i]?.choices?.[0]?.delta?.tool_calls;
    if (tcs?.some((tc) => tc.function?.arguments)) lastToolDeltaIdx = i;
  }
  const tFinish = findFinishReasonIndex(chunks, "tool_calls");

  assert.ok(lastToolDeltaIdx >= 0);
  assert.ok(tFinish >= 0);
  assert.ok(lastToolDeltaIdx < tFinish);
});

test("§7.2.8 client-style accumulator parity — buffered-final vs stream-normalized", () => {
  function run(mode) {
    const state = createState(mode);
    feedAndSnapshot(() =>
      feed(state, { type: "message_start", message: { id: "msg1", model: "claude-opus-4-7" } })
    );
    const start = feedAndSnapshot(() => feedToolUseStart(state, 0, "toolu_a", "f"));
    const d1 = feedAndSnapshot(() => feedDelta(state, 0, '{"header":"\\u'));
    const d2 = feedAndSnapshot(() => feedDelta(state, 0, 'ad6c\\ud604"}'));
    const stop = feedAndSnapshot(() => feedStop(state, 0));
    const md = feedAndSnapshot(() => feedMessageDelta(state, "tool_use"));
    const ms = feedAndSnapshot(() => feedMessageStop(state));
    return flatten(start, d1, d2, stop, md, ms);
  }

  const bufChunks = run("buffered-final");
  const normChunks = run("stream-normalized");

  const bufAccum = accumulateOpenAIToolCalls(bufChunks);
  const normAccum = accumulateOpenAIToolCalls(normChunks);

  assert.equal(bufAccum.calls.length, 1);
  assert.equal(normAccum.calls.length, 1);

  assert.deepEqual(
    JSON.parse(bufAccum.calls[0].function.arguments),
    JSON.parse(normAccum.calls[0].function.arguments)
  );
  assert.equal(bufAccum.calls[0].id, "toolu_a");
  assert.equal(normAccum.calls[0].id, "toolu_a");
  assert.equal(bufAccum.calls[0].function.name, "f");
  assert.equal(normAccum.calls[0].function.name, "f");

  assert.equal(bufAccum.finishReason, "tool_calls");
  assert.equal(normAccum.finishReason, "tool_calls");
});

test("resolveToolArgumentMode resolver precedence", async () => {
  const { resolveToolArgumentMode } =
    await import("../../open-sse/translator/helpers/toolArgumentMode.ts");

  assert.equal(resolveToolArgumentMode(null, "claude", null), "stream-normalized");
  assert.equal(resolveToolArgumentMode({}, "claude", null), "stream-normalized");
  assert.equal(
    resolveToolArgumentMode({ default: "buffered-final" }, "claude", null),
    "buffered-final"
  );
  assert.equal(
    resolveToolArgumentMode(
      { default: "stream-normalized", byProvider: { claude: "buffered-final" } },
      "claude",
      null
    ),
    "buffered-final"
  );
  assert.equal(
    resolveToolArgumentMode(
      { default: "stream-normalized", byProvider: { claude: "buffered-final" } },
      "anthropic",
      null
    ),
    "stream-normalized"
  );
  assert.equal(
    resolveToolArgumentMode(
      {
        default: "stream-normalized",
        byProvider: { claude: "stream-normalized" },
        byLane: { "claude-oauth-prefixed": "buffered-final" },
      },
      "claude",
      "claude-oauth-prefixed"
    ),
    "buffered-final"
  );
  assert.equal(
    resolveToolArgumentMode(
      { default: "stream-normalized", byProvider: { claude: "garbage" } },
      "claude",
      null
    ),
    "stream-normalized"
  );
});
