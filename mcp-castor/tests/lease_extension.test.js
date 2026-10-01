import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate test task state
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "lease_ext_test_"));
process.env.QWEN_STATE_DIR = testDir;

const {
  tasks,
  saveTaskToDisk,
  readTaskFromDisk,
  extendTaskBudget,
} = await import("../src/task_registry.js");
const { BASE_TURN_BUDGET, MAX_ELASTIC_TURNS } = await import("../src/config.js");

test("extendTaskBudget: increments budget and extension count for active task", () => {
  const taskId = `test_task_${Date.now()}`;
  const task = {
    id: taskId,
    sessionId: "test_session",
    cwd: process.cwd(),
    status: "running",
    done: false,
    budgetTurns: BASE_TURN_BUDGET,
    leaseExtensionsCount: 0,
    lastActivityPreview: "Analyzing file foo.js",
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);
  saveTaskToDisk(task);

  const res = extendTaskBudget(taskId, 30, "deep AST search");
  assert.equal(res.success, true);
  assert.equal(res.previousBudget, BASE_TURN_BUDGET);
  assert.equal(res.budgetTurns, BASE_TURN_BUDGET + 30);
  assert.equal(res.leaseExtensionsCount, 1);
  assert.equal(res.reason, "deep AST search");

  // Verify in memory
  assert.equal(task.budgetTurns, BASE_TURN_BUDGET + 30);
  assert.equal(task.leaseExtensionsCount, 1);

  // Verify persisted on disk
  const fromDisk = readTaskFromDisk(taskId);
  assert.equal(fromDisk.budgetTurns, BASE_TURN_BUDGET + 30);
  assert.equal(fromDisk.leaseExtensionsCount, 1);
  assert.equal(fromDisk.lastActivityPreview, "Analyzing file foo.js");
});

test("extendTaskBudget: clamps to MAX_ELASTIC_TURNS", () => {
  const taskId = `test_task_clamp_${Date.now()}`;
  const task = {
    id: taskId,
    sessionId: "test_session",
    cwd: process.cwd(),
    status: "running",
    done: false,
    budgetTurns: MAX_ELASTIC_TURNS - 10,
    leaseExtensionsCount: 1,
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);

  const res = extendTaskBudget(taskId, 50);
  assert.equal(res.success, true);
  assert.equal(res.budgetTurns, MAX_ELASTIC_TURNS);
});

test("extendTaskBudget: fails fast on non-existent or finished tasks", () => {
  const nonExistent = extendTaskBudget("non_existent_id", 20);
  assert.equal(nonExistent.success, false);
  assert.equal(nonExistent.error, "Task not found");

  const finishedId = `finished_task_${Date.now()}`;
  const finishedTask = {
    id: finishedId,
    status: "completed",
    done: true,
    budgetTurns: BASE_TURN_BUDGET,
    createdAt: Date.now(),
  };
  tasks.set(finishedId, finishedTask);

  const resDone = extendTaskBudget(finishedId, 25);
  assert.equal(resDone.success, false);
  assert.equal(resDone.error, "Task already finished");
});
