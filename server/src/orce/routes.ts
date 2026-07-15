import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import {
  attachRun,
  cancelRun,
  isRunActive,
  planOnly,
  proposeAgentsStream,
  startAuto,
  startExecute,
  type OrceEvent,
} from "./engine.js";
import { orceStore, type AgentInput } from "./store.js";
import { activeProjectId } from "../projects.js";
import { parseImageInputs } from "../images.js";
import { PlanValidationError } from "./plan-validation.js";
import { LifecycleTransitionError } from "./state-machine.js";

export const orceRoute = new Hono();

function pid(): string | null {
  return activeProjectId();
}

function commandKey(c: any, action: string, updatedAt: string): string {
  return c.req.header("Idempotency-Key")?.trim() || `${action}:${c.req.param("id")}:${updatedAt}`;
}

function commandError(c: any, error: unknown) {
  const status = error instanceof LifecycleTransitionError && error.code === "entity_not_found" ? 404 : 409;
  return c.json({ error: error instanceof Error ? error.message : "lifecycle command rejected" }, status);
}

/* ---- Runs ---- */

// Plan only — returns a proposed DAG for approval (no execution).
orceRoute.post("/orce/plan", async (c) => {
  const { goal, budgetUsd, images: rawImages } = await c.req.json<{ goal?: string; budgetUsd?: number | null; images?: unknown }>();
  const g = (goal ?? "").trim();
  let images;
  try {
    images = parseImageInputs(rawImages);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid images" }, 400);
  }
  if (!g && images.length === 0) return c.json({ error: "goal or image required" }, 400);
  const prompt = g || "Analyze the attached image(s) and determine the work required.";
  const budget = typeof budgetUsd === "number" && budgetUsd > 0 ? budgetUsd : null;
  const ac = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
  try {
    const plan = await planOnly(prompt, budget, ac.signal, images);
    return c.json(plan);
  } catch (error) {
    if (error instanceof PlanValidationError) return c.json(error.toResponse(), 422);
    throw error;
  }
});

/**
 * Stream a background run's events to this client. The run executes detached
 * from the request, so a disconnect (refresh) NEVER stops it — the client just
 * re-attaches. We deliberately do NOT wire the request's abort signal to the
 * run; closing the SSE only ends this viewer's stream.
 */
async function pipeRun(c: any, gen: AsyncGenerator<OrceEvent> | null) {
  return streamSSE(c, async (stream) => {
    if (!gen) {
      // Run isn't active (already finished / server restarted). Tell the client
      // to fall back to the persisted DB state.
      await stream.writeSSE({ data: JSON.stringify({ type: "not_active" }) });
      return;
    }
    try {
      for await (const ev of gen) {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      }
    } catch {
      /* client disconnected — the run keeps going in the background */
    }
  });
}

// Execute an approved run (starts it in the background, then streams).
orceRoute.post("/orce/runs/:id/start", async (c) => {
  const id = c.req.param("id");
  const run = await orceStore.getRun(id);
  if (!run) return c.json({ error: "not found" }, 404);
  try {
    await startExecute(id, commandKey(c, "start", run.updated_at), "start");
  } catch (error) {
    return commandError(c, error);
  }
  return pipeRun(c, attachRun(id));
});

orceRoute.post("/orce/runs/:id/retry", async (c) => {
  const id = c.req.param("id");
  const run = await orceStore.getRun(id);
  if (!run) return c.json({ error: "not found" }, 404);
  try {
    await startExecute(id, commandKey(c, "retry", run.updated_at), "retry");
  } catch (error) {
    return commandError(c, error);
  }
  return pipeRun(c, attachRun(id));
});

orceRoute.post("/orce/runs/:id/resume", async (c) => {
  const id = c.req.param("id");
  const run = await orceStore.getRun(id);
  if (!run) return c.json({ error: "not found" }, 404);
  try {
    await startExecute(id, commandKey(c, "resume", run.updated_at), "resume");
  } catch (error) {
    return commandError(c, error);
  }
  return pipeRun(c, attachRun(id));
});

