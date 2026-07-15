import { randomUUID } from "node:crypto";
import { sql as dbSql, dbMode } from "../driver.js";
import type { ImageInput } from "../images.js";
import { runOrceMigrations, type SqlFn } from "./migrations.js";
import {
  assertKnownStatus,
  assertTransition,
  isTerminalStatus,
  LifecycleTransitionError,
  type AttemptStatus,
  type RunStatus,
  type TaskStatus,
} from "./state-machine.js";

export type { AttemptStatus, RunStatus, TaskStatus } from "./state-machine.js";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface Agent {
  id: string;
  project_id: string | null;
  name: string;
  role: string;
  system_prompt: string;
  model: string | null; // null = inherit default
  tools: string[] | null; // null = all tools allowed
  isolate: boolean; // run in its own isolated working dir
  builtin: boolean;
  created_at: string;
}

export interface Run {
  id: string;
  project_id: string | null;
  goal: string;
  status: RunStatus;
  budget_usd: number | null;
  cost_usd: number;
  budget_microusd: number | null;
  spent_microusd: number;
  reserved_microusd: number;
  error: string | null;
  attachments: ImageInput[];
  idempotency_key: string;
  updated_at: string;
  started_at: string | null;
  terminal_at: string | null;
  terminal_reason: string | null;
  actor_type: string;
  actor_id: string | null;
  provider: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Task {
  id: string;
  run_id: string;
  ticket: string; // human ticket id, e.g. TASK-0001 (global sequential)
  key: string; // slug, unique within a run (used for dependency wiring)
  title: string;
  prompt: string;
  agent_id: string | null;
  agent_label: string;
  status: TaskStatus;
  depends_on: string[]; // task keys within the run
  output: string | null;
  cost_usd: number | null;
  error: string | null;
  order_idx: number;
  idempotency_key: string;
  updated_at: string;
  started_at: string | null;
  terminal_at: string | null;
  terminal_reason: string | null;
  actor_type: string;
  actor_id: string | null;
  provider: string | null;
  active_attempt_id: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
}

export interface Attempt {
  id: string;
  task_id: string;
  attempt_number: number;
  idempotency_key: string;
  status: AttemptStatus;
  actor_type: string;
  actor_id: string | null;
  provider: string | null;
  provider_request_key: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  terminal_at: string | null;
  terminal_reason: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  reserved_microusd: number;
  worktree_base_commit: string | null;
  worktree_head_commit: string | null;
  worktree_path: string | null;
  worktree_repository_path: string | null;
  worktree_owner: string | null;
  worktree_status: WorktreeStatus | null;
  worktree_changed_files: string[];
  worktree_diff: string | null;
  worktree_integration_error: string | null;
  worktree_integrated_commit: string | null;
  worktree_cleaned_at: string | null;
}

export type WorktreeStatus = "active" | "captured" | "integrated" | "conflict" | "cleanup_pending";

export interface AttemptWorktreePatch {
  baseCommit?: string;
  headCommit?: string;
  path?: string;
  repositoryPath?: string;
  owner?: string;
  status?: WorktreeStatus;
  changedFiles?: string[];
  diff?: string;
  integrationError?: string | null;
  integratedCommit?: string;
  cleanedAt?: string;
}

export type RunCommandAction = "start" | "retry" | "cancel" | "resume";

export interface RunCommandInput {
  runId: string;
  action: RunCommandAction;
  idempotencyKey: string;
  actorType: string;
  actorId?: string | null;
}

export interface TaskClaimInput extends AttemptInput {
  leaseOwner: string;
  leaseToken: string;
  leaseSeconds: number;
  estimatedCostMicrousd?: number;
}

export interface TaskClaim {
  attempt: Attempt;
  claimed: boolean;
}

export interface FinishTaskClaimInput {
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseToken: string;
  taskStatus: "done" | "failed" | "needs_attention";
  attemptStatus: "completed" | "failed" | "stopped" | "needs_attention";
  terminalReason: string;
  actorType: string;
  actorId?: string | null;
  provider?: string | null;
  error?: string | null;
  output?: string;
  costUsd?: number;
}

export interface StartupRecovery {
  resumableRunIds: string[];
  attentionRunIds: string[];
}

export interface TransitionMetadata {
  terminalReason?: string | null;
  actorType: string;
  actorId?: string | null;
  provider?: string | null;
  error?: string | null;
}

export interface AttemptInput {
  taskId: string;
  idempotencyKey: string;
  actorType: string;
  actorId?: string | null;
  provider?: string | null;
  providerRequestKey?: string | null;
}

export interface OrceEventRow {
  id: string;
  run_id: string;
  task_id: string | null;
  type: string; // e.g. plan | task.running | task.done | budget.warn | run.done
  level: "info" | "warn" | "error";
  message: string;
  created_at: string;
}

export interface BudgetLedgerEntry {
  id: string; run_id: string; task_id: string | null; attempt_id: string | null;
  account: "reserved" | "spent"; delta_microusd: number; idempotency_key: string; created_at: string;
}

export class BudgetLimitError extends Error {
  constructor(public readonly budgetMicrousd: number, public readonly spentMicrousd: number,
    public readonly reservedMicrousd: number, public readonly requestedMicrousd: number) {
    super("task reservation would cross the configured run budget"); this.name = "BudgetLimitError";
  }
}

export interface AgentInput {
  name: string;
  role: string;
  system_prompt: string;
  model: string | null;
  tools: string[] | null;
  isolate: boolean;
}

export type TaskInput = Omit<
  Task,
  | "id"
  | "created_at"
  | "ticket"
  | "idempotency_key"
  | "updated_at"
  | "started_at"
  | "terminal_at"
  | "terminal_reason"
  | "actor_type"
  | "actor_id"
  | "provider"
  | "active_attempt_id"
  | "lease_owner"
  | "lease_token"
  | "lease_expires_at"
  | "last_heartbeat_at"
> & {
  idempotencyKey?: string;
};

const BUILTIN_AGENTS: AgentInput[] = [
  {
    name: "Generalist",
    role: "Handles any task end to end",
    system_prompt: "You are a capable generalist engineer. Complete the task pragmatically and report a concise result.",
    model: null,
    tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    isolate: false,
  },
  {
    name: "Researcher",
    role: "Explores and analyzes code, read-only",
    system_prompt:
      "You are a research agent. Investigate thoroughly using read-only tools and return a precise, sourced summary. Do not modify files.",
    model: null,
    tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    isolate: false,
  },
  {
    name: "Implementer",
    role: "Writes and edits code",
    system_prompt:
      "You are an implementation agent. Write clean, working code that matches the surrounding style. Verify it builds/typechecks when possible.",
    model: null,
    tools: null,
    isolate: true,
  },
  {
    name: "Reviewer",
    role: "Reviews work and finds issues, read-only",
    system_prompt:
      "You are a critical reviewer. Inspect the work read-only and report concrete issues, risks, and concise fixes. Do not modify files.",
    model: null,
    tools: ["Read", "Grep", "Glob"],
    isolate: false,
  },
];

/* ------------------------------------------------------------------ */
/* Store interface                                                    */
/* ------------------------------------------------------------------ */

export interface OrceStore {
  init(): Promise<void>;
  // agents (scoped per project)
  seedBuiltins(projectId: string, which: "one" | "all"): Promise<void>;
  listAgents(projectId: string): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | null>;
  createAgent(projectId: string, a: AgentInput, builtin?: boolean): Promise<Agent>;
  updateAgent(id: string, a: Partial<AgentInput>): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  // runs (scoped per project)
  createRun(projectId: string, goal: string, budgetUsd: number | null, attachments?: ImageInput[], idempotencyKey?: string): Promise<Run>;
  transitionRun(id: string, status: RunStatus, metadata: TransitionMetadata, patch?: { cost_usd?: number }): Promise<Run>;
  listRuns(projectId: string, limit?: number): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  applyRunCommand(input: RunCommandInput): Promise<Run>;
  recoverStartup(leaseOwner: string, activeRunIds?: string[]): Promise<StartupRecovery>;
  // tasks
  createTask(t: TaskInput): Promise<Task>;
  transitionTask(id: string, status: TaskStatus, metadata: TransitionMetadata, patch?: { output?: string; cost_usd?: number }): Promise<Task>;
  listTasks(runId: string): Promise<Task[]>;
  listAllTasks(projectId: string, limit?: number): Promise<(Task & { run_goal: string })[]>;
  // attempts
  createAttempt(input: AttemptInput): Promise<Attempt>;
  transitionAttempt(id: string, status: AttemptStatus, metadata: TransitionMetadata): Promise<Attempt>;
  listAttempts(taskId: string): Promise<Attempt[]>;
  claimTask(input: TaskClaimInput): Promise<TaskClaim>;
  heartbeatTaskClaim(taskId: string, attemptId: string, leaseOwner: string, leaseToken: string, leaseSeconds: number): Promise<boolean>;
  finishTaskClaim(input: FinishTaskClaimInput): Promise<Task>;
  updateAttemptWorktree(attemptId: string, patch: AttemptWorktreePatch): Promise<Attempt>;
  listAbandonedWorktrees(): Promise<Attempt[]>;
  listBudgetLedger(runId: string): Promise<BudgetLedgerEntry[]>;
  recordBudgetSpend(runId: string, amountMicrousd: number, idempotencyKey: string): Promise<Run>;
  // audit events
  addEvent(runId: string, taskId: string | null, type: string, level: OrceEventRow["level"], message: string): Promise<OrceEventRow>;
  listEvents(runId: string): Promise<OrceEventRow[]>;
}

/* ------------------------------------------------------------------ */
/* Neon implementation                                                */
/* ------------------------------------------------------------------ */

export class SqlOrceStore implements OrceStore {
  constructor(private readonly sql: SqlFn = dbSql) {}

