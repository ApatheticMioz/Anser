/**
 * Closed-Loop Metric Evaluator (Evo Fitness Engine)
 *
 * Executes evaluation commands and parses feedback into a quantitative FitnessScore.
 */

import { condenseTraceback } from "./trace_repair.js";

export class ClosedLoopEvaluator {
  constructor(options = {}) {
    this.shell = options.shell; // ShellExecutorService instance
  }

  /**
   * Evaluates a command line and computes a structured FitnessScore.
   *
   * @param {object} params
   * @param {string} params.command Test or benchmark command (e.g. "npm test", "pytest")
   * @param {string} [params.cwd]
   * @param {string} [params.primaryMetric] Name of primary metric ("throughput", "latency_ms", "tests_passed")
   * @param {number} [params.timeout_ms]
   * @returns {Promise<{
   *   passed: boolean,
   *   fitness: number,
   *   exitCode: number,
   *   metrics: object,
   *   failureDigest: object|null,
   *   stdout: string,
   *   stderr: string,
   *   latencyMs: number
   * }>}
   */
  async evaluate({ command, cwd, primaryMetric = "tests_passed", timeout_ms = 120_000 }) {
    if (!this.shell) {
      throw new Error("ClosedLoopEvaluator requires a ShellExecutorService instance");
    }

    const execResult = await this.shell.execute({
      command,
      cwd,
      timeout_ms,
    });

    const parsed = this.parseMetrics(execResult.stdout, execResult.stderr, execResult.exitCode);
    const fitness = this.calculateFitness(parsed, primaryMetric, execResult.latencyMs);

    const failureDigest = !execResult.exitCode || parsed.testsFailed === 0
      ? null
      : condenseTraceback({
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          exitCode: execResult.exitCode,
          timedOut: execResult.timedOut,
          workspaceRoot: cwd,
        });

    return {
      passed: parsed.testsFailed === 0 && execResult.exitCode === 0,
      fitness,
      exitCode: execResult.exitCode,
      metrics: parsed,
      failureDigest,
      stdout: execResult.stdout.slice(0, 8000),
      stderr: execResult.stderr.slice(0, 8000),
      latencyMs: execResult.latencyMs,
    };
  }

  /**
   * Parses test outputs and numeric metrics from stdout/stderr.
   */
  parseMetrics(stdout, stderr, exitCode) {
    const combined = `${stdout}\n${stderr}`;
    const metrics = {
      exitCode,
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: exitCode === 0 ? 0 : 1,
      throughput: null,
      latencyMs: null,
      opsPerSec: null,
      memoryMb: null,
    };

    // Pytest match: "X passed, Y failed in Zs"
    const pytestMatch = combined.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/i);
    if (pytestMatch) {
      metrics.testsPassed = parseInt(pytestMatch[1], 10);
      metrics.testsFailed = pytestMatch[2] ? parseInt(pytestMatch[2], 10) : 0;
      metrics.testsTotal = metrics.testsPassed + metrics.testsFailed;
    }

    // Vitest / Jest match: "Tests: X passed, Y failed, Z total"
    const jestMatch = combined.match(/Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/i);
    if (jestMatch) {
      metrics.testsFailed = jestMatch[1] ? parseInt(jestMatch[1], 10) : 0;
      metrics.testsPassed = jestMatch[2] ? parseInt(jestMatch[2], 10) : 0;
      metrics.testsTotal = parseInt(jestMatch[3], 10);
    }

    // Go test match: "PASS" or "FAIL"
    if (combined.includes("--- PASS:")) metrics.testsPassed = Math.max(1, metrics.testsPassed);
    if (combined.includes("--- FAIL:")) metrics.testsFailed = Math.max(1, metrics.testsFailed);

    // Throughput matches: "123.45 ops/sec" or "123.45 req/sec" or "123 tokens/s"
    const opsMatch = combined.match(/([\d.]+)\s*(?:ops\/s(?:ec)?|req\/s(?:ec)?|tokens?\/s(?:ec)?)/i);
    if (opsMatch) {
      metrics.opsPerSec = parseFloat(opsMatch[1]);
      metrics.throughput = metrics.opsPerSec;
    }

    // Benchmark Latency: "123.45 ms"
    const latencyMatch = combined.match(/(?:latency|duration|time):\s*([\d.]+)\s*ms/i);
    if (latencyMatch) {
      metrics.latencyMs = parseFloat(latencyMatch[1]);
    }

    // Memory usage: "123 MB"
    const memMatch = combined.match(/([\d.]+)\s*MB(?:\s+heap)?/i);
    if (memMatch) {
      metrics.memoryMb = parseFloat(memMatch[1]);
    }

    return metrics;
  }

  /**
   * Calculates scalar fitness score.
   */
  calculateFitness(parsed, primaryMetric, runDurationMs) {
    // Severe penalty for non-zero exit code or failed tests
    if (parsed.exitCode !== 0 || parsed.testsFailed > 0) {
      return -100 - parsed.testsFailed * 25;
    }

    // Zero-assertion baseline: a compiler pass or command without test framework assertions
    // is a neutral syntax gate (score: 50.0), NOT a verified functional optimization (100.0).
    let baseScore = 50;
    if (parsed.testsTotal > 0) {
      baseScore = (parsed.testsPassed / parsed.testsTotal) * 100;
    }

    // Metric bonus
    if (primaryMetric === "throughput" && parsed.throughput) {
      return Number((baseScore + parsed.throughput).toFixed(2));
    }

    if (primaryMetric === "latency_ms") {
      const lat = parsed.latencyMs || runDurationMs;
      // Lower latency yields higher fitness
      return Number((baseScore + 1000 / Math.max(1, lat)).toFixed(2));
    }

    return Number(baseScore.toFixed(2));
  }
}
