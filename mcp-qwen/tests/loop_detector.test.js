import test from "node:test";
import assert from "node:assert/strict";
import { LoopDetector } from "../src/harness/loop_detector.js";

test("LoopDetector: computes deterministic action hash regardless of key order", () => {
  const detector = new LoopDetector();
  const hash1 = detector.computeActionHash("read_file", { path: "foo.txt", encoding: "utf8" }, { isError: false, result: "hello" });
  const hash2 = detector.computeActionHash("read_file", { encoding: "utf8", path: "foo.txt" }, { isError: false, result: "hello" });
  assert.equal(hash1, hash2, "Key order must not affect action hash");
});

test("LoopDetector: distinct tools or args produce distinct action hashes", () => {
  const detector = new LoopDetector();
  const hash1 = detector.computeActionHash("read_file", { path: "foo.txt" }, { isError: false, result: "hello" });
  const hash2 = detector.computeActionHash("read_file", { path: "bar.txt" }, { isError: false, result: "hello" });
  const hash3 = detector.computeActionHash("list_dir", { path: "foo.txt" }, { isError: false, result: "hello" });
  assert.notEqual(hash1, hash2, "Different paths must produce different hashes");
  assert.notEqual(hash1, hash3, "Different tools must produce different hashes");
});

test("LoopDetector: detects action loop after threshold non-mutating repetitions", () => {
  const detector = new LoopDetector({ windowSize: 6, threshold: 3 });

  // Call 1
  const r1 = detector.recordAction("list_dir", { path: "." }, { isError: false, result: ["a.js", "b.js"] });
  assert.equal(r1.isLoop, false);
  assert.equal(r1.repeats, 1);

  // Call 2
  const r2 = detector.recordAction("list_dir", { path: "." }, { isError: false, result: ["a.js", "b.js"] });
  assert.equal(r2.isLoop, false);
  assert.equal(r2.repeats, 2);

  // Call 3 (threshold reached)
  const r3 = detector.recordAction("list_dir", { path: "." }, { isError: false, result: ["a.js", "b.js"] });
  assert.equal(r3.isLoop, true);
  assert.equal(r3.repeats, 3);
});

test("LoopDetector: state mutation resets non-mutating repetition streak", () => {
  const detector = new LoopDetector({ windowSize: 6, threshold: 3 });

  // Call 1 & 2 identical
  detector.recordAction("search_code", { query: "foo" }, { isError: false, result: "match 1" });
  const r2 = detector.recordAction("search_code", { query: "foo" }, { isError: false, result: "match 1" });
  assert.equal(r2.repeats, 2);

  // State mutation occurs (e.g. edit_file / apply_patch)
  detector.recordMutation();

  // Call 3 after mutation should reset repeats to 1
  const r3 = detector.recordAction("search_code", { query: "foo" }, { isError: false, result: "match 1" });
  assert.equal(r3.isLoop, false);
  assert.equal(r3.repeats, 1);
});

test("LoopDetector: sliding window evicts oldest action entries beyond windowSize", () => {
  const detector = new LoopDetector({ windowSize: 3, threshold: 2 });
  detector.recordAction("read_file", { path: "1.js" }, { isError: false });
  detector.recordAction("read_file", { path: "2.js" }, { isError: false });
  detector.recordAction("read_file", { path: "3.js" }, { isError: false });
  assert.equal(detector.history.length, 3);

  detector.recordAction("read_file", { path: "4.js" }, { isError: false });
  assert.equal(detector.history.length, 3);
  assert.equal(detector.history[0].toolName, "read_file");
});
