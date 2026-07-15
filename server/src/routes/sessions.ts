import { Hono } from "hono";
import { activeProjectId } from "../projects.js";
import { store } from "../db.js";
import { isTurnActive } from "../chat-manager.js";

export const sessionsRoute = new Hono();

sessionsRoute.get("/sessions", async (c) => {
  return c.json(await store.listSessions(activeProjectId()));
});

sessionsRoute.get("/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  const session = await store.getSession(id);
  if (!session) return c.json({ error: "not found" }, 404);
  // `streaming` lets the client re-attach to a turn still running after a refresh.
  return c.json({ session, messages: await store.listMessages(id), streaming: isTurnActive(id) });
});

sessionsRoute.patch("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string }>();
  if (body.title !== undefined) {
    await store.updateSession(id, { title: body.title });
  }
  return c.json({ ok: true });
});

sessionsRoute.delete("/sessions/:id", async (c) => {
  await store.deleteSession(c.req.param("id"));
  return c.json({ ok: true });
});
