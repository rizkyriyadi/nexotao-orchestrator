import { runAgent, type AgentEvent } from "./agent.js";
import { store } from "./db.js";
import { ensureGraph } from "./graph.js";
import { activeCwd } from "./projects.js";
import { createHub, type Hub } from "./stream-hub.js";
import type { ImageInput } from "./images.js";

/**
 * A chat turn runs in the BACKGROUND, decoupled from the HTTP request. The
 * browser can refresh mid-turn and re-attach to replay the whole assistant
 * message. Events buffer in a hub keyed by DB session id; the assistant message
 * is persisted when the turn ends.
 */

/** What the SSE stream carries (agent events + a terminal `done`). */
export type ChatStreamEvent = AgentEvent | { type: "done"; dbSessionId: string };

type AssistantPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: string; isError?: boolean };

type Turn = { hub: Hub<ChatStreamEvent>; controller: AbortController; done: boolean };
const turns = new Map<string, Turn>(); // keyed by DB session id

export function isTurnActive(sessionId: string): boolean {
  const t = turns.get(sessionId);
  return !!t && !t.done;
}

/** Attach to a live turn (replay buffered events, then live) — for reconnection. */
export function attachTurn(sessionId: string): AsyncGenerator<ChatStreamEvent> | null {
  return turns.get(sessionId)?.hub.attach() ?? null;
}

export function cancelTurn(sessionId: string): void {
  turns.get(sessionId)?.controller.abort();
}

/**
 * Start a turn in the background for `dbSessionId`. Idempotent: if one is
 * already running for the session, this is a no-op (the caller just attaches).
 */
export function startTurn(
  dbSessionId: string,
  message: string,
  resume: string | undefined,
  images: ImageInput[] = []
): void {
  if (turns.has(dbSessionId)) return;

  const hub = createHub<ChatStreamEvent>();
  const controller = new AbortController();
  const turn: Turn = { hub, controller, done: false };
  turns.set(dbSessionId, turn);

  void ensureGraph(activeCwd());

  (async () => {
    const parts: AssistantPart[] = [];
    let currentText = "";
    let newSdkSessionId: string | null = null;
    const flushText = () => {
      if (currentText) {
        parts.push({ kind: "text", text: currentText });
        currentText = "";
      }
    };

    try {
      for await (const ev of runAgent(message, resume, controller.signal, undefined, {
        graphCwd: activeCwd(),
        images,
      })) {
        switch (ev.type) {
          case "session":
            newSdkSessionId = ev.sessionId;
            break;
          case "text_delta":
          case "thinking_delta":
            currentText += ev.text;
            break;
          case "tool_use":
            flushText();
            parts.push({ kind: "tool", id: ev.id, name: ev.name, input: ev.input });
            break;
          case "tool_result": {
            const p = [...parts].reverse().find(
              (x): x is Extract<AssistantPart, { kind: "tool" }> => x.kind === "tool" && x.id === ev.toolUseId
            );
            if (p) {
              p.result = ev.content;
              p.isError = ev.isError;
            }
            break;
          }
        }
        hub.push(ev);
      }
    } catch (err) {
      hub.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }

    flushText();
    if (parts.length > 0) await store.addMessage(dbSessionId, "assistant", parts);
    if (newSdkSessionId) await store.updateSession(dbSessionId, { sdk_session_id: newSdkSessionId });
    hub.push({ type: "done", dbSessionId });
  })()
    .catch(() => {})
    .finally(() => {
      turn.done = true;
      hub.close();
      setTimeout(() => {
        if (turns.get(dbSessionId) === turn) turns.delete(dbSessionId);
      }, 120_000);
    });
}
