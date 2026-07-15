import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { type SqlFn } from "./migrations.js";
import { LifecycleTransitionError } from "./state-machine.js";
import { SqlOrceStore, type TaskInput } from "./store.js";

function sqlFor(pg: PGlite): SqlFn {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index++) text += `$${index + 1}${strings[index + 1]}`;
    return (await pg.query(text, values)).rows;
  };
}

async function fixture() {
  const pg = new PGlite();
  await pg.waitReady;
  const store = new SqlOrceStore(sqlFor(pg));
  await store.init();
  const projectId = "00000000-0000-4000-8000-000000000015";
  const run = await store.createRun(projectId, "atomic claim fixture", null);
  await store.transitionRun(run.id, "awaiting_approval", { actorType: "test" });
  const taskInput: TaskInput = {
    run_id: run.id,
    key: "claim",
    title: "Claim",
    prompt: "test",
    agent_id: null,
    agent_label: "Generalist",
    status: "pending",
    depends_on: [],
    output: null,
    cost_usd: null,
    error: null,
    order_idx: 0,
  };
  const task = await store.createTask(taskInput);
  return { pg, store, run, task };
}

test("100 repeated start claims create one active attempt and one provider identity", async () => {
  const { pg, store, task } = await fixture();
  const commandKey = `start:${randomUUID()}:task:${task.id}`;
  const claims = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      store.claimTask({
        taskId: task.id,
        idempotencyKey: commandKey,
        actorType: "test",
        providerRequestKey: `provider:${commandKey}`,
        leaseOwner: `worker-${index}`,
        leaseToken: randomUUID(),
        leaseSeconds: 20,
      })
    )
  );

  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal(new Set(claims.map((claim) => claim.attempt.id)).size, 1);
  assert.equal(new Set(claims.map((claim) => claim.attempt.provider_request_key)).size, 1);
  assert.equal((await store.listAttempts(task.id)).length, 1);
  await pg.close();
});

test("100 reconnect and startup-resume cycles reuse one command and one attempt", async () => {
  const { pg, store, run, task } = await fixture();
  const startKey = `start:${run.id}`;
  await store.applyRunCommand({ runId: run.id, action: "start", idempotencyKey: startKey, actorType: "test" });

  const reconnects = await Promise.all(
    Array.from({ length: 100 }, () =>
      store.applyRunCommand({ runId: run.id, action: "start", idempotencyKey: startKey, actorType: "test" })
    )
  );
  assert(reconnects.every((reconnected) => reconnected.status === "running"));

  const recoveries = await Promise.all(Array.from({ length: 100 }, () => store.recoverStartup("replacement-process")));
  assert(recoveries.every((recovery) => recovery.resumableRunIds.includes(run.id)));

  const resumeKey = `startup-resume:${run.id}`;
  await Promise.all(
    Array.from({ length: 100 }, () =>
      store.applyRunCommand({ runId: run.id, action: "resume", idempotencyKey: resumeKey, actorType: "startup_recovery" })
    )
  );
  const claims = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      store.claimTask({
        taskId: task.id,
        idempotencyKey: `${resumeKey}:task:${task.id}`,
        actorType: "scheduler",
        providerRequestKey: `${resumeKey}:provider:${task.id}`,
        leaseOwner: `replacement-${index}`,
        leaseToken: randomUUID(),
        leaseSeconds: 20,
      })
    )
  );

  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal(new Set(claims.map((claim) => claim.attempt.id)).size, 1);
  assert.equal((await store.listAttempts(task.id)).length, 1);
  const commandCounts = await pg.query<{ action: string; count: number }>(
    "SELECT action, count(*)::int AS count FROM orce_run_commands WHERE run_id = $1 GROUP BY action ORDER BY action",
    [run.id]
  );
  assert.deepEqual(commandCounts.rows, [
    { action: "resume", count: 1 },
    { action: "start", count: 1 },
  ]);
  await pg.close();
});

test("100 distinct workers cannot claim the same live task lease", async () => {
  const { pg, store, task } = await fixture();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 100 }, (_, index) =>
      store.claimTask({
        taskId: task.id,
        idempotencyKey: `command:${index}:${randomUUID()}`,
        actorType: "test",
        leaseOwner: `worker-${index}`,
        leaseToken: randomUUID(),
        leaseSeconds: 20,
      })
    )
  );

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") continue;
    assert(outcome.reason instanceof LifecycleTransitionError);
    assert.equal(outcome.reason.code, "lease_held");
  }
  assert.equal((await store.listAttempts(task.id)).length, 1);
  await pg.close();
});

