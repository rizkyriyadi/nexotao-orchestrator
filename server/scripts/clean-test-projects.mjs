// One-off cleanup: remove the `cbt-demo` test projects (and their sessions) that
// were written to the dev DATABASE_URL during testing, and clear the test
// auth_password. Safe: only touches rows named "cbt-demo" at /tmp/cbt-demo.
// Run from the server/ dir:  node scripts/clean-test-projects.mjs
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.log("No DATABASE_URL set — nothing to clean."); process.exit(0); }
const sql = neon(url);

const mine = await sql`SELECT id FROM projects WHERE name = ${"cbt-demo"} AND path = ${"/tmp/cbt-demo"}`;
console.log(`Removing ${mine.length} cbt-demo test project(s)…`);
for (const { id } of mine) {
  await sql`DELETE FROM sessions WHERE project_id = ${id}`;
  try { await sql`DELETE FROM orce_runs WHERE project_id = ${id}`; } catch {}
  try { await sql`DELETE FROM orce_agents WHERE project_id = ${id}`; } catch {}
  await sql`DELETE FROM projects WHERE id = ${id}`;
}
await sql`DELETE FROM app_settings WHERE key = ${"auth_password"}`;
const active = await sql`SELECT value FROM app_settings WHERE key = ${"active_project_id"}`;
if (active[0] && mine.some((m) => m.id === active[0].value)) {
  await sql`DELETE FROM app_settings WHERE key = ${"active_project_id"}`;
}

const left = await sql`SELECT name, path FROM projects ORDER BY created_at`;
console.log("Remaining projects:");
for (const p of left) console.log(`  - ${p.name}  ${p.path}`);
console.log("Cleared test auth_password. Done.");