  async init() {
    await runOrceMigrations(this.sql);
  }

  async seedBuiltins(projectId: string, which: "one" | "all") {
    const agents = which === "one" ? BUILTIN_AGENTS.slice(0, 1) : BUILTIN_AGENTS;
    for (const a of agents) await this.createAgent(projectId, a, true);
  }

  async listAgents(projectId: string) {
    return (await this
      .sql`SELECT * FROM orce_agents WHERE project_id = ${projectId} ORDER BY builtin DESC, created_at ASC`) as Agent[];
  }
  async getAgent(id: string) {
    const r = (await this.sql`SELECT * FROM orce_agents WHERE id = ${id}`) as Agent[];
    return r[0] ?? null;
  }
  async createAgent(projectId: string, a: AgentInput, builtin = false) {
    const id = randomUUID();
    const r = (await this.sql`
      INSERT INTO orce_agents (id, project_id, name, role, system_prompt, model, tools, isolate, builtin)
      VALUES (${id}, ${projectId}, ${a.name}, ${a.role}, ${a.system_prompt}, ${a.model}, ${
      a.tools ? JSON.stringify(a.tools) : null
    }, ${a.isolate}, ${builtin})
      RETURNING *`) as Agent[];
    return r[0];
  }
  async updateAgent(id: string, a: Partial<AgentInput>) {
    const cur = await this.getAgent(id);
    if (!cur) return;
    const next = { ...cur, ...a };
    await this.sql`
      UPDATE orce_agents SET name = ${next.name}, role = ${next.role}, system_prompt = ${next.system_prompt},
        model = ${next.model}, tools = ${next.tools ? JSON.stringify(next.tools) : null}, isolate = ${next.isolate}
      WHERE id = ${id}`;
  }
  async deleteAgent(id: string) {
    await this.sql`DELETE FROM orce_agents WHERE id = ${id} AND builtin = false`;
  }

  async createRun(
    projectId: string,
    goal: string,
    budgetUsd: number | null,
    attachments: ImageInput[] = [],
    idempotencyKey = `run:${randomUUID()}`
  ) {
    const id = randomUUID();
    const r = (await this
      .sql`INSERT INTO orce_runs (id, project_id, goal, budget_usd, budget_microusd, attachments, idempotency_key)
        VALUES (${id}, ${projectId}, ${goal}, ${budgetUsd}, ${budgetUsd == null ? null : Math.round(budgetUsd * 1_000_000)}, ${JSON.stringify(attachments)}, ${idempotencyKey})
        ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING *`) as Run[];
    return r[0];
  }
  async transitionRun(id: string, status: RunStatus, metadata: TransitionMetadata, patch: { cost_usd?: number } = {}) {
    assertKnownStatus("run", status);
    const current = await this.getRun(id);
    if (!current) throw new LifecycleTransitionError("entity_not_found", "run", id, null, status);
    assertTransition("run", id, current.status, status, metadata.terminalReason);
    const terminal = isTerminalStatus("run", status);
    const rows = (await this.sql`
      UPDATE orce_runs SET status = ${status},
        cost_usd = COALESCE(${patch.cost_usd ?? null}, cost_usd),
        error = ${metadata.error ?? null},
        actor_type = ${metadata.actorType}, actor_id = ${metadata.actorId ?? null}, provider = ${metadata.provider ?? null},
        updated_at = now(),
        started_at = CASE WHEN ${status === "running"} THEN COALESCE(started_at, now()) ELSE started_at END,
        terminal_at = CASE WHEN ${terminal} THEN now() ELSE NULL END,
        terminal_reason = ${terminal ? metadata.terminalReason?.trim() ?? null : null},
        completed_at = CASE WHEN ${terminal} THEN now() ELSE NULL END
      WHERE id = ${id} AND status = ${current.status}
      RETURNING *`) as Run[];
    if (rows[0]) return rows[0];
    throw new LifecycleTransitionError("concurrent_transition", "run", id, current.status, status);
  }
  async listRuns(projectId: string, limit = 30) {
    return (await this
      .sql`SELECT id, project_id, goal, status, budget_usd, cost_usd, error, idempotency_key,
        created_at, updated_at, started_at, terminal_at, terminal_reason, completed_at,
        actor_type, actor_id, provider,
        '[]'::jsonb AS attachments
        FROM orce_runs WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT ${limit}`) as Run[];
  }
  async getRun(id: string) {
    const r = (await this.sql`SELECT * FROM orce_runs WHERE id = ${id}`) as Run[];
    return r[0] ?? null;
  }

