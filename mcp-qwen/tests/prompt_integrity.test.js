/**
 * prompt_integrity.test.js - Extreme offline test suite for LLM-facing contracts,
 * prompt idempotency, reasoning continuation guards, and anti-overlap invariants.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  injectSkills,
  matchSkills,
} from "../src/skills.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  CONTINUATION_DIRECTIVE,
  REASONING_CONTINUATION_DIRECTIVE,
  AnserRunner,
} from "../src/harness/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const claudePath = path.join(repoRoot, "CLAUDE.md");
const geminiPath = path.join(repoRoot, "GEMINI.md");

// ---------------------------------------------------------------------------
// 1. Prompt Idempotency & Deduplication under Adversarial Conditions
// ---------------------------------------------------------------------------

test("prompt_integrity: injectSkills is strictly idempotent across multiple passes", () => {
  const basePrompt = "Please optimize this function using hypothesis testing and check traceback.";
  const pass1 = injectSkills(basePrompt, process.cwd());
  assert.ok(pass1.includes("--- Matching skills (auto-injected from skills/) ---"), "Pass 1 must inject skills header");

  const pass2 = injectSkills(pass1, process.cwd());
  assert.equal(pass2, pass1, "Pass 2 must be strictly byte-identical to Pass 1");

  const pass3 = injectSkills(pass2, process.cwd());
  assert.equal(pass3, pass1, "Pass 3 must remain strictly byte-identical");

  // Count occurrences of skill header
  const headerMatches = pass3.match(/--- Matching skills \(auto-injected from skills\/\) ---/g);
  assert.equal(headerMatches?.length, 1, "There must be exactly one skills header block");
});

test("prompt_integrity: injectSkills deduplicates skills even with repetitive keyword triggers", () => {
  // Repeatedly trigger the exact same skill keywords in adversarial prompt
  const adversarialPrompt = "hypothesis hypothesis hypothesis evo evo evo traceback traceback traceback";
  const injected = injectSkills(adversarialPrompt, process.cwd());

  // Extract all "### <skill_name>" headers
  const skillHeaders = injected.match(/### [a-zA-Z0-9_-]+/g) || [];
  const uniqueHeaders = new Set(skillHeaders);

  assert.equal(
    skillHeaders.length,
    uniqueHeaders.size,
    `Every injected skill must be unique. Found: ${skillHeaders.join(", ")}`
  );
});

test("prompt_integrity: injectSkills handles non-string and empty inputs gracefully", () => {
  assert.equal(injectSkills(null), null);
  assert.equal(injectSkills(undefined), undefined);
  assert.equal(injectSkills(""), "");
});

// ---------------------------------------------------------------------------
// 2. Qwen System Prompt Integrity (Zero Redundant Recitation & Autonomy)
// ---------------------------------------------------------------------------

test("prompt_integrity: DEFAULT_SYSTEM_PROMPT does not redundantly recite tool schemas", () => {
  // Tools are supplied via OpenAI JSON tool definitions. The system prompt must NOT
  // repeat multiple redundant lists of tool signatures or arguments.
  const lines = DEFAULT_SYSTEM_PROMPT.split("\n");

  // Count occurrences of tool names in the system prompt
  const toolNames = ["search_code", "list_dir", "ast_search", "apply_patch", "edit_file", "web_search", "web_fetch"];
  for (const name of toolNames) {
    const occurrences = DEFAULT_SYSTEM_PROMPT.split(`'${name}'`).length - 1;
    // Each tool should be mentioned at most once or twice in high-level discipline, never in redundant bullet lists
    assert.ok(
      occurrences <= 2,
      `Tool '${name}' appears ${occurrences} times in system prompt. Redundant tool recitations must stay pruned.`
    );
  }
});

test("prompt_integrity: DEFAULT_SYSTEM_PROMPT codifies peer autonomy and confidence to speak up", () => {
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Peer Partnership & Two-Way Discussion"),
    "System prompt must elevate peer partnership"
  );
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Never treat a dispatch as \"life or death\""),
    "System prompt must explicitly ban life-or-death framing"
  );
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("DO NOT loop in solitary trial-and-error"),
    "System prompt must instruct against solitary trial-and-error looping"
  );
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Concluding your turn with a clear, grounded inquiry or status report IS successful fulfillment"),
    "System prompt must affirm that reporting in plain text is successful fulfillment"
  );
});

// ---------------------------------------------------------------------------
// 3. Reasoning Ceiling Continuation & Balanced Landing Directive
// ---------------------------------------------------------------------------

test("prompt_integrity: REASONING_CONTINUATION_DIRECTIVE is non-coercive and provides balanced landing", () => {
  // It must NOT command a forced action (which causes hallucinations)
  assert.ok(
    !REASONING_CONTINUATION_DIRECTIVE.includes("Conclude your thinking immediately"),
    "Must not violently command immediate conclusion"
  );
  assert.ok(
    !REASONING_CONTINUATION_DIRECTIVE.includes("Emit your next concrete empirical action"),
    "Must not coerce forced tool execution"
  );

  // It MUST give permission to either proceed or request guidance
  assert.ok(
    REASONING_CONTINUATION_DIRECTIVE.includes("If you have reached a resolution, proceed"),
    "Must permit natural resolution"
  );
  assert.ok(
    REASONING_CONTINUATION_DIRECTIVE.includes("request guidance from the supervisor"),
    "Must provide an open door to consult the supervisor"
  );
});

test("prompt_integrity: runner caps consecutive reasoning cutoffs to 1 and terminates with reasoning_budget_exhausted", async () => {
  // Mock LLM provider that simulates hitting reasoning ceiling repeatedly
  let calls = 0;
  const mockLlm = {
    async streamChat({ messages, onMetrics }) {
      calls++;
      const metrics = {
        promptTokens: 1000,
        completionTokens: 32768,
        ttftMs: 50,
        totalMs: 500,
        reasoningTokens: 32768,
        hadReasoning: true,
        reasoningCeilingHit: true,
      };
      if (onMetrics) onMetrics(metrics);
      // Return length cutoff with reasoningCeilingHit and empty content
      return {
        content: "",
        toolCalls: [],
        finishReason: "length",
        metrics,
        hadReasoning: true,
        reasoningTokens: 32768,
      };
    },
  };

  // Mock logger
  const events = [];
  const mockLogger = {
    append(ev) { events.push(ev); },
    readAll() { return events; },
    getConversationHistory() { return []; },
  };

  const runner = new AnserRunner({
    llm: mockLlm,
    logger: mockLogger,
  });

  const result = await runner.run({
    prompt: "Test task that triggers reasoning ceiling",
    sessionId: "test_reasoning_ceiling",
  });

  // Call 1: Turn 1 (hits ceiling) -> triggers continuation 1 with REASONING_CONTINUATION_DIRECTIVE
  // Call 2: Turn 2 (continuation turn, hits ceiling again) -> consecutiveReasoningContinuations > 1 -> breaks!
  assert.equal(calls, 2, "Must make exactly 2 calls before terminating consecutive reasoning loops");
  assert.equal(result.status, "reasoning_budget_exhausted", "Status must be reasoning_budget_exhausted");
  assert.ok(
    result.finalText.includes("ReasoningBudgetExhaustedError"),
    "Must return structured ReasoningBudgetExhaustedError"
  );

  // Check logged events for balanced landing directive
  const contEvents = events.filter((e) => e.type === "continuation_injected");
  assert.equal(contEvents.length, 1, "Must inject exactly 1 continuation for reasoning cutoff");
  assert.equal(contEvents[0].directive, "balanced_landing");
  assert.equal(contEvents[0].content, REASONING_CONTINUATION_DIRECTIVE);
});

test("prompt_integrity: runner allows normal content cutoffs up to MAX_CONTINUATION_TURNS", async () => {
  // Mock LLM that emits content but gets cut off by length (e.g. streaming a giant file)
  let calls = 0;
  const mockLlm = {
    async streamChat({ messages, onMetrics }) {
      calls++;
      if (calls < 3) {
        const metrics = {
          promptTokens: 500,
          completionTokens: 4000,
          ttftMs: 50,
          totalMs: 200,
          reasoningTokens: 0,
          hadReasoning: false,
          reasoningCeilingHit: false,
        };
        if (onMetrics) onMetrics(metrics);
        return {
          content: `Chunk ${calls} of large file... `,
          toolCalls: [],
          finishReason: "length",
          metrics,
        };
      }
      const metrics = {
        promptTokens: 500,
        completionTokens: 100,
        ttftMs: 50,
        totalMs: 100,
        reasoningTokens: 0,
        hadReasoning: false,
        reasoningCeilingHit: false,
      };
      if (onMetrics) onMetrics(metrics);
      return {
        content: "Final chunk. Done.",
        toolCalls: [],
        finishReason: "stop",
        metrics,
      };
    },
  };

  const events = [];
  const mockLogger = {
    append(ev) { events.push(ev); },
    readAll() { return events; },
    getConversationHistory() { return []; },
  };

  const runner = new AnserRunner({
    llm: mockLlm,
    logger: mockLogger,
  });

  const result = await runner.run({
    prompt: "Generate a large file",
    sessionId: "test_content_continuation",
  });

  assert.equal(calls, 3, "Must successfully continue multi-part content stream");
  assert.equal(result.status, "completed", "Must conclude with completed status");

  const contEvents = events.filter((e) => e.type === "continuation_injected");
  assert.equal(contEvents.length, 2, "Must record 2 content continuations");
  assert.equal(contEvents[0].directive, "resume");
  assert.equal(contEvents[0].content, CONTINUATION_DIRECTIVE);
});

// ---------------------------------------------------------------------------
// 4. Cloud Model Contracts (CLAUDE.md & GEMINI.md Anti-Coercion Invariants)
// ---------------------------------------------------------------------------

test("prompt_integrity: CLAUDE.md and GEMINI.md explicitly ban life-or-death ultimatums and mandate collaborative exit criteria", () => {
  const claudeContent = fs.readFileSync(claudePath, "utf8");
  const geminiContent = fs.readFileSync(geminiPath, "utf8");

  for (const [name, content] of [["CLAUDE.md", claudeContent], ["GEMINI.md", geminiContent]]) {
    assert.ok(
      content.includes("Never Corner the Coworker with Life-or-Death Mandates"),
      `${name} must explicitly ban life-or-death mandates`
    );
    assert.ok(
      content.includes("The Lead Architect MUST NEVER frame dispatches with coercive ultimatums"),
      `${name} must prohibit coercive ultimatums`
    );
    assert.ok(
      content.includes("collaborative exit criteria"),
      `${name} must require collaborative exit criteria on test gates`
    );
    assert.ok(
      content.includes("Reporting verified empirical failures or trade-offs in plain text is successful objective fulfillment"),
      `${name} must validate reporting failures in text as successful objective fulfillment`
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Extreme & Adversarial Robustness Tests
// ---------------------------------------------------------------------------

test("prompt_integrity: injectSkills survives adversarial payloads (unicode, null bytes, CRLF, large repeated strings)", () => {
  const adversarialInputs = [
    "🚀 🔥 💡 💥 hypothesis testing with non-ascii characters and emojis",
    "prompt with null bytes \u0000 and control chars \u0007 \u001b[31m evo \u001b[0m",
    "windows CRLF prompt\r\nwith multiple\r\nnewlines and hypothesis\r\nkeywords",
    "A".repeat(50000) + " evo traceback hypothesis",
  ];

  for (const input of adversarialInputs) {
    const res = injectSkills(input, process.cwd());
    assert.ok(typeof res === "string", "Must always return string");
    assert.ok(res.length >= input.length, "Output must contain at least original input length");
    assert.ok(
      res.includes("--- Matching skills (auto-injected from skills/) ---"),
      "Must correctly detect keywords despite adversarial payload"
    );

    // Re-injection must be idempotent even with adversarial inputs
    const reInjected = injectSkills(res, process.cwd());
    assert.equal(reInjected, res, "Re-injection must remain strictly idempotent");
  }
});

test("prompt_integrity: DEFAULT_SYSTEM_PROMPT maintains core invariants while being token-efficient", () => {
  // Token efficiency: system prompt should be concise and focused (under 3,000 chars, pruned down from 3,800+ chars)
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.length < 3000,
    `System prompt must stay concise and pruned (actual length: ${DEFAULT_SYSTEM_PROMPT.length} chars)`
  );

  // Core invariants codified directly into the prompt
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Ground Truth in Code & Tests"),
    "Must preserve Ground Truth in Code & Tests invariant"
  );
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Workspace Scratchpads for Audits, Exploration & Empirical Reproduction"),
    "Must preserve Workspace Scratchpads invariant"
  );
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Pure Text-Only Engine"),
    "Must preserve Pure Text-Only Engine invariant"
  );
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Reserve 'bash' strictly"),
    "Must preserve bash usage boundaries"
  );
  assert.ok(
    DEFAULT_SYSTEM_PROMPT.includes("Peer Partnership & Two-Way Discussion"),
    "Must preserve Peer Partnership invariant"
  );
});

test("prompt_integrity: runner allows collaborative resolution on continuation turn after reasoning cutoff", async () => {
  // Test that when Qwen receives the balanced landing directive, it can conclude
  // naturally with an inquiry or status report without taking a tool call.
  let calls = 0;
  const mockLlm = {
    async streamChat({ messages, onMetrics }) {
      calls++;
      if (calls === 1) {
        // Turn 1: hits reasoning ceiling
        const metrics = {
          promptTokens: 1000,
          completionTokens: 32768,
          ttftMs: 50,
          totalMs: 500,
          reasoningTokens: 32768,
          hadReasoning: true,
          reasoningCeilingHit: true,
        };
        if (onMetrics) onMetrics(metrics);
        return {
          content: "",
          toolCalls: [],
          finishReason: "length",
          metrics,
        };
      }
      // Turn 2: Coworker concludes with collaborative status report
      const report = "I have reached an empirical impasse: the test gate expects 90% recall, but the dataset only provides 75% coverage. Lead Architect, should we adjust the threshold?";
      const metrics = {
        promptTokens: 1500,
        completionTokens: 80,
        ttftMs: 30,
        totalMs: 80,
        reasoningTokens: 500,
        hadReasoning: true,
        reasoningCeilingHit: false,
      };
      if (onMetrics) onMetrics(metrics);
      return {
        content: report,
        toolCalls: [],
        finishReason: "stop",
        metrics,
      };
    },
  };

  const events = [];
  const mockLogger = {
    append(ev) { events.push(ev); },
    readAll() { return events; },
    getConversationHistory() { return []; },
  };

  const runner = new AnserRunner({
    llm: mockLlm,
    logger: mockLogger,
  });

  const result = await runner.run({
    prompt: "Investigate test failure",
    sessionId: "test_collaborative_resolution",
  });

  assert.equal(calls, 2, "Must resolve on continuation turn");
  assert.equal(result.status, "completed", "Status must be completed");
  assert.ok(
    result.finalText.includes("empirical impasse"),
    "Deliverable text must contain coworker's status report"
  );
});

test("prompt_integrity: empirical tool call resets consecutive reasoning continuation counter", async () => {
  // Turn 1: reasoning ceiling hit -> continuation 1 injected
  // Turn 2: coworker emits tool call (e.g. read_file) -> executes tool -> consecutive reset to 0!
  // Turn 3: coworker hits reasoning ceiling again -> this is now consecutive = 1, NOT 2!
  // Turn 4: hits reasoning ceiling again -> consecutive = 2 -> terminates with reasoning_budget_exhausted
  let calls = 0;
  const mockLlm = {
    async streamChat({ messages, onMetrics }) {
      calls++;
      if (calls === 1 || calls === 3 || calls === 4) {
        // Reasoning ceiling cutoff
        const metrics = {
          promptTokens: 1000,
          completionTokens: 32768,
          ttftMs: 50,
          totalMs: 500,
          reasoningTokens: 32768,
          hadReasoning: true,
          reasoningCeilingHit: true,
        };
        if (onMetrics) onMetrics(metrics);
        return {
          content: "",
          toolCalls: [],
          finishReason: "length",
          metrics,
        };
      }
      if (calls === 2) {
        // Turn 2: Coworker emits a tool call
        const metrics = {
          promptTokens: 1200,
          completionTokens: 50,
          ttftMs: 30,
          totalMs: 60,
          reasoningTokens: 50,
          hadReasoning: true,
          reasoningCeilingHit: false,
        };
        if (onMetrics) onMetrics(metrics);
        return {
          content: "",
          toolCalls: [
            {
              id: "call_read_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "package.json" }),
              },
            },
          ],
          finishReason: "tool_calls",
          metrics,
        };
      }
      throw new Error(`Unexpected call ${calls}`);
    },
  };

  const events = [];
  const mockLogger = {
    append(ev) { events.push(ev); },
    readAll() { return events; },
    getConversationHistory() { return []; },
  };

  const runner = new AnserRunner({
    llm: mockLlm,
    logger: mockLogger,
  });

  const result = await runner.run({
    prompt: "Test action resets consecutive reasoning counter",
    sessionId: "test_action_reset",
  });

  // Call 1: Turn 1 (hits ceiling) -> continuation 1
  // Call 2: Turn 2 (tool call) -> executes tool, resets counter
  // Call 3: Turn 3 (hits ceiling) -> continuation 2 (consecutive = 1)
  // Call 4: Turn 4 (hits ceiling again) -> consecutive = 2 -> terminates!
  assert.equal(calls, 4, "Must survive past call 3 because call 2 executed a tool");
  assert.equal(result.status, "reasoning_budget_exhausted", "Status must be reasoning_budget_exhausted");

  const contEvents = events.filter((e) => e.type === "continuation_injected");
  assert.equal(contEvents.length, 2, "Must have injected 2 continuations across the run");
});

