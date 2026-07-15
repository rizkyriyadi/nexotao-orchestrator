import { randomUUID } from "node:crypto";
import { runAgent, type AgentEvent } from "../agent.js";
import { config } from "../config.js";
import { ensureGraph } from "../graph.js";
import { activeCwd, activeProjectId } from "../projects.js";
import { createHub, type Hub } from "../stream-hub.js";
import type { ImageInput } from "../images.js";
import { LifecycleTransitionError } from "./state-machine.js";
import {
  BudgetLimitError,
  orceStore,
  type Agent,
  type AgentInput,
  type Attempt,
  type RunCommandAction,
  type Task,
  type TaskStatus,
} from "./store.js";
import { readyTaskKeys, schedulerDecision } from "./dag-scheduler.js";
import {
  generateValidatedPlan,
  PlanValidationError,
  validatePlan,
  type PlannedTask,
} from "./plan-validation.js";
import { GitWorktreeManager, type PreparedWorktree } from "./worktrees.js";

const ENGINE_INSTANCE_ID = `engine:${randomUUID()}`;
const TASK_LEASE_SECONDS = 20;

/** Anything that can receive streamed run events (a queue or a background hub). */
export type EventSink = { push(ev: OrceEvent): void };

/* ------------------------------------------------------------------ */
/* Events streamed to the client                                      */
/* ------------------------------------------------------------------ */

export interface TaskMeta {
  id: string;
  ticket: string;
  key: string;
  title: string;
  agentLabel: string;
  dependsOn: string[];
  status: TaskStatus;
}

export type OrceEvent =
  | { type: "run_start"; runId: string; goal: string; budgetUsd: number | null; images: ImageInput[] }
  | { type: "planning" }
  | { type: "plan"; tasks: TaskMeta[] }
  | { type: "task_status"; id: string; status: TaskStatus }
  | { type: "task_delta"; id: string; ev: AgentEvent }
  | { type: "budget"; spent: number; limit: number | null; warn: boolean; stopped: boolean }
  | { type: "log"; at: string; level: "info" | "warn" | "error"; message: string; taskId?: string }
  | { type: "run_done"; status: "completed" | "failed" | "stopped"; costUsd: number }
  | { type: "error"; message: string };

/* ------------------------------------------------------------------ */
/* Planner — decompose a goal into a task DAG                          */
/* ------------------------------------------------------------------ */

function extractJson(text: string): any | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function planGoal(
  goal: string,
  agents: Agent[],
  signal: AbortSignal,
  images: ImageInput[]
): Promise<{ tasks: PlannedTask[]; costUsd: number }> {
  const roster = agents.map((a) => `- ${a.name}: ${a.role}`).join("\n");
  const limits = { maxNodes: config.orcePlanMaxNodes, maxDepth: config.orcePlanMaxDepth };
  const prompt =
    `You are the ORCHESTRATION PLANNER. Break the user's goal into a small DAG of concrete tasks ` +
    `(1 to ${limits.maxNodes}; normally 2 to 6).\n\n` +
    `GOAL:\n${goal}\n\n` +
    `AVAILABLE AGENTS (assign each task to the best-fit one by exact name):\n${roster}\n\n` +
    `Rules:\n` +
    `- Each task needs: a unique short "key" (slug), a "title", a detailed "prompt" (full standalone instructions for the worker), the "agent" name, and "depends_on" (array of task keys that must finish first; [] if independent).\n` +
    `- Split the work so each distinct, independently-ownable piece is its OWN task assigned to the most suitable agent — when parts can run in parallel, give them to different agents so they run concurrently. Match the decomposition to the available agents above.\n` +
    `- Add a dependency only when a task genuinely needs another's output. Independent tasks run in parallel.\n` +
    `- The graph must be acyclic and no dependency path may exceed ${limits.maxDepth} tasks.\n` +
    `- Don't split just to inflate the count: if the goal is genuinely a single unit of work, ONE task is correct. Otherwise prefer distinct tasks over one monolithic task.\n` +
    `- A final review/synthesis task (Reviewer) depending on the others is often worthwhile.\n` +
    `- You may briefly inspect the workspace (read-only) before planning.\n\n` +
    `Respond with ONLY a JSON code block:\n` +
    '```json\n{"tasks":[{"key":"slug","title":"...","prompt":"...","agent":"Name","depends_on":[]}]}\n```';

  const planned = await generateValidatedPlan(prompt, agents.map((agent) => agent.name), limits, async (attemptPrompt) => {
    let text = "";
    let costUsd = 0;
    for await (const ev of runAgent(attemptPrompt, undefined, signal, undefined, {
      allowedTools: ["Read", "Grep", "Glob"],
      graphCwd: activeCwd(),
      images,
    })) {
      if (ev.type === "text_delta") text += ev.text;
      if (ev.type === "result") {
        costUsd = ev.costUsd ?? 0;
        if (ev.text) text = ev.text;
      }
    }
    return { text, costUsd };
  });
  return { tasks: planned.tasks, costUsd: planned.costUsd };
}