test("expired owners cannot heartbeat or commit after a replacement claim", async () => {
  const { pg, store, task } = await fixture();
  const firstToken = randomUUID();
  const first = await store.claimTask({
    taskId: task.id,
    idempotencyKey: "first",
    actorType: "test",
    leaseOwner: "worker-a",
    leaseToken: firstToken,
    leaseSeconds: 20,
  });
  await pg.query("UPDATE orce_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [task.id]);
  assert.equal(await store.heartbeatTaskClaim(task.id, first.attempt.id, "worker-a", firstToken, 20), false);

  const secondToken = randomUUID();
  const second = await store.claimTask({
    taskId: task.id,
    idempotencyKey: "second",
    actorType: "test",
    leaseOwner: "worker-b",
    leaseToken: secondToken,
    leaseSeconds: 20,
  });
  assert.equal(second.claimed, true);

  await assert.rejects(
    () =>
      store.finishTaskClaim({
        taskId: task.id,
        attemptId: first.attempt.id,
        leaseOwner: "worker-a",
        leaseToken: firstToken,
        taskStatus: "done",
        attemptStatus: "completed",
        terminalReason: "stale_result",
        actorType: "test",
      }),
    (error) => error instanceof LifecycleTransitionError && error.code === "stale_lease"
  );

  const completed = await store.finishTaskClaim({
    taskId: task.id,
    attemptId: second.attempt.id,
    leaseOwner: "worker-b",
    leaseToken: secondToken,
    taskStatus: "done",
    attemptStatus: "completed",
    terminalReason: "provider_completed",
    actorType: "test",
    output: "owned result",
  });
  assert.equal(completed.status, "done");
  assert.equal(completed.output, "owned result");
  const attempts = await store.listAttempts(task.id);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["needs_attention", "completed"]);
  await pg.close();
});

test("start, cancel, and retry commands are idempotent under 100 repeated requests", async () => {
  const { pg, store, run, task } = await fixture();
  await Promise.all(
    Array.from({ length: 100 }, () =>
      store.applyRunCommand({ runId: run.id, action: "start", idempotencyKey: "start-once", actorType: "test" })
    )
  );
  assert.equal((await store.getRun(run.id))?.status, "running");

  await store.transitionRun(run.id, "failed", { actorType: "test", terminalReason: "injected_failure" });
  await Promise.all(
    Array.from({ length: 100 }, () =>
      store.applyRunCommand({ runId: run.id, action: "retry", idempotencyKey: "retry-once", actorType: "test" })
    )
  );
  assert.equal((await store.getRun(run.id))?.status, "running");

  const activeAttempt = await store.claimTask({
    taskId: task.id,
    idempotencyKey: "cancelled-attempt",
    actorType: "test",
    leaseOwner: "worker",
    leaseToken: randomUUID(),
    leaseSeconds: 20,
  });

  await Promise.all(
    Array.from({ length: 100 }, () =>
      store.applyRunCommand({ runId: run.id, action: "cancel", idempotencyKey: "cancel-once", actorType: "test" })
    )
  );
  assert.equal((await store.getRun(run.id))?.status, "stopped");
  assert.equal((await store.listAttempts(task.id)).find((attempt) => attempt.id === activeAttempt.attempt.id)?.status, "stopped");
  assert.equal((await store.listTasks(run.id))[0].status, "failed");

  const commandCounts = await pg.query<{ action: string; count: number }>(
    "SELECT action, count(*)::int AS count FROM orce_run_commands WHERE run_id = $1 GROUP BY action ORDER BY action",
    [run.id]
  );
  assert.deepEqual(commandCounts.rows, [
    { action: "cancel", count: 1 },
    { action: "retry", count: 1 },
    { action: "start", count: 1 },
  ]);
  await pg.close();
});

