import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { store } from "../db.js";
import { activeProjectId } from "../projects.js";
import { attachTurn, cancelTurn, startTurn, type ChatStreamEvent } from "../chat-manager.js";
import { parseImageInputs } from "../images.js";

export const chatRoute = new Hono();

/** Stream a turn's events to this client. The turn runs detached from the
 *  request, so a refresh never stops it — the client re-attaches instead. */
async function pipeChat(c: any, gen: AsyncGenerator<ChatStreamEvent> | null, dbSessionId: string) {
  return streamSSE(c, async (stream) => {
    if (!gen) {
      // No active turn (already finished / server restarted) — client uses the
      // persisted messages.
      await stream.writeSSE({ data: JSON.stringify({ type: "done", dbSessionId }) });
      return;
    }
    try {
      for await (const ev of gen) {
        await stream.writeSSE({ data: JSON.stringify(ev) });
      }
    } catch {
      /* client disconnected — the turn keeps running in the background */
    }
  });
}

chatRoute.post("/chat", async (c) => {
  const body = await c.req.json<{ sessionId?: string; message?: string; images?: unknown }>();
  const message = (body.message ?? "").trim();
  let images;
  try {
    images = parseImageInputs(body.images);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "invalid images" }, 400);
  }
  if (!message && images.length === 0) return c.json({ error: "message or image required" }, 400);
  const prompt = message || "Please analyze the attached image(s).";

  // Resolve (or create) the conversation.
  let session = body.sessionId ? await store.getSession(body.sessionId) : null;
  if (!session) {
    session = await store.createSession(activeProjectId(), message.slice(0, 60) || images[0]?.name || "Image chat");
  }

  await store.addMessage(session.id, "user", [
    ...(message ? [{ kind: "text", text: message }] : []),
    ...images.map((image) => ({ kind: "image", ...image })),
  ]);
  const resume = session.sdk_session_id ?? undefined;

  // Kick off the turn in the background, then attach this client to its stream.
  startTurn(session.id, prompt, resume, images);
  return pipeChat(c, attachTurn(session.id), session.id);
});

// Reconnect to an in-flight turn after a refresh.
chatRoute.get("/chat/stream", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  return pipeChat(c, attachTurn(sessionId), sessionId);
});

// Stop an in-flight turn (aborts the background agent).
chatRoute.post("/chat/stop", async (c) => {
  const { sessionId } = await c.req.json<{ sessionId?: string }>();
  if (sessionId) cancelTurn(sessionId);
  return c.json({ ok: true });
});