/* ------------------------------------------------------------------ */
/* Isolated working directory (per-task) — prevents parallel-write     */
/* collisions for agents flagged `isolate`.                            */
/* ------------------------------------------------------------------ */

function canWrite(agent: Agent | null): boolean {
  if (!agent || agent.isolate || agent.tools === null) return true;
  return agent.tools.some((tool) => ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool));
}

/* ------------------------------------------------------------------ */
/* Scheduler — execute the DAG, parallel where dependencies allow      */
/* ------------------------------------------------------------------ */

const MAX_PARALLEL = 4;

function toMeta(tasks: Task[]): TaskMeta[] {
  return tasks.map((t) => ({
    id: t.id,
    ticket: t.ticket,
    key: t.key,
    title: t.title,
    agentLabel: t.agent_label,
    dependsOn: t.depends_on,
    status: t.status,
  }));
}

/**
 * Plan phase — create the run + task DAG, leave it "awaiting_approval".
 * Emits to `q` when running in auto mode; runs silently for the approval flow.
 */
async function planPhase(
  goal: string,
  budgetUsd: number | null,
  signal: AbortSignal,
  images: ImageInput[],
  q?: EventSink
): Promise<{ runId: string }> {
  const run = await orceStore.createRun(activeProjectId()!, goal, budgetUsd, images);
  try {
    await planInto(run.id, goal, budgetUsd, signal, q);
  } catch (error) {
    await persistBackgroundFailure(run.id, error, signal.aborted ? "planning_cancelled" : "planning_failed");
    throw error;
  }
  return { runId: run.id };
}

/** Decompose a goal into a DAG under an already-created run row. */
async function planInto(
  runId: string,
  goal: string,
  budgetUsd: number | null,
  signal: AbortSignal,
  q?: EventSink
): Promise<void> {
  const agents = await orceStore.listAgents(activeProjectId()!);
  const byName = new Map(agents.map((a) => [a.name, a]));

  const run = await orceStore.getRun(runId);
  if (!run) throw new Error("run not found");
  const images = run.attachments ?? [];
  const log = async (taskId: string | null, type: string, level: "info" | "warn" | "error", message: string) => {
    await orceStore.addEvent(run.id, taskId, type, level, message);
    q?.push({ type: "log", at: new Date().toISOString(), level, message, taskId: taskId ?? undefined });
  };

  q?.push({ type: "run_start", runId: run.id, goal, budgetUsd, images });
  q?.push({ type: "planning" });
  await log(null, "run.created", "info", `Run created${budgetUsd != null ? ` · budget $${budgetUsd.toFixed(2)}` : ""}`);
  // Build/refresh the workspace knowledge graph while the planner works.
  void ensureGraph(activeCwd());
  await log(null, "plan.start", "info", "Planner is decomposing the goal into a task DAG");

  let planned: PlannedTask[];
  let planCost: number;
  try {
    ({ tasks: planned, costUsd: planCost } = await planGoal(goal, agents, signal, images));
  } catch (error) {
    if (error instanceof PlanValidationError) await log(null, "plan.invalid", "error", error.message);
    throw error;
  }
  await orceStore.recordBudgetSpend(run.id, Math.round(planCost * 1_000_000), `run:${run.id}:planner`);
  const created: Task[] = [];
  let idx = 0;
  for (const p of planned) {
    const agent = byName.get(p.agent);
    if (!agent) {
      throw new PlanValidationError([
        { code: "unknown_agent", message: `Agent "${p.agent}" disappeared before task creation`, nodes: [p.key] },
      ]);
    }
    created.push(
      await orceStore.createTask({
        run_id: run.id,
        key: p.key,
        title: p.title || p.key,
        prompt: p.prompt || goal,
        agent_id: agent.id,
        agent_label: agent.name,
        status: "pending",
        depends_on: p.depends_on,
        output: null,
        cost_usd: null,
        error: null,
        order_idx: idx++,
      })
    );
  }

  await orceStore.transitionRun(
    run.id,
    "awaiting_approval",
    { actorType: "planner" },
    { cost_usd: planCost }
  );
  await log(null, "plan.ready", "info", `Plan ready · ${created.length} tasks · awaiting approval`);
  q?.push({ type: "plan", tasks: toMeta(created) });
  q?.push({ type: "budget", spent: planCost, limit: budgetUsd, warn: false, stopped: false });
}

