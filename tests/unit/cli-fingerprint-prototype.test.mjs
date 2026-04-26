import test from "node:test";
import assert from "node:assert/strict";

const { orderFields } = await import("../../open-sse/config/cliFingerprints.ts");

test("orderFields — prototype pollution defense", async (t) => {
  await t.test("__proto__ key in input does not pollute Object.prototype", () => {
    const malicious = JSON.parse(`{"__proto__":{"polluted":true},"model":"x","messages":[]}`);
    const ordered = orderFields(malicious, ["model", "messages"]);

    const probe = {};
    assert.equal(probe.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.getPrototypeOf(ordered), null);
  });

  await t.test("__proto__ key is preserved as own data property after reorder", () => {
    const malicious = JSON.parse(`{"model":"x","__proto__":{"hijack":true},"messages":[]}`);
    const ordered = orderFields(malicious, ["model", "messages"]);

    assert.equal(Object.hasOwn(ordered, "__proto__"), true);
    assert.equal(Object.hasOwn(ordered, "model"), true);
    assert.equal(Object.hasOwn(ordered, "messages"), true);
  });

  await t.test("ordered output preserves the requested key order", () => {
    const input = { c: 3, a: 1, b: 2 };
    const ordered = orderFields(input, ["a", "b", "c"]);
    assert.deepEqual(Object.keys(ordered), ["a", "b", "c"]);
  });

  await t.test("keys not in fieldOrder are appended after ordered keys", () => {
    const input = { extra: "z", a: 1, b: 2 };
    const ordered = orderFields(input, ["a", "b"]);
    assert.deepEqual(Object.keys(ordered), ["a", "b", "extra"]);
  });

  await t.test("returns input when fieldOrder is empty", () => {
    const input = { a: 1, b: 2 };
    assert.equal(orderFields(input, []), input);
  });
});
