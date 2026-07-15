export interface Project {
  id: string;
  name: string;
  path: string;
  kind: "fresh" | "imported";
  model: string | null;
  created_at: string;
  last_active_at: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  series: "claude" | "gpt" | "grok" | "deepseek";
  recommended: boolean;
  vision: boolean;
}

export interface AiSettings {
  provider: "nexotao" | "claude";
  baseUrl: string;
  hasKey: boolean;
  maskedKey: string | null;
  claudeAvailable: boolean;
  model: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  sdk_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface ImageContent {
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

export interface ImageAttachment extends ImageContent {
  id: string;
  size: number;
}

/** Persisted assistant parts (mirrors the server). */
export type AssistantPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | ({ kind: "image" } & ImageContent)
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: AssistantPart[];
  created_at?: string;
  /** true while the assistant is still streaming this turn */
  streaming?: boolean;
}

/* ---- Orchestration ---- */

export interface WorkerRole {
  id: string;
  label: string;
  lens: string;
}

export type OrchEvent =
  | { type: "orch_start"; task: string; workers: WorkerRole[]; synth: { id: string; label: string } }
  | { type: "phase"; phase: "workers" | "synthesize" }
  | { type: "agent"; id: string; ev: AgentEvent }
  | { type: "agent_done"; id: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface OrchLane {
  id: string;
  label: string;
  lens?: string;
  parts: AssistantPart[];
  done: boolean;
}

export interface OrchRun {
  task: string;
  phase: "workers" | "synthesize" | "done";
  workers: OrchLane[];
  synth: OrchLane;
  error?: string;
}

/* ---- Orce (full orchestration system) ---- */

export interface OrceAgent {
  id: string;
  name: string;
  role: string;
  system_prompt: string;
  model: string | null;
  tools: string[] | null;
  isolate: boolean;
  builtin: boolean;
  created_at: string;
}

export type OrceTaskStatus = "pending" | "running" | "done" | "failed" | "skipped" | "needs_attention";

export interface OrceRunMeta {
  id: string;
  goal: string;
  status: "planning" | "awaiting_approval" | "running" | "completed" | "failed" | "stopped" | "needs_attention";
  cost_usd: number;
  error: string | null;
  attachments: ImageContent[];
  created_at: string;
  completed_at: string | null;
}

export interface OrceTaskDb {
  id: string;
  ticket: string;
  key: string;
  title: string;
  prompt: string;
  agent_label: string;
  status: OrceTaskStatus;
  depends_on: string[];
  output: string | null;
  cost_usd: number | null;
  error: string | null;
  order_idx: number;
}

export interface OrceTaskFull extends OrceTaskDb {
  run_id: string;
  run_goal: string;
}

export interface FsEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: string | null;
}

export interface FsList {
  path: string;
  root: string;
  items: FsEntry[];
}

export interface FsFile {
  path: string;
  size: number;
  content: string;
  binary?: boolean;
  truncated?: boolean;
  note?: string;
}

export interface OrceTaskMeta {
  id: string;
  ticket: string;
  key: string;
  title: string;
  agentLabel: string;
  dependsOn: string[];
  status: OrceTaskStatus;
}

export interface OrceLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  taskId?: string;
}

export interface OrceBudget {
  spent: number;
  limit: number | null;
  warn: boolean;
  stopped: boolean;
}

export interface OrceEventRow {
  id: string;
  task_id: string | null;
  type: string;
  level: "info" | "warn" | "error";
  message: string;
  created_at: string;
}

export type OrceEvent =
  | { type: "run_start"; runId: string; goal: string; budgetUsd: number | null; images: ImageContent[] }
  | { type: "planning" }
  | { type: "plan"; tasks: OrceTaskMeta[] }
  | { type: "task_status"; id: string; status: OrceTaskStatus }
  | { type: "task_delta"; id: string; ev: AgentEvent }
  | { type: "budget"; spent: number; limit: number | null; warn: boolean; stopped: boolean }
  | { type: "log"; at: string; level: "info" | "warn" | "error"; message: string; taskId?: string }
  | { type: "run_done"; status: "completed" | "failed" | "stopped"; costUsd: number }
  | { type: "error"; message: string };

/** Client-side accumulated run state. */
export interface OrceTaskState {
  id: string;
  ticket: string;
  key: string;
  title: string;
  agentLabel: string;
  dependsOn: string[];
  status: OrceTaskStatus;
  parts: AssistantPart[];
  cost?: number;
}

export interface OrceRunState {
  runId?: string;
  goal: string;
  images: ImageContent[];
  phase: "planning" | "awaiting_approval" | "running" | "done";
  tasks: OrceTaskState[];
  status?: "completed" | "failed" | "stopped" | "needs_attention";
  costUsd?: number;
  budget?: OrceBudget;
  activity: OrceLogEntry[];
  error?: string;
}

export interface OrcePlan {
  runId: string;
  goal: string;
  budgetUsd: number | null;
  images: ImageContent[];
  tasks: OrceTaskMeta[];
}

/** Normalized SSE events from the server (see server/src/agent.ts). */
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | { type: "result"; subtype: string; text?: string; costUsd?: number; durationMs?: number; numTurns?: number }
  | { type: "error"; message: string }
  | { type: "done"; dbSessionId: string };
