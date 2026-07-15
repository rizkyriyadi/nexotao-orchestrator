import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";
import { initStore, store } from "./db.js";
import {
  checkPassword,
  clearAuthCookie,
  initAuth,
  issueToken,
  needsPasswordSetup,
  requireAuth,
  revokeAllSessions,
  setAuthCookie,
  setupPassword,
} from "./auth.js";
import { chatRoute } from "./routes/chat.js";
import { sessionsRoute } from "./routes/sessions.js";
import { orchestrateRoute } from "./routes/orchestrate.js";
import { orceRoute } from "./orce/routes.js";
import { initOrce } from "./orce/store.js";
import { startRecoveryMonitor } from "./orce/engine.js";
import { fsRoute } from "./routes/fs.js";
import { projectsRoute } from "./routes/projects.js";
import { aiRoute } from "./routes/ai.js";
import { initGraph } from "./graph.js";
import { initProjects, activeCwd, activeProjectId, getActiveProject } from "./projects.js";
import { initAi, hasApiKey, getProvider, providerReady } from "./ai.js";
import { initDb, dbMode, dbLabel } from "./driver.js";
import { diagnosticsRoute, initDiagnostics } from "./diagnostics.js";
import { deploymentBoundary, loginClientKey, loginThrottle, requireSameOrigin, securityHeaders } from "./security.js";

const app = new Hono();
app.use("*", logger());
app.use("*", securityHeaders);
app.use("/api/*", requireSameOrigin);

/* ---- Auth (public) ---- */
// First-run status: does the operator still need to create a password?
app.get("/api/auth/status", (c) => c.json({ needsSetup: needsPasswordSetup() }));

// First-run: create the password (only when none exists), then auto-login.
app.post("/api/auth/setup", async (c) => {
  if (!needsPasswordSetup()) return c.json({ error: "password already set" }, 409);
  const { password } = await c.req.json<{ password?: string }>();
  try {
    await setupPassword((password ?? "").trim());
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid password" }, 400);
  }
  setAuthCookie(c, await issueToken());
  return c.json({ ok: true });
});

app.post("/api/login", async (c) => {
  const clientKey = loginClientKey(c);
  const retryAfter = loginThrottle.retryAfterSeconds(clientKey);
  if (retryAfter > 0) { c.header("Retry-After", String(retryAfter)); return c.json({ error: "login temporarily blocked" }, 429); }
  const { password } = await c.req.json<{ password?: string }>();
  if (!password || !checkPassword(password)) {
    const blockedFor = loginThrottle.recordFailure(clientKey);
    if (blockedFor > 0) c.header("Retry-After", String(blockedFor));
    return c.json({ error: "invalid password" }, 401);
  }
  loginThrottle.clear(clientKey);
  const token = await issueToken();
  setAuthCookie(c, token);
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  clearAuthCookie(c);
  return c.json({ ok: true });
});

/* ---- Protected API ---- */
const api = new Hono();
api.use("*", requireAuth);
api.post("/auth/sessions/revoke", async (c) => {
  await revokeAllSessions(); clearAuthCookie(c); return c.json({ ok: true });
});
api.get("/me", (c) => {
  const p = getActiveProject();
  return c.json({
    ok: true,
    cwd: activeCwd(),
    permissionMode: config.permissionMode,
    dangerousMode: config.dangerousMode,
    dangerousModeAcknowledged: config.dangerousModeAcknowledged,
    sessionTtlSeconds: config.sessionTtlSeconds,
    deployment: deploymentBoundary(),
    needsOnboarding: !p,
    hasApiKey: hasApiKey(),
    provider: getProvider(),
    providerReady: providerReady(),
    project: p,
  });
});
api.get("/stats", async (c) => {
  const counts = await store.counts(activeProjectId());
  return c.json({
    ...counts,
    cwd: activeCwd(),
    permissionMode: config.permissionMode,
    dbConnected: dbMode() !== "memory",
    storage: dbLabel(),
    project: getActiveProject(),
  });
});
api.route("/", projectsRoute);
api.route("/", chatRoute);
api.route("/", sessionsRoute);
api.route("/", orchestrateRoute);
api.route("/", orceRoute);
api.route("/", fsRoute);
api.route("/", aiRoute);
api.route("/", diagnosticsRoute);
app.route("/api", api);

/* ---- Static frontend (built SPA) ----
   serveStatic's `root` is relative to process.cwd(). In Docker the build is
   copied to ./public; in local dev/prod it lives at ../web/dist. */
const staticRootRel = existsSync(resolve(process.cwd(), "public")) ? "./public" : "../web/dist";
const staticRootAbs = resolve(process.cwd(), staticRootRel);

if (existsSync(staticRootAbs)) {
  app.use("/*", serveStatic({ root: staticRootRel }));
  // SPA fallback: serve index.html for any non-API, non-file route.
  app.get("*", async (c) => {
    const indexPath = resolve(staticRootAbs, "index.html");
    if (existsSync(indexPath)) return c.html(await readFile(indexPath, "utf8"));
    return c.text("Frontend not built. Run `npm run build` in /web.", 200);
  });
} else {
  app.get("/", (c) =>
    c.text("API running. Frontend not built yet — use the Vite dev server on :5173.")
  );
}

async function main() {
  await initDb();
  await initStore();
  await initOrce();
  await initProjects();
  startRecoveryMonitor();
  await initDiagnostics();
  await initAuth();
  await initAi();
  initGraph();
  const boundary = deploymentBoundary();
  console.log(`[security] deployment boundary: ${boundary.mode}`);
  for (const warning of boundary.warnings) console.warn(`[security] ${warning}`);
  serve({ fetch: app.fetch, port: config.port, hostname: config.bindHost }, (info) => {
    console.log(`\n  ◆ Nexotao Orce`);
    console.log(`  → http://${config.bindHost}:${info.port}`);
    console.log(`  → agent cwd: ${config.agentCwd}`);
    console.log(`  → permission mode: ${config.permissionMode}\n`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
