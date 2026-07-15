import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { type SqlFn } from "./migrations.js";
import { BudgetLimitError, SqlOrceStore, type TaskInput } from "./store.js";

function sqlFor(pg: PGlite): SqlFn {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index++) text += `$${index + 1}${strings[index + 1]}`;
    return (await pg.query(text, values)).rows;
  };
}

test("atomic reservations deny a provider start that would cross the integer budget", async () => {
  const pg = new PGlite(); await pg.waitReady;
  const store = new SqlOrceStore(sqlFor(pg)); await store.init();
  const run = await store.createRun(randomUUID(), "budget fixture", 1);
  const makeTask = (key: string, order_idx: number): TaskInput => ({ run_id: run.id, key, title: key, prompt: key,
    agent_id: null, agent_label: "Generalist", status: "pending", depends_on: [], output: null,
    cost_usd: null, error: null, order_idx });
  const first = await store.createTask(makeTask("first", 0));
  const second = await store.createTask(makeTask("second", 1));
  const token = randomUUID();
  const claim = await store.claimTask({ taskId: first.id, idempotencyKey: "first-attempt", actorType: "test",
    leaseOwner: "worker-a", leaseToken: token, leaseSeconds: 20, estimatedCostMicrousd: 600_000 });
  await assert.rejects(() => store.claimTask({ taskId: second.id, idempotencyKey: "second-attempt", actorType: "test",
    leaseOwner: "worker-b", leaseToken: randomUUID(), leaseSeconds: 20, estimatedCostMicrousd: 600_000 }),
    (error) => error instanceof BudgetLimitError && error.requestedMicrousd === 600_000);
  assert.equal((await store.listAttempts(second.id)).length, 0);
  await store.finishTaskClaim({ taskId: first.id, attemptId: claim.attempt.id, leaseOwner: "worker-a", leaseToken: token,
    taskStatus: "done", attemptStatus: "completed", terminalReason: "provider_completed", actorType: "test", costUsd: 0.8 });
  const persisted = await store.getRun(run.id);
  assert.equal(Number(persisted?.reserved_microusd), 0);
  assert.equal(Number(persisted?.spent_microusd), 800_000);
  const ledger = await store.listBudgetLedger(run.id);
  assert.equal(ledger.filter((entry) => entry.account === "reserved")
    .reduce((sum, entry) => sum + Number(entry.delta_microusd), 0), 0);
  assert.equal(ledger.filter((entry) => entry.account === "spent")
    .reduce((sum, entry) => sum + Number(entry.delta_microusd), 0), 800_000);
  await pg.close();
});

test("cancelling an active attempt atomically releases its reservation", async () => {
  const pg = new PGlite(); await pg.waitReady;
  const store = new SqlOrceStore(sqlFor(pg)); await store.init();
  const run = await store.createRun(randomUUID(), "cancel accounting", 1);
  await store.transitionRun(run.id, "awaiting_approval", { actorType: "test" });
  await store.applyRunCommand({ runId: run.id, action: "start", idempotencyKey: "start", actorType: "test" });
  const task = await store.createTask({ run_id: run.id, key: "cancel", title: "cancel", prompt: "cancel",
    agent_id: null, agent_label: "Generalist", status: "pending", depends_on: [], output: null,
    cost_usd: null, error: null, order_idx: 0 });
  await store.claimTask({ taskId: task.id, idempotencyKey: "cancel-attempt", actorType: "test",
    leaseOwner: "worker", leaseToken: randomUUID(), leaseSeconds: 20, estimatedCostMicrousd: 700_000 });
  await store.applyRunCommand({ runId: run.id, action: "cancel", idempotencyKey: "cancel", actorType: "test" });
  assert.equal(Number((await store.getRun(run.id))?.reserved_microusd), 0);
  const reservedDelta = (await store.listBudgetLedger(run.id)).filter((entry) => entry.account === "reserved")
    .reduce((sum, entry) => sum + Number(entry.delta_microusd), 0);
  assert.equal(reservedDelta, 0);
  await pg.close();
});

test("provider spend reconciliation is idempotent", async () => {
  const pg = new PGlite(); await pg.waitReady;
  const store = new SqlOrceStore(sqlFor(pg)); await store.init();
  const run = await store.createRun(randomUUID(), "planner accounting", 1);
  await Promise.all(Array.from({ length: 20 }, () => store.recordBudgetSpend(run.id, 125_000, "planner-once")));
  assert.equal(Number((await store.getRun(run.id))?.spent_microusd), 125_000);
  assert.equal((await store.listBudgetLedger(run.id)).length, 1);
  await pg.close();
});

test("provider timeout enters needs_attention and retains the reservation until usage reconciliation", async () => {
  const pg = new PGlite(); await pg.waitReady;
  const store = new SqlOrceStore(sqlFor(pg)); await store.init();
  const run = await store.createRun(randomUUID(), "ambiguous provider timeout", 1);
  const task = await store.createTask({ run_id: run.id, key: "timeout", title: "timeout", prompt: "timeout",
    agent_id: null, agent_label: "Generalist", status: "pending", depends_on: [], output: null,
    cost_usd: null, error: null, order_idx: 0 });
  const token = randomUUID();
  const claim = await store.claimTask({ taskId: task.id, idempotencyKey: "timeout-attempt", actorType: "test",
    leaseOwner: "worker", leaseToken: token, leaseSeconds: 20, estimatedCostMicrousd: 400_000 });

  await store.finishTaskClaim({ taskId: task.id, attemptId: claim.attempt.id, leaseOwner: "worker", leaseToken: token,
    taskStatus: "needs_attention", attemptStatus: "needs_attention",
    terminalReason: "provider_usage_reconciliation_required", actorType: "test",
    error: "provider timed out after dispatch" });

  const persisted = await store.getRun(run.id);
  assert.equal(Number(persisted?.reserved_microusd), 400_000);
  assert.equal(Number(persisted?.spent_microusd), 0);
  const ledger = await store.listBudgetLedger(run.id);
  assert.equal(ledger.filter((entry) => entry.account === "reserved")
    .reduce((sum, entry) => sum + Number(entry.delta_microusd), 0), 400_000);
  assert.equal(ledger.filter((entry) => entry.account === "spent").length, 0);
  assert.equal((await store.listTasks(run.id))[0].status, "needs_attention");
  await pg.close();
});