  async applyRunCommand(input: RunCommandInput) {
    const commandId = randomUUID();
    const rows = (await this.sql`
      WITH command AS (
        INSERT INTO orce_run_commands (id, run_id, action, idempotency_key, actor_type, actor_id)
        SELECT ${commandId}, id, ${input.action}, ${input.idempotencyKey}, ${input.actorType}, ${input.actorId ?? null}
        FROM orce_runs WHERE id = ${input.runId}
        ON CONFLICT (run_id, action, idempotency_key) DO NOTHING
        RETURNING id
      ), stopped_attempts AS (
        UPDATE orce_attempts a SET status = 'stopped', updated_at = now(), terminal_at = now(),
          terminal_reason = 'operator_cancelled', lease_expires_at = NULL
        FROM orce_tasks t, command
        WHERE ${input.action} = 'cancel' AND t.run_id = ${input.runId} AND a.task_id = t.id
          AND a.status IN ('created', 'running')
          AND EXISTS (SELECT 1 FROM orce_runs r WHERE r.id = ${input.runId}
            AND r.status IN ('planning', 'awaiting_approval', 'running'))
        RETURNING a.id, a.reserved_microusd
      ), cancelled_tasks AS (
        UPDATE orce_tasks t SET
          status = CASE WHEN t.status = 'pending' THEN 'skipped' ELSE 'failed' END,
          updated_at = now(), terminal_at = now(), terminal_reason = 'operator_cancelled',
          active_attempt_id = NULL, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_heartbeat_at = NULL
        FROM command
        WHERE ${input.action} = 'cancel' AND t.run_id = ${input.runId}
          AND t.status IN ('pending', 'running')
          AND EXISTS (SELECT 1 FROM orce_runs r WHERE r.id = ${input.runId}
            AND r.status IN ('planning', 'awaiting_approval', 'running'))
        RETURNING t.id
      ), release_entry AS (
        INSERT INTO orce_budget_ledger (id, run_id, account, delta_microusd, idempotency_key)
        SELECT ${randomUUID()}, ${input.runId}, 'reserved', -SUM(a.reserved_microusd),
          ${`run:${input.runId}:cancel:${commandId}:release`}
        FROM stopped_attempts a HAVING SUM(a.reserved_microusd) > 0
        RETURNING run_id
      ), retry_tasks AS (
        UPDATE orce_tasks t SET status = 'pending', error = NULL, updated_at = now(),
          terminal_at = NULL, terminal_reason = NULL, active_attempt_id = NULL,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL
        FROM command
        WHERE ${input.action} = 'retry' AND t.run_id = ${input.runId}
          AND t.status IN ('failed', 'skipped', 'needs_attention')
          AND EXISTS (SELECT 1 FROM orce_runs r WHERE r.id = ${input.runId}
            AND r.status IN ('failed', 'needs_attention'))
        RETURNING t.id
      ), updated AS (
        UPDATE orce_runs r SET
          status = CASE WHEN ${input.action} = 'cancel' THEN 'stopped' ELSE 'running' END,
          reserved_microusd = CASE WHEN ${input.action} = 'cancel'
            THEN GREATEST(0, r.reserved_microusd - COALESCE((SELECT SUM(reserved_microusd) FROM stopped_attempts), 0))
            ELSE r.reserved_microusd END,
          actor_type = ${input.actorType}, actor_id = ${input.actorId ?? null}, updated_at = now(),
          error = CASE WHEN ${input.action} = 'retry' THEN NULL ELSE error END,
          started_at = CASE WHEN ${input.action} IN ('start', 'retry') THEN COALESCE(started_at, now()) ELSE started_at END,
          terminal_at = CASE WHEN ${input.action} = 'cancel' THEN now() ELSE NULL END,
          terminal_reason = CASE WHEN ${input.action} = 'cancel' THEN 'operator_cancelled' ELSE NULL END,
          completed_at = CASE WHEN ${input.action} = 'cancel' THEN now() ELSE NULL END
        FROM command
        WHERE r.id = ${input.runId} AND (
          (${input.action} = 'start' AND r.status = 'awaiting_approval') OR
          (${input.action} = 'retry' AND r.status IN ('failed', 'needs_attention')) OR
          (${input.action} = 'cancel' AND r.status IN ('planning', 'awaiting_approval', 'running'))
        )
        RETURNING r.*
      )
      SELECT u.* FROM updated u
      UNION ALL
      SELECT r.* FROM orce_runs r WHERE r.id = ${input.runId} AND NOT EXISTS (SELECT 1 FROM updated)`) as Run[];
    let run = rows[0];
    const expected: Record<RunCommandAction, RunStatus> = {
      start: "running",
      retry: "running",
      resume: "running",
      cancel: "stopped",
    };
    if (!run) throw new LifecycleTransitionError("entity_not_found", "run", input.runId, null, expected[input.action]);
    // A concurrent duplicate may wait on the unique command key after this statement's snapshot was taken.
    // Reload once so every caller observes the winner's committed lifecycle state.
    if (run.status !== expected[input.action]) run = (await this.getRun(input.runId)) ?? run;
    if (run.status !== expected[input.action]) {
      throw new LifecycleTransitionError("illegal_transition", "run", input.runId, run.status, expected[input.action]);
    }
    return run;
  }

  async recoverStartup(_leaseOwner: string, activeRunIds: string[] = []): Promise<StartupRecovery> {
    const activeIds = JSON.stringify(activeRunIds);
    const expiredAttempts = (await this.sql`
      WITH attention_tasks AS (
        UPDATE orce_tasks t SET status = 'needs_attention', error = 'Worker lease expired after restart; reconcile provider usage before retrying.',
          updated_at = now(), terminal_at = now(), terminal_reason = 'lease_expired_after_restart',
          active_attempt_id = NULL, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_heartbeat_at = NULL
        WHERE t.status = 'running' AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= now())
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${activeIds}::jsonb) AS excluded(run_id)
            WHERE excluded.run_id = t.run_id::text
          )
        RETURNING t.id, t.run_id
      ), expired AS (
        UPDATE orce_attempts a SET status = 'needs_attention', updated_at = now(), terminal_at = now(),
          terminal_reason = 'lease_expired_after_restart', lease_expires_at = NULL
        FROM attention_tasks t
        WHERE a.task_id = t.id AND a.status IN ('created', 'running')
        RETURNING a.task_id
      ), attention_runs AS (
        UPDATE orce_runs r SET status = 'needs_attention',
          error = 'A worker lease expired after restart; reconcile provider usage, then retry the run.',
          updated_at = now(), terminal_at = now(), completed_at = now(),
          terminal_reason = 'task_lease_expired_after_restart', actor_type = 'startup_recovery'
        WHERE r.id IN (SELECT run_id FROM attention_tasks) AND r.status = 'running'
        RETURNING r.id
      ) SELECT id FROM attention_runs`) as { id: string }[];

    const interruptedPlanning = (await this.sql`
      UPDATE orce_runs SET status = 'needs_attention',
        error = 'Planning was interrupted by process restart; retry to create a fresh deterministic plan.',
        updated_at = now(), terminal_at = now(), completed_at = now(),
        terminal_reason = 'planning_interrupted_by_restart', actor_type = 'startup_recovery'
      WHERE status = 'planning'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${activeIds}::jsonb) AS excluded(run_id)
          WHERE excluded.run_id = orce_runs.id::text
        )
      RETURNING id`) as { id: string }[];

    const resumable = (await this.sql`
      SELECT r.id FROM orce_runs r
      WHERE r.status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM orce_tasks t WHERE t.run_id = r.id AND t.status = 'running'
            AND t.lease_expires_at > now()
        )`) as { id: string }[];
    return {
      resumableRunIds: resumable.map((row) => row.id),
      attentionRunIds: [...expiredAttempts, ...interruptedPlanning].map((row) => row.id),
    };
  }

