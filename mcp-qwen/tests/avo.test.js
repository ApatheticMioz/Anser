/**
 * DeepSeek AVO Full System Test Suite & Comparative Benchmarks
 *
 * Validates:
 * 1. Cordis Microkernel & EventBus (lifecycle & reversible disposers)
 * 2. Sandboxed FS Service (.venv & node_modules ignore, path resolution, edits)
 * 3. Shell Executor (process control & timeouts)
 * 4. Event Logger (JSONL append-only streaming & branching)
 * 5. NVIDIA AVO Evolutionary Engine (propose -> snapshot -> evaluate -> select / revert)
 * 6. Live vLLM Streaming & Runner Integration
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { EventBus } from "../src/harness/core/events.js";
import { Context } from "../src/harness/core/kernel.js";
import { SandboxFsService, sandboxFsPlugin } from "../src/harness/services/sandbox_fs.js";
import { ShellExecutorService } from "../src/harness/services/shell_executor.js";
import { EventLoggerService } from "../src/harness/services/event_logger.js";
import { LineageDag } from "../src/harness/avo/lineage_dag.js";
import { ClosedLoopEvaluator } from "../src/harness/avo/evaluator.js";
import { AvoWatchdog } from "../src/harness/avo/watchdog.js";
import { AvoOperator } from "../src/harness/avo/avo_operator.js";
import { DeepSeekAvoRunner } from "../src/harness/runner.js";
import { isEngineAvailable } from "./helpers/engine_probe.js";

const TEST_DIR = path.resolve(process.cwd(), ".test_avo_tmp");

async function cleanup() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

async function runTests() {
  console.log("=== DeepSeek AVO Comprehensive System Validation ===\n");
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
  // Test 2: Cordis Microkernel & Plugin Lifecycle
  // -------------------------------------------------------------
  console.log("[Test 2] Cordis Microkernel Context & Tool Registry...");
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
  // Test 5: NVIDIA AVO Operator (Propose -> Snapshot -> Evaluate -> Rollback)
  // -------------------------------------------------------------
  console.log("[Test 5] NVIDIA AVO Operator (Closed-Loop Mutation & Deterministic Rollback)...");
  {
    const targetFile = path.join(TEST_DIR, "algo.mjs");
    fs.writeFileSync(targetFile, "export function compute() { return 10; }\n");

    const shell = new ShellExecutorService({ cwd: TEST_DIR });
    const avo = new AvoOperator({ workspaceRoot: TEST_DIR, shell });

    const checkScript = path.join(TEST_DIR, "run_check.mjs");
    fs.writeFileSync(
      checkScript,
      "import { compute } from './algo.mjs';\nif (compute() !== 100) process.exit(1);\nconsole.log('100.0 ops/sec');\n"
    );

    // Step 1: Propose candidate with target file snapshot
    const proposal = await avo.proposeCandidate({
      hypothesis: "Improve compute() to return 100",
      files_to_modify: ["algo.mjs"],
    });
    assert.strictEqual(proposal.files_snapshotted, 1, "algo.mjs was not snapshotted");

    // Step 2: Mutate file
    fs.writeFileSync(targetFile, "export function compute() { return 100; }\n");

    // Step 3: Evaluate candidate
    const evalPass = await avo.evaluateCandidate({
      command: "node run_check.mjs",
      primary_metric: "throughput",
    });
    assert.strictEqual(evalPass.passed, true, "Candidate evaluation unexpectedly failed");
    assert.strictEqual(evalPass.is_improvement, true, "Candidate should improve baseline");

    // Step 4: Accept candidate
    await avo.selectCandidate({ candidate_id: proposal.candidate_id });
    const status1 = avo.getStatus();
    assert.strictEqual(status1.summary.acceptedCount, 2, "Lineage should have baseline + candidate accepted");

    // Step 5: Propose a regressive candidate and verify rollback
    const badProposal = await avo.proposeCandidate({
      hypothesis: "Broken modification causing crash",
      files_to_modify: ["algo.mjs"],
    });

    // Introduce syntax break
    fs.writeFileSync(targetFile, "BROKEN_SYNTAX_ERROR +++");

    const evalFail = await avo.evaluateCandidate({
      command: "node run_check.mjs",
    });
    assert.strictEqual(evalFail.passed, false, "Broken code should fail evaluation");

    // Step 6: Revert candidate
    const revertRes = await avo.revertCandidate({ candidate_id: badProposal.candidate_id });
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
    // Check if vLLM endpoint is reachable (shared P11 availability probe)
    const vllmOnline = await isEngineAvailable();

    if (!vllmOnline) {
      console.log("  -> [SKIP] vLLM endpoint offline at :18020 (skipping live inference test)");
    } else {
      const runner = new DeepSeekAvoRunner({ cwd: TEST_DIR });
      let streamedTokens = "";

      const runRes = await runner.run({
        prompt: "Reply with exactly the word 'CONFIRMED' and nothing else.",
        cwd: TEST_DIR,
        maxTurns: 2,
        onToken: (t) => {
          streamedTokens += t;
        },
      });

      console.log(`  -> Model Response: ${JSON.stringify(runRes.finalText.trim())}`);
      console.log(`  -> Duration: ${runRes.durationMs}ms, Tokens: ${runRes.totalCompletionTokens}`);
      assert.ok(runRes.finalText.toUpperCase().includes("CONFIRMED"), "Expected model confirmation");
      console.log("  -> Passed!");
    }
  }

  await cleanup();
  console.log("\n>>> ALL DEEPSEEK AVO TESTS PASSED SUCCESSFULLY! <<<\n");
}

runTests().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