// Reconnect to an already-running run after a refresh.
orceRoute.get("/orce/runs/:id/stream", async (c) => {
  return pipeRun(c, attachRun(c.req.param("id")));
});

// Which of these runs are still executing in the background (for reconnect on load).
orceRoute.get("/orce/active", (c) => {
  // caller passes ?ids=a,b,c — return the subset still active
  const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
  return c.json({ active: ids.filter((id) => isRunActive(id)) });
});

// Discard / stop a run (aborts the background agents too).
orceRoute.post("/orce/runs/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const run = await orceStore.getRun(id);
  if (!run) return c.json({ error: "not found" }, 404);
  try {
    await orceStore.applyRunCommand({
      runId: id,
      action: "cancel",
      idempotencyKey: commandKey(c, "cancel", run.updated_at),
      actorType: "operator",
    });
  } catch (error) {
    return commandError(c, error);
  }
  cancelRun(id);
  return c.json({ ok: true });
});

// Auto mode — plan + execute in the background (no approval gate).
orceRoute.post("/orce/run", async (c) => {
  const { goal, budgetUsd, images: rawImages } = await c.req.json<{ goal?: string; budgetUsd?: number | null; images?: unknown }>();
  const g = (goal ?? "").trim();
  let images;
  try {
    images = parseImageInputs(rawImages);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid images" }, 400);
  }
  if (!g && images.length === 0) return c.json({ error: "goal or image required" }, 400);
  const prompt = g || "Analyze the attached image(s) and determine the work required.";
  const budget = typeof budgetUsd === "number" && budgetUsd > 0 ? budgetUsd : null;
  const idempotencyKey = c.req.header("Idempotency-Key")?.trim() || `auto:${randomUUID()}`;
  const runId = await startAuto(prompt, budget, images, idempotencyKey);
  return pipeRun(c, attachRun(runId));
});

orceRoute.get("/orce/runs", async (c) => c.json(await orceStore.listRuns(pid() ?? "")));

orceRoute.get("/orce/tasks", async (c) => c.json(await orceStore.listAllTasks(pid() ?? "")));

orceRoute.get("/orce/runs/:id", async (c) => {
  const run = await orceStore.getRun(c.req.param("id"));
  if (!run) return c.json({ error: "not found" }, 404);
  const [tasks, events] = await Promise.all([orceStore.listTasks(run.id), orceStore.listEvents(run.id)]);
  const attempts = (await Promise.all(tasks.map((task) => orceStore.listAttempts(task.id)))).flat();
  return c.json({ run, tasks, attempts, events });
});

/* ---- Agents ---- */

orceRoute.get("/orce/agents", async (c) => c.json(await orceStore.listAgents(pid() ?? "")));

// AI-propose tailored agents for the active project. Streams live inspection
// progress (files read, graph queries, thinking) then a final `proposals` event.
orceRoute.post("/orce/propose-agents", async (c) => {
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort(), { once: true });
    try {
      for await (const ev of proposeAgentsStream(ac.signal)) {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      }
    } catch (err) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }),
      });
    }
  });
});

function parseAgent(body: any): AgentInput {
  return {
    name: String(body.name ?? "").trim() || "Agent",
    role: String(body.role ?? "").trim(),
    system_prompt: String(body.system_prompt ?? ""),
    model: body.model ? String(body.model) : null,
    tools: Array.isArray(body.tools) && body.tools.length ? body.tools.map(String) : null,
    isolate: Boolean(body.isolate),
  };
}

orceRoute.post("/orce/agents", async (c) => {
  const agent = await orceStore.createAgent(pid() ?? "", parseAgent(await c.req.json()));
  return c.json(agent);
});

orceRoute.patch("/orce/agents/:id", async (c) => {
  await orceStore.updateAgent(c.req.param("id"), parseAgent(await c.req.json()));
  return c.json({ ok: true });
});

orceRoute.delete("/orce/agents/:id", async (c) => {
  await orceStore.deleteAgent(c.req.param("id"));
  return c.json({ ok: true });
});
