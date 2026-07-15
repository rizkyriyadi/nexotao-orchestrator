import assert from "node:assert/strict";
import test from "node:test";
import { readyTaskKeys, schedulerDecision, type SchedulerStatus } from "./dag-scheduler.js";

const tasks = [
  { key: "first", depends_on: [] },
  { key: "parallel", depends_on: [] },
  { key: "last", depends_on: ["first", "parallel"] },
];

test("ready task selection is deterministic and respects dependency order", () => {
  const status = new Map<string, SchedulerStatus>(tasks.map((task) => [task.key, "pending"]));
  assert.deepEqual(readyTaskKeys(tasks, status, 4), ["first", "parallel"]);
  assert.deepEqual(readyTaskKeys(tasks, status, 1), ["first"]);
  status.set("first", "done");
  assert.deepEqual(readyTaskKeys(tasks, status, 4), ["parallel"]);
  status.set("parallel", "done");
  assert.deepEqual(readyTaskKeys(tasks, status, 4), ["last"]);
});

test("scheduler waits only with an active promise and never treats pending deadlock as completion", () => {
  const cyclic = [
    { key: "a", depends_on: ["b"] },
    { key: "b", depends_on: ["a"] },
  ];
  const pending = new Map<string, SchedulerStatus>(cyclic.map((task) => [task.key, "pending"]));

  const deadlock = schedulerDecision(cyclic, pending, 0, false);
  assert.equal(deadlock.kind, "deadlock");
  if (deadlock.kind === "deadlock") {
    assert.deepEqual(deadlock.pendingKeys, ["a", "b"]);
    assert.match(deadlock.message, /a <- \[b:pending\]/);
    assert.match(deadlock.message, /b <- \[a:pending\]/);
  }
  assert.deepEqual(schedulerDecision(cyclic, pending, 1, false), { kind: "wait" });
  assert.deepEqual(schedulerDecision(cyclic, pending, 0, true), { kind: "budget_halt" });

  pending.set("a", "failed");
  pending.set("b", "skipped");
  assert.deepEqual(schedulerDecision(cyclic, pending, 0, false), { kind: "complete" });
});

test("dangling dependencies produce an operator-facing deadlock edge", () => {
  const dangling = [{ key: "blocked", depends_on: ["missing"] }];
  const status = new Map<string, SchedulerStatus>([["blocked", "pending"]]);
  const decision = schedulerDecision(dangling, status, 0, false);
  assert.equal(decision.kind, "deadlock");
  if (decision.kind === "deadlock") assert.match(decision.message, /missing:missing/);
});
