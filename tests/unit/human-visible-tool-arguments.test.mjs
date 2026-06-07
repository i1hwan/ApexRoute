import test from "node:test";
import assert from "node:assert/strict";

const { normalizeHumanVisibleToolArguments } =
  await import("../../open-sse/translator/helpers/humanVisibleToolArguments.ts");

test("human-visible tool arguments decode literal unicode only in display fields", () => {
  const args = JSON.stringify({
    question: "mlbasics \\ud3f4\\ub354",
    options: [{ label: "\\uc81c\\uac70", description: "\\uc548\\uc804" }],
    literal: "\\uad6c",
  });

  const parsed = JSON.parse(normalizeHumanVisibleToolArguments("clarify", args));

  assert.equal(parsed.question, "mlbasics 폴더");
  assert.deepEqual(parsed.options, [{ label: "제거", description: "안전" }]);
  assert.equal(parsed.literal, "\\uad6c");
});

test("human-visible tool arguments preserve non-display tools", () => {
  const args = JSON.stringify({ question: "\\uc9c8\\ubb38", title: "\\uad6c\\ud604" });

  assert.equal(normalizeHumanVisibleToolArguments("save_doc", args), args);
});

test("human-visible tool arguments decode paired surrogate literals and preserve lone surrogates", () => {
  const args = JSON.stringify({
    question: "emoji \\uD83D\\uDE00 lone-high \\uD83D lone-low \\uDE00",
  });

  const parsed = JSON.parse(normalizeHumanVisibleToolArguments("question", args));

  assert.equal(parsed.question, "emoji 😀 lone-high \\uD83D lone-low \\uDE00");
});

test("human-visible tool arguments preserve malformed JSON verbatim", () => {
  const args = '{"question":"\\uc9c8\\ubb38"';

  assert.equal(normalizeHumanVisibleToolArguments("question", args), args);
});
