import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createResponsesApiTransformStream, createResponsesLogger } =
  await import("../../open-sse/transformer/responsesTransformer.ts");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function runTransformStream(chunks, logger = null) {
  const stream = createResponsesApiTransformStream(logger);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const output = [];
  const readerTask = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output.push(decoder.decode(value));
    }
  })();

  for (const chunk of chunks) {
    await writer.write(encoder.encode(chunk));
  }
  await writer.close();
  await readerTask;

  return output.join("");
}

function parseSseOutput(output) {
  return output
    .trim()
    .split("\n\n")
    .map((entry) => {
      const lines = entry.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      return {
        event: eventLine ? eventLine.slice("event: ".length) : null,
        data: dataLine ? dataLine.slice("data: ".length) : null,
      };
    });
}

test("createResponsesApiTransformStream converts plain chat deltas into Responses API events", async () => {
  const output = await runTransformStream([
    'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ]);

  const events = parseSseOutput(output);
  const types = events.map((event) => event.event || event.data);
  const deltas = events
    .filter((event) => event.event === "response.output_text.delta")
    .map((event) => JSON.parse(event.data));
  const completed = JSON.parse(
    events.find((event) => event.event === "response.completed").data
  ).response;
  const doneMarker = events.at(-1);

  assert.deepEqual(
    deltas.map((delta) => delta.delta),
    ["Hel", "lo"]
  );
  assert.ok(types.includes("response.created"));
  assert.ok(types.includes("response.in_progress"));
  assert.ok(types.includes("response.output_item.added"));
  assert.ok(types.includes("response.output_text.done"));
  assert.equal(completed.output[0].content[0].text, "Hello");
  assert.deepEqual(completed.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
  assert.equal(doneMarker.data, "[DONE]");
});

test("createResponsesApiTransformStream converts think tags into reasoning summaries", async () => {
  const output = await runTransformStream([
    'data: {"choices":[{"index":0,"delta":{"content":"<think>plan"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"ning</think>answer"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ]);

  const events = parseSseOutput(output);
  const reasoningDeltas = events
    .filter((event) => event.event === "response.reasoning_summary_text.delta")
    .map((event) => JSON.parse(event.data).delta);
  const completed = JSON.parse(
    events.find((event) => event.event === "response.completed").data
  ).response;

  assert.deepEqual(reasoningDeltas, ["plan", "ning"]);
  assert.deepEqual(completed.output[0], {
    id: completed.output[0].id,
    type: "reasoning",
    summary: [{ type: "summary_text", text: "planning" }],
  });
  assert.deepEqual(completed.output[1].content, [
    { type: "output_text", annotations: [], text: "answer" },
  ]);
});

test("createResponsesApiTransformStream handles native reasoning content and tool call index replacement", async () => {
  const output = await runTransformStream([
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"draft "}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":\\"hel"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"arguments":"lo\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n',
  ]);

  const events = parseSseOutput(output);
  const addedCalls = events
    .filter((event) => event.event === "response.output_item.added")
    .map((event) => JSON.parse(event.data).item)
    .filter((item) => item.type === "function_call");
  const doneCalls = events
    .filter((event) => event.event === "response.output_item.done")
    .map((event) => JSON.parse(event.data).item)
    .filter((item) => item.type === "function_call");
  const completed = JSON.parse(
    events.find((event) => event.event === "response.completed").data
  ).response;

  assert.deepEqual(
    addedCalls.map((item) => ({ id: item.id, call_id: item.call_id, name: item.name })),
    [
      { id: "fc_call_1", call_id: "call_1", name: "search" },
      { id: "fc_call_2", call_id: "call_2", name: "lookup" },
    ]
  );
  assert.deepEqual(
    doneCalls.map((item) => ({ id: item.id, call_id: item.call_id, name: item.name })),
    [
      { id: "fc_call_1", call_id: "call_1", name: "search" },
      { id: "fc_call_2", call_id: "call_2", name: "lookup" },
    ]
  );
  assert.equal(completed.output[0].type, "reasoning");
  assert.deepEqual(
    completed.output
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        id: item.id,
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      })),
    [{ id: "fc_call_2", call_id: "call_2", name: "lookup", arguments: "{}" }]
  );
});

test("createResponsesLogger persists input and output event logs on flush", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "responses-transformer-"));
  const logger = createResponsesLogger("gpt-4o", logsDir);

  assert.ok(logger);

  const output = await runTransformStream(
    ['data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'],
    logger
  );

  const logRoot = join(logsDir, "logs");
  const [sessionDir] = readdirSync(logRoot);
  const inputLog = readFileSync(join(logRoot, sessionDir, "1_input_stream.txt"), "utf8");
  const outputLog = readFileSync(join(logRoot, sessionDir, "2_output_stream.txt"), "utf8");

  assert.match(sessionDir, /^responses_gpt-4o_/);
  assert.match(inputLog, /"content":"hi"/);
  assert.match(outputLog, /response\.completed/);
  assert.match(output, /data: \[DONE]/);
});

test("createResponsesApiTransformStream ignores malformed events and preserves usage-only chunks", async () => {
  const output = await runTransformStream([
    "event: ping\n\n",
    "data: [DONE]\n\n",
    'data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    "data: {not-json}\n\n",
    'data: {"id":"chatcmpl_edge","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
  ]);

  const events = parseSseOutput(output);
  const completed = JSON.parse(
    events.find((event) => event.event === "response.completed").data
  ).response;

  assert.equal(completed.id, "resp_chatcmpl_edge");
  assert.equal(completed.output[0].content[0].text, "ok");
  assert.deepEqual(completed.usage, {
    prompt_tokens: 2,
    completion_tokens: 1,
    total_tokens: 3,
  });
});