  async createTask(t: TaskInput) {
    const id = randomUUID();
    const seq = (await this.sql`SELECT 'TASK-' || lpad(nextval('orce_task_seq')::text, 4, '0') AS ticket`) as {
      ticket: string;
    }[];
    const ticket = seq[0].ticket;
    const r = (await this.sql`
      INSERT INTO orce_tasks (id, run_id, ticket, key, title, prompt, agent_id, agent_label, status, depends_on, order_idx, idempotency_key)
      VALUES (${id}, ${t.run_id}, ${ticket}, ${t.key}, ${t.title}, ${t.prompt}, ${t.agent_id}, ${t.agent_label}, ${t.status}, ${JSON.stringify(
      t.depends_on
    )}, ${t.order_idx}, ${t.idempotencyKey ?? `task:${id}`})
      RETURNING *`) as Task[];
    return r[0];
  }
  async transitionTask(
    id: string,
    status: TaskStatus,
    metadata: TransitionMetadata,
    patch: { output?: string; cost_usd?: number } = {}
  ) {
    assertKnownStatus("task", status);
    const rows = (await this.sql`SELECT * FROM orce_tasks WHERE id = ${id}`) as Task[];
    const current = rows[0];
    if (!current) throw new LifecycleTransitionError("entity_not_found", "task", id, null, status);
    assertTransition("task", id, current.status, status, metadata.terminalReason);
    const terminal = isTerminalStatus("task", status);
    const updated = (await this.sql`
      UPDATE orce_tasks SET status = ${status},
        output = COALESCE(${patch.output ?? null}, output),
        cost_usd = COALESCE(${patch.cost_usd ?? null}, cost_usd),
        error = ${metadata.error ?? null},
        actor_type = ${metadata.actorType}, actor_id = ${metadata.actorId ?? null}, provider = ${metadata.provider ?? null},
        updated_at = now(),
        started_at = CASE WHEN ${status === "running"} THEN COALESCE(started_at, now()) ELSE started_at END,
        terminal_at = CASE WHEN ${terminal} THEN now() ELSE NULL END,
        terminal_reason = ${terminal ? metadata.terminalReason?.trim() ?? null : null}
      WHERE id = ${id} AND status = ${current.status}
      RETURNING *`) as Task[];
    if (updated[0]) return updated[0];
    throw new LifecycleTransitionError("concurrent_transition", "task", id, current.status, status);
  }
  async listTasks(runId: string) {
    return (await this.sql`SELECT * FROM orce_tasks WHERE run_id = ${runId} ORDER BY order_idx ASC`) as Task[];
  }

  async listAllTasks(projectId: string, limit = 200) {
    return (await this.sql`
      SELECT t.*, r.goal AS run_goal
      FROM orce_tasks t JOIN orce_runs r ON r.id = t.run_id
      WHERE r.project_id = ${projectId}
      ORDER BY t.created_at DESC LIMIT ${limit}`) as (Task & { run_goal: string })[];
  }

  async createAttempt(input: AttemptInput) {
    const existing = (await this.sql`SELECT * FROM orce_attempts WHERE idempotency_key = ${input.idempotencyKey}`) as Attempt[];
    if (existing[0]) return existing[0];
    const numberRows = (await this.sql`
      SELECT COALESCE(MAX(attempt_number), 0)::int + 1 AS attempt_number
      FROM orce_attempts WHERE task_id = ${input.taskId}`) as { attempt_number: number }[];
    const id = randomUUID();
    const rows = (await this.sql`
      INSERT INTO orce_attempts (
        id, task_id, attempt_number, idempotency_key, actor_type, actor_id, provider, provider_request_key
      ) VALUES (
        ${id}, ${input.taskId}, ${numberRows[0].attempt_number}, ${input.idempotencyKey}, ${input.actorType},
        ${input.actorId ?? null}, ${input.provider ?? null}, ${input.providerRequestKey ?? null}
      ) RETURNING *`) as Attempt[];
    return rows[0];
  }

  async transitionAttempt(id: string, status: AttemptStatus, metadata: TransitionMetadata) {
    assertKnownStatus("attempt", status);
    const rows = (await this.sql`SELECT * FROM orce_attempts WHERE id = ${id}`) as Attempt[];
    const current = rows[0];
    if (!current) throw new LifecycleTransitionError("entity_not_found", "attempt", id, null, status);
    assertTransition("attempt", id, current.status, status, metadata.terminalReason);
    const terminal = isTerminalStatus("attempt", status);
    const updated = (await this.sql`
      UPDATE orce_attempts SET status = ${status},
        actor_type = ${metadata.actorType}, actor_id = ${metadata.actorId ?? null}, provider = ${metadata.provider ?? null},
        error = ${metadata.error ?? null}, updated_at = now(),
        started_at = CASE WHEN ${status === "running"} THEN COALESCE(started_at, now()) ELSE started_at END,
        terminal_at = CASE WHEN ${terminal} THEN now() ELSE NULL END,
        terminal_reason = ${terminal ? metadata.terminalReason?.trim() ?? null : null}
      WHERE id = ${id} AND status = ${current.status}
      RETURNING *`) as Attempt[];
    if (updated[0]) return updated[0];
    throw new LifecycleTransitionError("concurrent_transition", "attempt", id, current.status, status);
  }

  async listAttempts(taskId: string) {
    return (await this.sql`
      SELECT * FROM orce_attempts WHERE task_id = ${taskId} ORDER BY attempt_number ASC`) as Attempt[];
  }

  async claimTask(input: TaskClaimInput): Promise<TaskClaim> {
    const estimated = Math.max(0, Math.round(input.estimatedCostMicrousd ?? 0));
    const rows = (await this.sql`
      WITH target AS (
        SELECT t.*, r.budget_microusd, r.spent_microusd, r.reserved_microusd
        FROM orce_tasks t JOIN orce_runs r ON r.id = t.run_id
        WHERE t.id = ${input.taskId} FOR UPDATE OF t, r
      ), existing AS (
        SELECT a.* FROM orce_attempts a WHERE a.idempotency_key = ${input.idempotencyKey}
      ), expired AS (
        UPDATE orce_attempts a SET status = 'needs_attention', updated_at = now(), terminal_at = now(),
          terminal_reason = 'lease_expired', lease_expires_at = NULL
        FROM target t
        WHERE a.id = t.active_attempt_id AND a.status IN ('created', 'running')
          AND t.lease_expires_at <= now() AND NOT EXISTS (SELECT 1 FROM existing)
        RETURNING a.id
      ), inserted AS (
        INSERT INTO orce_attempts (
          id, task_id, attempt_number, idempotency_key, status, actor_type, actor_id, provider,
          provider_request_key, lease_owner, lease_token, lease_expires_at, last_heartbeat_at, started_at, reserved_microusd
        )
        SELECT ${randomUUID()}, t.id,
          COALESCE((SELECT MAX(a.attempt_number) FROM orce_attempts a WHERE a.task_id = t.id), 0) + 1,
          ${input.idempotencyKey}, 'running', ${input.actorType}, ${input.actorId ?? null}, ${input.provider ?? null},
          ${input.providerRequestKey ?? null}, ${input.leaseOwner}, ${input.leaseToken},
          now() + make_interval(secs => ${input.leaseSeconds}), now(), now(), ${estimated}
        FROM target t
        WHERE NOT EXISTS (SELECT 1 FROM existing)
          AND (t.status = 'pending' OR (t.status = 'running' AND t.lease_expires_at <= now()))
          AND (t.budget_microusd IS NULL OR t.spent_microusd + t.reserved_microusd + ${estimated} <= t.budget_microusd)
          AND (SELECT COUNT(*) FROM expired) >= 0
        RETURNING *
      ), reservation AS (
        INSERT INTO orce_budget_ledger (id, run_id, task_id, attempt_id, account, delta_microusd, idempotency_key)
        SELECT ${randomUUID()}, t.run_id, t.id, i.id, 'reserved', ${estimated}, ${`${input.idempotencyKey}:reserve`}
        FROM inserted i JOIN target t ON t.id = i.task_id RETURNING run_id
      ), budgeted AS (
        UPDATE orce_runs r SET reserved_microusd = reserved_microusd + ${estimated}, updated_at = now()
        FROM reservation x WHERE r.id = x.run_id RETURNING r.id
      ), claimed AS (
        UPDATE orce_tasks t SET status = 'running', actor_type = ${input.actorType}, actor_id = ${input.actorId ?? null},
          provider = ${input.provider ?? null}, updated_at = now(), started_at = COALESCE(t.started_at, now()),
          terminal_at = NULL, terminal_reason = NULL, active_attempt_id = i.id,
          lease_owner = ${input.leaseOwner}, lease_token = ${input.leaseToken},
          lease_expires_at = i.lease_expires_at, last_heartbeat_at = now()
        FROM inserted i, budgeted b WHERE t.id = i.task_id
        RETURNING i.id
      )
      SELECT a.*, true AS claimed FROM inserted a, claimed c WHERE c.id = a.id
      UNION ALL
      SELECT a.*, false AS claimed FROM existing a`) as (Attempt & { claimed: boolean })[];
    if (rows[0]) {
      const { claimed, ...attempt } = rows[0];
      return { attempt, claimed };
    }
    const taskRows = (await this.sql`SELECT t.status, t.lease_expires_at, r.budget_microusd, r.spent_microusd, r.reserved_microusd
      FROM orce_tasks t JOIN orce_runs r ON r.id = t.run_id WHERE t.id = ${input.taskId}`) as Array<{
      status: TaskStatus; lease_expires_at: string | null; budget_microusd: number | null;
      spent_microusd: number; reserved_microusd: number;
    }>;
    if (!taskRows[0]) throw new LifecycleTransitionError("entity_not_found", "task", input.taskId, null, "running");
    const snapshot = taskRows[0];
    if (snapshot.status === "pending" && snapshot.budget_microusd != null &&
      Number(snapshot.spent_microusd) + Number(snapshot.reserved_microusd) + estimated > Number(snapshot.budget_microusd)) {
      throw new BudgetLimitError(Number(snapshot.budget_microusd), Number(snapshot.spent_microusd),
        Number(snapshot.reserved_microusd), estimated);
    }
    throw new LifecycleTransitionError("lease_held", "task", input.taskId, taskRows[0].status, "running");
  }

