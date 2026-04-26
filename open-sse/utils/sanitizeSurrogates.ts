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
  if (value.length === 0) return value;
  if (!SURROGATE_PRESENT_RE.test(value)) return value;

  const candidate = value as MaybeWellFormedString;
  if (typeof candidate.toWellFormed === "function") {
    return candidate.toWellFormed();
  }

  return value.replace(LONE_SURROGATE_RE, REPLACEMENT_CHAR);
}

/**
 * Deep-walk plain objects and arrays, sanitizing every string. Clean
 * subtrees are returned by reference; only the first branch that actually
 * mutates triggers a clone, so clean payloads incur zero extra allocation.
 *
 * Non-plain objects (Date, Map, class instances) are not descended into;
 * cycles are not protected against (request bodies are acyclic JSON).
 *
 * Cloning uses `Object.create(null)` so untrusted `__proto__` / `constructor`
 * keys become plain data properties instead of mutating the result's
 * prototype chain (prototype-pollution defense).
 */
export function sanitizeSurrogatesDeep<T>(input: T): T {
  return sanitizeNode(input) as T;
}

function sanitizeNode(node: unknown): unknown {
  if (typeof node === "string") {
    return sanitizeSurrogates(node);
  }

  if (Array.isArray(node)) {
    return sanitizeArray(node);
  }

  if (node !== null && typeof node === "object" && isPlainObject(node)) {
    return sanitizeObject(node as Record<string, unknown>);
  }

  return node;
}

function sanitizeArray(node: readonly unknown[]): unknown[] | readonly unknown[] {
  let next: unknown[] | undefined;
  for (let i = 0; i < node.length; i++) {
    const original = node[i];
    const sanitized = sanitizeNode(original);

    if (next !== undefined) {
      next[i] = sanitized;
      continue;
    }

    if (sanitized !== original) {
      next = new Array(node.length);
      for (let j = 0; j < i; j++) {
        next[j] = node[j];
      }
      next[i] = sanitized;
    }
  }
  return next ?? node;
}

function sanitizeObject(source: Record<string, unknown>): Record<string, unknown> {
  let next: Record<string, unknown> | undefined;
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const original = source[key];
    const sanitized = sanitizeNode(original);

    if (next !== undefined) {
      next[key] = sanitized;
      continue;
    }

    if (sanitized !== original) {
      // Null prototype prevents `__proto__` / `constructor` keys from
      // hijacking the clone's prototype chain.
      next = Object.create(null) as Record<string, unknown>;
      for (let j = 0; j < i; j++) {
        const earlier = keys[j];
        next[earlier] = source[earlier];
      }
      next[key] = sanitized;
    }
  }
  return next ?? source;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
