import test from "node:test";
import assert from "node:assert/strict";

const { sanitizeSurrogates, sanitizeSurrogatesDeep } =
  await import("../../open-sse/utils/sanitizeSurrogates.ts");

const REPLACEMENT = "\uFFFD";
const HIGH = "\uD83D";
const LOW = "\uDE00";
const EMOJI = "\uD83D\uDE00";

test("sanitizeSurrogates — primitives", async (t) => {
  await t.test("ASCII passes through unchanged", () => {
    assert.equal(sanitizeSurrogates("hello world"), "hello world");
  });

  await t.test("empty string returns empty string", () => {
    assert.equal(sanitizeSurrogates(""), "");
  });

  await t.test("valid emoji surrogate pair is preserved", () => {
    assert.equal(sanitizeSurrogates(EMOJI), EMOJI);
    assert.equal(sanitizeSurrogates(`hi ${EMOJI} there`), `hi ${EMOJI} there`);
  });

  await t.test("lone high surrogate is replaced with U+FFFD", () => {
    assert.equal(sanitizeSurrogates(HIGH), REPLACEMENT);
  });

  await t.test("lone low surrogate is replaced with U+FFFD", () => {
    assert.equal(sanitizeSurrogates(LOW), REPLACEMENT);
  });

  await t.test("interior lone surrogate replaced; surrounding chars preserved", () => {
    assert.equal(sanitizeSurrogates(`a${HIGH}b`), `a${REPLACEMENT}b`);
    assert.equal(sanitizeSurrogates(`a${LOW}b`), `a${REPLACEMENT}b`);
  });

  await t.test("valid pair followed by lone low: pair preserved, lone replaced", () => {
    assert.equal(sanitizeSurrogates(`${EMOJI}${LOW}`), `${EMOJI}${REPLACEMENT}`);
  });

  await t.test("lone high followed by valid pair: lone replaced, pair preserved", () => {
    assert.equal(sanitizeSurrogates(`${HIGH}${EMOJI}`), `${REPLACEMENT}${EMOJI}`);
  });

  await t.test("non-string input returned as-is", () => {
    assert.equal(sanitizeSurrogates(42), 42);
    assert.equal(sanitizeSurrogates(null), null);
    assert.equal(sanitizeSurrogates(undefined), undefined);
  });

  await t.test("output never contains lone surrogates", () => {
    const inputs = [HIGH, LOW, `pre${HIGH}post`, `${LOW}tail`, `${HIGH}${EMOJI}${LOW}`];
    for (const input of inputs) {
      const cleaned = sanitizeSurrogates(input);
      assert.match(
        cleaned,
        /^[^\uD800-\uDFFF]*(?:[\uD800-\uDBFF][\uDC00-\uDFFF][^\uD800-\uDFFF]*)*$/
      );
    }
  });
});

test("sanitizeSurrogatesDeep — recursive walk", async (t) => {
  await t.test("clean payload returns the same reference (no clone)", () => {
    const input = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hello world" }],
      tools: [{ name: "echo", description: "echoes input" }],
    };
    const output = sanitizeSurrogatesDeep(input);
    assert.equal(output, input);
    assert.equal(output.messages, input.messages);
  });

  await t.test("dirty string deep inside object is replaced; siblings preserved", () => {
    const input = {
      model: "claude-opus-4-7",
      messages: [
        { role: "user", content: `bad ${HIGH} chunk` },
        { role: "user", content: `clean ${EMOJI}` },
      ],
      system: [{ type: "text", text: `prompt ${LOW}` }],
    };
    const output = sanitizeSurrogatesDeep(input);

    assert.notEqual(output, input);
    assert.equal(output.messages[0].content, `bad ${REPLACEMENT} chunk`);
    assert.equal(output.messages[1].content, `clean ${EMOJI}`);
    assert.equal(output.system[0].text, `prompt ${REPLACEMENT}`);
    assert.equal(output.model, "claude-opus-4-7");
  });

  await t.test("only the dirty branch is cloned; clean branch is referentially equal", () => {
    const cleanArr = [{ role: "user", content: "fine" }];
    const dirty = { type: "text", text: HIGH };
    const input = { messages: cleanArr, system: [dirty] };

    const output = sanitizeSurrogatesDeep(input);

    assert.notEqual(output, input);
    assert.equal(output.messages, cleanArr);
    assert.notEqual(output.system, input.system);
    assert.equal(output.system[0].text, REPLACEMENT);
  });

  await t.test("array of strings sanitized", () => {
    const input = { stop: [`tag${HIGH}`, "ok"] };
    const output = sanitizeSurrogatesDeep(input);
    assert.deepEqual(output.stop, [`tag${REPLACEMENT}`, "ok"]);
  });

  await t.test("nested tool arguments sanitized", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "x", function: { name: "search", arguments: `{"q":"${LOW}"}` } }],
        },
      ],
    };
    const output = sanitizeSurrogatesDeep(input);
    assert.equal(output.messages[0].tool_calls[0].function.arguments, `{"q":"${REPLACEMENT}"}`);
  });

  await t.test("primitives at top-level pass through", () => {
    assert.equal(sanitizeSurrogatesDeep("clean"), "clean");
    assert.equal(sanitizeSurrogatesDeep(123), 123);
    assert.equal(sanitizeSurrogatesDeep(true), true);
    assert.equal(sanitizeSurrogatesDeep(null), null);
  });

  await t.test("non-plain object (Date) is returned by reference, not descended into", () => {
    const date = new Date("2026-04-26T00:00:00Z");
    const input = { timestamp: date, label: `bad ${HIGH}` };
    const output = sanitizeSurrogatesDeep(input);
    assert.equal(output.timestamp, date);
    assert.equal(output.label, `bad ${REPLACEMENT}`);
  });
});

test("sanitizeSurrogatesDeep — JSON.stringify safety guarantee", async (t) => {
  await t.test("dirty input + sanitize → JSON.stringify produces well-formed JSON", () => {
    const dirty = {
      messages: [{ role: "user", content: `pre ${HIGH} mid ${LOW} post ${EMOJI} end` }],
    };
    const cleaned = sanitizeSurrogatesDeep(dirty);
    const serialized = JSON.stringify(cleaned);

    // Anthropic's parser rejects \uD8xx / \uDCxx without a paired counterpart.
    // After sanitize, JSON.stringify must not emit lone escaped surrogates.
    const loneEscaped =
      /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][cdefCDEF][0-9a-fA-F]{2})|(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][cdefCDEF][0-9a-fA-F]{2}/;
    assert.equal(loneEscaped.test(serialized), false);

    // Round-trip: parsed payload must contain no lone surrogates either.
    const reparsed = JSON.parse(serialized);
    const reserialized = JSON.stringify(reparsed);
    assert.equal(loneEscaped.test(reserialized), false);
  });
});
