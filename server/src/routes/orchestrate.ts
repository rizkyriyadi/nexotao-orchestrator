import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { runOrchestration } from "../orchestrate.js";

export const orchestrateRoute = new Hono();

orchestrateRoute.post("/orchestrate", async (c) => {
  const body = await c.req.json<{ message?: string; workers?: string[] }>();
  const task = (body.message ?? "").trim();
  if (!task) return c.json({ error: "message required" }, 400);

  return streamSSE(c, async (stream) => {
    try {
      for await (const ev of runOrchestration(task, c.req.raw.signal, body.workers)) {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      }
    } catch (err) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }),
      });
    }
  });
});
