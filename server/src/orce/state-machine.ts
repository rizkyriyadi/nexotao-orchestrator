export const RUN_STATUSES = [
  "planning",
  "awaiting_approval",
  "running",
  "completed",
  "failed",
  "stopped",
  "needs_attention",
] as const;

export const TASK_STATUSES = ["pending", "running", "done", "failed", "skipped", "needs_attention"] as const;

export const ATTEMPT_STATUSES = ["created", "running", "completed", "failed", "stopped", "needs_attention"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type LifecycleKind = "run" | "task" | "attempt";
export type LifecycleStatus = RunStatus | TaskStatus | AttemptStatus;

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  planning: ["awaiting_approval", "failed", "stopped", "needs_attention"],
  awaiting_approval: ["running", "failed", "stopped", "needs_attention"],
  running: ["completed", "failed", "stopped", "needs_attention"],
  completed: [],
  failed: ["running"],
  stopped: [],
  needs_attention: ["running", "stopped"],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["running", "failed", "skipped", "needs_attention"],
  running: ["done", "failed", "needs_attention"],
  done: [],
  failed: ["pending"],
  skipped: ["pending"],
  needs_attention: ["pending"],
};

export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  created: ["running", "stopped"],
  running: ["completed", "failed", "stopped", "needs_attention"],
  completed: [],
  failed: [],
  stopped: [],
  needs_attention: [],
};

export const TRANSITION_TABLES = {
  run: RUN_TRANSITIONS,
  task: TASK_TRANSITIONS,
  attempt: ATTEMPT_TRANSITIONS,
} as const;

const TERMINAL_STATUSES: Readonly<Record<LifecycleKind, ReadonlySet<string>>> = {
  run: new Set<RunStatus>(["completed", "failed", "stopped", "needs_attention"]),
  task: new Set<TaskStatus>(["done", "failed", "skipped", "needs_attention"]),
  attempt: new Set<AttemptStatus>(["completed", "failed", "stopped", "needs_attention"]),
};

export type LifecycleErrorCode =
  | "entity_not_found"
  | "duplicate_transition"
  | "illegal_transition"
  | "terminal_reason_required"
  | "concurrent_transition"
  | "lease_held"
  | "stale_lease";

export class LifecycleTransitionError extends Error {
  constructor(
    public readonly code: LifecycleErrorCode,
    public readonly kind: LifecycleKind,
    public readonly entityId: string,
    public readonly from: string | null,
    public readonly to: string,
    detail?: string
  ) {
    const prefix = `${kind} ${entityId}`;
    const messages: Record<LifecycleErrorCode, string> = {
      entity_not_found: `${prefix} was not found`,
      duplicate_transition: `${prefix} is already ${to}; duplicate transition rejected`,
      illegal_transition: `${prefix} cannot transition from ${from ?? "unknown"} to ${to}`,
      terminal_reason_required: `${prefix} requires a terminal reason when transitioning to ${to}`,
      concurrent_transition: `${prefix} changed concurrently while transitioning from ${from ?? "unknown"} to ${to}; reload and retry`,
      lease_held: `${prefix} already has an active lease`,
      stale_lease: `${prefix} lease is expired or owned by another worker`,
    };
    super(detail ? `${messages[code]}: ${detail}` : messages[code]);
    this.name = "LifecycleTransitionError";
  }
}

export function isTerminalStatus(kind: LifecycleKind, status: string): boolean {
  return TERMINAL_STATUSES[kind].has(status);
}

export function assertTransition(
  kind: LifecycleKind,
  entityId: string,
  from: string,
  to: string,
  terminalReason?: string | null
): void {
  if (from === to) {
    throw new LifecycleTransitionError("duplicate_transition", kind, entityId, from, to);
  }

  const table = TRANSITION_TABLES[kind] as Record<string, readonly string[]>;
  if (!table[from]?.includes(to)) {
    const legal = table[from]?.length ? table[from].join(", ") : "none (state is terminal)";
    throw new LifecycleTransitionError("illegal_transition", kind, entityId, from, to, `legal next states: ${legal}`);
  }

  if (isTerminalStatus(kind, to) && !terminalReason?.trim()) {
    throw new LifecycleTransitionError("terminal_reason_required", kind, entityId, from, to);
  }
}

export function assertKnownStatus(kind: LifecycleKind, status: string): void {
  const table = TRANSITION_TABLES[kind] as Record<string, readonly string[]>;
  if (!(status in table)) {
    throw new LifecycleTransitionError("illegal_transition", kind, "unknown", null, status, "unknown target state");
  }
}