test("startup recovery resumes unambiguous work and flags expired provider work with a next action", async () => {
  const { pg, store, run, task } = await fixture();
  await store.applyRunCommand({ runId: run.id, action: "start", idempotencyKey: "start", actorType: "test" });
  const recoveryWithoutAttempt = await store.recoverStartup("new-process");
  assert.deepEqual(recoveryWithoutAttempt.resumableRunIds, [run.id]);

  const token = randomUUID();
  await store.claimTask({
    taskId: task.id,
    idempotencyKey: "killed-worker",
    actorType: "test",
    leaseOwner: "old-process",
    leaseToken: token,
    leaseSeconds: 20,
  });
  await pg.query("UPDATE orce_tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [task.id]);
  const recovered = await store.recoverStartup("new-process");
  assert.deepEqual(recovered.attentionRunIds, [run.id]);
  const recoveredRun = await store.getRun(run.id);
  assert.equal(recoveredRun?.status, "needs_attention");
  assert.match(recoveredRun?.error ?? "", /reconcile provider usage, then retry/i);
  assert.equal((await store.listTasks(run.id))[0].status, "needs_attention");

  const planning = await store.createRun("00000000-0000-4000-8000-000000000015", "interrupted plan", null);
  const livePlanning = await store.createRun("00000000-0000-4000-8000-000000000015", "live plan", null);
  const exclusionRecovery = await store.recoverStartup("same-process", [livePlanning.id]);
  assert(exclusionRecovery.attentionRunIds.includes(planning.id));
  assert.equal((await store.getRun(livePlanning.id))?.status, "planning");
  const planningRecovery = await store.recoverStartup("new-process");
  assert(planningRecovery.attentionRunIds.includes(livePlanning.id));
  assert.equal((await store.getRun(planning.id))?.status, "needs_attention");
  assert.equal((await store.getRun(livePlanning.id))?.status, "needs_attention");
  await pg.close();
});

test("a killed worker is fenced and classified within 30 seconds after a fresh store starts", async () => {
  const { pg, store, run, task } = await fixture();
  await store.applyRunCommand({ runId: run.id, action: "start", idempotencyKey: "start", actorType: "test" });
  await store.claimTask({
    taskId: task.id,
    idempotencyKey: "killed-process",
    actorType: "test",
    leaseOwner: "killed-process",
    leaseToken: randomUUID(),
    leaseSeconds: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const restartedStore = new SqlOrceStore(sqlFor(pg));
  await restartedStore.init();
  const restartedAt = Date.now();
  const recovery = await restartedStore.recoverStartup("replacement-process");

  assert(Date.now() - restartedAt < 30_000);
  assert.deepEqual(recovery.attentionRunIds, [run.id]);
  assert.equal((await restartedStore.getRun(run.id))?.status, "needs_attention");
  await pg.close();
});

test("startup recovery classifies planning, approval, running, and terminal lifecycle states", async () => {
  const { pg, store } = await fixture();
  const projectId = "00000000-0000-4000-8000-000000000015";
  const planning = await store.createRun(projectId, "planning", null);
  const awaiting = await store.createRun(projectId, "awaiting", null);
  await store.transitionRun(awaiting.id, "awaiting_approval", { actorType: "test" });
  const resumable = await store.createRun(projectId, "resumable", null);
  await store.transitionRun(resumable.id, "awaiting_approval", { actorType: "test" });
  await store.applyRunCommand({ runId: resumable.id, action: "start", idempotencyKey: "start", actorType: "test" });
  const unleased = await store.createRun(projectId, "legacy unleased", null);
  await store.transitionRun(unleased.id, "awaiting_approval", { actorType: "test" });
  await store.applyRunCommand({ runId: unleased.id, action: "start", idempotencyKey: "start", actorType: "test" });
  const unleasedTask = await store.createTask({
    run_id: unleased.id,
    key: "legacy",
    title: "Legacy",
    prompt: "legacy",
    agent_id: null,
    agent_label: "Generalist",
    status: "pending",
    depends_on: [],
    output: null,
    cost_usd: null,
    error: null,
    order_idx: 0,
  });
  await pg.query("UPDATE orce_tasks SET status = 'running' WHERE id = $1", [unleasedTask.id]);
  const completed = await store.createRun(projectId, "completed", null);
  await store.transitionRun(completed.id, "awaiting_approval", { actorType: "test" });
  await store.applyRunCommand({ runId: completed.id, action: "start", idempotencyKey: "start", actorType: "test" });
  await store.transitionRun(completed.id, "completed", { actorType: "test", terminalReason: "done" });
  const failed = await store.createRun(projectId, "failed", null);
  await store.transitionRun(failed.id, "failed", { actorType: "test", terminalReason: "injected_failure" });
  const stopped = await store.createRun(projectId, "stopped", null);
  await store.transitionRun(stopped.id, "stopped", { actorType: "test", terminalReason: "operator_cancelled" });
  const needsAttention = await store.createRun(projectId, "needs attention", null);
  await store.transitionRun(needsAttention.id, "needs_attention", {
    actorType: "test",
    terminalReason: "manual_reconciliation_required",
  });

  const recovery = await store.recoverStartup("new-process");
  assert(recovery.attentionRunIds.includes(planning.id));
  assert(recovery.attentionRunIds.includes(unleased.id));
  assert(recovery.resumableRunIds.includes(resumable.id));
  assert.equal((await store.getRun(awaiting.id))?.status, "awaiting_approval");
  assert.equal((await store.getRun(completed.id))?.status, "completed");
  assert.equal((await store.getRun(failed.id))?.status, "failed");
  assert.equal((await store.getRun(stopped.id))?.status, "stopped");
  assert.equal((await store.getRun(needsAttention.id))?.status, "needs_attention");
  await pg.close();
});