/** Execute phase — run an already-planned DAG, streaming task events. */
async function executePhase(
  runId: string,
  signal: AbortSignal,
  q: EventSink,
  emitStart = false,
  executionKey = `resume:${runId}`
) {
  const run = await orceStore.getRun(runId);
  if (!run) throw new Error("run not found");
  const goal = run.goal;
  const budgetUsd = run.budget_usd;

  const log = async (taskId: string | null, type: string, level: "info" | "warn" | "error", message: string) => {
    await orceStore.addEvent(runId, taskId, type, level, message);
    q.push({ type: "log", at: new Date().toISOString(), level, message, taskId: taskId ?? undefined });
  };

  const dbList = await orceStore.listTasks(runId);
  const dbTasks = new Map<string, Task>(dbList.map((task) => [task.key, task]));

  if (emitStart) {
    q.push({ type: "run_start", runId, goal, budgetUsd, images: run.attachments ?? [] });
    q.push({ type: "plan", tasks: toMeta(dbList) });
    q.push({ type: "budget", spent: run.cost_usd, limit: budgetUsd, warn: false, stopped: false });
  }

  try {
    validatePlan(
      {
        tasks: dbList.map((task) => ({
          key: task.key,
          title: task.title,
          prompt: task.prompt,
          agent: task.agent_label,
          depends_on: task.depends_on,
        })),
      },
      [...new Set(dbList.map((task) => task.agent_label))],
      { maxNodes: config.orcePlanMaxNodes, maxDepth: config.orcePlanMaxDepth }
    );
  } catch (error) {
    if (!(error instanceof PlanValidationError)) throw error;
    const message = `Stored task graph rejected before execution: ${error.issues.map((issue) => issue.message).join("; ")}`;
    for (const task of dbList) {
      if (task.status !== "pending") continue;
      await orceStore.transitionTask(task.id, "failed", {
        actorType: "scheduler",
        terminalReason: "invalid_task_graph",
        error: message,
      });
      q.push({ type: "task_status", id: task.id, status: "failed" });
    }
    await orceStore.transitionRun(runId, "failed", {
      actorType: "scheduler",
      terminalReason: "invalid_task_graph",
      error: message,
    });
    await log(null, "scheduler.invalid_graph", "error", message);
    q.push({ type: "error", message });
    q.push({ type: "run_done", status: "failed", costUsd: run.cost_usd });
    return;
  }

  let totalCost = run.cost_usd; // already includes planner cost
  // Make sure the knowledge graph is ready before workers start (coalesced with planPhase).
  await ensureGraph(activeCwd());
  await log(null, "exec.start", "info", "Approved — execution started");

  const status = new Map<string, TaskStatus>([...dbTasks.values()].map((t) => [t.key, t.status]));
  const outputs = new Map<string, string>([...dbTasks.values()].filter((t) => t.output).map((t) => [t.key, t.output!]));
  const running = new Map<string, Promise<void>>();

  const depsFailed = (t: Task) => t.depends_on.some((k) => ["failed", "skipped", "needs_attention"].includes(status.get(k) ?? ""));

  let budgetWarned = false;
  let budgetStopped = false;
  let deadlockMessage: string | null = null;

  const emitBudget = () =>
    q.push({ type: "budget", spent: totalCost, limit: budgetUsd, warn: budgetWarned, stopped: budgetStopped });

  const runTask = async (t: Task) => {
    const agent = t.agent_id ? await orceStore.getAgent(t.agent_id) : null;
    const provider = agent?.model ?? null;
    const leaseToken = randomUUID();
    let attempt: Attempt;
    try {
      const claim = await orceStore.claimTask({
        taskId: t.id,
        idempotencyKey: `${executionKey}:task:${t.id}`,
        actorType: "scheduler",
        actorId: agent?.id ?? null,
        provider,
        providerRequestKey: `${executionKey}:provider:${t.id}`,
        leaseOwner: ENGINE_INSTANCE_ID,
        leaseToken,
        leaseSeconds: TASK_LEASE_SECONDS,
        estimatedCostMicrousd: config.taskReservationMicrousd,
      });
      attempt = claim.attempt;
      if (!claim.claimed) {
        status.set(t.key, claim.attempt.status === "completed" ? "done" : claim.attempt.status === "failed" ? "failed" : "running");
        return;
      }
    } catch (error) {
      if (error instanceof BudgetLimitError) {
        budgetStopped = true;
        await log(null, "budget.stop", "warn",
          `Reservation denied · requested $${(error.requestedMicrousd / 1_000_000).toFixed(2)} · ` +
          `spent/reserved $${((error.spentMicrousd + error.reservedMicrousd) / 1_000_000).toFixed(2)} of ` +
          `$${(error.budgetMicrousd / 1_000_000).toFixed(2)} — no provider call started`);
        emitBudget();
        return;
      }
      if (error instanceof LifecycleTransitionError && error.code === "lease_held") {
        status.set(t.key, "running");
        return;
      }
      throw error;
    }
    status.set(t.key, "running");
    q.push({ type: "task_status", id: t.id, status: "running" });
    await log(t.id, "task.running", "info", `▶ ${t.ticket} · ${t.title} · ${t.agent_label}`);

    let cwd = activeCwd();
    let preparedWorktree: PreparedWorktree | null = null;
    let providerError: string | null = null;
    let requiresAttention = false;
    let requiresProviderReconciliation = false;
    const worktrees = new GitWorktreeManager(activeCwd());
    if (canWrite(agent)) {
      try {
        preparedWorktree = await worktrees.prepare(attempt.id, ENGINE_INSTANCE_ID);
        cwd = preparedWorktree.path;
        await orceStore.updateAttemptWorktree(attempt.id, { baseCommit: preparedWorktree.baseCommit, path: preparedWorktree.path, repositoryPath: preparedWorktree.repositoryRoot, owner: ENGINE_INSTANCE_ID, status: "active" });
      } catch (error) {
        providerError = error instanceof Error ? error.message : String(error);
      }
    }

    // Goal ancestry — the worker sees the mission and where its task sits.
    const ancestry = [`Overall mission: ${goal}`, `Your task: ${t.title}`];
    if (t.depends_on.length) ancestry.push(`Builds on upstream tasks: ${t.depends_on.join(", ")}`);
    const context = t.depends_on
      .map((k) => outputs.get(k))
      .filter(Boolean)
      .map((o, i) => `### Upstream result ${i + 1}\n${o}`)
      .join("\n\n");
    const prompt =
      `## Mission context (why this task exists)\n${ancestry.join("\n")}\n\n` +
      `## Your task\n${t.prompt}` +
      (context ? `\n\n---\nContext from completed upstream tasks:\n\n${context}` : "");

    let text = "";
    let cost = 0;
    const taskController = new AbortController();
    const abortTask = () => taskController.abort();
    signal.addEventListener("abort", abortTask, { once: true });
    if (signal.aborted) taskController.abort();
    const heartbeat = setInterval(() => {
      void orceStore
        .heartbeatTaskClaim(t.id, attempt.id, ENGINE_INSTANCE_ID, leaseToken, TASK_LEASE_SECONDS)
        .then((owned) => {
          if (!owned) taskController.abort();
        })
        .catch(() => taskController.abort());
    }, (TASK_LEASE_SECONDS * 1_000) / 3);
    try {
      if (providerError === null) for await (const ev of runAgent(prompt, undefined, taskController.signal, cwd, {
        model: agent?.model ?? undefined,
        allowedTools: agent?.tools ?? undefined,
        appendPrompt: agent?.system_prompt || undefined,
        graphCwd: activeCwd(),
        images: run.attachments ?? [],
      })) {
        if (ev.type === "text_delta") text += ev.text;
        if (ev.type === "result") {
          cost = ev.costUsd ?? 0;
          if (ev.text) text = ev.text;
        }
        q.push({ type: "task_delta", id: t.id, ev });
      }
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
      // Once the provider iterator has started, a transport failure can hide
      // billable usage. Fail closed until usage is reconciled; an explicit
      // operator cancellation follows the separate stopped/release path.
      requiresAttention = !signal.aborted;
      requiresProviderReconciliation = !signal.aborted;
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abortTask);
    }

    if (preparedWorktree) {
      try {
        const captured = await worktrees.capture(preparedWorktree);
        await orceStore.updateAttemptWorktree(attempt.id, { headCommit: captured.headCommit, changedFiles: captured.changedFiles, diff: captured.diff, status: "captured" });
        if (providerError === null) {
          const integration = await worktrees.integrate(captured);
          if (integration.integrated) {
            await orceStore.updateAttemptWorktree(attempt.id, { status: "integrated", integratedCommit: integration.commit, integrationError: null });
          } else {
            requiresAttention = true;
            providerError = `Worktree integration blocked: ${integration.reason}`;
            await orceStore.updateAttemptWorktree(attempt.id, { status: "conflict", integrationError: integration.reason });
          }
        }
      } catch (error) {
        requiresAttention = true;
        providerError ??= error instanceof Error ? error.message : String(error);
        await orceStore.updateAttemptWorktree(attempt.id, { status: "conflict", integrationError: providerError });
      } finally {
        try {
          await worktrees.cleanup(preparedWorktree);
          await orceStore.updateAttemptWorktree(attempt.id, { cleanedAt: new Date().toISOString() });
        } catch (error) {
          requiresAttention = true;
          const message = error instanceof Error ? error.message : String(error);
          providerError ??= `Worktree cleanup failed: ${message}`;
          await orceStore.updateAttemptWorktree(attempt.id, { status: "cleanup_pending", integrationError: message });
        }
      }
    }

    if (providerError === null) {
      try {
        await orceStore.finishTaskClaim({
          taskId: t.id, attemptId: attempt.id, leaseOwner: ENGINE_INSTANCE_ID, leaseToken,
          taskStatus: "done", attemptStatus: "completed", terminalReason: "provider_completed",
          actorType: "worker", actorId: agent?.id ?? null, provider, output: text, costUsd: cost,
        });
      } catch (error) {
        if (error instanceof LifecycleTransitionError && error.code === "stale_lease") {
          await log(t.id, "task.stale", "warn", `Ignored terminal result from stale worker for ${t.ticket}`);
          return;
        }
        throw error;
      }
      totalCost += cost;
      outputs.set(t.key, text);
      status.set(t.key, "done");
      q.push({ type: "task_status", id: t.id, status: "done" });
      await log(t.id, "task.done", "info", `✔ ${t.ticket} · ${t.title} · $${cost.toFixed(4)}`);
    } else {
      try {
        await orceStore.finishTaskClaim({
          taskId: t.id, attemptId: attempt.id, leaseOwner: ENGINE_INSTANCE_ID, leaseToken,
          taskStatus: requiresAttention ? "needs_attention" : "failed",
          attemptStatus: signal.aborted ? "stopped" : requiresAttention ? "needs_attention" : "failed",
          terminalReason: signal.aborted
            ? "operator_cancelled"
            : requiresAttention
              ? requiresProviderReconciliation
                ? "provider_usage_reconciliation_required"
                : "worktree_reconciliation_required"
              : "provider_error",
          actorType: "worker", actorId: agent?.id ?? null, provider, error: providerError,
        });
      } catch (error) {
        if (error instanceof LifecycleTransitionError && error.code === "stale_lease") {
          await log(t.id, "task.stale", "warn", `Ignored terminal result from stale worker for ${t.ticket}`);
          return;
        }
        throw error;
      }
      const failedStatus: TaskStatus = requiresAttention ? "needs_attention" : "failed";
      status.set(t.key, failedStatus);
      q.push({ type: "task_status", id: t.id, status: failedStatus });
      await log(t.id, requiresAttention ? "task.needs_attention" : "task.failed", requiresAttention ? "warn" : "error", `✖ ${t.ticket} · ${t.title} — ${providerError}`);
    }

    // Budget accounting after each task completes.
    if (budgetUsd != null) {
      if (!budgetWarned && totalCost >= budgetUsd * 0.8) {
        budgetWarned = true;
        await log(null, "budget.warn", "warn", `Budget 80% used · $${totalCost.toFixed(2)} of $${budgetUsd.toFixed(2)}`);
      }
      if (!budgetStopped && totalCost >= budgetUsd) {
        budgetStopped = true;
        await log(null, "budget.stop", "warn", `Budget reached · $${totalCost.toFixed(2)} of $${budgetUsd.toFixed(2)} — halting new tasks`);
      }
    }
    emitBudget();
  };

  // Main scheduling loop.
  while (true) {
    if (signal.aborted) break;

    // Propagate failure through the whole graph independent of model task order.
    let propagated: boolean;
    do {
      propagated = false;
      for (const t of dbList) {
        if (status.get(t.key) === "pending" && depsFailed(t)) {
          status.set(t.key, "skipped");
          q.push({ type: "task_status", id: t.id, status: "skipped" });
          await orceStore.transitionTask(t.id, "skipped", {
            actorType: "scheduler",
            terminalReason: "upstream_dependency_failed",
          });
          await log(t.id, "task.skipped", "warn", `⊘ ${t.ticket} · ${t.title} — upstream dependency failed`);
          propagated = true;
        }
      }
    } while (propagated);

    // Launch ready tasks up to the concurrency cap (unless the budget halted us).
    if (!budgetStopped) {
      const ready = new Set(readyTaskKeys(dbList, status, MAX_PARALLEL - running.size));
      for (const t of dbList) {
        if (ready.has(t.key) && !running.has(t.key)) {
          const p = runTask(t).finally(() => running.delete(t.key));
          running.set(t.key, p);
        }
      }
    }

    const decision = schedulerDecision(dbList, status, running.size, budgetStopped);
    if (decision.kind === "complete" || decision.kind === "budget_halt") break;
    if (decision.kind === "deadlock") {
      deadlockMessage = decision.message;
      for (const key of decision.pendingKeys) {
        const task = dbList.find((candidate) => candidate.key === key);
        if (!task || status.get(key) !== "pending") continue;
        status.set(key, "failed");
        q.push({ type: "task_status", id: task.id, status: "failed" });
        await orceStore.transitionTask(task.id, "failed", {
          actorType: "scheduler",
          terminalReason: "scheduler_deadlock",
          error: decision.message,
        });
        await log(task.id, "scheduler.deadlock", "error", decision.message);
      }
      break;
    }
    // A wait decision guarantees at least one active promise.
    await Promise.race([...running.values()]);
  }

  // Any pending tasks left after a budget halt are marked skipped.
  if (budgetStopped) {
    for (const t of dbList) {
      if (status.get(t.key) === "pending") {
        status.set(t.key, "skipped");
        q.push({ type: "task_status", id: t.id, status: "skipped" });
        await orceStore.transitionTask(t.id, "skipped", {
          actorType: "scheduler",
          terminalReason: "budget_limit_reached",
        });
      }
    }
  }

  const currentRun = await orceStore.getRun(runId);
  if (!currentRun || currentRun.status !== "running") return;
  const persistedTasks = await orceStore.listTasks(runId);
  if (persistedTasks.some((task) => task.status === "pending" || task.status === "running")) return;
  const anyFailed = persistedTasks.some((task) => task.status === "failed" || task.status === "needs_attention");
  const anySkipped = persistedTasks.some((task) => task.status === "skipped");
  const finalStatus =
    signal.aborted || budgetStopped
      ? "stopped"
      : deadlockMessage || anyFailed || anySkipped
        ? "failed"
        : "completed";
  const terminalReason =
    finalStatus === "completed"
      ? "all_tasks_completed"
      : deadlockMessage
        ? "scheduler_deadlock"
        : signal.aborted
        ? "operator_cancelled"
        : budgetStopped
          ? "budget_limit_reached"
          : "task_failed_or_skipped";
  totalCost = Number(currentRun.spent_microusd) / 1_000_000;
  await orceStore.transitionRun(
    runId,
    finalStatus,
    { actorType: "scheduler", terminalReason, error: deadlockMessage },
    { cost_usd: totalCost }
  );
  await log(null, "run.done", finalStatus === "completed" ? "info" : "warn", `Run ${finalStatus} · $${totalCost.toFixed(4)}`);
  emitBudget();
  q.push({ type: "run_done", status: finalStatus, costUsd: totalCost });
}