  async heartbeatTaskClaim(
    taskId: string,
    attemptId: string,
    leaseOwner: string,
    leaseToken: string,
    leaseSeconds: number
  ) {
    const rows = (await this.sql`
      WITH renewed AS (
        UPDATE orce_tasks SET lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
          last_heartbeat_at = now(), updated_at = now()
        WHERE id = ${taskId} AND active_attempt_id = ${attemptId} AND lease_owner = ${leaseOwner}
          AND lease_token = ${leaseToken} AND lease_expires_at > now() AND status = 'running'
        RETURNING lease_expires_at
      )
      UPDATE orce_attempts a SET lease_expires_at = r.lease_expires_at, last_heartbeat_at = now(), updated_at = now()
      FROM renewed r WHERE a.id = ${attemptId} AND a.status = 'running'
      RETURNING a.id`) as { id: string }[];
    return rows.length === 1;
  }

  async finishTaskClaim(input: FinishTaskClaimInput) {
    const actualMicrousd = Math.max(0, Math.round((input.costUsd ?? 0) * 1_000_000));
    const retainReservation = input.taskStatus === "needs_attention";
    const reconciledActualMicrousd = retainReservation ? 0 : actualMicrousd;
    const rows = (await this.sql`
      WITH owned AS (
        UPDATE orce_tasks SET status = ${input.taskStatus}, output = COALESCE(${input.output ?? null}, output),
          cost_usd = COALESCE(${input.costUsd ?? null}, cost_usd), error = ${input.error ?? null},
          actor_type = ${input.actorType}, actor_id = ${input.actorId ?? null}, provider = ${input.provider ?? null},
          updated_at = now(), terminal_at = now(), terminal_reason = ${input.terminalReason},
          active_attempt_id = NULL, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_heartbeat_at = NULL
        WHERE id = ${input.taskId} AND active_attempt_id = ${input.attemptId}
          AND lease_owner = ${input.leaseOwner} AND lease_token = ${input.leaseToken}
          AND lease_expires_at > now() AND status = 'running'
        RETURNING *
      ), finished AS (
        UPDATE orce_attempts SET status = ${input.attemptStatus}, error = ${input.error ?? null},
          actor_type = ${input.actorType}, actor_id = ${input.actorId ?? null}, provider = ${input.provider ?? null},
          updated_at = now(), terminal_at = now(), terminal_reason = ${input.terminalReason}, lease_expires_at = NULL
        WHERE id = ${input.attemptId} AND status = 'running' AND EXISTS (SELECT 1 FROM owned)
        RETURNING id, reserved_microusd
      ), reconciled AS (
        UPDATE orce_runs r SET
          reserved_microusd = GREATEST(0, r.reserved_microusd - CASE WHEN ${retainReservation} THEN 0 ELSE f.reserved_microusd END),
          spent_microusd = r.spent_microusd + ${reconciledActualMicrousd},
          cost_usd = (r.spent_microusd + ${reconciledActualMicrousd})::double precision / 1000000, updated_at = now()
        FROM owned o, finished f WHERE r.id = o.run_id RETURNING r.id
      ), released AS (
        INSERT INTO orce_budget_ledger (id, run_id, task_id, attempt_id, account, delta_microusd, idempotency_key)
        SELECT ${randomUUID()}, o.run_id, ${input.taskId}, ${input.attemptId}, 'reserved', -f.reserved_microusd,
          ${`attempt:${input.attemptId}:release`} FROM owned o, finished f, reconciled r
        WHERE ${!retainReservation} RETURNING run_id
      ), charged AS (
        INSERT INTO orce_budget_ledger (id, run_id, task_id, attempt_id, account, delta_microusd, idempotency_key)
        SELECT ${randomUUID()}, o.run_id, ${input.taskId}, ${input.attemptId}, 'spent', ${reconciledActualMicrousd},
          ${`attempt:${input.attemptId}:charge`} FROM owned o, reconciled r
        WHERE ${!retainReservation} RETURNING run_id
      ) SELECT o.* FROM owned o, reconciled r`) as Task[];
    if (rows[0]) return rows[0];
    throw new LifecycleTransitionError("stale_lease", "task", input.taskId, "running", input.taskStatus);
  }

  async updateAttemptWorktree(attemptId: string, patch: AttemptWorktreePatch) {
    const current = (await this.sql`SELECT * FROM orce_attempts WHERE id = ${attemptId}`) as Attempt[];
    if (!current[0]) throw new LifecycleTransitionError("entity_not_found", "attempt", attemptId, null, "running");
    const next = current[0];
    const rows = (await this.sql`
      UPDATE orce_attempts SET
        worktree_base_commit = ${patch.baseCommit ?? next.worktree_base_commit},
        worktree_head_commit = ${patch.headCommit ?? next.worktree_head_commit},
        worktree_path = ${patch.path ?? next.worktree_path},
        worktree_repository_path = ${patch.repositoryPath ?? next.worktree_repository_path},
        worktree_owner = ${patch.owner ?? next.worktree_owner},
        worktree_status = ${patch.status ?? next.worktree_status},
        worktree_changed_files = ${JSON.stringify(patch.changedFiles ?? next.worktree_changed_files ?? [])},
        worktree_diff = ${patch.diff ?? next.worktree_diff},
        worktree_integration_error = ${patch.integrationError === undefined ? next.worktree_integration_error : patch.integrationError},
        worktree_integrated_commit = ${patch.integratedCommit ?? next.worktree_integrated_commit},
        worktree_cleaned_at = ${patch.cleanedAt ?? next.worktree_cleaned_at},
        updated_at = now()
      WHERE id = ${attemptId}
      RETURNING *`) as Attempt[];
    return rows[0];
  }

  async listAbandonedWorktrees() {
    return (await this.sql`
      SELECT * FROM orce_attempts
      WHERE worktree_path IS NOT NULL AND worktree_cleaned_at IS NULL
        AND status NOT IN ('created', 'running')
      ORDER BY created_at ASC`) as Attempt[];
  }

