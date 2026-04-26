// Streaming JSON Unicode-escape normalizer for Anthropic→OpenAI tool-arg translation.
// See `.sisyphus/plans/tool-args-unicode-normalizer.md` rev3 §5 and
// `notes/unicode-escape/00-investigation.md` for full rationale.
// Contract: JSON-value-preserving (NOT byte-preserving).

export interface JsonUnicodeNormalizer {
  write(chunk: string): string;
  flush(): string;
}

const MAX_PENDING_LEN = 12;

interface EscapeDecision {
  advance: number;
  emit: string;
}

function isHexChar(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

export function createJsonUnicodeNormalizer(): JsonUnicodeNormalizer {
  let inString = false;
  let pending = "";

  // Returns null when more data is needed.
  // Behaviour table (all only when inside a JSON string):
  //   \X (X != 'u')                       → preserve, advance 2
  //   \uXXXX in [0..1F] | 0022 | 005C      → preserve, advance 6
  //   \uXXXX high surrogate + \uYYYY low   → emit pair, advance 12
  //   \uXXXX high surrogate + anything     → preserve high, advance 6, reprocess
  //   \uXXXX lone low surrogate            → preserve, advance 6
  //   \uXXXX safe BMP                      → decode, advance 6
  //   \u<non-hex>                          → first-non-hex-char rule (plan §5.3 / Oracle §2)
  function decideEscape(buf: string, i: number): EscapeDecision | null {
    if (i + 1 >= buf.length) return null;

    const next = buf[i + 1];
    if (next !== "u") {
      return { advance: 2, emit: buf.slice(i, i + 2) };
    }

    let hexLen = 0;
    while (hexLen < 4 && i + 2 + hexLen < buf.length) {
      if (isHexChar(buf[i + 2 + hexLen])) {
        hexLen++;
      } else {
        return {
          advance: 2 + hexLen + 1,
          emit: buf.slice(i, i + 2 + hexLen + 1),
        };
      }
    }
    if (hexLen < 4) return null;

    const hex = buf.slice(i + 2, i + 6);
    const cp = parseInt(hex, 16);

    if (cp <= 0x001f || cp === 0x0022 || cp === 0x005c) {
      return { advance: 6, emit: buf.slice(i, i + 6) };
    }

    if (cp >= 0xd800 && cp <= 0xdbff) {
      if (i + 12 > buf.length) return null;
      const tail = buf.slice(i + 6, i + 12);
      if (
        tail[0] === "\\" &&
        tail[1] === "u" &&
        isHexChar(tail[2]) &&
        isHexChar(tail[3]) &&
        isHexChar(tail[4]) &&
        isHexChar(tail[5])
      ) {
        const lo = parseInt(tail.slice(2, 6), 16);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          return { advance: 12, emit: String.fromCharCode(cp, lo) };
        }
      }
      return { advance: 6, emit: buf.slice(i, i + 6) };
    }

    if (cp >= 0xdc00 && cp <= 0xdfff) {
      return { advance: 6, emit: buf.slice(i, i + 6) };
    }

    return { advance: 6, emit: String.fromCharCode(cp) };
  }

  function write(chunk: string): string {
    if (typeof chunk !== "string" || chunk.length === 0) {
      return "";
    }

    const buf = pending + chunk;
    pending = "";
    let out = "";
    let i = 0;

    while (i < buf.length) {
      const ch = buf[i];

      if (!inString) {
        if (ch === '"') inString = true;
        out += ch;
        i++;
        continue;
      }

      if (ch === "\\") {
        const decision = decideEscape(buf, i);
        if (decision === null) {
          pending = buf.slice(i);
          if (pending.length > MAX_PENDING_LEN) {
            // Unreachable invariant guard (decideEscape buffers ≤12 chars).
            throw new Error(
              `jsonUnicodeNormalizer: pending buffer overflow (len=${pending.length})`
            );
          }
          return out;
        }
        out += decision.emit;
        i += decision.advance;
        continue;
      }

      if (ch === '"') inString = false;
      out += ch;
      i++;
    }

    return out;
  }

  function flush(): string {
    const tail = pending;
    pending = "";
    return tail;
  }

  return { write, flush };
}
