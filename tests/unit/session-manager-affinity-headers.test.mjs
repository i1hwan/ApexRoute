import test from "node:test";
import assert from "node:assert/strict";

const { extractExternalSessionId } = await import("../../open-sse/services/sessionManager.ts");

function fakeHeaders(map) {
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
    },
  };
}

test("extractExternalSessionId recognises x-session-affinity with ext-xsa: namespace", () => {
  const got = extractExternalSessionId(fakeHeaders({ "x-session-affinity": "ses_abc123" }));
  assert.equal(got, "ext-xsa:ses_abc123");
});

test("extractExternalSessionId namespaces prevent cross-header collisions", () => {
  // Same raw value sent on two different headers MUST NOT collapse to the
  // same internal sessionId. Otherwise a client supplying one header could
  // pin to a session created by another client supplying the other header.
  const fromGeneric = extractExternalSessionId(fakeHeaders({ "x-session-id": "abc" }));
  const fromAffinity = extractExternalSessionId(fakeHeaders({ "x-session-affinity": "abc" }));
  const fromOmni = extractExternalSessionId(fakeHeaders({ "x-omniroute-session": "abc" }));
  assert.notEqual(fromGeneric, fromAffinity);
  assert.notEqual(fromGeneric, fromOmni);
  assert.notEqual(fromAffinity, fromOmni);
});

test("extractExternalSessionId namespace is collision-proof against legacy values that LOOK namespaced", () => {
  // A legacy generic header carrying a value like "xsa:foo" must NOT collide
  // with the new x-session-affinity: "foo" namespace. The hyphenated prefix
  // form (ext-xsa) prevents this because no legacy generic raw value can
  // begin with the hyphen-prefix marker.
  const legacyLooksNamespaced = extractExternalSessionId(
    fakeHeaders({ "x-session-id": "xsa:foo" })
  );
  const realAffinity = extractExternalSessionId(fakeHeaders({ "x-session-affinity": "foo" }));
  assert.notEqual(
    legacyLooksNamespaced,
    realAffinity,
    "x-session-id: 'xsa:foo' must NOT produce the same internal id as x-session-affinity: 'foo'"
  );

  // Same for omr
  const legacyLooksOmr = extractExternalSessionId(fakeHeaders({ "x-session-id": "omr:foo" }));
  const realOmr = extractExternalSessionId(fakeHeaders({ "x-omniroute-session": "foo" }));
  assert.notEqual(legacyLooksOmr, realOmr);
});

test("extractExternalSessionId prefers x-session-id over x-session-affinity when both present", () => {
  const got = extractExternalSessionId(
    fakeHeaders({
      "x-session-id": "from-x-session-id",
      "x-session-affinity": "from-affinity",
    })
  );
  assert.equal(got, "ext:from-x-session-id", "more explicit/generic header takes precedence");
});

test("extractExternalSessionId returns null when no recognised header present", () => {
  assert.equal(extractExternalSessionId(fakeHeaders({})), null);
  assert.equal(extractExternalSessionId(fakeHeaders({ "user-agent": "opencode/1.14.39" })), null);
});

test("extractExternalSessionId trims whitespace and slices to 64 chars", () => {
  assert.equal(
    extractExternalSessionId(fakeHeaders({ "x-session-affinity": "  ses_padded  " })),
    "ext-xsa:ses_padded"
  );

  const longRaw = "x".repeat(120);
  const got = extractExternalSessionId(fakeHeaders({ "x-session-affinity": longRaw }));
  assert.equal(got, `ext-xsa:${"x".repeat(64)}`);
});

test("extractExternalSessionId returns null for empty/whitespace-only header values", () => {
  assert.equal(extractExternalSessionId(fakeHeaders({ "x-session-affinity": "" })), null);
  assert.equal(extractExternalSessionId(fakeHeaders({ "x-session-affinity": "   " })), null);
});

test("extractExternalSessionId handles missing headers object gracefully", () => {
  assert.equal(extractExternalSessionId(null), null);
  assert.equal(extractExternalSessionId(undefined), null);
  assert.equal(extractExternalSessionId({}), null);
});

test("extractExternalSessionId fallback chain order: x-session-id > x_session_id > x-session-affinity > x-omniroute-session > session-id", () => {
  // Subset chain: ensure earlier sources mask later ones.
  const got1 = extractExternalSessionId(
    fakeHeaders({ x_session_id: "underscore", "x-session-affinity": "ignored" })
  );
  assert.equal(got1, "ext:underscore");

  const got2 = extractExternalSessionId(
    fakeHeaders({ "x-session-affinity": "affinity", "x-omniroute-session": "ignored" })
  );
  assert.equal(got2, "ext-xsa:affinity");

  const got3 = extractExternalSessionId(
    fakeHeaders({ "x-omniroute-session": "omr-val", "session-id": "ignored" })
  );
  assert.equal(got3, "ext-omr:omr-val");

  const got4 = extractExternalSessionId(fakeHeaders({ "session-id": "bare" }));
  assert.equal(got4, "ext:bare");
});