  async listBudgetLedger(runId: string) {
    return (await this.sql`SELECT * FROM orce_budget_ledger WHERE run_id = ${runId} ORDER BY created_at, id`) as BudgetLedgerEntry[];
  }

  async recordBudgetSpend(runId: string, amountMicrousd: number, idempotencyKey: string) {
    const amount = Math.max(0, Math.round(amountMicrousd));
    const rows = (await this.sql`WITH entry AS (
        INSERT INTO orce_budget_ledger (id, run_id, account, delta_microusd, idempotency_key)
        VALUES (${randomUUID()}, ${runId}, 'spent', ${amount}, ${idempotencyKey})
        ON CONFLICT (idempotency_key) DO NOTHING RETURNING run_id
      ), updated AS (
        UPDATE orce_runs r SET spent_microusd = spent_microusd + ${amount},
          cost_usd = (spent_microusd + ${amount})::double precision / 1000000, updated_at = now()
        FROM entry e WHERE r.id = e.run_id RETURNING r.*
      ) SELECT * FROM updated UNION ALL
        SELECT * FROM orce_runs WHERE id = ${runId} AND NOT EXISTS (SELECT 1 FROM updated)`) as Run[];
    if (!rows[0]) throw new LifecycleTransitionError("entity_not_found", "run", runId, null, "running");
    return rows[0];
  }

  async addEvent(runId: string, taskId: string | null, type: string, level: OrceEventRow["level"], message: string) {
    const id = randomUUID();
    const r = (await this.sql`
      INSERT INTO orce_events (id, run_id, task_id, type, level, message)
      VALUES (${id}, ${runId}, ${taskId}, ${type}, ${level}, ${message})
      RETURNING *`) as OrceEventRow[];
    return r[0];
  }
  async listEvents(runId: string) {
    return (await this.sql`SELECT * FROM orce_events WHERE run_id = ${runId} ORDER BY created_at ASC`) as OrceEventRow[];
  }
}

/* ------------------------------------------------------------------ */
/* In-memory implementation                                           */
/* ------------------------------------------------------------------ */

class MemoryOrceStore implements OrceStore {
  private agents = new Map<string, Agent>();
  private runs = new Map<string, Run>();
  private tasks = new Map<string, Task>();
  private attempts = new Map<string, Attempt>();
  private events: OrceEventRow[] = [];
  private budgetLedger: BudgetLedgerEntry[] = [];
  private runCommands = new Set<string>();
  private taskSeq = 0;
  private now() {
    return new Date().toISOString();
  }

  async init() {}
  async seedBuiltins(projectId: string, which: "one" | "all") {
    const agents = which === "one" ? BUILTIN_AGENTS.slice(0, 1) : BUILTIN_AGENTS;
    for (const a of agents) await this.createAgent(projectId, a, true);
  }
  async listAgents(projectId: string) {
    return [...this.agents.values()]
      .filter((a) => a.project_id === projectId)
      .sort((a, b) => Number(b.builtin) - Number(a.builtin));
  }
  async getAgent(id: string) {
    return this.agents.get(id) ?? null;
  }
  async createAgent(projectId: string, a: AgentInput, builtin = false) {
    const agent: Agent = { id: randomUUID(), project_id: projectId, builtin, created_at: this.now(), ...a };
    this.agents.set(agent.id, agent);
    return agent;
  }
  async updateAgent(id: string, a: Partial<AgentInput>) {
    const cur = this.agents.get(id);
    if (cur) this.agents.set(id, { ...cur, ...a });
  }
  async deleteAgent(id: string) {
    const a = this.agents.get(id);
    if (a && !a.builtin) this.agents.delete(id);
  }

  async createRun(
    projectId: string,
    goal: string,
    budgetUsd: number | null,
    attachments: ImageInput[] = [],
    idempotencyKey = `run:${randomUUID()}`
  ) {
    const existing = [...this.runs.values()].find((run) => run.idempotency_key === idempotencyKey);
    if (existing) return existing;
    const now = this.now();
    const run: Run = {
      id: randomUUID(),
      project_id: projectId,
      goal,
      status: "planning",
      budget_usd: budgetUsd,
      cost_usd: 0,
      budget_microusd: budgetUsd == null ? null : Math.round(budgetUsd * 1_000_000),
      spent_microusd: 0,
      reserved_microusd: 0,
      error: null,
      attachments,
      idempotency_key: idempotencyKey,
      created_at: now,
      updated_at: now,
      started_at: null,
      terminal_at: null,
      terminal_reason: null,
      actor_type: "system",
      actor_id: null,
      provider: null,
      completed_at: null,
    };
    this.runs.set(run.id, run);
    return run;
  }
  async transitionRun(id: string, status: RunStatus, metadata: TransitionMetadata, patch: { cost_usd?: number } = {}) {
    const r = this.runs.get(id);
    if (!r) throw new LifecycleTransitionError("entity_not_found", "run", id, null, status);
    assertKnownStatus("run", status);
    assertTransition("run", id, r.status, status, metadata.terminalReason);
    const now = this.now();
    r.status = status;
    if (patch.cost_usd !== undefined) r.cost_usd = patch.cost_usd;
    r.error = metadata.error ?? null;
    r.actor_type = metadata.actorType;
    r.actor_id = metadata.actorId ?? null;
    r.provider = metadata.provider ?? null;
    r.updated_at = now;
    if (status === "running" && !r.started_at) r.started_at = now;
    if (isTerminalStatus("run", status)) {
      r.terminal_at = now;
      r.completed_at = now;
      r.terminal_reason = metadata.terminalReason?.trim() ?? null;
    }
    return r;
  }
  async listRuns(projectId: string, limit = 30) {
    return [...this.runs.values()]
      .filter((r) => r.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((r) => ({ ...r, attachments: [] }));
  }
  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }

  async applyRunCommand(input: RunCommandInput) {
    const run = this.runs.get(input.runId);
    const target: Record<RunCommandAction, RunStatus> = { start: "running", retry: "running", resume: "running", cancel: "stopped" };
    if (!run) throw new LifecycleTransitionError("entity_not_found", "run", input.runId, null, target[input.action]);
    const key = `${input.runId}:${input.action}:${input.idempotencyKey}`;
    if (!this.runCommands.has(key)) {
      this.runCommands.add(key);
      if (input.action === "start" && run.status === "awaiting_approval") run.status = "running";
      else if (input.action === "retry" && (run.status === "failed" || run.status === "needs_attention")) {
        run.status = "running";
        run.error = null;
        run.terminal_at = null;
        run.terminal_reason = null;
        run.completed_at = null;
        for (const task of this.tasks.values()) {
          if (task.run_id === run.id && ["failed", "skipped", "needs_attention"].includes(task.status)) {
            task.status = "pending";
            task.error = null;
            task.terminal_at = null;
            task.terminal_reason = null;
            task.active_attempt_id = null;
            task.lease_owner = task.lease_token = task.lease_expires_at = task.last_heartbeat_at = null;
          }
        }
      } else if (input.action === "cancel" && ["planning", "awaiting_approval", "running"].includes(run.status)) {
        run.status = "stopped";
        run.terminal_at = this.now();
        run.terminal_reason = "operator_cancelled";
        run.completed_at = run.terminal_at;
        for (const task of this.tasks.values()) {
          if (task.run_id !== run.id || !["pending", "running"].includes(task.status)) continue;
          task.status = task.status === "pending" ? "skipped" : "failed";
          task.terminal_at = this.now();
          task.terminal_reason = "operator_cancelled";
          const attempt = task.active_attempt_id ? this.attempts.get(task.active_attempt_id) : null;
          if (attempt && (attempt.status === "created" || attempt.status === "running")) {
            run.reserved_microusd = Math.max(0, run.reserved_microusd - attempt.reserved_microusd);
            if (attempt.reserved_microusd > 0) this.budgetLedger.push({ id: randomUUID(), run_id: run.id,
              task_id: task.id, attempt_id: attempt.id, account: "reserved", delta_microusd: -attempt.reserved_microusd,
              idempotency_key: `attempt:${attempt.id}:cancel-release`, created_at: this.now() });
            attempt.status = "stopped";
            attempt.terminal_at = this.now();
            attempt.terminal_reason = "operator_cancelled";
            attempt.lease_expires_at = null;
          }
          task.active_attempt_id = null;
          task.lease_owner = task.lease_token = task.lease_expires_at = task.last_heartbeat_at = null;
        }
      }
      run.actor_type = input.actorType;
      run.actor_id = input.actorId ?? null;
      run.updated_at = this.now();
    }
    if (run.status !== target[input.action]) {
      throw new LifecycleTransitionError("illegal_transition", "run", run.id, run.status, target[input.action]);
    }
    return run;
  }

