export type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "orce_baseline",
    statements: [
      `CREATE TABLE IF NOT EXISTS orce_agents (
        id UUID PRIMARY KEY,
        project_id UUID,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        model TEXT,
        tools JSONB,
        isolate BOOLEAN NOT NULL DEFAULT false,
        builtin BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS orce_runs (
        id UUID PRIMARY KEY,
        project_id UUID,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        budget_usd DOUBLE PRECISION,
        cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        error TEXT,
        attachments JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      )`,
      `CREATE SEQUENCE IF NOT EXISTS orce_task_seq START 1`,
      `CREATE TABLE IF NOT EXISTS orce_tasks (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES orce_runs(id) ON DELETE CASCADE,
        ticket TEXT,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        agent_id UUID,
        agent_label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        depends_on JSONB NOT NULL DEFAULT '[]',
        output TEXT,
        cost_usd DOUBLE PRECISION,
        error TEXT,
        order_idx INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS orce_tasks_run_idx ON orce_tasks(run_id)`,
      `CREATE TABLE IF NOT EXISTS orce_events (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES orce_runs(id) ON DELETE CASCADE,
        task_id UUID,
        type TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS orce_events_run_idx ON orce_events(run_id)`,
    ],
  },
  {
    version: 2,
    name: "durable_lifecycle_state",
    statements: [
      `ALTER TABLE orce_agents ADD COLUMN IF NOT EXISTS project_id UUID`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS project_id UUID`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS budget_usd DOUBLE PRECISION`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS terminal_reason TEXT`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'system'`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS actor_id TEXT`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS provider TEXT`,
      `UPDATE orce_runs SET idempotency_key = 'legacy:run:' || id::text WHERE idempotency_key IS NULL`,
      `UPDATE orce_runs SET started_at = COALESCE(started_at, created_at)
       WHERE status IN ('running', 'completed', 'failed', 'stopped', 'needs_attention')`,
      `UPDATE orce_runs
         SET terminal_at = COALESCE(terminal_at, completed_at, created_at),
             terminal_reason = COALESCE(terminal_reason, 'legacy_' || status)
       WHERE status IN ('completed', 'failed', 'stopped', 'needs_attention')`,
      `ALTER TABLE orce_runs ALTER COLUMN idempotency_key SET NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS orce_runs_idempotency_idx ON orce_runs(idempotency_key)`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS ticket TEXT`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS terminal_reason TEXT`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'system'`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS actor_id TEXT`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS provider TEXT`,
      `UPDATE orce_tasks SET idempotency_key = 'legacy:task:' || id::text WHERE idempotency_key IS NULL`,
      `UPDATE orce_tasks SET started_at = COALESCE(started_at, created_at)
       WHERE status IN ('running', 'done', 'failed', 'needs_attention')`,
      `UPDATE orce_tasks
         SET terminal_at = COALESCE(terminal_at, created_at),
             terminal_reason = COALESCE(terminal_reason, 'legacy_' || status)
       WHERE status IN ('done', 'failed', 'skipped', 'needs_attention')`,
      `ALTER TABLE orce_tasks ALTER COLUMN idempotency_key SET NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS orce_tasks_idempotency_idx ON orce_tasks(idempotency_key)`,
      `CREATE TABLE IF NOT EXISTS orce_attempts (
        id UUID PRIMARY KEY,
        task_id UUID NOT NULL REFERENCES orce_tasks(id) ON DELETE CASCADE,
        attempt_number INT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        provider TEXT,
        provider_request_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at TIMESTAMPTZ,
        terminal_at TIMESTAMPTZ,
        terminal_reason TEXT,
        error TEXT,
        CONSTRAINT orce_attempts_number_positive CHECK (attempt_number > 0),
        CONSTRAINT orce_attempts_task_number_unique UNIQUE (task_id, attempt_number),
        CONSTRAINT orce_attempts_idempotency_unique UNIQUE (idempotency_key)
      )`,
      `CREATE INDEX IF NOT EXISTS orce_attempts_task_idx ON orce_attempts(task_id, attempt_number)`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_runs_status_check') THEN
           ALTER TABLE orce_runs ADD CONSTRAINT orce_runs_status_check
             CHECK (status IN ('planning', 'awaiting_approval', 'running', 'completed', 'failed', 'stopped', 'needs_attention'));
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_tasks_status_check') THEN
           ALTER TABLE orce_tasks ADD CONSTRAINT orce_tasks_status_check
             CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped', 'needs_attention'));
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_attempts_status_check') THEN
           ALTER TABLE orce_attempts ADD CONSTRAINT orce_attempts_status_check
             CHECK (status IN ('created', 'running', 'completed', 'failed', 'stopped', 'needs_attention'));
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_runs_terminal_metadata_check') THEN
           ALTER TABLE orce_runs ADD CONSTRAINT orce_runs_terminal_metadata_check
             CHECK (status NOT IN ('completed', 'failed', 'stopped', 'needs_attention') OR
               (terminal_reason IS NOT NULL AND terminal_at IS NOT NULL));
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_tasks_terminal_metadata_check') THEN
           ALTER TABLE orce_tasks ADD CONSTRAINT orce_tasks_terminal_metadata_check
             CHECK (status NOT IN ('done', 'failed', 'skipped', 'needs_attention') OR
               (terminal_reason IS NOT NULL AND terminal_at IS NOT NULL));
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_attempts_terminal_metadata_check') THEN
           ALTER TABLE orce_attempts ADD CONSTRAINT orce_attempts_terminal_metadata_check
             CHECK (status NOT IN ('completed', 'failed', 'stopped', 'needs_attention') OR
               (terminal_reason IS NOT NULL AND terminal_at IS NOT NULL));
         END IF;
       END $$`,
    ],
  },
  {
    version: 3,
    name: "atomic_task_claims_and_commands",
    statements: [
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS active_attempt_id UUID REFERENCES orce_attempts(id)`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS lease_owner TEXT`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
      `ALTER TABLE orce_tasks ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS lease_owner TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS lease_token UUID`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,
      `CREATE UNIQUE INDEX IF NOT EXISTS orce_attempts_one_active_per_task_idx
         ON orce_attempts(task_id) WHERE status IN ('created', 'running')`,
      `CREATE TABLE IF NOT EXISTS orce_run_commands (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL REFERENCES orce_runs(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('start', 'retry', 'cancel', 'resume')),
        idempotency_key TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT orce_run_commands_idempotency_unique UNIQUE (run_id, action, idempotency_key)
      )`,
      `CREATE INDEX IF NOT EXISTS orce_run_commands_run_idx ON orce_run_commands(run_id, created_at)`,
    ],
  },
  {
    version: 4,
    name: "durable_budget_reservations",
    statements: [
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS budget_microusd BIGINT`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS spent_microusd BIGINT NOT NULL DEFAULT 0`,
      `ALTER TABLE orce_runs ADD COLUMN IF NOT EXISTS reserved_microusd BIGINT NOT NULL DEFAULT 0`,
      `UPDATE orce_runs SET budget_microusd = round(budget_usd * 1000000)::bigint
       WHERE budget_usd IS NOT NULL AND budget_microusd IS NULL`,
      `UPDATE orce_runs SET spent_microusd = round(cost_usd * 1000000)::bigint WHERE spent_microusd = 0`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS reserved_microusd BIGINT NOT NULL DEFAULT 0`,
      `CREATE TABLE IF NOT EXISTS orce_budget_ledger (
        id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES orce_runs(id) ON DELETE CASCADE,
        task_id UUID REFERENCES orce_tasks(id) ON DELETE SET NULL,
        attempt_id UUID REFERENCES orce_attempts(id) ON DELETE SET NULL,
        account TEXT NOT NULL CHECK (account IN ('reserved', 'spent')),
        delta_microusd BIGINT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS orce_budget_ledger_run_idx ON orce_budget_ledger(run_id, created_at)`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_runs_budget_nonnegative') THEN
         ALTER TABLE orce_runs ADD CONSTRAINT orce_runs_budget_nonnegative
           CHECK (budget_microusd IS NULL OR budget_microusd >= 0);
       END IF; END $$`,
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_runs_spend_nonnegative') THEN
         ALTER TABLE orce_runs ADD CONSTRAINT orce_runs_spend_nonnegative
           CHECK (spent_microusd >= 0 AND reserved_microusd >= 0);
       END IF; END $$`,
    ],
  },
  {
    version: 5,
    name: "attempt_git_worktrees",
    statements: [
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_base_commit TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_head_commit TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_path TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_repository_path TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_owner TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_status TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_changed_files JSONB NOT NULL DEFAULT '[]'`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_diff TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_integration_error TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_integrated_commit TEXT`,
      `ALTER TABLE orce_attempts ADD COLUMN IF NOT EXISTS worktree_cleaned_at TIMESTAMPTZ`,
      `CREATE UNIQUE INDEX IF NOT EXISTS orce_attempts_worktree_path_idx
         ON orce_attempts(worktree_path) WHERE worktree_path IS NOT NULL`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orce_attempts_worktree_status_check') THEN
           ALTER TABLE orce_attempts ADD CONSTRAINT orce_attempts_worktree_status_check
             CHECK (worktree_status IS NULL OR worktree_status IN
               ('active', 'captured', 'integrated', 'conflict', 'cleanup_pending'));
         END IF;
       END $$`,
    ],
  },
] as const;

