import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { SqlOrceStore, type Attempt, type Run, type Task } from "./store.js";
import { type SqlFn } from "./migrations.js";
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  isTerminalStatus,
  LifecycleTransitionError,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
} from "./state-machine.js";

function sqlFor(pg: PGlite): SqlFn {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index++) text += `$${index + 1}${strings[index + 1]}`;
    return (await pg.query(text, values)).rows;
  };
}

test("embedded store enforces every legal and illegal run/task/attempt transition", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const sql = sqlFor(pg);
  const store = new SqlOrceStore(sql);
  await store.init();

  const projectId = "00000000-0000-4000-8000-000000000001";
  const parentRun = await store.createRun(projectId, "parent", null);
  const parentTask = await store.createTask({
    run_id: parentRun.id,
    key: "parent",
    title: "Parent",
    prompt: "Parent",
    agent_id: null,
    agent_label: "Generalist",
    status: "pending",
    depends_on: [],
    output: null,
    cost_usd: null,
    error: null,
    order_idx: 0,
  });

  for (const from of RUN_STATUSES) {
    for (const to of RUN_STATUSES) {
      const row = await store.createRun(projectId, `${from} to ${to}`, null);
      await pg.query(
        `UPDATE orce_runs SET status = $1,
          terminal_reason = CASE WHEN $3 THEN 'fixture_terminal' ELSE NULL END,
          terminal_at = CASE WHEN $3 THEN now() ELSE NULL END
         WHERE id = $2`,
        [from, row.id, isTerminalStatus("run", from)]
      );
      await expectTransition(
        "run",
        from,
        to,
        (RUN_TRANSITIONS[from] as readonly string[]).includes(to),
        () => store.transitionRun(row.id, to, { actorType: "test", terminalReason: "test_reason" })
      );
    }
  }

  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      const row = await store.createTask({
        run_id: parentRun.id,
        key: `${from}-${to}-${Math.random()}`,
        title: `${from} to ${to}`,
        prompt: "test",
        agent_id: null,
        agent_label: "Generalist",
        status: "pending",
        depends_on: [],
        output: null,
        cost_usd: null,
        error: null,
        order_idx: 1,
      });
      await pg.query(
        `UPDATE orce_tasks SET status = $1,
          terminal_reason = CASE WHEN $3 THEN 'fixture_terminal' ELSE NULL END,
          terminal_at = CASE WHEN $3 THEN now() ELSE NULL END
         WHERE id = $2`,
        [from, row.id, isTerminalStatus("task", from)]
      );
      await expectTransition(
        "task",
        from,
        to,
        (TASK_TRANSITIONS[from] as readonly string[]).includes(to),
        () => store.transitionTask(row.id, to, { actorType: "test", terminalReason: "test_reason" })
      );
    }
  }

  for (const from of ATTEMPT_STATUSES) {
    for (const to of ATTEMPT_STATUSES) {
      await pg.query(
        `UPDATE orce_attempts SET status = 'stopped', terminal_reason = 'fixture_cleanup', terminal_at = now()
         WHERE task_id = $1 AND status IN ('created', 'running')`,
        [parentTask.id]
      );
      const row = await store.createAttempt({
        taskId: parentTask.id,
        idempotencyKey: `attempt:${from}:${to}:${Math.random()}`,
        actorType: "test",
      });
      await pg.query(
        `UPDATE orce_attempts SET status = $1,
          terminal_reason = CASE WHEN $3 THEN 'fixture_terminal' ELSE NULL END,
          terminal_at = CASE WHEN $3 THEN now() ELSE NULL END
         WHERE id = $2`,
        [from, row.id, isTerminalStatus("attempt", from)]
      );
      await expectTransition(
        "attempt",
        from,
        to,
        (ATTEMPT_TRANSITIONS[from] as readonly string[]).includes(to),
        () => store.transitionAttempt(row.id, to, { actorType: "test", terminalReason: "test_reason" })
      );
    }
  }

  const durableRun = await store.createRun(projectId, "survives restart", null);
  await store.transitionRun(durableRun.id, "awaiting_approval", { actorType: "test" });
  const restartedStore = new SqlOrceStore(sql);
  await restartedStore.init();
  assert.equal((await restartedStore.getRun(durableRun.id))?.status, "awaiting_approval");

  await pg.close();
});

async function expectTransition(
  kind: "run" | "task" | "attempt",
  from: string,
  to: string,
  legal: boolean,
  transition: () => Promise<Run | Task | Attempt>
) {
  if (legal) {
    const updated = await transition();
    assert.equal(updated.status, to, `${kind} ${from} -> ${to}`);
    if (isTerminalStatus(kind, to)) {
      assert.equal(updated.terminal_reason, "test_reason");
      assert(updated.terminal_at);
    }
    return;
  }

  await assert.rejects(
    transition,
    (error) => {
      assert(error instanceof LifecycleTransitionError);
      assert.equal(error.code, from === to ? "duplicate_transition" : "illegal_transition");
      return true;
    },
    `${kind} ${from} -> ${to}`
  );
}
