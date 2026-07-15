#!/usr/bin/env node
// Nexotao Orce — one-command launcher.
// Ensures deps + build, provisions local secrets, then starts the server.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
};
const log = (s = "") => console.log(s);

if (has("--help") || has("-h")) {
  log(`
  ${c.bold("nexotao")} — self-hostable web console for Claude Code

  Usage:
    nexotao                 start and open the UI in your browser
    nexotao --port 9000     start on a custom port
    nexotao --no-open       start without opening the browser
    nexotao reset-password  forget the password — set a new one in the app
    npx nexotao-orce        run without a global install

  On first run you create your password in the app (nothing is printed here).
  Stop it with Ctrl+C.

  Environment overrides:
    PORT, APP_PASSWORD, DATABASE_URL, NEXOTAO_DB, PERMISSION_MODE, NEXOTAO_DATA
`);
  process.exit(0);
}

if (has("--version") || has("-v")) {
  log(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  process.exit(0);
}

function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`\n✖ \`${cmd} ${cmdArgs.join(" ")}\` failed.`);
    process.exit(r.status ?? 1);
  }
}

function canResolve(name) {
  try {
    require.resolve(name, { paths: [root, join(root, "server")] });
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* headless / no browser — the URL is printed anyway */
  }
}

// ---- Node version guard ----
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Nexotao Orce needs Node 20+. You have ${process.versions.node}.`);
  process.exit(1);
}

// ---- Data dir + persistent secrets (survive restarts; work for npx) ----
const dataDir = process.env.NEXOTAO_DATA || join(homedir(), ".nexotao-orce");
const workspace = process.env.AGENT_CWD || join(dataDir, "workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

const cfgPath = join(dataDir, "config.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
let cfgChanged = false;
if (!cfg.jwtSecret) {
  cfg.jwtSecret = randomBytes(32).toString("hex");
  cfgChanged = true;
}
// `nexotao reset-password`: forget the password so the next start asks for a
// new one in the app (also clears the hash stored in the DB via the env flag).
const resetPassword = has("reset-password") || has("--reset-password");
if (resetPassword && cfg.password) {
  delete cfg.password;
  cfgChanged = true;
}
if (cfgChanged) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// Password is created by the operator on first run IN THE APP (stored hashed,
// server-side) — never generated or printed here. An explicit APP_PASSWORD env
// or a legacy cfg.password still works; empty means "first run, set it in-app".
const appPassword = process.env.APP_PASSWORD || cfg.password || "";

// ---- Ensure dependencies + build (skipped when shipped prebuilt) ----
if (!canResolve("hono")) {
  log(c.dim("Installing dependencies (first run)…"));
  run("npm", ["install"], root);
}
const built = existsSync(join(root, "web", "dist", "index.html")) && existsSync(join(root, "server", "dist", "index.js"));
if (!built) {
  log(c.dim("Building the app (first run)…"));
  run("npm", ["run", "build"], root);
}

// ---- Launch ----
const port = flagValue("--port", process.env.PORT || "8787");
const env = {
  ...process.env,
  NODE_ENV: "production",
  PORT: String(port),
  APP_PASSWORD: appPassword,
  JWT_SECRET: process.env.JWT_SECRET || cfg.jwtSecret,
  AGENT_CWD: workspace,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || cfg.apiKey || "",
  DATABASE_URL: process.env.DATABASE_URL || cfg.databaseUrl || "",
  PERMISSION_MODE: process.env.PERMISSION_MODE || "bypassPermissions",
  ...(resetPassword ? { NEXOTAO_RESET_PASSWORD: "1" } : {}),
};

const url = `http://localhost:${port}`;
log();
log(`  ${c.bold("◆ Nexotao Orce")}`);
log(`  ${c.dim("→")} ${c.green(url)}`);
if (resetPassword) {
  log(`  ${c.gold("→ password reset — create a new one in the app")}`);
} else if (appPassword) {
  log(`  ${c.dim("→ locked — log in with your password in the app")}`);
} else {
  log(`  ${c.gold("→ first run — create your password in the app")}`);
}
log(`  ${c.dim("→ workspace:")} ${workspace}`);
if (!env.DATABASE_URL) {
  log(`  ${c.dim(`→ storage: local database (persistent) at ${dataDir}/db`)}`);
}
log(`  ${c.dim("→ set your Nexotao API key + model in the app (onboarding / Settings)")}`);
log(`  ${c.dim("→ forgot your password? run")} ${c.bold("nexotao reset-password")}`);
log();
log(`  ${c.dim("Press")} ${c.bold("Ctrl+C")} ${c.dim("to stop.")}`);
log();

const child = spawn(process.execPath, [join(root, "server", "dist", "index.js")], {
  cwd: join(root, "server"),
  env,
  stdio: "inherit",
});

// Open the UI in the default browser once the server is up (unless --no-open).
if (!has("--no-open")) {
  setTimeout(() => openBrowser(url), 1200);
}

let stopping = false;
function stop(sig) {
  if (stopping) return;
  stopping = true;
  child.kill(sig);
}
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
