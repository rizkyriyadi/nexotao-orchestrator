import type {
  AgentEvent,
  ChatMessage,
  OrceAgent,
  OrceEvent,
  OrceEventRow,
  OrceRunMeta,
  OrcePlan,
  OrceTaskDb,
  OrceTaskFull,
  OrchEvent,
  FsList,
  FsFile,
  Project,
  ModelInfo,
  AiSettings,
  SessionMeta,
  ImageContent,
} from "./types";

export async function apiErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // A non-JSON upstream error is still useful operator copy.
  }
  return text;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await apiErrorMessage(res));
  return res.json() as Promise<T>;
}

export interface ServerInfo {
  cwd: string;
  permissionMode: string;
  dangerousMode: boolean;
  dangerousModeAcknowledged: boolean;
  sessionTtlSeconds: number;
  deployment: { mode: "local_only" | "network_exposed"; safeLocalOnly: boolean; warnings: string[] };
  needsOnboarding: boolean;
  provider: "nexotao" | "claude";
  providerReady: boolean;
  project: Project | null;
}

export interface ProposedAgent {
  name: string;
  role: string;
  system_prompt: string;
  model: string | null;
  tools: string[] | null;
  isolate: boolean;
}

export interface Stats {
  sessions: number;
  messages: number;
  lastActivityAt: string | null;
  cwd: string;
  permissionMode: string;
  dbConnected: boolean;
  storage: string;
}

