#!/usr/bin/env node
// dispatch-scorecard.mjs — standing dispatch-discipline scorecard (2026-09 usage audit).
//
// Reads the Anser state dir (~/.qwen by default) and emits per-session and
// per-task metrics that quantify orchestrator/coworker balance:
//   - prompt-size distribution + failures           (from tasks/*.json)
//   - premature/late cancels                        (from tasks/*.json)
//   - turn counts, early-vs-late throughput decay   (from sessions/*/events.jsonl)
//   - continuation / empty-stream / error events    (from sessions/*/events.jsonl)
//
// Usage:  node scripts/dispatch-scorecard.mjs [--days N] [--json] [--state-dir PATH]
//   --days N        only sessions/tasks active in the last N days (default: 7)
//   --json          machine-readable output instead of the human table
//   --state-dir     override state dir (default: ~/.qwen)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const DAYS = Number(flag("--days") ?? 7);
const AS_JSON = args.includes("--json");
const STATE_DIR = flag("--state-dir") ?? path.join(os.homedir(), ".qwen");

const SESSIONS_DIR = path.join(STATE_DIR, "sessions");
const TASKS_DIR = path.join(STATE_DIR, "tasks");
for (const d of [SESSIONS_DIR, TASKS_DIR]) {
  if (!fs.existsSync(d)) {
    console.error(`dispatch-scorecard: missing state dir: ${d}`);
    process.exit(1);
  }
}

const SINCE = Date.now() - DAYS * 86_400_000;
const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// ---------- per-session metrics ----------
// Decay heuristic from the audit: compare whole-turn rate (completionTokens/totalMs,
// the harness's tokensPerSec) across the first vs second half of a session's
// assistant turns; flag when late < 70% of early (only meaningful for >= 6 turns).
const sessions = [];
for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(SESSIONS_DIR, entry.name, "events.jsonl");
  if (!fs.existsSync(file)) continue;
  const st = fs.statSync(file);
  if (st.mtimeMs < SINCE) continue;
  const ev = readJsonl(file);
  const turns = ev.filter((e) => e.type === "assistant_message");
  const rates = turns
    .map((t) => t.metrics?.tokensPerSec)
    .filter((r) => typeof r === "number" && r > 0);
  const ttfts = turns
    .map((t) => t.metrics?.ttftMs)
    .filter((r) => typeof r === "number");
  const half = Math.floor(rates.length / 2);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  const early = rates.slice(0, half);
  const late = rates.slice(half);
  const end = ev.findLast((e) => e.type === "session_end");
  const start = ev.find((e) => e.type === "session_start");
  sessions.push({
    id: entry.name,
    date: start?.timestamp?.slice(0, 10) ?? st.mtime.toISOString().slice(0, 10),
    turns: turns.length,
    earlyTokS: +avg(early).toFixed(2),
    lateTokS: +avg(late).toFixed(2),
    decayPct:
      early.length && late.length && avg(early) > 0
        ? Math.round((1 - avg(late) / avg(early)) * 100)
        : 0,
    ttftMsMed: med(ttfts),
    continuations: ev.filter((e) => e.type === "continuation_injected").length,
    emptyStreamRetries: ev.filter((e) => e.type === "empty_stream_retry").length,
    engineEmpty: ev.filter((e) => e.type === "engine_empty_response").length,
    errors: ev.filter((e) => e.type === "session_error").length,
    ended: Boolean(end),
    endStatus: end?.status ?? null,
  });
}

// ---------- per-task metrics ----------
const tasks = [];
for (const f of fs.readdirSync(TASKS_DIR)) {
  if (!f.startsWith("task_") || !f.endsWith(".json")) continue;
  const file = path.join(TASKS_DIR, f);
  let t;
  try {
    t = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if ((t.createdAt ?? 0) < SINCE) continue;
  const durS =
    t.startedAt && t.finishedAt ? Math.round((t.finishedAt - t.startedAt) / 1000) : null;
  tasks.push({
    id: t.id,
    sessionId: t.sessionId,
    promptChars: (t.prompt ?? "").length,
    status: t.status,
    isError: Boolean(t.isError),
    toolCalls: t.toolCallsCount ?? 0,
    durS,
    // Review aid (audit lesson): cancelled tasks that already did real work
    // deserve a human look — was it a wedge or a healthy kill?
    reviewCancel: t.status === "cancelled" && (t.toolCallsCount ?? 0) >= 5,
  });
}

// ---------- report ----------
const pct = (a) => {
  if (!a.length) return { p50: 0, p90: 0, max: 0 };
  const s = a.slice().sort((x, y) => x - y);
  return {
    p50: s[Math.floor(s.length / 2)],
    p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))],
    max: s[s.length - 1],
  };
};
const policyChecks = {
  promptsOverBudget: tasks.filter((t) => t.promptChars > 1500),
  turnCapHits: sessions.filter((s) => (s.endStatus ?? "").includes("turn_limit")),
  decayedSessions: sessions.filter((s) => s.turns >= 6 && s.decayPct >= 30),
  unclosedSessions: sessions.filter((s) => !s.ended),
  cancelsToReview: tasks.filter((t) => t.reviewCancel),
  errors: tasks.filter((t) => t.isError),
};

if (AS_JSON) {
  console.log(JSON.stringify({ days: DAYS, sessions, tasks, policyChecks }, null, 2));
  process.exit(0);
}

console.log(`dispatch-scorecard — last ${DAYS} days, state dir ${STATE_DIR}`);
console.log(
  `\nsessions: ${sessions.length}  (turns total ${sessions.reduce((a, s) => a + s.turns, 0)})`
);
console.log(
  "decayed (late <70% of early, >=6 turns): " +
    (policyChecks.decayedSessions.map((s) => `${s.id} (-${s.decayPct}%)`).join(", ") || "none")
);
console.log(`unclosed sessions (silent deaths?): ${policyChecks.unclosedSessions.length}`);
for (const s of policyChecks.unclosedSessions)
  console.log(`  ! ${s.id} (${s.date}, ${s.turns} turns) — no session_end event`);

console.log(`\ntasks: ${tasks.length}`);
const sizes = pct(tasks.map((t) => t.promptChars));
console.log(
  `prompt chars p50/p90/max: ${sizes.p50}/${sizes.p90}/${sizes.max}` +
    `  (policy budget: <=1500)`
);
for (const t of policyChecks.promptsOverBudget)
  console.log(`  ! over budget: ${t.sessionId} (${t.promptChars} chars, status=${t.status})`);
for (const t of policyChecks.turnCapHits)
  console.log(`  ! turn-limit death: ${t.id}`);
for (const t of policyChecks.cancelsToReview)
  console.log(
    `  ? cancelled after real work: ${t.sessionId} (${t.toolCalls} tool calls` +
      `${t.durS != null ? `, ${Math.round(t.durS / 60)} min` : ""}) — healthy kill or wedge?`
  );
for (const t of policyChecks.errors)
  console.log(`  ! isError: ${t.id}`);

const cont = sessions.reduce((a, s) => a + s.continuations, 0);
const retr = sessions.reduce((a, s) => a + s.emptyStreamRetries, 0);
console.log(
  `\nrecovery events: ${cont} continuation_injected, ${retr} empty_stream_retry` +
    `, ${sessions.reduce((a, s) => a + s.engineEmpty, 0)} engine_empty_response` +
    `, ${sessions.reduce((a, s) => a + s.errors, 0)} session_error`
);
