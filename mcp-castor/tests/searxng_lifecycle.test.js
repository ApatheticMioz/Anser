#!/usr/bin/env node
/**
 * SearXNG Docker Lifecycle Manager Test Suite (fully OFFLINE).
 *
 * Adversarially tests:
 * 1. isLocalSearxngUrl: loopback detection (localhost/127.0.0.1 true; external false).
 * 2. ensureSearxngRunning: no-op for external URLs (no docker calls).
 * 3. ensureSearxngRunning: healthy instance → no docker calls.
 * 4. ensureSearxngRunning: unhealthy → sweep + compose up + health poll until healthy.
 * 5. ensureSearxngRunning: concurrent calls share a single start (no double up).
 * 6. ensureSearxngRunning: start timeout throws SearXNG timeout error.
 * 7. markSearxngActive + scheduleIdleStop: idle timer fires shutdown after idleMs.
 * 8. shutdownSearxng: idempotent, clears idle timer, tolerates docker failure.
 * 9. sweepOrphans: removes listed containers; tolerates docker failure.
 * 10. web_service integration: _searchSearxng calls ensureSearxngRunning for local
 *     URLs and markSearxngActive on success; external URLs skip lifecycle.
 *
 * Run: node tests/searxng_lifecycle.test.js
 */

import assert from "node:assert/strict";
import {
  isLocalSearxngUrl,
  ensureSearxngRunning,
  markSearxngActive,
  scheduleIdleStop,
  shutdownSearxng,
  sweepOrphans,
  _setDockerRunner,
  _setHealthCheck,
  _resetForTest,
} from "../src/harness/services/searxng_lifecycle.js";
import { WebService } from "../src/harness/services/web_service.js";

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${label}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${label}: ${err.message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${label}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${label}: ${err.message}`);
  }
}

console.log("=== SearXNG Docker Lifecycle Manager Tests (offline) ===\n");

// ---------------------------------------------------------------------------
// Section 1: Local-instance detection
// ---------------------------------------------------------------------------
check("isLocalSearxngUrl: loopback URLs detected", () => {
  assert.equal(isLocalSearxngUrl("http://127.0.0.1:8888/"), true);
  assert.equal(isLocalSearxngUrl("http://localhost:8888"), true);
  assert.equal(isLocalSearxngUrl("http://127.0.0.1"), true);
});

check("isLocalSearxngUrl: external URLs rejected", () => {
  assert.equal(isLocalSearxngUrl("https://searx.be/"), false);
  assert.equal(isLocalSearxngUrl("http://192.168.1.5:8888/"), false);
  assert.equal(isLocalSearxngUrl("http://0.0.0.0:8888/"), false);
  assert.equal(isLocalSearxngUrl(""), false);
  assert.equal(isLocalSearxngUrl(null), false);
  assert.equal(isLocalSearxngUrl("not a url"), false);
});

// ---------------------------------------------------------------------------
// Section 2: ensureSearxngRunning — external URL is a no-op
// ---------------------------------------------------------------------------
await checkAsync("ensureSearxngRunning: external URL is a no-op (zero docker calls)", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "" };
  });
  _setHealthCheck(async () => false);
  await ensureSearxngRunning("https://searx.be/");
  assert.equal(calls.length, 0, `expected no docker calls, got: ${JSON.stringify(calls)}`);
});

// ---------------------------------------------------------------------------
// Section 3: ensureSearxngRunning — already healthy
// ---------------------------------------------------------------------------
await checkAsync("ensureSearxngRunning: healthy instance → no docker calls", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "" };
  });
  _setHealthCheck(async () => true);
  await ensureSearxngRunning("http://127.0.0.1:8888/");
  assert.equal(calls.length, 0, `expected no docker calls, got: ${JSON.stringify(calls)}`);
});

// ---------------------------------------------------------------------------
// Section 4: ensureSearxngRunning — cold start (sweep → up → poll)
// ---------------------------------------------------------------------------
await checkAsync("ensureSearxngRunning: cold start runs sweep, compose up, then polls to healthy", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  let healthCalls = 0;
  _setHealthCheck(async () => {
    healthCalls++;
    return healthCalls >= 3; // healthy on the 3rd poll
  });
  await ensureSearxngRunning("http://127.0.0.1:8888/");
  assert.ok(calls.some((c) => c.startsWith("ps -a --filter name=castor-searxng")), "must sweep orphans first");
  assert.ok(calls.some((c) => c.includes("compose") && c.includes("up -d")), "must run compose up -d");
  assert.ok(healthCalls >= 3, `expected >=3 health polls, got ${healthCalls}`);
});

// ---------------------------------------------------------------------------
// Section 5: ensureSearxngRunning — concurrent calls share one start
// ---------------------------------------------------------------------------
await checkAsync("ensureSearxngRunning: concurrent calls share a single compose up", async () => {
  _resetForTest();
  let upCount = 0;
  _setDockerRunner(async (args) => {
    if (args[0] === "ps") return { stdout: "", stderr: "" };
    if (args.includes("up")) upCount++;
    return { stdout: "", stderr: "" };
  });
  let healthCalls = 0;
  _setHealthCheck(async () => {
    healthCalls++;
    return healthCalls >= 2;
  });
  await Promise.all([
    ensureSearxngRunning("http://127.0.0.1:8888/"),
    ensureSearxngRunning("http://127.0.0.1:8888/"),
    ensureSearxngRunning("http://127.0.0.1:8888/"),
  ]);
  assert.equal(upCount, 1, `expected exactly 1 compose up, got ${upCount}`);
});

// ---------------------------------------------------------------------------
// Section 6: ensureSearxngRunning — start timeout
// ---------------------------------------------------------------------------
await checkAsync("ensureSearxngRunning: never-healthy instance throws timeout error", async () => {
  _resetForTest();
  _setDockerRunner(async () => ({ stdout: "", stderr: "" }));
  _setHealthCheck(async () => false);
  let threw = false;
  try {
    await ensureSearxngRunning("http://127.0.0.1:8888/");
  } catch (err) {
    threw = true;
    assert.ok(/healthy within/.test(err.message), `expected timeout message, got: ${err.message}`);
  }
  assert.ok(threw, "must throw when the instance never becomes healthy");
});

// ---------------------------------------------------------------------------
// Section 7: idle-stop watchdog
// ---------------------------------------------------------------------------
await checkAsync("idle-stop: shutdown fires after idleMs of inactivity", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "" };
  });
  _setHealthCheck(async () => true);
  scheduleIdleStop(150);
  markSearxngActive();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(calls.some((c) => c.includes("compose") && c.includes("down")), `expected compose down, got: ${JSON.stringify(calls)}`);
});

await checkAsync("idle-stop: activity within the window defers shutdown", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "" };
  });
  _setHealthCheck(async () => true);
  scheduleIdleStop(200);
  markSearxngActive();
  await new Promise((r) => setTimeout(r, 100));
  markSearxngActive(); // keep alive
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.length, 0, `expected no shutdown yet, got: ${JSON.stringify(calls)}`);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(calls.some((c) => c.includes("down")), "shutdown must fire after the deferred window");
});

// ---------------------------------------------------------------------------
// Section 8: shutdownSearxng idempotency + failure tolerance
// ---------------------------------------------------------------------------
await checkAsync("shutdownSearxng: idempotent and tolerates docker failure", async () => {
  _resetForTest();
  let downCount = 0;
  _setDockerRunner(async (args) => {
    if (args.includes("down")) downCount++;
    if (downCount === 2) throw new Error("docker daemon gone");
    return { stdout: "", stderr: "" };
  });
  _setHealthCheck(async () => true);
  await shutdownSearxng();
  await shutdownSearxng(); // second call must not throw
  assert.equal(downCount, 2, `expected 2 down attempts, got ${downCount}`);
});

// ---------------------------------------------------------------------------
// Section 9: sweepOrphans
// ---------------------------------------------------------------------------
await checkAsync("sweepOrphans: removes listed containers", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") return { stdout: "castor-searxng\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  await sweepOrphans();
  assert.ok(calls.some((c) => c === "rm -f castor-searxng"), `expected rm -f, got: ${JSON.stringify(calls)}`);
});

await checkAsync("sweepOrphans: tolerates docker being unavailable", async () => {
  _resetForTest();
  _setDockerRunner(async () => {
    throw new Error("docker not found");
  });
  await sweepOrphans(); // must not throw
});

// ---------------------------------------------------------------------------
// Section 10: web_service integration
// ---------------------------------------------------------------------------
await checkAsync("web_service._searchSearxng: local URL triggers lifecycle ensure + active mark", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "" };
  });
  let healthCalls = 0;
  _setHealthCheck(async () => {
    healthCalls++;
    return healthCalls >= 2;
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("127.0.0.1:8888/search")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: "test",
          results: [{ title: "T", url: "https://example.com", content: "S" }],
        }),
      };
    }
    return originalFetch(url);
  };

  const web = new WebService();
  try {
    const results = await web._searchSearxng("test", 5, "http://127.0.0.1:8888/");
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "T");
    assert.ok(calls.some((c) => c.includes("up -d")), "must have started the container");
  } finally {
    globalThis.fetch = originalFetch;
    _resetForTest();
  }
});

await checkAsync("web_service._searchSearxng: external URL skips lifecycle entirely", async () => {
  _resetForTest();
  const calls = [];
  _setDockerRunner(async (args) => {
    calls.push(args.join(" "));
    return { stdout: "", stderr: "" };
  });
  _setHealthCheck(async () => false);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [] }),
  });

  const web = new WebService();
  try {
    await web._searchSearxng("test", 5, "https://searx.be/");
    assert.equal(calls.length, 0, `expected no docker calls for external URL, got: ${JSON.stringify(calls)}`);
  } finally {
    globalThis.fetch = originalFetch;
    _resetForTest();
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n==========================================");
console.log(`SearXNG Lifecycle Tests: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================");

if (failed > 0) process.exit(1);