  async recoverStartup(_leaseOwner: string, activeRunIds: string[] = []): Promise<StartupRecovery> {
    const resumableRunIds: string[] = [];
    const attentionRunIds: string[] = [];
    const now = Date.now();
    for (const run of this.runs.values()) {
      if (activeRunIds.includes(run.id)) continue;
      if (run.status === "planning") {
        run.status = "needs_attention";
        run.terminal_reason = "planning_interrupted_by_restart";
        run.terminal_at = this.now();
        attentionRunIds.push(run.id);
        continue;
      }
      if (run.status !== "running") continue;
      const expired = [...this.tasks.values()].filter(
        (task) => task.run_id === run.id && task.status === "running" && (!task.lease_expires_at || Date.parse(task.lease_expires_at) <= now)
      );
      if (expired.length) {
        for (const task of expired) {
          const attempts = [...this.attempts.values()].filter(
            (attempt) => attempt.task_id === task.id && (attempt.status === "created" || attempt.status === "running")
          );
          for (const attempt of attempts) {
            attempt.status = "needs_attention";
            attempt.terminal_at = this.now();
            attempt.terminal_reason = "lease_expired_after_restart";
            attempt.lease_expires_at = null;
          }
          task.status = "needs_attention";
          task.error = "Worker lease expired after restart; reconcile provider usage before retrying.";
          task.terminal_reason = "lease_expired_after_restart";
          task.terminal_at = this.now();
          task.active_attempt_id = null;
          task.lease_owner = task.lease_token = task.lease_expires_at = task.last_heartbeat_at = null;
        }
        run.status = "needs_attention";
        run.terminal_reason = "task_lease_expired_after_restart";
        run.terminal_at = this.now();
        attentionRunIds.push(run.id);
      } else if (![...this.tasks.values()].some((task) => task.run_id === run.id && task.status === "running")) {
        resumableRunIds.push(run.id);
      }
    }
    return { resumableRunIds, attentionRunIds };
  }

  async createTask(t: TaskInput) {
    const ticket = `TASK-${String(++this.taskSeq).padStart(4, "0")}`;
    const id = randomUUID();
    const now = this.now();
    const { idempotencyKey, ...values } = t;
    const task: Task = {
      id,
      ticket,
      idempotency_key: idempotencyKey ?? `task:${id}`,
      created_at: now,
      updated_at: now,
      started_at: null,
      terminal_at: null,
      terminal_reason: null,
      actor_type: "system",
      actor_id: null,
      provider: null,
      active_attempt_id: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      last_heartbeat_at: null,
      ...values,
    };
    this.tasks.set(task.id, task);
    return task;
  }
  async transitionTask(
    id: string,
    status: TaskStatus,
    metadata: TransitionMetadata,
    patch: { output?: string; cost_usd?: number } = {}
  ) {
    const t = this.tasks.get(id);
    if (!t) throw new LifecycleTransitionError("entity_not_found", "task", id, null, status);
    assertKnownStatus("task", status);
    assertTransition("task", id, t.status, status, metadata.terminalReason);
    const now = this.now();
    t.status = status;
    if (patch.output !== undefined) t.output = patch.output;
    if (patch.cost_usd !== undefined) t.cost_usd = patch.cost_usd;
    t.error = metadata.error ?? null;
    t.actor_type = metadata.actorType;
    t.actor_id = metadata.actorId ?? null;
    t.provider = metadata.provider ?? null;
    t.updated_at = now;
    if (status === "running" && !t.started_at) t.started_at = now;
    if (isTerminalStatus("task", status)) {
      t.terminal_at = now;
      t.terminal_reason = metadata.terminalReason?.trim() ?? null;
    } else {
      t.terminal_at = null;
      t.terminal_reason = null;
    }
    return t;
  }
  async listTasks(runId: string) {
    return [...this.tasks.values()].filter((t) => t.run_id === runId).sort((a, b) => a.order_idx - b.order_idx);
  }

  async listAllTasks(projectId: string, limit = 200) {
    return [...this.tasks.values()]
      .filter((t) => this.runs.get(t.run_id)?.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((t) => ({ ...t, run_goal: this.runs.get(t.run_id)?.goal ?? "" }));
  }

  async createAttempt(input: AttemptInput) {
    const existing = [...this.attempts.values()].find((attempt) => attempt.idempotency_key === input.idempotencyKey);
    if (existing) return existing;
    const attemptNumber =
      Math.max(0, ...[...this.attempts.values()].filter((a) => a.task_id === input.taskId).map((a) => a.attempt_number)) + 1;
    const now = this.now();
    const attempt: Attempt = {
      id: randomUUID(),
      task_id: input.taskId,
      attempt_number: attemptNumber,
      idempotency_key: input.idempotencyKey,
      status: "created",
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      provider: input.provider ?? null,
      provider_request_key: input.providerRequestKey ?? null,
      created_at: now,
      updated_at: now,
      started_at: null,
      terminal_at: null,
      terminal_reason: null,
      error: null,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      last_heartbeat_at: null,
      reserved_microusd: 0,
      worktree_base_commit: null,
      worktree_head_commit: null,
      worktree_path: null,
      worktree_repository_path: null,
      worktree_owner: null,
      worktree_status: null,
      worktree_changed_files: [],
      worktree_diff: null,
      worktree_integration_error: null,
      worktree_integrated_commit: null,
      worktree_cleaned_at: null,
    };
    this.attempts.set(attempt.id, attempt);
    return attempt;
  }

  async transitionAttempt(id: string, status: AttemptStatus, metadata: TransitionMetadata) {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new LifecycleTransitionError("entity_not_found", "attempt", id, null, status);
    assertKnownStatus("attempt", status);
    assertTransition("attempt", id, attempt.status, status, metadata.terminalReason);
    const now = this.now();
    attempt.status = status;
    attempt.actor_type = metadata.actorType;
    attempt.actor_id = metadata.actorId ?? null;
    attempt.provider = metadata.provider ?? null;
    attempt.error = metadata.error ?? null;
    attempt.updated_at = now;
    if (status === "running" && !attempt.started_at) attempt.started_at = now;
    if (isTerminalStatus("attempt", status)) {
      attempt.terminal_at = now;
      attempt.terminal_reason = metadata.terminalReason?.trim() ?? null;
    }
    return attempt;
  }

  async listAttempts(taskId: string) {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.task_id === taskId)
      .sort((a, b) => a.attempt_number - b.attempt_number);
  }

