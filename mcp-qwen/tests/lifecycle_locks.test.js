import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  tryAcquireExclusiveLock,
  releaseExclusiveLock,
  bumpWedgeCounter,
  readWedgeCounter,
} from "../src/server_lifecycle.js";
import { WEDGE_COUNTER_FILE } from "../src/config.js";

console.log("=== Lifecycle Locks & Concurrency Hardening (Offline) ===");

const testDir = path.join(os.tmpdir(), `test_lifecycle_${Date.now()}_${process.pid}`);
fs.mkdirSync(testDir, { recursive: true });

try {
  // Test 1: Exclusive lock acquisition
  console.log("\n[Test 1: tryAcquireExclusiveLock fresh acquire]");
  const lock1Path = path.join(testDir, "test1.lock");
  const res1 = tryAcquireExclusiveLock(lock1Path, 60_000, { owner: "proc1" });
  assert.strictEqual(res1.acquired, true, "Should acquire fresh lock");
  assert.ok(fs.existsSync(lock1Path), "Lockfile should exist on disk");
  const content1 = JSON.parse(fs.readFileSync(lock1Path, "utf8"));
  assert.strictEqual(content1.owner, "proc1");
  assert.strictEqual(content1.pid, process.pid);
  console.log("  [PASS] Fresh lock acquired successfully");

  // Test 2: Active lock rejection within TTL
  console.log("\n[Test 2: tryAcquireExclusiveLock rejection within TTL]");
  const res2 = tryAcquireExclusiveLock(lock1Path, 60_000, { owner: "proc2" });
  assert.strictEqual(res2.acquired, false, "Should reject acquisition when locked");
  assert.strictEqual(res2.heldBy?.owner, "proc1");
  console.log("  [PASS] Active lock within TTL rejected with heldBy payload");

  // Test 3: Stale lock recovery via Rename-to-Tombstone
  console.log("\n[Test 3: Stale lock recovery via Rename-to-Tombstone]");
  const stalePayload = { owner: "dead_proc", at: Date.now() - 100_000, pid: 999999 };
  fs.writeFileSync(lock1Path, JSON.stringify(stalePayload));
  const res3 = tryAcquireExclusiveLock(lock1Path, 30_000, { owner: "proc3" });
  assert.strictEqual(res3.acquired, true, "Should reclaim stale lock whose age exceeds TTL");
  const content3 = JSON.parse(fs.readFileSync(lock1Path, "utf8"));
  assert.strictEqual(content3.owner, "proc3");
  assert.strictEqual(content3.pid, process.pid);
  console.log("  [PASS] Stale lock reclaimed atomically");

  // Test 4: PID ownership safety in releaseExclusiveLock
  console.log("\n[Test 4: releaseExclusiveLock PID ownership check]");
  const lock2Path = path.join(testDir, "test2.lock");
  // Write lock owned by another PID
  fs.writeFileSync(lock2Path, JSON.stringify({ owner: "foreign", at: Date.now(), pid: 987654 }));
  releaseExclusiveLock(lock2Path);
  assert.ok(fs.existsSync(lock2Path), "Lock owned by foreign PID must NOT be released");
  console.log("  [PASS] Foreign PID lock preserved");

  // Release lock owned by current PID
  fs.writeFileSync(lock2Path, JSON.stringify({ owner: "self", at: Date.now(), pid: process.pid }));
  releaseExclusiveLock(lock2Path);
  assert.ok(!fs.existsSync(lock2Path), "Lock owned by current PID must be deleted");
  console.log("  [PASS] Own PID lock successfully released");

  // Test 5: Atomic wedge counter write
  console.log("\n[Test 5: bumpWedgeCounter atomic file write]");
  const curBefore = readWedgeCounter();
  bumpWedgeCounter("test_concurrency_reason");
  const curAfter = readWedgeCounter();
  assert.strictEqual(curAfter.count, (curBefore.count ?? 0) + 1, "Wedge counter must increment by 1");
  assert.ok(curAfter.lastReason.includes("test_concurrency_reason"), "Reason recorded");
  assert.ok(!fs.existsSync(`${WEDGE_COUNTER_FILE}.tmp`), "Temporary atomic file must be renamed");
  console.log("  [PASS] Wedge counter incremented atomically");

} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}

console.log("\n=======================================================");
console.log("ALL LIFECYCLE LOCK TESTS PASSED SUCCESSFULLY!");
console.log("=======================================================\n");
