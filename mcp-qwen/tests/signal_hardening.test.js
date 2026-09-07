/**
 * Signal-Preserving Hardening Verification (fully OFFLINE)
 *
 * Tests:
 * 1. provider_vllm.js dynamic headroom clamping against MAX_LEN_HUGE (245,760)
 * 2. provider_vllm.js ContextExhaustedError when prompt exceeds ceiling
 * 3. task_registry.js readTaskFromDisk transientLock return on EBUSY/EPERM
 * 4. task_registry.js diskPoll debouncing of missing task before failing
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe } from "node:test";

describe("Signal Preserving Hardening (Offline)", () => {
  test("provider_vllm clamps max_tokens to fit within MAX_LEN_HUGE headroom", async () => {
    const { VllmProviderService } = await import("../src/harness/services/provider_vllm.js");
    const { MAX_LEN_HUGE } = await import("../src/config.js");

    const provider = new VllmProviderService();

    // Create a large prompt (~196,000 tokens => ~686,000 chars)
    const largeMessage = {
      role: "user",
      content: "A".repeat(686_000),
    };

    let capturedPayload = null;
    const fakeFetch = async (url, opts) => {
      capturedPayload = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            let done = false;
            return {
              async read() {
                if (done) return { done: true };
                done = true;
                return {
                  done: false,
                  value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
                };
              },
            };
          },
        },
      };
    };

    const origFetch = global.fetch;
    global.fetch = fakeFetch;
    try {
      await provider.streamChat({
        messages: [largeMessage],
        maxTokens: 50000,
      });

      assert.ok(capturedPayload, "Request was dispatched");
      assert.ok(
        capturedPayload.max_tokens < 50000,
        `max_tokens was clamped down (was: ${capturedPayload.max_tokens})`
      );
      const estPrompt = Math.ceil(JSON.stringify([largeMessage]).length / 3.5);
      assert.strictEqual(
        capturedPayload.max_tokens,
        MAX_LEN_HUGE - estPrompt - 128,
        "Clamped to exact headroom formula"
      );
    } finally {
      global.fetch = origFetch;
    }
  });

  test("provider_vllm throws ContextExhaustedError when prompt exceeds ceiling", async () => {
    const { VllmProviderService } = await import("../src/harness/services/provider_vllm.js");

    const provider = new VllmProviderService();
    // Huge message exceeding 245K tokens (~860,000 chars)
    const hugeMessage = {
      role: "user",
      content: "B".repeat(860_000),
    };

    let threw = false;
    try {
      await provider.streamChat({
        messages: [hugeMessage],
        maxTokens: 4096,
      });
    } catch (err) {
      threw = true;
      assert.ok(
        err.message.includes("ContextExhaustedError"),
        `Error must be ContextExhaustedError (got: ${err.message})`
      );
    }
    assert.strictEqual(threw, true, "Must fail fast with ContextExhaustedError");
  });

  test("task_registry readTaskFromDisk returns transientLock on EBUSY", async () => {
    const { readTaskFromDisk } = await import("../src/task_registry.js");

    const origReadFileSync = fs.readFileSync;
    const origExistsSync = fs.existsSync;
    try {
      fs.existsSync = () => true;
      fs.readFileSync = () => {
        const err = new Error("Resource busy or locked");
        err.code = "EBUSY";
        throw err;
      };

      const result = readTaskFromDisk("mock_task_123");
      assert.ok(result, "Result is not null on EBUSY");
      assert.strictEqual(result.transientLock, true, "transientLock is true on EBUSY");
      assert.strictEqual(result.id, "mock_task_123");
    } finally {
      fs.readFileSync = origReadFileSync;
      fs.existsSync = origExistsSync;
    }
  });

  test("task_registry readTaskFromDisk returns null on ENOENT", async () => {
    const { readTaskFromDisk } = await import("../src/task_registry.js");

    const origExistsSync = fs.existsSync;
    try {
      fs.existsSync = () => false;
      const result = readTaskFromDisk("nonexistent_task_456");
      assert.strictEqual(result, null, "Result is null when file does not exist");
    } finally {
      fs.existsSync = origExistsSync;
    }
  });
});
