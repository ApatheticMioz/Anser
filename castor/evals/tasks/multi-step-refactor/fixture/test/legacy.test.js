import { test } from "node:test";
import assert from "node:assert";
import { process } from "../src/legacy.js";

test("empty input", () => {
  assert.strictEqual(process(""), "EMPTY");
  assert.strictEqual(process("   "), "EMPTY");
});

test("valid adult", () => {
  assert.strictEqual(process("Alice|30"), "Alice:adult");
});

test("valid minor", () => {
  assert.strictEqual(process("Bob|10"), "Bob:minor");
});

test("valid senior", () => {
  assert.strictEqual(process("Carol|70"), "Carol:senior");
});

test("boundary 18 is adult", () => {
  assert.strictEqual(process("Alice|18"), "Alice:adult");
});

test("boundary 65 is senior", () => {
  assert.strictEqual(process("Alice|65"), "Alice:senior");
});

test("long name truncated", () => {
  assert.strictEqual(process("VeryLongName|30"), "VeryLongNa..:adult");
});

test("missing name", () => {
  assert.strictEqual(process("|30"), "INVALID:missing-name");
});

test("bad age", () => {
  assert.strictEqual(process("Alice|abc"), "INVALID:bad-age");
});

test("negative age", () => {
  assert.strictEqual(process("Alice|-5"), "INVALID:negative-age");
});

test("age too large", () => {
  assert.strictEqual(process("Alice|200"), "INVALID:age-too-large");
});