test("createResponsesLogger returns null for invalid base paths and swallows flush write failures", () => {
  const blockedPath = join(tmpdir(), `responses-transformer-blocked-${Date.now()}`);
  writeFileSync(blockedPath, "blocked");

  try {
    const blockedLogger = createResponsesLogger("gpt-4o", blockedPath);
    assert.equal(blockedLogger, null);
  } finally {
    unlinkSync(blockedPath);
  }

  const logsDir = mkdtempSync(join(tmpdir(), "responses-transformer-broken-"));
  const logger = createResponsesLogger("gpt-4o", logsDir);
  const capturedLogs = [];
  const originalConsoleLog = console.log;

  logger.logInput("input");
  logger.logOutput("output");

  const sessionDir = readdirSync(join(logsDir, "logs"))[0];
  rmSync(join(logsDir, "logs", sessionDir), { recursive: true, force: true });
  console.log = (...args) => capturedLogs.push(args.join(" "));

  try {
    logger.flush();
  } finally {
    console.log = originalConsoleLog;
  }

  assert.ok(capturedLogs.some((entry) => entry.includes("[RESPONSES] Failed to write logs:")));
});

// Helper: send pre-split byte chunks (Uint8Array) directly into the transform.
// runTransformStream() above always re-encodes whole strings, which hides
// chunk-boundary bugs. This bypasses the encoder so we can simulate the
// upstream HTTP body splitting a multi-byte UTF-8 sequence mid-character.
async function runTransformStreamBytes(byteChunks) {
  const stream = createResponsesApiTransformStream(null);
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const output = [];
  const readerTask = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output.push(decoder.decode(value));
    }
  })();

  for (const chunk of byteChunks) {
    await writer.write(chunk);
  }
  await writer.close();
  await readerTask;

  return output.join("");
}

// Regression test for mojibake hotfix:
// `responsesTransformer.ts` previously created a fresh `new TextDecoder()` per
// chunk without `{ stream: true }`, so a multi-byte UTF-8 character (Korean is
// 3 bytes) split across two HTTP chunks decoded as two invalid sequences and
// emerged as wrong/missing characters in `tool_calls.function.arguments` and
// `output_text.delta`. The fix uses a single decoder with `stream: true` and a
// terminal `decode()` in `flush()` to drain any tail bytes.
//
// "수정할 때는" = ec 88 98 / ec a0 95 / ed 95 a0 / 20 / eb 95 8c / eb 8a 94
// We split the chunk inside "때" (eb 95 8c) so the first chunk ends with
// `eb 95` and the next begins with `8c`. Pre-fix this surfaces as mojibake
// (different valid Korean characters or a U+FFFD); post-fix it stitches.
test("createResponsesApiTransformStream preserves Korean multi-byte chars split across chunk boundaries", async () => {
  // Build the raw bytes for the SSE event so we can split mid-character.
  const fullPayload = encoder.encode(
    'data: {"choices":[{"index":0,"delta":{"content":"수정할 때는"}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
  );

  // Locate the third byte of "때" (the trailing 0x8C of EB 95 8C). We split
  // immediately BEFORE that byte so chunk1 ends mid-character.
  // 때 codepoint = U+B54C → UTF-8 = 0xEB 0x95 0x8C
  let splitAt = -1;
  for (let i = 0; i + 2 < fullPayload.length; i++) {
    if (fullPayload[i] === 0xeb && fullPayload[i + 1] === 0x95 && fullPayload[i + 2] === 0x8c) {
      splitAt = i + 2; // split right before the trailing byte
      break;
    }
  }
  assert.ok(splitAt > 0, "expected to find the 0xEB 0x95 0x8C sequence in the encoded payload");

  const chunk1 = fullPayload.slice(0, splitAt);
  const chunk2 = fullPayload.slice(splitAt);

  const output = await runTransformStreamBytes([chunk1, chunk2]);
  const events = parseSseOutput(output);

  const deltas = events
    .filter((event) => event.event === "response.output_text.delta")
    .map((event) => JSON.parse(event.data).delta)
    .join("");
  const completed = events.find((event) => event.event === "response.completed");
  const text = completed ? JSON.parse(completed.data).response.output[0].content[0].text : null;

  assert.equal(deltas, "수정할 때는");
  assert.equal(text, "수정할 때는");
});

// Same bug, harsher repro: 3-way split with each Korean char split across
// chunk boundaries. Without `{ stream: true }` + outer-scoped decoder, every
// boundary corrupts. Post-fix: clean stitching.
test("createResponsesApiTransformStream stitches multiple Korean characters split byte-by-byte", async () => {
  const phrase = "사용자가";
  const head = encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"');
  const body = encoder.encode(phrase);
  const tail = encoder.encode(
    '"}}]}\n\n' + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
  );

  // Split the body byte-by-byte: every boundary lands inside a multi-byte char.
  const byteChunks = [head];
  for (let i = 0; i < body.length; i++) {
    byteChunks.push(body.slice(i, i + 1));
  }
  byteChunks.push(tail);

  const output = await runTransformStreamBytes(byteChunks);
  const events = parseSseOutput(output);

  const deltas = events
    .filter((event) => event.event === "response.output_text.delta")
    .map((event) => JSON.parse(event.data).delta)
    .join("");
  const completed = events.find((event) => event.event === "response.completed");
  const text = completed ? JSON.parse(completed.data).response.output[0].content[0].text : null;

  assert.equal(deltas, phrase);
  assert.equal(text, phrase);
});