export class OrceMigrationError extends Error {
  constructor(
    public readonly version: number,
    public readonly migrationName: string,
    public readonly statementNumber: number,
    cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Orce migration ${version} (${migrationName}) failed at statement ${statementNumber}: ${message}. ` +
        "The version was not recorded; fix the database error and restart to retry safely."
    );
    this.name = "OrceMigrationError";
    this.cause = cause;
  }
}

function template(text: string): TemplateStringsArray {
  return Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
}

async function execute(sql: SqlFn, statement: string): Promise<void> {
  await sql(template(statement));
}

export async function runOrceMigrations(sql: SqlFn): Promise<number[]> {
  try {
    await execute(
      sql,
      `CREATE TABLE IF NOT EXISTS orce_schema_migrations (
        version INT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    );
  } catch (error) {
    throw new OrceMigrationError(0, "migration_bootstrap", 1, error);
  }

  let appliedRows: { version: number }[];
  try {
    appliedRows = (await sql`SELECT version FROM orce_schema_migrations ORDER BY version`) as { version: number }[];
  } catch (error) {
    throw new OrceMigrationError(0, "migration_bootstrap", 2, error);
  }
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const completed: number[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    for (let index = 0; index < migration.statements.length; index++) {
      try {
        await execute(sql, migration.statements[index]);
      } catch (error) {
        throw new OrceMigrationError(migration.version, migration.name, index + 1, error);
      }
    }
    try {
      await sql`INSERT INTO orce_schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
    } catch (error) {
      throw new OrceMigrationError(migration.version, migration.name, migration.statements.length + 1, error);
    }
    completed.push(migration.version);
  }

  return completed;
}

export const ORCE_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
