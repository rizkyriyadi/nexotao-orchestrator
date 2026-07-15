import "dotenv/config";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const defaultCwd = resolve(process.cwd(), "workspace");
const permissionMode = (process.env.PERMISSION_MODE || "plan") as
  | "bypassPermissions"
  | "acceptEdits"
  | "default"
  | "plan";
const dangerousMode = permissionMode === "bypassPermissions";
const dangerousModeAcknowledged =
  process.env.DANGEROUS_MODE_ACKNOWLEDGEMENT === "I_UNDERSTAND_ORCE_CAN_EXECUTE_ARBITRARY_COMMANDS";

if (dangerousMode && !dangerousModeAcknowledged) {
  throw new Error(
    "PERMISSION_MODE=bypassPermissions requires DANGEROUS_MODE_ACKNOWLEDGEMENT=" +
      "I_UNDERSTAND_ORCE_CAN_EXECUTE_ARBITRARY_COMMANDS"
  );
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Optional: an explicit APP_PASSWORD (Docker/power users). When unset, the
  // operator creates a password on first run in the UI (see auth.ts).
  appPassword: process.env.APP_PASSWORD || undefined,
  jwtSecret: required("JWT_SECRET", "please-change-me-to-a-long-random-string"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  agentCwd: resolve(process.env.AGENT_CWD || defaultCwd),
  permissionMode,
  dangerousMode,
  dangerousModeAcknowledged,
  sessionTtlSeconds: Math.max(300, Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12)),
  loginMaxFailures: Math.max(1, Number(process.env.LOGIN_MAX_FAILURES ?? 5)),
  loginWindowMs: Math.max(1_000, Number(process.env.LOGIN_WINDOW_MS ?? 10 * 60 * 1_000)),
  loginBlockMs: Math.max(1_000, Number(process.env.LOGIN_BLOCK_MS ?? 15 * 60 * 1_000)),
  taskReservationMicrousd: Math.max(1, Math.round(Number(process.env.ORCE_TASK_RESERVATION_USD ?? 0.5) * 1_000_000)),
  trustProxy: (process.env.TRUST_PROXY ?? "false").toLowerCase() === "true",
  bindHost: process.env.HOST || "127.0.0.1",
  databaseUrl: process.env.DATABASE_URL || undefined,
  // Persistence: default embedded local Postgres (PGlite). NEXOTAO_DB=memory forces ephemeral.
  dbForceMemory: (process.env.NEXOTAO_DB || "").toLowerCase() === "memory",
  // Give agents a graphify knowledge-graph tool for the workspace. Default on;
  // set GRAPH_ENABLED=false to disable. No-ops if graphify isn't installed.
  graphEnabled: (process.env.GRAPH_ENABLED ?? "true").toLowerCase() !== "false",
  // Hard planner boundaries. Invalid model output is retried once, never
  // truncated or silently repaired into a different graph.
  orcePlanMaxNodes: positiveInteger("ORCE_PLAN_MAX_NODES", 32),
  orcePlanMaxDepth: positiveInteger("ORCE_PLAN_MAX_DEPTH", 8),
  isProd: process.env.NODE_ENV === "production",
};

// Ensure the agent's working directory exists.
if (!existsSync(config.agentCwd)) {
  mkdirSync(config.agentCwd, { recursive: true });
}

if (config.appPassword === "changeme") {
  console.warn(
    "[WARN] APP_PASSWORD is still 'changeme'. Set a strong password before deploying."
  );
}
