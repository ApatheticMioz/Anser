#!/usr/bin/env node
/**
 * Tenant Concurrency Test: Single-Tenant Multi-Slot Invariant.
 *
 * Verifies that:
 * 1. The same tenant (process.pid) can acquire up to 2 concurrent execution slots.
 * 2. An alien tenant (different PID / separate OS process) is blocked from acquiring
 *    ANY slot while the first tenant holds ANY active slot (preventing cross-chat thrashing).
 * 3. When the first tenant partially releases (holds 1 of 2 slots), the alien tenant remains blocked.
 * 4. When the first tenant fully releases (0 slots held), the alien tenant immediately acquires.
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import path from "path";

if (process.argv[2] !== "child") {
  process.env.QWEN_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "tenant_concurrency_state_")
  );
  // Explicitly test 2-concurrency-one-tenant
  process.env.QWEN_MAX_CONCURRENT = "2";
}

const { acquireTaskSlot, releaseTaskSlot, listTaskSlots, getSlotStatus } = await import("../index.js");
const { SLOTS_DIR } = await import("../src/config.js");

async function childMode() {
  const slot = await acquireTaskSlot({ id: "alien_child_task" });
  if (!slot) {
    console.error("CHILD: failed to acquire");
    process.exit(1);
  }
  console.log("CHILD_HELD");
  setTimeout(() => {
    releaseTaskSlot(slot);
    process.exit(0);
  }, 1000);
}

async function stillPendingAfter(promise, ms) {
  let done = false;
  promise.then(
    () => { done = true; },
    () => { done = true; }
  );
  await new Promise((r) => setTimeout(r, ms));
  return !done;
}

async function parentMode() {
  let failures = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
    if (!ok) failures++;
  };

  const HARD_DEADLINE_MS = 30_000;
  setTimeout(() => {
    console.log(`\nHARD WATCHDOG fired - forcing exit (failures=${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  }, HARD_DEADLINE_MS).unref();

  fs.rmSync(SLOTS_DIR, { recursive: true, force: true });

  // 1. In-process: same tenant acquires slot 1
  const slotA = await acquireTaskSlot({ id: "tenant_task_1" });
  check("tenant acquires slot 1", !!slotA);

  // 2. In-process: same tenant can acquire slot 2 concurrently (2-concurrency-one-tenant)
  const slotB = await acquireTaskSlot({ id: "tenant_task_2" });
  check("tenant acquires slot 2 concurrently", !!slotB);
  check("two active leases held by this tenant", listTaskSlots().length === 2);

  // 3. Verify getSlotStatus from tenant perspective
  const statusSelf = getSlotStatus(process.pid);
  check("getSlotStatus sees both slots as sameHolders", statusSelf.sameHolders.length === 2);
  check("getSlotStatus sees zero alienHolders", statusSelf.alienHolders.length === 0);
  check("getSlotStatus marks isAlienActive: false", statusSelf.isAlienActive === false);

  // 4. Cross-process: spawn alien child process while tenant holds slots
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});

  let childHeld = false;
  child.stdout.on("data", (d) => {
    if (String(d).includes("CHILD_HELD")) childHeld = true;
  });

  // Verify child does NOT acquire while parent holds both slots
  await new Promise((r) => setTimeout(r, 1500));
  check("alien child blocked while tenant holds both slots", !childHeld);

  // 5. Partial release: parent releases slot 2, but keeps slot 1
  releaseTaskSlot(slotB);
  check("parent released slot 2 (1 slot still held)", listTaskSlots().length === 1);

  // Verify child STILL does NOT acquire while parent holds slot 1
  await new Promise((r) => setTimeout(r, 1500));
  check("alien child STILL blocked while tenant holds slot 1 (single-tenant exclusivity)", !childHeld);

  // 6. Full release: parent releases slot 1
  releaseTaskSlot(slotA);
  check("parent released slot 1 (0 slots held)", listTaskSlots().length === 0);

  // Child should now immediately unblock and acquire
  const childAcquired = await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (childHeld) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - started > 8000) {
        clearInterval(poll);
        resolve(false);
      }
    }, 100);
  });
  check("alien child acquired slot after tenant released all slots", childAcquired);

  // 7. Wait for child to exit cleanly
  const childExited = await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (child.exitCode !== null || child.killed) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - started > 5000) {
        clearInterval(poll);
        child.kill();
        resolve(false);
      }
    }, 100);
  });
  check("alien child exited on its own", childExited);

  await new Promise((r) => setTimeout(r, 500));
  check("no leases remain after child exit", listTaskSlots().length === 0);

  console.log(failures === 0 ? "\nALL TENANT CONCURRENCY TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[2] === "child") {
  await childMode();
} else {
  await parentMode();
}
