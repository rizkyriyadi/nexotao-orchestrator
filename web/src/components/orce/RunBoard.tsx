import { useState } from "react";
import type { OrceRunState, OrceTaskState, OrceTaskStatus } from "../../types";
import { PartsView } from "../PartsView";
import { ImageGallery } from "../ImageAttachments";

const STATUS_DOT: Record<OrceTaskStatus, string> = {
  pending: "bg-iron",
  running: "animate-pulse bg-prompt",
  done: "bg-bone",
  failed: "bg-danger",
  skipped: "bg-iron",
  needs_attention: "bg-gold",
};

export function RunBoard({
  run,
  onOpenTask,
  onApprove,
  onDiscard,
}: {
  run: OrceRunState;
  onOpenTask: (taskId: string) => void;
  onApprove?: () => void;
  onDiscard?: () => void;
}) {
  const total = run.tasks.length;
  const done = run.tasks.filter((t) => t.status === "done").length;
  const failed = run.tasks.filter((t) => ["failed", "skipped", "needs_attention"].includes(t.status)).length;
  const pct = total ? Math.round(((done + failed) / total) * 100) : 0;
  const ticketByKey = Object.fromEntries(run.tasks.map((t) => [t.key, t.ticket]));
  const awaiting = run.phase === "awaiting_approval";

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="rounded-lg border border-line bg-charcoal">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
          <span className="eyebrow">orce run</span>
          <span className="ml-auto font-mono text-[11px] text-bone">
            {run.phase === "done" ? run.status ?? "done" : run.phase}
            {run.costUsd != null ? ` · $${run.costUsd.toFixed(4)}` : ""}
          </span>
        </div>
        <div className="px-4 py-3">
          <p className="text-[15px] leading-relaxed text-ink">
            <span className="text-prompt">›</span> {run.goal}
          </p>
          <ImageGallery images={run.images} compact />
        </div>
        {total > 0 && (
          <div className="px-4 pb-3">
            <div className="mb-1.5 flex justify-between font-mono text-[11px] text-bone">
              <span>
                {done}/{total} done{failed ? ` · ${failed} failed` : ""}
              </span>
              <span>{pct}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-iron">
              <div className="h-full bg-ink transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {run.budget && run.budget.limit != null && (
          <div className="border-t border-line-soft px-4 py-2.5">
            <div className="mb-1.5 flex justify-between font-mono text-[11px]">
              <span className={run.budget.stopped ? "text-danger" : run.budget.warn ? "text-gold" : "text-bone"}>
                budget {run.budget.stopped ? "· halted" : run.budget.warn ? "· 80% used" : ""}
              </span>
              <span className="text-bone">
                ${run.budget.spent.toFixed(4)} / ${run.budget.limit.toFixed(2)}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-iron">
              <div
                className={`h-full transition-all ${
                  run.budget.stopped ? "bg-danger" : run.budget.warn ? "bg-gold" : "bg-cobalt"
                }`}
                style={{ width: `${Math.min(100, (run.budget.spent / run.budget.limit) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {run.phase === "planning" && (
        <div className="cursor font-mono text-[13px] text-bone">planner is decomposing the goal</div>
      )}

      {awaiting && (onApprove || onDiscard) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-cobalt/40 bg-charcoal px-4 py-3">
          <span className="text-[14px] text-ink">
            Plan ready — {total} task{total !== 1 ? "s" : ""}. Review below, then approve to run.
          </span>
          <div className="ml-auto flex gap-2">
            {onDiscard && (
              <button
                onClick={onDiscard}
                className="rounded border border-iron px-3 py-1.5 font-mono text-[12px] text-stone transition hover:border-danger hover:text-danger"
              >
                Discard
              </button>
            )}
            {onApprove && (
              <button
                onClick={onApprove}
                className="rounded bg-ink px-4 py-1.5 font-mono text-[12px] text-ember transition hover:bg-linen"
              >
                Approve &amp; run
              </button>
            )}
          </div>
        </div>
      )}

      {run.error && <p className="font-mono text-[13px] text-danger">⚠ {run.error}</p>}

      {/* Task DAG */}
      <div className="grid gap-4 md:grid-cols-2">
        {run.tasks.map((t) => (
          <TaskCard key={t.id} task={t} ticketByKey={ticketByKey} onOpen={() => onOpenTask(t.id)} />
        ))}
      </div>

      {run.activity.length > 0 && <ActivityFeed activity={run.activity} />}
    </div>
  );
}

function ActivityFeed({ activity }: { activity: OrceRunState["activity"] }) {
  const [open, setOpen] = useState(false);
  const colour = (l: string) => (l === "error" ? "text-danger" : l === "warn" ? "text-gold" : "text-bone");
  return (
    <div className="rounded-lg border border-line bg-charcoal">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
        <span className="eyebrow">activity log</span>
        <span className="font-mono text-[10px] text-bone">{activity.length} events · immutable audit</span>
        <span className="ml-auto font-mono text-[11px] text-bone">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="max-h-72 space-y-0.5 overflow-y-auto border-t border-line-soft px-4 py-3 font-mono text-[12px]">
          {activity.map((e, i) => (
            <div key={i} className="flex gap-3">
              <span className="shrink-0 text-bone">{fmtTime(e.at)}</span>
              <span className={`${colour(e.level)} min-w-0`}>{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function TaskCard({
  task,
  ticketByKey,
  onOpen,
}: {
  task: OrceTaskState;
  ticketByKey: Record<string, string>;
  onOpen: () => void;
}) {
  const active = task.status === "running";
  const hasOutput = task.parts.length > 0;
  const toolCount = task.parts.filter((p) => p.kind === "tool").length;

  return (
    <div
      className={`flex min-w-0 flex-col rounded-lg border bg-charcoal ${
        active ? "border-cobalt/50" : "border-line"
      } ${task.status === "skipped" ? "opacity-50" : ""}`}
    >
      <button
        onClick={onOpen}
        className="w-full border-b border-line px-4 py-2.5 text-left transition hover:bg-iron/40"
      >
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[task.status]}`} />
          <span className="shrink-0 font-mono text-[11px] font-medium tracking-wide text-gold">{task.ticket}</span>
          <span className="shrink-0 rounded border border-line-soft px-1.5 py-0.5 font-mono text-[10px] text-stone">
            {task.agentLabel}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-bone">
            {active ? "running" : task.status} ⤢
          </span>
        </div>
        <div className="mt-1.5 truncate text-[14px] text-ink">{task.title}</div>
      </button>

      {task.dependsOn.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line-soft px-4 py-1.5">
          <span className="font-mono text-[10px] text-bone">depends on</span>
          {task.dependsOn.map((d) => (
            <span key={d} className="rounded bg-onyx px-1.5 py-0.5 font-mono text-[10px] text-cobalt">
              {ticketByKey[d] ?? d}
            </span>
          ))}
        </div>
      )}

      <div className="min-w-0 px-4 py-3 text-[14px]">
        {hasOutput ? (
          <div className="max-h-56 overflow-hidden">
            <PartsView parts={task.parts} streaming={active} />
          </div>
        ) : active ? (
          <span className="cursor font-mono text-[12px] text-bone">working</span>
        ) : (
          <span className="font-mono text-[12px] text-bone">
            {task.status === "pending"
              ? "queued…"
              : task.status === "skipped"
                ? "skipped (dependency failed)"
                : task.status === "needs_attention"
                  ? "operator reconciliation required"
                  : "—"}
          </span>
        )}
      </div>

      <button
        onClick={onOpen}
        className="border-t border-line-soft px-4 py-2 text-left font-mono text-[11px] text-bone transition hover:text-ink"
      >
        open detail{toolCount ? ` · ${toolCount} tool call${toolCount > 1 ? "s" : ""}` : ""} →
      </button>
    </div>
  );
}