  async claimTask(input: TaskClaimInput): Promise<TaskClaim> {
    const existing = [...this.attempts.values()].find((attempt) => attempt.idempotency_key === input.idempotencyKey);
    if (existing) return { attempt: existing, claimed: false };
    const task = this.tasks.get(input.taskId);
    if (!task) throw new LifecycleTransitionError("entity_not_found", "task", input.taskId, null, "running");
    if (task.status === "running" && task.lease_expires_at && Date.parse(task.lease_expires_at) > Date.now()) {
      throw new LifecycleTransitionError("lease_held", "task", task.id, task.status, "running");
    }
    if (task.status !== "pending" && task.status !== "running") {
      throw new LifecycleTransitionError("illegal_transition", "task", task.id, task.status, "running");
    }
    const run = this.runs.get(task.run_id)!;
    const estimated = Math.max(0, Math.round(input.estimatedCostMicrousd ?? 0));
    if (run.budget_microusd != null && run.spent_microusd + run.reserved_microusd + estimated > run.budget_microusd)
      throw new BudgetLimitError(run.budget_microusd, run.spent_microusd, run.reserved_microusd, estimated);
    if (task.active_attempt_id) {
      const prior = this.attempts.get(task.active_attempt_id);
      if (prior && (prior.status === "created" || prior.status === "running")) {
        prior.status = "needs_attention";
        prior.terminal_reason = "lease_expired";
        prior.terminal_at = this.now();
      }
    }
    const attempt = await this.createAttempt(input);
    attempt.reserved_microusd = estimated;
    run.reserved_microusd += estimated;
    this.budgetLedger.push({ id: randomUUID(), run_id: run.id, task_id: task.id, attempt_id: attempt.id,
      account: "reserved", delta_microusd: estimated, idempotency_key: `${input.idempotencyKey}:reserve`, created_at: this.now() });
    const expires = new Date(Date.now() + input.leaseSeconds * 1_000).toISOString();
    attempt.status = "running";
    attempt.started_at = this.now();
    attempt.lease_owner = input.leaseOwner;
    attempt.lease_token = input.leaseToken;
    attempt.lease_expires_at = expires;
    attempt.last_heartbeat_at = this.now();
    task.status = "running";
    task.active_attempt_id = attempt.id;
    task.lease_owner = input.leaseOwner;
    task.lease_token = input.leaseToken;
    task.lease_expires_at = expires;
    task.last_heartbeat_at = this.now();
    return { attempt, claimed: true };
  }

  async heartbeatTaskClaim(taskId: string, attemptId: string, leaseOwner: string, leaseToken: string, leaseSeconds: number) {
    const task = this.tasks.get(taskId);
    const attempt = this.attempts.get(attemptId);
    if (!task || !attempt || task.active_attempt_id !== attemptId || task.lease_owner !== leaseOwner || task.lease_token !== leaseToken ||
      !task.lease_expires_at || Date.parse(task.lease_expires_at) <= Date.now() || task.status !== "running") return false;
    const expires = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
    task.lease_expires_at = attempt.lease_expires_at = expires;
    task.last_heartbeat_at = attempt.last_heartbeat_at = this.now();
    return true;
  }

  async finishTaskClaim(input: FinishTaskClaimInput) {
    const task = this.tasks.get(input.taskId);
    const attempt = this.attempts.get(input.attemptId);
    if (!task || !attempt || task.active_attempt_id !== input.attemptId || task.lease_owner !== input.leaseOwner ||
      task.lease_token !== input.leaseToken || !task.lease_expires_at || Date.parse(task.lease_expires_at) <= Date.now()) {
      throw new LifecycleTransitionError("stale_lease", "task", input.taskId, "running", input.taskStatus);
    }
    task.status = input.taskStatus;
    task.output = input.output ?? task.output;
    task.cost_usd = input.costUsd ?? task.cost_usd;
    task.error = input.error ?? null;
    task.terminal_at = this.now();
    task.terminal_reason = input.terminalReason;
    task.active_attempt_id = null;
    task.lease_owner = task.lease_token = task.lease_expires_at = task.last_heartbeat_at = null;
    attempt.status = input.attemptStatus;
    attempt.error = input.error ?? null;
    attempt.terminal_at = this.now();
    attempt.terminal_reason = input.terminalReason;
    attempt.lease_expires_at = null;
    const run = this.runs.get(task.run_id)!;
    const actualMicrousd = Math.max(0, Math.round((input.costUsd ?? 0) * 1_000_000));
    if (input.taskStatus !== "needs_attention") {
      run.reserved_microusd = Math.max(0, run.reserved_microusd - attempt.reserved_microusd);
      run.spent_microusd += actualMicrousd; run.cost_usd = run.spent_microusd / 1_000_000;
      this.budgetLedger.push(
        { id: randomUUID(), run_id: run.id, task_id: task.id, attempt_id: attempt.id, account: "reserved",
          delta_microusd: -attempt.reserved_microusd, idempotency_key: `attempt:${attempt.id}:release`, created_at: this.now() },
        { id: randomUUID(), run_id: run.id, task_id: task.id, attempt_id: attempt.id, account: "spent",
          delta_microusd: actualMicrousd, idempotency_key: `attempt:${attempt.id}:charge`, created_at: this.now() });
    }
    return task;
  }

  async updateAttemptWorktree(attemptId: string, patch: AttemptWorktreePatch) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new LifecycleTransitionError("entity_not_found", "attempt", attemptId, null, "running");
    if (patch.baseCommit !== undefined) attempt.worktree_base_commit = patch.baseCommit;
    if (patch.headCommit !== undefined) attempt.worktree_head_commit = patch.headCommit;
    if (patch.path !== undefined) attempt.worktree_path = patch.path;
    if (patch.repositoryPath !== undefined) attempt.worktree_repository_path = patch.repositoryPath;
    if (patch.owner !== undefined) attempt.worktree_owner = patch.owner;
    if (patch.status !== undefined) attempt.worktree_status = patch.status;
    if (patch.changedFiles !== undefined) attempt.worktree_changed_files = [...patch.changedFiles];
    if (patch.diff !== undefined) attempt.worktree_diff = patch.diff;
    if (patch.integrationError !== undefined) attempt.worktree_integration_error = patch.integrationError;
    if (patch.integratedCommit !== undefined) attempt.worktree_integrated_commit = patch.integratedCommit;
    if (patch.cleanedAt !== undefined) attempt.worktree_cleaned_at = patch.cleanedAt;
    attempt.updated_at = this.now();
    return attempt;
  }

  async listAbandonedWorktrees() {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.worktree_path && !attempt.worktree_cleaned_at && !["created", "running"].includes(attempt.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listBudgetLedger(runId: string) { return this.budgetLedger.filter((entry) => entry.run_id === runId); }
  async recordBudgetSpend(runId: string, amountMicrousd: number, idempotencyKey: string) {
    const run = this.runs.get(runId);
    if (!run) throw new LifecycleTransitionError("entity_not_found", "run", runId, null, "running");
    if (this.budgetLedger.some((entry) => entry.idempotency_key === idempotencyKey)) return run;
    const amount = Math.max(0, Math.round(amountMicrousd));
    run.spent_microusd += amount; run.cost_usd = run.spent_microusd / 1_000_000;
    this.budgetLedger.push({ id: randomUUID(), run_id: runId, task_id: null, attempt_id: null, account: "spent",
      delta_microusd: amount, idempotency_key: idempotencyKey, created_at: this.now() });
    return run;
  }

  async addEvent(runId: string, taskId: string | null, type: string, level: OrceEventRow["level"], message: string) {
    const row: OrceEventRow = { id: randomUUID(), run_id: runId, task_id: taskId, type, level, message, created_at: this.now() };
    this.events.push(row);
    return row;
  }
  async listEvents(runId: string) {
    return this.events.filter((e) => e.run_id === runId);
  }
}

export let orceStore: OrceStore;

export async function initOrce() {
  orceStore = dbMode() === "memory" ? new MemoryOrceStore() : new SqlOrceStore();
  await orceStore.init();
  console.log("[orce] store ready");
}