/* ------------------------------------------------------------------ */
/* Background run manager — runs keep executing even if the client      */
/* disconnects (refresh). Clients attach/re-attach to replay + stream.  */
/* ------------------------------------------------------------------ */

type RunEntry = { hub: Hub<OrceEvent>; controller: AbortController; done: boolean; executionKey: string };
const activeRuns = new Map<string, RunEntry>();

/** Is a run currently executing in the background (so a client should attach)? */
export function isRunActive(runId: string): boolean {
  const e = activeRuns.get(runId);
  return !!e && !e.done;
}

/** Attach to a live background run: replays buffered events then streams live. */
export function attachRun(runId: string): AsyncGenerator<OrceEvent> | null {
  return activeRuns.get(runId)?.hub.attach() ?? null;
}

/** Explicitly cancel a background run (aborts its agents). */
export function cancelRun(runId: string): void {
  activeRuns.get(runId)?.controller.abort();
}

function registerRun(runId: string, executionKey: string): RunEntry {
  const entry: RunEntry = { hub: createHub<OrceEvent>(), controller: new AbortController(), done: false, executionKey };
  activeRuns.set(runId, entry);
  return entry;
}

function finishRun(runId: string, entry: RunEntry) {
  entry.done = true;
  entry.hub.close();
  // Keep the buffer briefly so a late reconnect can still replay, then drop it.
  setTimeout(() => {
    if (activeRuns.get(runId) === entry) activeRuns.delete(runId);
  }, 120_000);
}