export const api = {
  /** Returns server info if authed, otherwise null. */
  async info(): Promise<ServerInfo | null> {
    const res = await fetch("/api/me");
    if (!res.ok) return null;
    return (await res.json()) as ServerInfo;
  },

  /* ---- First-run auth ---- */
  async authStatus() {
    return json<{ needsSetup: boolean }>(await fetch("/api/auth/status"));
  },
  async setupPassword(password: string) {
    const res = await fetch("/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "setup failed");
  },

  /* ---- Projects ---- */
  async listProjects() {
    return json<{ projects: Project[]; activeId: string | null }>(await fetch("/api/projects"));
  },
  async createProject(body: {
    name: string;
    kind: "fresh" | "imported";
    path?: string;
    agents?: "one" | "all";
    model?: string;
    apiKey?: string;
    provider?: "nexotao" | "claude";
  }) {
    return json<Project>(
      await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  },
  async activateProject(id: string) {
    await fetch(`/api/projects/${id}/activate`, { method: "POST" });
  },
  async deleteProject(id: string) {
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
  },
  async buildGraph() {
    return json<{ hasGraph: boolean }>(await fetch("/api/projects/build-graph", { method: "POST" }));
  },
  async aiModels() {
    return json<{ models: ModelInfo[]; default: string }>(await fetch("/api/ai/models"));
  },
  async aiSettings() {
    return json<AiSettings>(await fetch("/api/ai/settings"));
  },
  async updateAiSettings(body: { provider?: "nexotao" | "claude"; apiKey?: string; model?: string }) {
    return json<{ provider: "nexotao" | "claude"; hasKey: boolean; maskedKey: string | null; claudeAvailable: boolean; model: string }>(
      await fetch("/api/ai/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  },

  async login(password: string) {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error("Invalid password");
  },

  async logout() {
    await fetch("/api/logout", { method: "POST" });
  },
  async revokeSessions() {
    await fetch("/api/auth/sessions/revoke", { method: "POST" });
  },

  async stats() {
    return json<Stats>(await fetch("/api/stats"));
  },

  async listSessions() {
    return json<SessionMeta[]>(await fetch("/api/sessions"));
  },

  async getMessages(id: string) {
    return json<{ session: SessionMeta; messages: ChatMessage[]; streaming?: boolean }>(
      await fetch(`/api/sessions/${id}/messages`)
    );
  },
  /** Cancel an in-flight chat turn running in the background. */
  async stopChat(sessionId: string) {
    await fetch("/api/chat/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  },

  async deleteSession(id: string) {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  },

  async renameSession(id: string, title: string) {
    await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  },

  /* ---- Orce ---- */
  async listAgents() {
    return json<OrceAgent[]>(await fetch("/api/orce/agents"));
  },
  async createAgent(a: Partial<OrceAgent>) {
    return json<OrceAgent>(
      await fetch("/api/orce/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(a),
      })
    );
  },
  async updateAgent(id: string, a: Partial<OrceAgent>) {
    await fetch(`/api/orce/agents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(a),
    });
  },
  async deleteAgent(id: string) {
    await fetch(`/api/orce/agents/${id}`, { method: "DELETE" });
  },
  async listRuns() {
    return json<OrceRunMeta[]>(await fetch("/api/orce/runs"));
  },
  async listAllTasks() {
    return json<OrceTaskFull[]>(await fetch("/api/orce/tasks"));
  },
  async fsList(path = "") {
    return json<FsList>(await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`));
  },
  async fsRead(path: string) {
    return json<FsFile>(await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`));
  },
  /** Browse the host filesystem (absolute) to pick a project folder. */
  async fsBrowse(path?: string) {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return json<{ path: string; parent: string | null; home: string; dirs: { name: string; path: string }[] }>(
      await fetch(`/api/fs/browse${q}`)
    );
  },
  async getRun(id: string) {
    return json<{ run: OrceRunMeta; tasks: OrceTaskDb[]; events: OrceEventRow[] }>(
      await fetch(`/api/orce/runs/${id}`)
    );
  },
  async planOrce(goal: string, budgetUsd: number | null, images: ImageContent[] = []) {
    return json<OrcePlan>(
      await fetch("/api/orce/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, budgetUsd, images }),
      })
    );
  },
  async cancelOrce(runId: string) {
    await fetch(`/api/orce/runs/${runId}/cancel`, { method: "POST" });
  },
  /** Of the given run ids, which are still executing in the background. */
  async orceActive(ids: string[]) {
    if (ids.length === 0) return { active: [] as string[] };
    return json<{ active: string[] }>(await fetch(`/api/orce/active?ids=${encodeURIComponent(ids.join(","))}`));
  },
};

/** POST a body and consume the SSE stream, invoking `onEvent` per parsed frame. */
async function postSSE<T>(
  url: string,
  body: unknown,
  onEvent: (ev: T) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return consumeSSE(res, onEvent, signal);
}

/** GET an SSE stream (used to re-attach to a background run after a refresh). */
async function getSSE<T>(url: string, onEvent: (ev: T) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  return consumeSSE(res, onEvent, signal);
}

async function consumeSSE<T>(res: Response, onEvent: (ev: T) => void, _signal?: AbortSignal): Promise<void> {
  if (!res.ok || !res.body) {
    throw new Error(await apiErrorMessage(res));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        onEvent(JSON.parse(payload) as T);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

/** Stream a single-agent chat turn. */
export function streamChat(
  sessionId: string | null,
  message: string,
  images: ImageContent[],
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return postSSE<AgentEvent>("/api/chat", { sessionId, message, images }, onEvent, signal);
}

/** Re-attach to a chat turn still running in the background (after a refresh). */
export function streamChatAttach(
  sessionId: string,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return getSSE<AgentEvent>(`/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`, onEvent, signal);
}

/** Stream a fan-out → synthesize orchestration run. */
export function streamOrchestrate(
  message: string,
  onEvent: (ev: OrchEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return postSSE<OrchEvent>("/api/orchestrate", { message }, onEvent, signal);
}

/** Stream a planner-driven DAG orchestration run (auto — no approval gate). */
export function streamOrceRun(
  goal: string,
  images: ImageContent[],
  onEvent: (ev: OrceEvent) => void,
  signal?: AbortSignal,
  budgetUsd?: number | null
): Promise<void> {
  return postSSE<OrceEvent>("/api/orce/run", { goal, images, budgetUsd: budgetUsd ?? null }, onEvent, signal);
}

/** Stream execution of an approved (already-planned) run. */
export function streamOrceStart(
  runId: string,
  onEvent: (ev: OrceEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return postSSE<OrceEvent>(`/api/orce/runs/${runId}/start`, {}, onEvent, signal);
}

/** Re-attach to a run still executing in the background (after a refresh). */
export function streamOrceAttach(
  runId: string,
  onEvent: (ev: OrceEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return getSSE<OrceEvent>(`/api/orce/runs/${runId}/stream`, onEvent, signal);
}

export type ProposeEvent =
  | { type: "activity"; text: string }
  | { type: "thinking"; text: string }
  | { type: "proposals"; agents: ProposedAgent[] }
  | { type: "error"; message: string };

/** Stream the propose-agents inspection (live progress) then the proposals. */
export function streamProposeAgents(
  onEvent: (ev: ProposeEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return postSSE<ProposeEvent>("/api/orce/propose-agents", {}, onEvent, signal);
}
