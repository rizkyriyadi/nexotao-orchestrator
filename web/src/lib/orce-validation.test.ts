import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorMessage } from "../api";
import { reduceOrceRun } from "./parts";

test("422 plan validation response becomes concise operator-facing UI copy", async () => {
  const response = new Response(
    JSON.stringify({
      code: "invalid_plan",
      error: 'Planner produced an invalid task graph after 2 attempts: Task "review" depends on missing task "build"',
      issues: [
        {
          code: "dangling_dependency",
          message: 'Task "review" depends on missing task "build"',
          nodes: ["review", "build"],
          edges: ["review->build"],
        },
      ],
    }),
    { status: 422, headers: { "content-type": "application/json" } }
  );
  assert.equal(
    await apiErrorMessage(response),
    'Planner produced an invalid task graph after 2 attempts: Task "review" depends on missing task "build"'
  );
});

test("streamed validation failure terminates the run UI visibly", () => {
  const started = reduceOrceRun(null, {
    type: "run_start",
    runId: "run-1",
    goal: "ship safely",
    budgetUsd: null,
    images: [],
  });
  assert(started);
  const failed = reduceOrceRun(started, {
    type: "error",
    message: "Scheduler deadlock: blocked nodes: review <- [build:missing]",
  });
  assert(failed);
  assert.equal(failed.phase, "done");
  assert.match(failed.error ?? "", /review.*build:missing/);
});

test("recovery-required tasks remain visibly distinct from ordinary failures", () => {
  const started = reduceOrceRun(null, {
    type: "run_start", runId: "run-timeout", goal: "recover safely", budgetUsd: 1, images: [],
  });
  const planned = reduceOrceRun(started, {
    type: "plan",
    tasks: [{ id: "task-timeout", ticket: "TASK-0001", key: "timeout", title: "Provider call",
      agentLabel: "Generalist", dependsOn: [], status: "running" }],
  });
  const attention = reduceOrceRun(planned, {
    type: "task_status", id: "task-timeout", status: "needs_attention",
  });
  assert.equal(attention?.tasks[0].status, "needs_attention");
});