async function persistBackgroundFailure(runId: string, error: unknown, reason = "unhandled_orchestration_error") {
  const run = await orceStore.getRun(runId);
  if (!run || ["completed", "failed", "stopped", "needs_attention"].includes(run.status)) return;
  const target = run.status === "running" ? "needs_attention" : reason === "planning_cancelled" ? "stopped" : "failed";
  const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
  await orceStore.transitionRun(
    runId,
    target,
    {
      actorType: "engine",
      terminalReason: reason,
      error: message,
    },
    error instanceof PlanValidationError ? { cost_usd: error.costUsd } : undefined
  );
}

/** Execute an approved run in the BACKGROUND. Idempotent per runId. Returns immediately. */
export async function startExecute(
  runId: string,
  commandKey = `start:${runId}`,
  action: Extract<RunCommandAction, "start" | "retry" | "resume"> = "start"
): Promise<void> {
  await orceStore.applyRunCommand({ runId, action, idempotencyKey: commandKey, actorType: "operator" });
  const active = activeRuns.get(runId);
  if (active && !active.done) {
    if (action !== "retry" || active.executionKey === commandKey) return;
    active.controller.abort();
  }
  const entry = registerRun(runId, commandKey);
  executePhase(runId, entry.controller.signal, entry.hub, true, commandKey)
    .catch(async (err) => {
      await persistBackgroundFailure(runId, err);
      entry.hub.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => finishRun(runId, entry));
}

/** Auto mode (plan + execute) in the BACKGROUND. Returns the runId once the row exists. */
export async function startAuto(
  goal: string,
  budgetUsd: number | null,
  images: ImageInput[] = [],
  idempotencyKey = `auto:${randomUUID()}`
): Promise<string> {
  const run = await orceStore.createRun(activeProjectId()!, goal, budgetUsd, images, idempotencyKey);
  if (activeRuns.has(run.id)) return run.id;
  if (run.status !== "planning") return run.id;
  const entry = registerRun(run.id, idempotencyKey);
  (async () => {
    await planInto(run.id, goal, budgetUsd, entry.controller.signal, entry.hub);
    if (!entry.controller.signal.aborted) {
      const commandKey = `${idempotencyKey}:start`;
      await orceStore.applyRunCommand({ runId: run.id, action: "start", idempotencyKey: commandKey, actorType: "auto" });
      await executePhase(run.id, entry.controller.signal, entry.hub, false, commandKey);
    }
  })()
    .catch(async (err) => {
      await persistBackgroundFailure(run.id, err);
      entry.hub.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => finishRun(run.id, entry));
  return run.id;
}

/** Reconcile expired leases and resume only runs with no ambiguous in-flight provider call. */
export async function recoverRunsOnStartup(): Promise<void> {
  const liveRunIds = [...activeRuns.entries()].filter(([, entry]) => !entry.done).map(([runId]) => runId);
  const recovery = await orceStore.recoverStartup(ENGINE_INSTANCE_ID, liveRunIds);
  const worktrees = new GitWorktreeManager(activeCwd());
  for (const attempt of await orceStore.listAbandonedWorktrees()) {
    if (!attempt.worktree_path || !attempt.worktree_repository_path) continue;
    try {
      await worktrees.cleanup({ repositoryRoot: attempt.worktree_repository_path, path: attempt.worktree_path });
      await orceStore.updateAttemptWorktree(attempt.id, { cleanedAt: new Date().toISOString() });
    } catch (error) {
      await orceStore.updateAttemptWorktree(attempt.id, { status: "cleanup_pending", integrationError: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const runId of recovery.resumableRunIds) {
    await startExecute(runId, `startup-resume:${runId}`, "resume");
  }
}

/** Keep recovery within the lease SLO after a process dies just after its last heartbeat. */
export function startRecoveryMonitor(): void {
  let recovering = false;
  const recover = async () => {
    if (recovering) return;
    recovering = true;
    try {
      await recoverRunsOnStartup();
    } catch (error) {
      console.error("[orce] startup recovery failed:", error instanceof Error ? error.message : error);
    } finally {
      recovering = false;
    }
  };
  void recover();
  setInterval(() => void recover(), 2_000);
}

/** Approval mode — plan only, return the proposed DAG for review. */
export async function planOnly(
  goal: string,
  budgetUsd: number | null,
  signal: AbortSignal,
  images: ImageInput[] = []
): Promise<{ runId: string; goal: string; budgetUsd: number | null; images: ImageInput[]; tasks: TaskMeta[] }> {
  const { runId } = await planPhase(goal, budgetUsd, signal, images);
  const tasks = await orceStore.listTasks(runId);
  return { runId, goal, budgetUsd, images, tasks: toMeta(tasks) };
}

const PROPOSE_PROMPT =
  `Inspect THIS project to propose a specialized multi-agent team for orchestrating work on it.\n` +
  `First use the graphify knowledge-graph tool (mcp__graphify__*) if available and read key files ` +
  `(package.json / pyproject / go.mod, README, top-level source) to understand the stack and structure.\n\n` +
  `Then propose 2 to 4 agents tailored to this project. For each agent give:\n` +
  `- name (short, e.g. "Frontend Engineer")\n- role (one line)\n- system_prompt (2-4 sentences of focused instructions)\n` +
  `- model: null\n- tools: null for full access, or a read-only subset ["Read","Grep","Glob"] for reviewers/researchers\n` +
  `- isolate: true for agents that write code (safe parallel writes), false for read-only ones.\n\n` +
  `Respond with ONLY a JSON code block:\n` +
  '```json\n{"agents":[{"name":"...","role":"...","system_prompt":"...","model":null,"tools":null,"isolate":false}]}\n```';

/** Streaming events for the propose-agents step, so the UI can show live progress. */
export type ProposeEvent =
  | { type: "activity"; text: string }
  | { type: "thinking"; text: string }
  | { type: "proposals"; agents: AgentInput[] }
  | { type: "error"; message: string };

function baseName(p: string, n = 44): string {
  const b = String(p).replace(/\/+$/, "").split("/").pop() || String(p);
  return b.length > n ? b.slice(0, n) + "…" : b;
}

/** Turn a raw tool_use into a human-friendly progress line. */
function activityLabel(name: string, input: unknown): string {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  if (name === "Read") return `Reading ${baseName(p.file_path || p.path || "a file")}`;
  if (name === "Grep") return `Searching for “${String(p.pattern ?? "").slice(0, 40)}”`;
  if (name === "Glob") return `Scanning ${String(p.pattern ?? "files").slice(0, 40)}`;
  if (name === "Bash") {
    const cmd = String(p.command || "a command").split("\n")[0].trim();
    return `Running ${cmd.length > 44 ? cmd.slice(0, 44) + "…" : cmd}`;
  }
  if (name.startsWith("mcp__graphify")) return "Querying the knowledge graph";
  if (name.startsWith("mcp__")) return name.replace(/^mcp__/, "").replace(/__/g, " · ");
  return name;
}

function parseProposals(text: string): AgentInput[] {
  const parsed = extractJson(text);
  const raw: any[] = Array.isArray(parsed?.agents) ? parsed.agents : [];
  return raw.slice(0, 4).map((a) => ({
    name: String(a.name ?? "Agent").slice(0, 40),
    role: String(a.role ?? ""),
    system_prompt: String(a.system_prompt ?? ""),
    model: a.model ? String(a.model) : null,
    tools: Array.isArray(a.tools) && a.tools.length ? a.tools.map(String) : null,
    isolate: Boolean(a.isolate),
  }));
}

/** Inspect the active project and stream progress, ending with the proposals. */
export async function* proposeAgentsStream(signal: AbortSignal): AsyncGenerator<ProposeEvent> {
  yield { type: "activity", text: "Inspecting the project…" };
  let text = "";
  let think = "";
  let lastThink = 0;
  for await (const ev of runAgent(PROPOSE_PROMPT, undefined, signal, undefined, {
    allowedTools: ["Read", "Grep", "Glob"],
    graphCwd: activeCwd(),
  })) {
    if (ev.type === "tool_use") {
      yield { type: "activity", text: activityLabel(ev.name, ev.input) };
    } else if (ev.type === "thinking_delta") {
      think += ev.text;
      if (think.length - lastThink > 60) {
        lastThink = think.length;
        yield { type: "thinking", text: think.slice(-160) };
      }
    } else if (ev.type === "text_delta") {
      text += ev.text;
    } else if (ev.type === "result" && ev.text) {
      text = ev.text;
    } else if (ev.type === "error") {
      yield { type: "error", message: ev.message };
      return;
    }
  }
  yield { type: "proposals", agents: parseProposals(text) };
}

/** Inspect the active project and propose tailored agents (non-streaming). */
export async function proposeAgents(signal: AbortSignal): Promise<AgentInput[]> {
  let agents: AgentInput[] = [];
  for await (const ev of proposeAgentsStream(signal)) {
    if (ev.type === "proposals") agents = ev.agents;
  }
  return agents;
}
