import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ORCE_SCHEMA_VERSION, OrceMigrationError, runOrceMigrations, type SqlFn } from "./migrations.js";

function sqlFor(pg: PGlite): SqlFn {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index++) text += `$${index + 1}${strings[index + 1]}`;
    return (await pg.query(text, values)).rows;
  };
}

test("embedded migration upgrades supported legacy run/task data and is restart-safe", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const sql = sqlFor(pg);
  const runId = randomUUID();
  const taskId = randomUUID();

  await pg.exec(`
    CREATE TABLE orce_runs (
      id UUID PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planning',
      budget_usd DOUBLE PRECISION, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      error TEXT, attachments JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE orce_tasks (
      id UUID PRIMARY KEY, run_id UUID NOT NULL REFERENCES orce_runs(id) ON DELETE CASCADE,
      ticket TEXT, key TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, agent_id UUID,
      agent_label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', depends_on JSONB NOT NULL DEFAULT '[]',
      output TEXT, cost_usd DOUBLE PRECISION, error TEXT, order_idx INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pg.query("INSERT INTO orce_runs (id, goal, status) VALUES ($1, 'legacy run', 'completed')", [runId]);
  await pg.query(
    "INSERT INTO orce_tasks (id, run_id, key, title, prompt, status) VALUES ($1, $2, 'legacy', 'Legacy', 'Legacy', 'done')",
    [taskId, runId]
  );

  const applied = await runOrceMigrations(sql);
  assert.equal(applied.at(-1), ORCE_SCHEMA_VERSION);
  assert.deepEqual(await runOrceMigrations(sql), []);

  const runs = await pg.query<{
    idempotency_key: string;
    terminal_reason: string;
    terminal_at: Date;
  }>("SELECT idempotency_key, terminal_reason, terminal_at FROM orce_runs WHERE id = $1", [runId]);
  assert.equal(runs.rows[0].idempotency_key, `legacy:run:${runId}`);
  assert.equal(runs.rows[0].terminal_reason, "legacy_completed");
  assert(runs.rows[0].terminal_at);

  const tasks = await pg.query<{ idempotency_key: string; terminal_reason: string }>(
    "SELECT idempotency_key, terminal_reason FROM orce_tasks WHERE id = $1",
    [taskId]
  );
  assert.equal(tasks.rows[0].idempotency_key, `legacy:task:${taskId}`);
  assert.equal(tasks.rows[0].terminal_reason, "legacy_done");

  const versions = await pg.query<{ version: number }>("SELECT version FROM orce_schema_migrations ORDER BY version");
  assert.deepEqual(versions.rows.map((row) => Number(row.version)), [...applied].sort((a, b) => a - b));
  await pg.close();
});

test("migration failures identify the unapplied version and statement", async () => {
  const sql: SqlFn = async (strings) => {
    const text = strings[0];
    if (text.includes("SELECT version")) return [];
    if (text.includes("CREATE TABLE IF NOT EXISTS orce_agents")) throw new Error("injected DDL failure");
    return [];
  };

  await assert.rejects(
    () => runOrceMigrations(sql),
    (error) => {
      assert(error instanceof OrceMigrationError);
      assert.equal(error.version, 1);
      assert.equal(error.statementNumber, 1);
      assert.match(error.message, /injected DDL failure/);
      assert.match(error.message, /restart to retry safely/);
      return true;
    }
  );
});
