import { neon } from "@neondatabase/serverless";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Database driver. Default is an embedded local Postgres (PGlite) that persists
 * to `~/.nexotao-orce/db` with zero setup — install and start coding. Set
 * DATABASE_URL to use a hosted Neon/Postgres instead, or NEXOTAO_DB=memory for
 * ephemeral in-memory.
 *
 * Both Neon and PGlite speak Postgres, so all SQL stores share one `sql`
 * tagged-template that returns rows (identical to the neon serverless client).
 */

type SqlFn = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

let sqlFn: SqlFn | null = null;
let mode: "neon" | "local" | "memory" = "memory";

export async function initDb() {
  if (config.databaseUrl) {
    sqlFn = neon(config.databaseUrl) as unknown as SqlFn;
    mode = "neon";
    return;
  }
  if (config.dbForceMemory) {
    mode = "memory";
    return;
  }
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = join(process.env.NEXOTAO_DATA || join(homedir(), ".nexotao-orce"), "db");
    mkdirSync(dir, { recursive: true }); // PGlite doesn't create parent dirs
    const pg = new PGlite(dir);
    await pg.waitReady;
    sqlFn = async (strings, ...values) => {
      // Convert the tagged template into a $1,$2 parameterized query (like neon).
      let text = strings[0];
      for (let i = 0; i < values.length; i++) text += "$" + (i + 1) + strings[i + 1];
      const r = await pg.query(text, values);
      return r.rows as any[];
    };
    mode = "local";
  } catch (err) {
    console.warn("[db] embedded database unavailable — using in-memory:", err instanceof Error ? err.message : err);
    mode = "memory";
  }
}

export function dbMode() {
  return mode;
}

export function dbLabel() {
  return mode === "neon" ? "Neon/Postgres" : mode === "local" ? "local (PGlite, persistent)" : "in-memory (not persistent)";
}

/** Shared Postgres tagged-template. Throws if used before initDb() or in memory mode. */
export const sql: SqlFn = (strings, ...values) => {
  if (!sqlFn) throw new Error("database not initialized (memory mode has no SQL)");
  return sqlFn(strings, ...values);
};
