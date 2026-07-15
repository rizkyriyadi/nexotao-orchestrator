import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { AssistantPart, OrceEventRow, OrceRunMeta, OrceTaskDb, OrceTaskStatus } from "../../types";
import { PartsView } from "../PartsView";

const STATUS_DOT: Record<OrceTaskStatus, string> = {
  pending: "bg-iron",
  running: "animate-pulse bg-prompt",
  done: "bg-bone",
  failed: "bg-danger",
  skipped: "bg-iron",
  needs_attention: "bg-gold",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function TaskDetailPage({
  runId,
  taskId,
  onBack,
  onOpenTask,
}: {
  runId: string;
  taskId: string;
  onBack: () => void;
  onOpenTask: (runId: string, taskId: string) => void;
}) {
  const [data, setData] = useState<{ run: OrceRunMeta; tasks: OrceTaskDb[]; events: OrceEventRow[] } | null>(null);

  const load = useCallback(() => {
    api.getRun(runId).then(setData).catch(() => {});
  }, [runId]);

  useEffect(() => {
    load();
  }, [load, taskId]);

  // Live-poll while the run is still active.
  useEffect(() => {
    if (!data) return;
    const active = data.run.status === "running" || data.run.status === "planning" || data.run.status === "awaiting_approval";
    if (!active) return;
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [data, load]);

  if (!data) return <div className="p-8 font-mono text-[13px] text-bone">loading…</div>;

  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) return <div className="p-8 font-mono text-[13px] text-bone">Task not found.</div>;

  const byKey = new Map(data.tasks.map((t) => [t.key, t]));
  const upstream = task.depends_on.map((k) => byKey.get(k)).filter(Boolean) as OrceTaskDb[];
  const downstream = data.tasks.filter((t) => t.depends_on.includes(task.key));
  const taskEvents = data.events.filter((e) => e.task_id === task.id);

  // Why is it in this state?
  const unmet = upstream.filter((t) => t.status !== "done");
  const reason =
    task.status === "pending"
      ? unmet.length
        ? { label: "Blocked", tone: "text-gold", text: "Waiting for upstream tasks to finish." }
        : { label: "Ready", tone: "text-stone", text: "Dependencies met — queued for execution." }
      : task.status === "running"
      ? { label: "Running", tone: "text-prompt", text: "The agent is working on this now." }
      : task.status === "done"
      ? { label: "Done", tone: "text-stone", text: "Completed successfully." }
      : task.status === "failed"
      ? { label: "Failed", tone: "text-danger", text: task.error || "The task failed." }
      : task.status === "needs_attention"
      ? { label: "Needs attention", tone: "text-gold", text: task.error || "Reconcile provider usage before retrying." }
      : { label: "Skipped", tone: "text-bone", text: "An upstream dependency failed, so this was skipped." };

  const parts: AssistantPart[] = task.output
    ? [{ kind: "text", text: task.output }]
    : task.error
    ? [{ kind: "text", text: `⚠ ${task.error}` }]
    : [];

  return (
    <div className="mx-auto max-w-4xl px-5 py-6">
      <button onClick={onBack} className="mb-4 font-mono text-[12px] text-bone transition hover:text-ink">
        ← back
      </button>

      {/* Header */}
      <div className="mb-2 flex items-center gap-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[task.status]}`} />
        <span className="font-mono text-[13px] font-medium tracking-wide text-gold">{task.ticket}</span>
        <span className="rounded border border-line-soft px-1.5 py-0.5 font-mono text-[10px] text-stone">
          {task.agent_label}
        </span>
        <span className="ml-auto font-mono text-[11px] text-bone">
          {task.status}
          {task.cost_usd != null ? ` · $${task.cost_usd.toFixed(4)}` : ""}
        </span>
      </div>
      <h1 className="heading text-[24px] text-ink">{task.title}</h1>
      <p className="mt-1 truncate text-[12px] text-bone">run: {data.run.goal}</p>

      {/* Meta bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-onyx px-4 py-2.5 font-mono text-[11px] text-bone">
        <span className="flex items-center gap-1.5 text-stone">
          <span className="text-bone">◈</span> {task.agent_label}
        </span>
        <span className="text-line">·</span>
        <span>{task.depends_on.length} dependencies</span>
        {task.cost_usd != null && (
          <>
            <span className="text-line">·</span>
            <span>${task.cost_usd.toFixed(4)}</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-stone">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[task.status]}`} />
          {task.status}
        </span>
      </div>

      {/* Task brief (what the agent was asked to do) */}
      {task.prompt && (
        <div className="mt-4">
          <span className="eyebrow">task brief</span>
          <div className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-charcoal px-4 py-3 text-[13.5px] leading-relaxed text-stone">
            {task.prompt}
          </div>
        </div>
      )}

      {/* Why / status reasoning */}
      <div className="mt-4 rounded-lg border border-line bg-charcoal px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="eyebrow">status</span>
          <span className={`font-mono text-[12px] ${reason.tone}`}>{reason.label}</span>
        </div>
        <p className="mt-1.5 text-[14px] text-stone">{reason.text}</p>
        {task.status === "pending" && unmet.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] text-bone">blocked by</span>
            {unmet.map((t) => (
              <button
                key={t.id}
                onClick={() => onOpenTask(runId, t.id)}
                className="rounded bg-onyx px-1.5 py-0.5 font-mono text-[10px] text-gold hover:text-ink"
              >
                {t.ticket} · {t.status}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Connections */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Connections label="depends on (upstream)" tasks={upstream} runId={runId} onOpenTask={onOpenTask} empty="Nothing — this can start immediately." />
        <Connections label="blocks (downstream)" tasks={downstream} runId={runId} onOpenTask={onOpenTask} empty="Nothing depends on this." />
      </div>

      {/* Timeline */}
      <div className="mt-5">
        <span className="eyebrow">timeline</span>
        <div className="relative mt-3 pl-5">
          <div className="absolute bottom-1 left-[3px] top-1 w-px bg-line" />
          <TimelineItem dot="bg-bone" time="" message="queued" muted />
          {taskEvents.map((e) => (
            <TimelineItem
              key={e.id}
              dot={e.level === "error" ? "bg-danger" : e.level === "warn" ? "bg-gold" : "bg-cobalt"}
              time={fmtTime(e.created_at)}
              message={e.message}
            />
          ))}
          {taskEvents.length === 0 && task.status === "pending" && (
            <TimelineItem dot="bg-iron" time="" message="not started yet" muted />
          )}
        </div>
      </div>

      {/* Output */}
      <div className="mt-6">
        <span className="eyebrow">agent output</span>
        <div className="mt-2 rounded-lg border border-line bg-charcoal px-4 py-4 text-[14px]">
          {parts.length ? (
            <PartsView parts={parts} streaming={task.status === "running"} />
          ) : (
            <span className="font-mono text-[12px] text-bone">
              {task.status === "running" ? "working…" : "no output yet"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Connections({
  label,
  tasks,
  runId,
  onOpenTask,
  empty,
}: {
  label: string;
  tasks: OrceTaskDb[];
  runId: string;
  onOpenTask: (runId: string, taskId: string) => void;
  empty: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-charcoal px-4 py-3">
      <span className="eyebrow">{label}</span>
      <div className="mt-2 space-y-1.5">
        {tasks.length === 0 && <p className="text-[12px] text-bone">{empty}</p>}
        {tasks.map((t) => (
          <button
            key={t.id}
            onClick={() => onOpenTask(runId, t.id)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-iron/40"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status]}`} />
            <span className="shrink-0 font-mono text-[11px] text-gold">{t.ticket}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-stone">{t.title}</span>
            <span className="shrink-0 font-mono text-[10px] text-bone">{t.status}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TimelineItem({ dot, time, message, muted }: { dot: string; time: string; message: string; muted?: boolean }) {
  return (
    <div className="relative pb-4">
      <span className={`absolute -left-5 top-1 h-2 w-2 rounded-full ${dot}`} />
      {time && <div className="font-mono text-[11px] text-bone">{time}</div>}
      <div className={`text-[13px] ${muted ? "text-bone" : "text-stone"}`}>{message}</div>
    </div>
  );
}
