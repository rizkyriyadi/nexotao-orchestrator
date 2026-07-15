import type { AgentEvent, AssistantPart, OrchEvent, OrchRun, OrceEvent, OrceRunState } from "../types";

/** Fold a streamed agent event into an accumulating list of assistant parts. */
export function applyAgentEvent(parts: AssistantPart[], ev: AgentEvent): AssistantPart[] {
  const next = [...parts];
  switch (ev.type) {
    case "text_delta": {
      const last = next[next.length - 1];
      if (last && last.kind === "text") next[next.length - 1] = { ...last, text: last.text + ev.text };
      else next.push({ kind: "text", text: ev.text });
      break;
    }
    case "thinking_delta": {
      const last = next[next.length - 1];
      if (last && last.kind === "thinking") next[next.length - 1] = { ...last, text: last.text + ev.text };
      else next.push({ kind: "thinking", text: ev.text });
      break;
    }
    case "tool_use":
      next.push({ kind: "tool", id: ev.id, name: ev.name, input: ev.input });
      break;
    case "tool_result":
      for (let i = next.length - 1; i >= 0; i--) {
        const p = next[i];
        if (p.kind === "tool" && p.id === ev.toolUseId) {
          next[i] = { ...p, result: ev.content, isError: ev.isError };
          break;
        }
      }
      break;
    case "error":
      next.push({ kind: "text", text: `\n\n⚠ ${ev.message}` });
      break;
  }
  return next;
}

/** Fold an orchestration event into the run state. */
export function reduceOrch(prev: OrchRun | null, ev: OrchEvent): OrchRun | null {
  switch (ev.type) {
    case "orch_start":
      return {
        task: ev.task,
        phase: "workers",
        workers: ev.workers.map((w) => ({ id: w.id, label: w.label, lens: w.lens, parts: [], done: false })),
        synth: { id: ev.synth.id, label: ev.synth.label, parts: [], done: false },
      };
    case "phase":
      return prev ? { ...prev, phase: ev.phase } : prev;
    case "agent": {
      if (!prev) return prev;
      const update = (lane: OrchRun["synth"]) =>
        lane.id === ev.id ? { ...lane, parts: applyAgentEvent(lane.parts, ev.ev) } : lane;
      return {
        ...prev,
        workers: prev.workers.map(update),
        synth: update(prev.synth),
      };
    }
    case "agent_done": {
      if (!prev) return prev;
      const mark = (lane: OrchRun["synth"]) => (lane.id === ev.id ? { ...lane, done: true } : lane);
      return { ...prev, workers: prev.workers.map(mark), synth: mark(prev.synth) };
    }
    case "done":
      return prev ? { ...prev, phase: "done" } : prev;
    case "error":
      return prev ? { ...prev, error: ev.message } : prev;
    default:
      return prev;
  }
}

/** Fold an orce (planner/DAG) run event into the run state. */
export function reduceOrceRun(prev: OrceRunState | null, ev: OrceEvent): OrceRunState | null {
  switch (ev.type) {
    case "run_start":
      return {
        runId: ev.runId,
        goal: ev.goal,
        images: ev.images,
        phase: "planning",
        tasks: [],
        activity: [],
        budget: { spent: 0, limit: ev.budgetUsd, warn: false, stopped: false },
      };
    case "planning":
      return prev ? { ...prev, phase: "planning" } : prev;
    case "budget":
      return prev
        ? { ...prev, budget: { spent: ev.spent, limit: ev.limit, warn: ev.warn, stopped: ev.stopped } }
        : prev;
    case "log":
      return prev
        ? { ...prev, activity: [...prev.activity, { at: ev.at, level: ev.level, message: ev.message, taskId: ev.taskId }] }
        : prev;
    case "plan":
      return prev
        ? {
            ...prev,
            phase: "running",
            tasks: ev.tasks.map((t) => ({
              id: t.id,
              ticket: t.ticket,
              key: t.key,
              title: t.title,
              agentLabel: t.agentLabel,
              dependsOn: t.dependsOn,
              status: t.status,
              parts: [],
            })),
          }
        : prev;
    case "task_status":
      return prev
        ? { ...prev, tasks: prev.tasks.map((t) => (t.id === ev.id ? { ...t, status: ev.status } : t)) }
        : prev;
    case "task_delta":
      return prev
        ? {
            ...prev,
            tasks: prev.tasks.map((t) =>
              t.id === ev.id
                ? {
                    ...t,
                    parts: applyAgentEvent(t.parts, ev.ev),
                    cost: ev.ev.type === "result" ? ev.ev.costUsd ?? t.cost : t.cost,
                  }
                : t
            ),
          }
        : prev;
    case "run_done":
      return prev ? { ...prev, phase: "done", status: ev.status, costUsd: ev.costUsd } : prev;
    case "error":
      return prev ? { ...prev, error: ev.message, phase: "done" } : prev;
    default:
      return prev;
  }
}
