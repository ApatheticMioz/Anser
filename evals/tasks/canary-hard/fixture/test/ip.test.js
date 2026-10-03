import { test } from "node:test";
import assert from "node:assert";
import { parseIpv4 } from "../src/ip.js";

test("valid address", () => {
  assert.deepStrictEqual(parseIpv4("192.168.1.1"), [192, 168, 1, 1]);
});

test("zero and 255 boundaries", () => {
  assert.deepStrictEqual(parseIpv4("0.0.0.0"), [0, 0, 0, 0]);
  assert.deepStrictEqual(parseIpv4("255.255.255.255"), [255, 255, 255, 255]);
});

test("too many parts", () => {
  assert.strictEqual(parseIpv4("1.2.3.4.5"), null);
});

test("too few parts", () => {
  assert.strictEqual(parseIpv4("1.2.3"), null);
});

test("non-digit part", () => {
  assert.strictEqual(parseIpv4("1.2.3.x"), null);
});

test("value over 255", () => {
  assert.strictEqual(parseIpv4("1.2.3.256"), null);
});

test("empty string", () => {
  assert.strictEqual(parseIpv4(""), null);
});

test("empty part", () => {
  assert.strictEqual(parseIpv4("1..3.4"), null);
});

// The hard edge case: leading zeros are NOT a valid decimal octet.
test("leading zero rejected", () => {
  assert.strictEqual(parseIpv4("1.2.3.04"), null);
});
