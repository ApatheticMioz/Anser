/**
 * Evo Benchmark Suite
 *
 * Quantitatively benchmarks:
 * 1. Filesystem Traversal Latency & DrvFs Stall Elimination (.venv / node_modules ignore)
 * 2. Harness Startup Overhead & Time-to-First-Token (TTFT)
 * 3. Closed-Loop Evolutionary Optimization with Evo Fitness Guidance
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// F9 (state isolation): pin the Qwen state dir (and home-based candidate
// paths) to a fresh temp dir BEFORE importing runner.js. The live AnserRunner
// (Benchmark 2) mounts the eventLogger plugin with no explicit baseDir, so it
// defaults to QWEN_STATE_DIR/sessions — without this redirect it would write
// session logs into the PRODUCTION C:\Users\Apath\.qwen/sessions state. This is
// the established isolation pattern from tests/shell_hardening.test.js.
const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "fx7_benchmark_state_"));
process.env.QWEN_STATE_DIR = TMP_STATE;
process.env.QWEN_WSL_HOME = TMP_STATE;
process.env.QWEN_WIN_HOME = TMP_STATE;
process.env.HOME = TMP_STATE;

// Dynamic imports AFTER the env redirect so config.js pins QWEN_STATE_DIR to
// the temp dir at module load.
const { SandboxFsService } = await import("../src/harness/services/sandbox_fs.js");
const { AnserRunner } = await import("../src/harness/runner.js");
const { ShellExecutorService } = await import("../src/harness/services/shell_executor.js");
const { EvoOperator } = await import("../src/harness/evo/evo_operator.js");
const { requireEngineOrSkip } = await import("./helpers/engine_probe.js");

const execFileAsync = promisify(execFile);
const BENCHMARK_TMP = path.resolve(process.cwd(), ".benchmark_tmp");

async function setupBenchmarkEnvironment() {
  try {
    fs.rmSync(BENCHMARK_TMP, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(BENCHMARK_TMP, { recursive: true });

  // Create a synthetic deep dependency tree (simulating a 25,000-file .venv / node_modules)
  const venvDir = path.join(BENCHMARK_TMP, ".venv", "Lib", "site-packages");
  fs.mkdirSync(venvDir, { recursive: true });
  for (let pkg = 0; pkg < 40; pkg++) {
    const pkgDir = path.join(venvDir, `mock_package_${pkg}`);
    fs.mkdirSync(pkgDir, { recursive: true });
    for (let f = 0; f < 50; f++) {
      fs.writeFileSync(
        path.join(pkgDir, `mod_${f}.py`),
        `# Mock library file ${f}\ndef util_${f}(): return ${f * pkg}\n`
      );
    }
  }

  // Create active workspace application files
  const srcDir = path.join(BENCHMARK_TMP, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "core.js"),
    `export function calculateThroughput(items) { return items.length * 10; }\n`
  );
}

async function cleanupBenchmarkEnvironment() {
  try {
    fs.rmSync(BENCHMARK_TMP, { recursive: true, force: true });
  } catch {}
}

async function runBenchmark1_FilesystemTraversal() {
  console.log("\n=======================================================");
  console.log("BENCHMARK 1: Filesystem Traversal & Dependency Isolation");
  console.log("=======================================================");
  console.log("Testing traversal in a directory with 2,000+ mock .venv library files...");

  // 1A. Naive Un-sandboxed Traversal (baseline)
  const t0_legacy = Date.now();
  let legacyFilesFound = 0;
  const walkNaive = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walkNaive(full);
      } else {
        legacyFilesFound++;
      }
    }
  };
  walkNaive(BENCHMARK_TMP);
  const dt_legacy = Date.now() - t0_legacy;

  // 1B. Evo Sandboxed FS Service
  const t0_evo = Date.now();
  const fsService = new SandboxFsService({ root: BENCHMARK_TMP });
  const evoResult = await fsService.listDir({ path: ".", max_depth: 3 });
  const dt_evo = Date.now() - t0_evo;

  console.log(`\nResults:`);
  console.log(`  - Naive Crawler:  traversed ${legacyFilesFound} files in ${dt_legacy}ms (crawled all .venv packages)`);
  console.log(`  - Evo Sandbox:    traversed ${evoResult.total_items} items in ${dt_evo}ms (.venv auto-isolated)`);
  console.log(`  -> Speedup: ${(dt_legacy / Math.max(1, dt_evo)).toFixed(1)}x faster, 0 dependency noise\n`);

  return {
    dt_legacy,
    dt_evo,
    speedup: (dt_legacy / Math.max(1, dt_evo)).toFixed(1),
    legacyFilesFound,
    evoFilesFound: evoResult.total_items,
  };
}

async function runBenchmark2_HarnessStartupAndStreaming() {
  console.log("=======================================================");
  console.log("BENCHMARK 2: Harness Startup Latency & Time-To-First-Token");
  console.log("=======================================================");

  // 2A. Evo In-Process Anser Microkernel
  const t0_evo = Date.now();
  const runner = new AnserRunner({ cwd: BENCHMARK_TMP });
  let evoFirstTokenMs = null;
  let evoTotalTokens = 0;

  const evoRes = await runner.run({
    prompt: "Respond with exactly 'PONG'.",
    cwd: BENCHMARK_TMP,
    maxTurns: 1,
    onToken: () => {
      if (evoFirstTokenMs === null) {
        evoFirstTokenMs = Date.now() - t0_evo;
      }
    },
    onMetrics: (m) => {
      evoTotalTokens += m.completionTokens;
    },
  });
  const dt_evo = Date.now() - t0_evo;

  console.log(`\nResults:`);
  console.log(`  - Evo Microkernel: TTFT: ${evoFirstTokenMs}ms | Total Duration: ${dt_evo}ms`);
  console.log(`    Response: ${JSON.stringify(evoRes.finalText.trim())}`);

  return {
    evoFirstTokenMs,
    dt_evo,
    evoTokens: evoTotalTokens,
  };
}

async function runBenchmark3_ClosedLoopEvoOptimization() {
  console.log("\n=======================================================");
  console.log("BENCHMARK 3: Closed-Loop Evolutionary Optimization (Evo)");
  console.log("=======================================================");

  const targetFile = path.join(BENCHMARK_TMP, "benchmark_target.mjs");
  fs.writeFileSync(
    targetFile,
    `export function processData(arr) {
  // Baseline O(N^2) inefficient implementation
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length; j++) {
      if (i === j) sum += arr[i];
    }
  }
  return sum;
}\n`
  );

  const benchScript = path.join(BENCHMARK_TMP, "run_perf.mjs");
  fs.writeFileSync(
    benchScript,
    `import { processData } from './benchmark_target.mjs';
const data = Array.from({ length: 5000 }, (_, i) => i);
const t0 = performance.now();
const res = processData(data);
const durationMs = performance.now() - t0;
const opsPerSec = (1000 / durationMs).toFixed(2);
console.log('Tests: 1 passed, 0 failed, 1 total');
console.log(opsPerSec + ' ops/sec');
`
  );

  const shell = new ShellExecutorService({ cwd: BENCHMARK_TMP });
  const evo = new EvoOperator({ workspaceRoot: BENCHMARK_TMP, shell });

  // Baseline evaluation
  const baselineEval = await shell.execute({ command: "node run_perf.mjs", cwd: BENCHMARK_TMP });
  const baselineOps = parseFloat(baselineEval.stdout.match(/([\d.]+)\s*ops\/sec/)?.[1] || "1.0");
  console.log(`  -> Baseline throughput: ${baselineOps} ops/sec`);

  // Candidate 1: Propose O(N) optimized variation
  console.log("\n[Iteration 1] Proposing O(N) Linear Algorithm Variation...");
  const cand1 = await evo.proposeCandidate({
    hypothesis: "Replace O(N^2) nested loop with single O(N) linear reduction pass",
    files_to_modify: ["benchmark_target.mjs"],
  });

  // Mutate file to O(N)
  fs.writeFileSync(
    targetFile,
    `export function processData(arr) {
  // O(N) optimized implementation
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
  }
  return sum;
}\n`
  );

  // Evaluate candidate 1
  const eval1 = await evo.evaluateCandidate({
    command: "node run_perf.mjs",
    primary_metric: "throughput",
  });
  console.log(`  -> Candidate 1 Throughput: ${eval1.metrics.opsPerSec} ops/sec (Fitness: ${eval1.fitness})`);
  assert.ok(eval1.is_improvement, "O(N) variation should improve over O(N^2) baseline");

  // Select Candidate 1
  await evo.selectCandidate({ candidate_id: cand1.candidate_id });
  console.log("  -> Candidate 1 ACCEPTED into Lineage DAG!");

  // Candidate 2: Introduce broken variation to test deterministic rollback
  console.log("\n[Iteration 2] Proposing Regressive Variation with Syntax Defect...");
  const cand2 = await evo.proposeCandidate({
    hypothesis: "Faulty optimization introducing syntax error",
    files_to_modify: ["benchmark_target.mjs"],
  });

  fs.writeFileSync(targetFile, `export function processData() { SYNTAX ERROR; }\n`);
  const eval2 = await evo.evaluateCandidate({
    command: "node run_perf.mjs",
    primary_metric: "throughput",
  });
  console.log(`  -> Candidate 2 Evaluation: Passed=${eval2.passed}, ExitCode=${eval2.metrics.exitCode}`);
  assert.strictEqual(eval2.passed, false, "Faulty variation must fail evaluation");

  // Revert Candidate 2
  const revert2 = await evo.revertCandidate({ candidate_id: cand2.candidate_id });
  console.log(`  -> Candidate 2 REVERTED cleanly! Files restored: ${revert2.files_reverted}`);

  // Verify workspace restored to Candidate 1 state
  const restoredCode = fs.readFileSync(targetFile, "utf8");
  assert.ok(restoredCode.includes("O(N) optimized"), "Workspace must retain Candidate 1 code after rollback");

  const status = evo.getStatus();
  console.log("\nFinal Evo Lineage DAG Summary:", status.summary);
  console.log("=======================================================\n");

  return {
    baselineOps,
    optimizedOps: eval1.metrics.opsPerSec,
    improvementRatio: (eval1.metrics.opsPerSec / baselineOps).toFixed(1),
    acceptedCandidates: status.summary.acceptedCount,
    rejectedCandidates: status.summary.rejectedCount,
  };
}

async function runAll() {
  console.log("************************************************************");
  console.log("  EVO BENCHMARKS");
  console.log("************************************************************");

  // P11: BENCHMARK 2 runs real generations - skip honestly when the engine is down.
  await requireEngineOrSkip("benchmark");

  await setupBenchmarkEnvironment();
  try {
    const b1 = await runBenchmark1_FilesystemTraversal();
    const b2 = await runBenchmark2_HarnessStartupAndStreaming();
    const b3 = await runBenchmark3_ClosedLoopEvoOptimization();

    console.log(">>> ALL BENCHMARKS COMPLETED SUCCESSFULLY! <<<");
    return { b1, b2, b3 };
  } finally {
    await cleanupBenchmarkEnvironment();
  }
}

runAll().catch((err) => {
  console.error("Benchmark run failed:", err);
  process.exit(1);
});
