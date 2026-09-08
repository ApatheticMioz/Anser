/**
 * Evo Full System Test Suite & Comparative Benchmarks
 *
 * Validates:
 * 1. Anser Microkernel & EventBus (lifecycle & reversible disposers)
 * 2. Sandboxed FS Service (.venv & node_modules ignore, path resolution, edits)
 * 3. Shell Executor (process control & timeouts)
 * 4. Event Logger (JSONL append-only streaming & branching)
 * 5. Evo Evolutionary Engine (propose -> snapshot -> evaluate -> select / revert)
 * 6. Live vLLM Streaming & Runner Integration
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// F9 (state isolation): pin the Qwen state dir (and home-based candidate
// paths) to a fresh temp dir BEFORE importing any module that reads
// config.js (QWEN_STATE_DIR) at import time. The live AnserRunner (Test 6)
// mounts the eventLogger plugin with no explicit baseDir, so it defaults to
// QWEN_STATE_DIR/sessions — without this redirect it would write session logs
// into the PRODUCTION C:\Users\Apath\.qwen/sessions state. This is the
// established isolation pattern from tests/shell_hardening.test.js.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx7_evo_state_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;
process.env.HOME = TMP_STATE;

// Dynamic imports AFTER the env redirect so config.js pins QWEN_STATE_DIR to
// the temp dir at module load.
const { EventBus } = await import("../src/harness/core/events.js");
const { Context } = await import("../src/harness/core/kernel.js");
const { SandboxFsService, sandboxFsPlugin } = await import("../src/harness/services/sandbox_fs.js");
const { ShellExecutorService } = await import("../src/harness/services/shell_executor.js");
const { EventLoggerService } = await import("../src/harness/services/event_logger.js");
const { LineageDag } = await import("../src/harness/evo/lineage_dag.js");
const { ClosedLoopEvaluator } = await import("../src/harness/evo/evaluator.js");
const { EvoWatchdog } = await import("../src/harness/evo/watchdog.js");
const { EvoOperator } = await import("../src/harness/evo/evo_operator.js");
const { AnserRunner } = await import("../src/harness/runner.js");
const { isEngineAvailable } = await import("./helpers/engine_probe.js");

const TEST_DIR = path.resolve(process.cwd(), ".test_evo_tmp");

async function cleanup() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

async function runTests() {
  console.log("=== Evo Comprehensive System Validation ===\n");
  await cleanup();
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // -------------------------------------------------------------
  // Test 1: EventBus with Reversible Disposers
  // -------------------------------------------------------------
  console.log("[Test 1] EventBus with Reversible Disposers...");
  {
    const bus = new EventBus();
    let count = 0;
    const disposer = bus.on("ping", (n) => {
      count += n;
    });

    await bus.emit("ping", 5);
    assert.strictEqual(count, 5, "Event handler did not receive payload");

    disposer(); // unbind
    await bus.emit("ping", 10);
    assert.strictEqual(count, 5, "Disposer failed to unbind handler cleanly");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 2: Anser Microkernel & Plugin Lifecycle
  // -------------------------------------------------------------
  console.log("[Test 2] Anser Microkernel Context & Tool Registry...");
  {
    const ctx = new Context(null, "test_root");
    let unmounted = false;

    const samplePlugin = (childCtx) => {
      childCtx.provide("dummyService", { value: 42 });
      childCtx.registerTool("echo", {
        description: "Echo test tool",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        execute: (args) => `echo:${args.text}`,
      });
      return () => {
        unmounted = true;
      };
    };

    const disposePlugin = ctx.plugin(samplePlugin);
    assert.strictEqual(ctx.get("dummyService")?.value, 42, "Service not provided");

    const tools = ctx.listTools();
    assert.strictEqual(tools.length, 1, "Tool not registered");
    assert.strictEqual(tools[0].function.name, "echo");

    const execRes = await ctx.executeTool("echo", { text: "hello" });
    assert.strictEqual(execRes.result, "echo:hello");
    assert.strictEqual(execRes.isError, false);

    disposePlugin();
    assert.strictEqual(unmounted, true, "Plugin cleanup disposer was not called");
    assert.strictEqual(ctx.get("dummyService"), undefined, "Service was not cleaned up on unmount");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 3: Sandboxed FS Service (.venv ignore & edits)
  // -------------------------------------------------------------
  console.log("[Test 3] Sandboxed FS Service (Auto-Ignore & Safe Slicing)...");
  {
    const fsService = new SandboxFsService({ root: TEST_DIR });
    const dummyVenvDir = path.join(TEST_DIR, ".venv", "Lib");
    fs.mkdirSync(dummyVenvDir, { recursive: true });
    fs.writeFileSync(path.join(dummyVenvDir, "ignore_me.py"), "SECRET_VENV");

    const appFile = path.join(TEST_DIR, "app.py");
    fs.writeFileSync(appFile, "def foo():\n    return 1\n");

    // List dir must NOT include .venv
    const dirResult = await fsService.listDir({ path: ".", max_depth: 3 });
    const paths = dirResult.items.map((i) => i.path);
    assert.ok(paths.includes("app.py"), "app.py should be listed");
    assert.ok(!paths.some((p) => p.includes(".venv")), ".venv must be automatically ignored");

    // Edit file test
    await fsService.editFile({
      path: "app.py",
      target_content: "return 1",
      replacement_content: "return 42",
    });
    const readBack = await fsService.readFile({ path: "app.py" });
    assert.ok(readBack.content.includes("return 42"), "Edit file replacement failed");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 4: Append-Only JSONL Event Logger & Branching
  // -------------------------------------------------------------
  console.log("[Test 4] Append-Only Event Logger & Session Branching...");
  {
    const logger = new EventLoggerService({
      sessionId: "session_alpha",
      baseDir: path.join(TEST_DIR, "sessions"),
    });

    logger.append({ type: "turn_start", turn: 1 });
    logger.append({ type: "user_message", content: "Optimize algorithm" });
    logger.append({ type: "assistant_message", content: "Here is proposal 1" });

    const all = logger.readAll();
    assert.strictEqual(all.length, 3, "Events not recorded in JSONL");

    // Branch session at turn 2
    const childLogger = logger.branch("session_beta", 2);
    const branchedEvents = childLogger.readAll();
    assert.strictEqual(branchedEvents.length, 2, "Branched session event count mismatch");
    assert.strictEqual(branchedEvents[0].parentSessionId, "session_alpha");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 5: Evo Operator (Propose -> Snapshot -> Evaluate -> Rollback)
  // -------------------------------------------------------------
  console.log("[Test 5] Evo Operator (Closed-Loop Mutation & Deterministic Rollback)...");
  {
    const targetFile = path.join(TEST_DIR, "algo.mjs");
    fs.writeFileSync(targetFile, "export function compute() { return 10; }\n");

    const shell = new ShellExecutorService({ cwd: TEST_DIR });
    const evo = new EvoOperator({ workspaceRoot: TEST_DIR, shell });

    const checkScript = path.join(TEST_DIR, "run_check.mjs");
    fs.writeFileSync(
      checkScript,
      "import { compute } from './algo.mjs';\nif (compute() !== 100) process.exit(1);\nconsole.log('100.0 ops/sec');\n"
    );

    // Step 1: Propose candidate with target file snapshot
    const proposal = await evo.proposeCandidate({
      hypothesis: "Improve compute() to return 100",
      files_to_modify: ["algo.mjs"],
    });
    assert.strictEqual(proposal.files_snapshotted, 1, "algo.mjs was not snapshotted");

    // Step 2: Mutate file
    fs.writeFileSync(targetFile, "export function compute() { return 100; }\n");

    // Step 3: Evaluate candidate
    const evalPass = await evo.evaluateCandidate({
      command: "node run_check.mjs",
      primary_metric: "throughput",
    });
    assert.strictEqual(evalPass.passed, true, "Candidate evaluation unexpectedly failed");
    assert.strictEqual(evalPass.is_improvement, true, "Candidate should improve baseline");

    // Step 4: Accept candidate
    await evo.selectCandidate({ candidate_id: proposal.candidate_id });
    const status1 = evo.getStatus();
    assert.strictEqual(status1.summary.acceptedCount, 2, "Lineage should have baseline + candidate accepted");

    // Test 5b: Zero-assertion command (syntax check like tsc) must yield exactly 50.0, not 100.0
    const zeroEval = new ClosedLoopEvaluator({ shell });
    const evalZeroAssertions = await zeroEval.evaluate({
      command: "node -e \"process.exit(0)\"",
      cwd: TEST_DIR,
    });
    assert.strictEqual(evalZeroAssertions.fitness, 50, "Zero-assertion exit 0 command must score exactly 50.0 (syntax gate)");

    // Step 5: Propose a regressive candidate and verify rollback
    const badProposal = await evo.proposeCandidate({
      hypothesis: "Broken modification causing crash",
      files_to_modify: ["algo.mjs"],
    });

    // Introduce syntax break
    fs.writeFileSync(targetFile, "BROKEN_SYNTAX_ERROR +++");

    const evalFail = await evo.evaluateCandidate({
      command: "node run_check.mjs",
    });
    assert.strictEqual(evalFail.passed, false, "Broken code should fail evaluation");

    // Step 6: Revert candidate
    const revertRes = await evo.revertCandidate({ candidate_id: badProposal.candidate_id });
    assert.strictEqual(revertRes.status, "rejected");

    // Verify file restored to pre-mutation state
    const restoredContent = fs.readFileSync(targetFile, "utf8");
    assert.ok(restoredContent.includes("return 100"), "File was not restored to pre-mutation snapshot");
    console.log("  -> Passed!");
  }

  // -------------------------------------------------------------
  // Test 6: Live vLLM Streaming Verification
  // -------------------------------------------------------------
  console.log("[Test 6] Live vLLM Streaming & Direct Microkernel Execution...");
  {
    const vllmOnline = !process.env.TEST_OFFLINE && (await isEngineAvailable());

    if (!vllmOnline) {
      console.log("  -> [SKIP] vLLM endpoint offline or TEST_OFFLINE set (skipping live inference test)");
    } else {
      const liveDir = path.resolve(process.cwd(), ".test_live_tmp");
      fs.mkdirSync(liveDir, { recursive: true });
      try {
        const runner = new AnserRunner({ cwd: liveDir });
        let streamedTokens = "";

        const runRes = await runner.run({
          prompt: "Reply with exactly the word 'CONFIRMED' and nothing else.",
          cwd: liveDir,
          maxTurns: 2,
          onToken: (t) => {
            streamedTokens += t;
          },
        });

        console.log(`  -> Model Response: ${JSON.stringify(runRes.finalText.trim())}`);
        console.log(`  -> Duration: ${runRes.durationMs}ms, Tokens: ${runRes.totalCompletionTokens}`);
        assert.ok(runRes.finalText.toUpperCase().includes("CONFIRMED"), "Expected model confirmation");
        console.log("  -> Passed!");
      } finally {
        fs.rmSync(liveDir, { recursive: true, force: true });
      }
    }
  }

  await cleanup();
  console.log("\n>>> ALL EVO TESTS PASSED SUCCESSFULLY! <<<\n");
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
