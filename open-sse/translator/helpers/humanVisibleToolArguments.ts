const HUMAN_VISIBLE_TOOL_NAMES = new Set([
  "clarify",
  "question",
  "proxy_clarify",
  "proxy_question",
]);
const HUMAN_VISIBLE_STRING_KEYS = new Set(["description", "header", "label", "question"]);
const HUMAN_VISIBLE_STRING_ARRAY_KEYS = new Set(["choices"]);

function isHexChar(c: string): boolean {
  return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function isUnicodeEscapeLiteral(text: string, index: number): boolean {
  return (
    text[index] === "\\" &&
    text[index + 1] === "u" &&
    isHexChar(text[index + 2] ?? "") &&
    isHexChar(text[index + 3] ?? "") &&
    isHexChar(text[index + 4] ?? "") &&
    isHexChar(text[index + 5] ?? "")
  );
}

function decodeUnicodeEscapeLiteral(text: string): string {
  if (!text.includes("\\u")) return text;

  let result = "";
  let index = 0;

  while (index < text.length) {
    if (!isUnicodeEscapeLiteral(text, index)) {
      result += text[index];
      index++;
      continue;
    }

    const codePoint = parseInt(text.slice(index + 2, index + 6), 16);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const lowIndex = index + 6;
      if (isUnicodeEscapeLiteral(text, lowIndex)) {
        const lowCodePoint = parseInt(text.slice(lowIndex + 2, lowIndex + 6), 16);
        if (lowCodePoint >= 0xdc00 && lowCodePoint <= 0xdfff) {
          result += String.fromCharCode(codePoint, lowCodePoint);
          index += 12;
          continue;
        }
      }
      result += text.slice(index, index + 6);
      index += 6;
      continue;
    }

    if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      result += text.slice(index, index + 6);
      index += 6;
      continue;
    }

    result += String.fromCharCode(codePoint);
    index += 6;
  }

  return result;
}

function normalizeHumanVisibleFields(value: unknown, key: string | null = null): unknown {
  if (typeof value === "string") {
    if (key && HUMAN_VISIBLE_STRING_KEYS.has(key)) {
      return decodeUnicodeEscapeLiteral(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (key && HUMAN_VISIBLE_STRING_ARRAY_KEYS.has(key)) {
      return value.map((item) =>
        typeof item === "string"
          ? decodeUnicodeEscapeLiteral(item)
          : normalizeHumanVisibleFields(item)
      );
    }
    return value.map((item) => normalizeHumanVisibleFields(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    normalized[childKey] = normalizeHumanVisibleFields(childValue, childKey);
  }
  return normalized;
}

export function normalizeHumanVisibleToolArguments(
  toolName: string,
  argumentsJson: string
): string {
  if (!HUMAN_VISIBLE_TOOL_NAMES.has(toolName) || !argumentsJson.includes("\\\\u")) {
    return argumentsJson;
  }

  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    const normalized = normalizeHumanVisibleFields(parsed);
    return JSON.stringify(normalized);
  } catch (error) {
    if (error instanceof SyntaxError) return argumentsJson;
    throw error;
  }
}
