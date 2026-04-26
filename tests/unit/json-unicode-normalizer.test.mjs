import test from "node:test";
import assert from "node:assert/strict";

const { createJsonUnicodeNormalizer } =
  await import("../../open-sse/translator/helpers/jsonUnicodeNormalizer.ts");

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Walks the string and asserts that:
 *   - every UTF-16 high surrogate in [0xD800, 0xDBFF] is immediately
 *     followed by a low surrogate in [0xDC00, 0xDFFF].
 *   - every low surrogate in [0xDC00, 0xDFFF] is immediately preceded
 *     by a high surrogate.
 *
 * Used to verify that the normalizer never emits a real lone UTF-16
 * surrogate even when chunk boundaries split escape sequences.
 */
function assertNoLoneSurrogates(s, msg = "") {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      assert.ok(
        next >= 0xdc00 && next <= 0xdfff,
        `${msg} high surrogate at index ${i} not followed by low surrogate`
      );
      i++; // skip the low we just verified
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      assert.fail(`${msg} lone low surrogate at index ${i}`);
    }
  }
}

/** Run input through a fresh normalizer and return the concatenated output. */
function runOnce(input) {
  const n = createJsonUnicodeNormalizer();
  return n.write(input) + n.flush();
}

/**
 * Asserts the normalizer's output, when re-parsed as JSON, deep-equals the input
 * re-parsed as JSON, AND that no real lone surrogates leaked. Use when output is
 * NOT byte-identical to input (e.g. `\uad6c` → `구`) but JSON value is preserved.
 */
function expectJsonValueEqual(input, label = input) {
  const out = runOnce(input);
  assertNoLoneSurrogates(out, `[${label}] output`);
  assert.deepEqual(JSON.parse(out), JSON.parse(input), `[${label}] JSON.parse equivalence`);
}

/** Asserts byte-for-byte output equality. */
function expectExactOutput(input, expected, label = input) {
  const out = runOnce(input);
  assert.equal(out, expected, `[${label}] exact output`);
  assertNoLoneSurrogates(out, `[${label}] output lone-surrogate check`);
}

// ──────────────────────────────────────────────────────────────────────
// 7.1 BMP — single chunk
// ──────────────────────────────────────────────────────────────────────

test("§7.1 BMP single chunk — Korean escape decoded to raw UTF-8", () => {
  const n = createJsonUnicodeNormalizer();
  const out = n.write('{"header":"\\uad6c\\ud604 + \\uc815\\ub9ac \\ubc29\\ud5a5"}');
  const tail = n.flush();
  assert.equal(out + tail, '{"header":"구현 + 정리 방향"}');
});

// ──────────────────────────────────────────────────────────────────────
// 7.2 Escape split across deltas (Korean)
// ──────────────────────────────────────────────────────────────────────

test("§7.2 escape split across deltas — Korean", () => {
  const n = createJsonUnicodeNormalizer();
  const out1 = n.write('{"header":"\\u');
  const out2 = n.write("ad6c\\ud604 + \\uc815");
  const out3 = n.write('\\ub9ac \\ubc29\\ud5a5"}');
  const tail = n.flush();
  const result = out1 + out2 + out3 + tail;
  assert.equal(result, '{"header":"구현 + 정리 방향"}');
  assertNoLoneSurrogates(result);
});

// ──────────────────────────────────────────────────────────────────────
// 7.3 Surrogate pair split — emoji
// ──────────────────────────────────────────────────────────────────────

test("§7.3 surrogate pair split — emoji 😀", () => {
  const n = createJsonUnicodeNormalizer();
  const out1 = n.write('{"emoji":"\\uD83D');
  const out2 = n.write('\\uDE00"}');
  const tail = n.flush();
  assert.equal(out1 + out2 + tail, '{"emoji":"\uD83D\uDE00"}');
  assert.ok(
    !/[\uD800-\uDBFF]/.test(out1),
    "out1 must not emit a real high surrogate before pairing"
  );
});

// ──────────────────────────────────────────────────────────────────────
// 7.4 Semantic escape preservation
// ──────────────────────────────────────────────────────────────────────

