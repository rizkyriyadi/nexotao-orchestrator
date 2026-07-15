export type SchedulerStatus = "pending" | "running" | "done" | "failed" | "skipped" | "needs_attention";

export interface SchedulableTask {
  key: string;
  depends_on: string[];
}

export type SchedulerDecision =
  | { kind: "wait" }
  | { kind: "complete" }
  | { kind: "budget_halt" }
  | { kind: "deadlock"; pendingKeys: string[]; message: string };

export function readyTaskKeys(
  tasks: readonly SchedulableTask[],
  status: ReadonlyMap<string, SchedulerStatus>,
  limit: number
): string[] {
  return tasks
    .filter(
      (task) =>
        status.get(task.key) === "pending" && task.depends_on.every((dependency) => status.get(dependency) === "done")
    )
    .slice(0, Math.max(0, limit))
    .map((task) => task.key);
}

export function schedulerDecision(
  tasks: readonly SchedulableTask[],
  status: ReadonlyMap<string, SchedulerStatus>,
  runningCount: number,
  budgetStopped: boolean
): SchedulerDecision {
  if (runningCount > 0) return { kind: "wait" };
  const pending = tasks.filter((task) => status.get(task.key) === "pending");
  if (pending.length === 0) return { kind: "complete" };
  if (budgetStopped) return { kind: "budget_halt" };

  const blocked = pending.map((task) => {
    const dependencies = task.depends_on.length
      ? task.depends_on.map((dependency) => `${dependency}:${status.get(dependency) ?? "missing"}`).join(", ")
      : "no dependencies (scheduler invariant violated)";
    return `${task.key} <- [${dependencies}]`;
  });
  return {
    kind: "deadlock",
    pendingKeys: pending.map((task) => task.key),
    message: `Scheduler deadlock: no runnable task and no active worker; blocked nodes: ${blocked.join("; ")}`,
  };
}
