#!/usr/bin/env node
/**
 * Cross-process goose-semaphore test (lease files only - no vLLM, no goose).
 *
 * Mode "child": acquire a slot, print HELD, hold ~4s, release, exit.
 * Default (parent): wipes stale leases, verifies in-process exclusion and
 * hand-off, then verifies a *separate OS process* is excluded while it holds.
 *
 * Isolated (telemetry Issue 3): QWEN_STATE_DIR is pinned to a fresh temp dir
 * below, so the production lease dir is never wiped or asserted against —
 * running this suite while a real task holds a lease is safe.
 *
 * Run: node test_global_semaphore.js
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import path from "path";

// config.js computes QWEN_STATE_DIR (and SLOTS_DIR under it) at import time
// from this env var. Pin it BEFORE importing index.js/config.js so the whole
// suite operates on a private lease dir. Without this, the rmSync wipe below
// would delete a live task's slot_0.json from ~/.qwen/tasks/goose_slots
// whenever `npm test` runs while a Qwen task is in flight (Gemini telemetry
// Issue 3). Only the PARENT mints the dir: this module's top level also runs
// in the spawned child, which must instead REUSE the inherited pin — a second
// mint there would give parent and child different lease dirs and silently
// defeat the cross-process exclusion assertion below.
if (process.argv[2] !== "child") {
  process.env.QWEN_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "semaphore_test_state_")
  );
}

const { acquireGooseSlot, releaseGooseSlot, listGooseSlots } = await import("../index.js");
const { SLOTS_DIR } = await import("../src/config.js");

const SLOT_DIR = SLOTS_DIR;

async function childMode() {
  const slot = await acquireGooseSlot({ id: "child_sem_test" });
  if (!slot) {
    console.error("CHILD: failed to acquire");
    process.exit(1);
  }
  console.log("HELD");
  setTimeout(() => {
    releaseGooseSlot(slot);
    process.exit(0);
  }, 4000);
}

async function stillPendingAfter(promise, ms) {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
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

  // Hard watchdog: this process embeds the full MCP server (importing index.js
  // runs it), whose stdio transport can wedge teardown on Windows. The verdict
  // is the checks below; this guarantees the test always terminates with it.
  const HARD_DEADLINE_MS = 45_000;
  setTimeout(() => {
    console.log(`\nHARD WATCHDOG fired - forcing exit (failures=${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  }, HARD_DEADLINE_MS).unref();

  // Wipe leftover leases from prior runs. Safe unconditionally: SLOT_DIR is
  // the private temp dir pinned above, never the production lease dir.
  fs.rmSync(SLOT_DIR, { recursive: true, force: true });

  // 1. First acquire is immediate, and exactly one lease is visible.
  const t0 = Date.now();
  const a = await acquireGooseSlot({ id: "sem_test_A" });
  check("first acquire resolves", !!a, `${Date.now() - t0}ms`);
  check("one active lease listed", listGooseSlots().length === 1);

  // 2. A second in-process acquire blocks until the first is released.
  const bPromise = acquireGooseSlot({ id: "sem_test_B" });
  const pending = await stillPendingAfter(bPromise, 1500);
  check("second acquire blocks while first held", pending);
  releaseGooseSlot(a);
  const b = await Promise.race([
    bPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("no handoff after release")), 4000)),
  ]);
  check("second acquire resolves after release", !!b);
  releaseGooseSlot(b);

  // 3. Cross-process exclusion: a separate OS process holds for ~4s; this
  //    process must wait for the lease regardless of its own in-process state.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // index.js may log the 18021 conflict; ignore
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("child never held")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("HELD")) {
        clearTimeout(to);
        res();
      }
    });
  });
  const t1 = Date.now();
  const c = await acquireGooseSlot({ id: "sem_test_C" });
  const waited = Date.now() - t1;
  check("cross-process acquire blocked until child released", waited > 1200, `waited ${waited}ms`);
  releaseGooseSlot(c);

  // Poll exitCode instead of awaiting the 'exit' event: with piped stdio on
  // Windows the event delivery has proven unreliable here, while the exitCode
  // property is set synchronously once the handle reaps the child.
  const childExited = await new Promise((res) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (child.exitCode !== null || child.killed) {
        clearInterval(poll);
        res(true);
      } else if (Date.now() - started > 10_000) {
        clearInterval(poll);
        child.kill();
        res(false);
      }
    }, 100);
  });
  check("child process exited on its own", childExited);
  await new Promise((r) => setTimeout(r, 1200)); // let poll cycles settle
  check("no leases remain after releases", listGooseSlots().length === 0);

  console.log(failures === 0 ? "\nALL SEMAPHORE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv[2] === "child") {
  await childMode();
} else {
  await parentMode();
}
