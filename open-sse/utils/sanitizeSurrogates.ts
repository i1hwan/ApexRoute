/**
 * Strip lone UTF-16 surrogates from request payloads before strict-JSON
 * upstreams (e.g. Anthropic) reject them with:
 *   400: The request body is not valid JSON: no low surrogate in string
 *
 * JavaScript strings allow unpaired 0xD800-0xDFFF code units; many strict
 * RFC-8259 parsers do not. Replace lone surrogates with U+FFFD; preserve
 * valid pairs (emoji etc.) untouched.
 */

const SURROGATE_PRESENT_RE = /[\uD800-\uDFFF]/;

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const REPLACEMENT_CHAR = "\uFFFD";

// `toWellFormed()` ships in V8 11.5+ (Node 20+, ES2024). Engine-native and
// faster than the JS-side regex on large bodies. Typed intersection avoids
// `as any` while still feature-detecting safely.
type MaybeWellFormedString = string & { toWellFormed?: () => string };

/** Replace lone UTF-16 surrogates in `value` with U+FFFD; pass-through if none. */
export function sanitizeSurrogates(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  if (!SURROGATE_PRESENT_RE.test(value)) return value;

  const candidate = value as MaybeWellFormedString;
  if (typeof candidate.toWellFormed === "function") {
    return candidate.toWellFormed();
  }

  return value.replace(LONE_SURROGATE_RE, REPLACEMENT_CHAR);
}

/**
 * Deep-walk plain objects and arrays, sanitizing every string. Clean
 * subtrees are returned by reference; mutated branches are cloned. Non-plain
 * objects (Date, Map, class instances) are not descended into; cycles are
 * not protected against (request bodies are acyclic JSON).
 */
export function sanitizeSurrogatesDeep<T>(input: T): T {
  return sanitizeNode(input) as T;
}

function sanitizeNode(node: unknown): unknown {
  if (typeof node === "string") {
    return sanitizeSurrogates(node);
  }

  if (Array.isArray(node)) {
    let mutated = false;
    const next = new Array(node.length);
    for (let i = 0; i < node.length; i++) {
      const original = node[i];
      const sanitized = sanitizeNode(original);
      next[i] = sanitized;
      if (sanitized !== original) mutated = true;
    }
    return mutated ? next : node;
  }

  if (node !== null && typeof node === "object" && isPlainObject(node)) {
    const source = node as Record<string, unknown>;
    let mutated = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const original = source[key];
      const sanitized = sanitizeNode(original);
      next[key] = sanitized;
      if (sanitized !== original) mutated = true;
    }
    return mutated ? next : node;
  }

  return node;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