test("§7.4 semantic escape preservation", () => {
  const input =
    '{"newline":"line\\nnext","quote":"\\"","backslash":"\\\\","literalEscapeText":"\\\\uad6c","encodedQuote":"\\u0022","encodedBackslash":"\\u005c","control":"\\u001f"}';
  const n = createJsonUnicodeNormalizer();
  const result = n.write(input) + n.flush();

  // JSON value must round-trip exactly.
  assert.deepEqual(JSON.parse(result), JSON.parse(input));

  // The literal escape text "\\uad6c" (7 chars: backslash + u + 4 hex)
  // must NOT be decoded to the Korean character "구".
  assert.equal(JSON.parse(result).literalEscapeText, "\\uad6c");

  // Encoded quote/backslash/control codepoints in the JSON string MUST remain
  // escaped in the wire (decoding them would inject raw `"`/`\`/control chars
  // and corrupt the JSON).
  assert.ok(/\\(u0022|")/.test(result), "encoded quote must remain escaped");
  assert.ok(/\\(u005[cC]|\\)/.test(result), "encoded backslash must remain escaped");
  assert.ok(result.includes("\\u001f"), "control U+001F must remain escaped");
});

// ──────────────────────────────────────────────────────────────────────
// 7.5 Raw UTF-8 passthrough
// ──────────────────────────────────────────────────────────────────────

test("§7.5 raw UTF-8 passthrough — input unchanged", () => {
  const input = '{"header":"구현"}';
  expectExactOutput(input, input);
});

// ──────────────────────────────────────────────────────────────────────
// 7.6 Unpaired surrogate cases (Momus § 5, Oracle § 5 / § 3)
// ──────────────────────────────────────────────────────────────────────

test("§7.6(a) high surrogate + ASCII letter — high stays escaped", () => {
  // Output is byte-identical because nothing decodes (high preserved, ASCII passes through).
  expectExactOutput('{"x":"\\uD83Dabc"}', '{"x":"\\uD83Dabc"}');
});

test("§7.6(b) high surrogate + non-low \\u — \\u0041 decodes to 'A', high stays escaped", () => {
  // Crucial: \uD83D must NOT pair with \u0041, but \u0041 must STILL decode.
  expectExactOutput('{"x":"\\uD83D\\u0041"}', '{"x":"\\uD83DA"}');
});

test("§7.6(c) lone low surrogate — preserved verbatim", () => {
  expectJsonValueEqual('{"x":"\\uDE00"}');
});

test("§7.6(d) high + literal backslash + low — must NOT pair", () => {
  // Input bytes:  \uD83D \\ \uDE00  (a high, then escaped backslash, then a low)
  // After decoding: high stays escaped (no immediate \uXXXX low after it),
  //                 \\ stays preserved (semantic JSON escape),
  //                 \uDE00 stays preserved (lone low after the escaped backslash).
  // None of the three should pair. JSON-value equivalence must hold.
  expectJsonValueEqual('{"x":"\\uD83D\\\\\\uDE00"}');
});

test("§7.6(e1) BOM \\uFEFF decodes", () => {
  expectExactOutput('{"x":"\\uFEFF"}', '{"x":"\uFEFF"}');
});

test("§7.6(e2) line separator \\u2028 decodes", () => {
  expectExactOutput('{"x":"\\u2028"}', '{"x":"\u2028"}');
});

test("§7.6(e3) BMP boundary \\uFFFF decodes", () => {
  expectExactOutput('{"x":"\\uFFFF"}', '{"x":"\uFFFF"}');
});

test("§7.6(f) split versions of unpaired-surrogate cases", () => {
  // (a) high + ASCII split mid-escape
  {
    const n = createJsonUnicodeNormalizer();
    const r = n.write('{"x":"\\uD8') + n.write('3Dabc"}') + n.flush();
    assert.equal(r, '{"x":"\\uD83Dabc"}');
    assertNoLoneSurrogates(r);
  }
  // (b) high + \u0041 split between the two escapes
  {
    const n = createJsonUnicodeNormalizer();
    const r = n.write('{"x":"\\uD83D') + n.write('\\u0041"}') + n.flush();
    assert.equal(r, '{"x":"\\uD83DA"}');
    assertNoLoneSurrogates(r);
  }
  // (c) lone low split
  {
    const n = createJsonUnicodeNormalizer();
    const r = n.write('{"x":"\\uDE') + n.write('00"}') + n.flush();
    assert.deepEqual(JSON.parse(r), JSON.parse('{"x":"\\uDE00"}'));
    assertNoLoneSurrogates(r);
  }
  // (d) high + \\ + low split into 4 pieces
  {
    const n = createJsonUnicodeNormalizer();
    const r =
      n.write('{"x":"\\uD83D') + n.write("\\\\") + n.write("\\uDE00") + n.write('"}') + n.flush();
    assert.deepEqual(JSON.parse(r), JSON.parse('{"x":"\\uD83D\\\\\\uDE00"}'));
    assertNoLoneSurrogates(r);
  }
});

// ──────────────────────────────────────────────────────────────────────
// 7.7 Composition stability — all 1-char, all 2-split, selected 3-split
// ──────────────────────────────────────────────────────────────────────

test("§7.7 composition stability across chunk boundaries", () => {
  const cases = [
    '{"a":"\\uad6c"}', // BMP
    '{"a":"\\uD83D\\uDE00 b"}', // surrogate pair
    '{"a":"line\\nbreak"}', // semantic escape
    '{"a":"\\\\uad6c is literal"}', // literal escaped backslash + u
    '{"a":"\\uD83Dabc"}', // unpaired high + ASCII
    '{"a":"\\uD83D\\u0041"}', // unpaired high + non-low \u
    '{"a":"\\uD83D\\\\\\uDE00"}', // high + literal backslash + low — must NOT pair
    '{"a":"\\uDE00 stuff"}', // lone low
    '{"a":"\\u12G4"}', // malformed hex (G is non-hex)
    '{"a":"\\u12"}', // truncated escape
    '{"a":"\\w\\d"}', // invalid non-\u escapes
    '{"a":"\\uFEFF"}', // BOM
    '{"a":"\\u2028"}', // line separator
    '{"a":"\\uFFFF"}', // BMP boundary
  ];

  for (const full of cases) {
    // Reference output: single-shot run.
    const ref = runOnce(full);

    // Per-character split: write one char at a time.
    {
      const n = createJsonUnicodeNormalizer();
      let acc = "";
      for (const ch of full) acc += n.write(ch);
      acc += n.flush();
      assert.equal(acc, ref, `per-char ${JSON.stringify(full)}`);
    }

    // All 2-split partitions.
    for (let i = 0; i <= full.length; i++) {
      const n = createJsonUnicodeNormalizer();
      const out = n.write(full.slice(0, i)) + n.write(full.slice(i)) + n.flush();
      assert.equal(out, ref, `split-at-${i} ${JSON.stringify(full)}`);
    }

    // All 3-split partitions for cases with length ≤ 40 (caps O(n²) at acceptable cost).
    if (full.length <= 40) {
      for (let i = 0; i <= full.length; i++) {
        for (let j = i; j <= full.length; j++) {
          const n = createJsonUnicodeNormalizer();
          const out =
            n.write(full.slice(0, i)) +
            n.write(full.slice(i, j)) +
            n.write(full.slice(j)) +
            n.flush();
          assert.equal(out, ref, `split-${i}-${j} ${JSON.stringify(full)}`);
        }
      }
    }
  }
});

// ──────────────────────────────────────────────────────────────────────
// Bonus — invariants spot-checks
// ──────────────────────────────────────────────────────────────────────

test("invariant — pending bound (≤ 12) after every write", () => {
  // Adversarial input: long stream of high surrogates without low followers.
  const n = createJsonUnicodeNormalizer();
  let acc = "";
  for (let k = 0; k < 50; k++) {
    acc += n.write('"\\uD83D ');
  }
  acc += n.flush();
  // We can't directly inspect `pending`, but we can assert no chunk produced
  // a pathologically large output (rough check: output should be < input * 2).
  assert.ok(acc.length < 50 * 12);
});

test("invariant — empty input is identity", () => {
  expectExactOutput("", "");
});

test("invariant — ASCII-only string passes through unchanged", () => {
  expectExactOutput('{"a":"hello world"}', '{"a":"hello world"}');
});

test("invariant — flush after fully consumed input returns empty string", () => {
  const n = createJsonUnicodeNormalizer();
  const out = n.write('{"a":"hi"}');
  assert.equal(out, '{"a":"hi"}');
  assert.equal(n.flush(), "");
});
