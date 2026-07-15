import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { OrceTaskFull, OrceTaskStatus } from "../../types";

type ColumnKey = "running" | "pending" | "done" | "failed";

const COLUMNS: {
  key: ColumnKey;
  label: string;
  statuses: OrceTaskStatus[];
  dot: string;
  accent: string;
}[] = [
  { key: "running", label: "In Progress", statuses: ["running"], dot: "animate-pulse bg-prompt", accent: "text-prompt" },
  { key: "pending", label: "Queued", statuses: ["pending"], dot: "bg-iron", accent: "text-stone" },
  { key: "done", label: "Done", statuses: ["done"], dot: "bg-bone", accent: "text-bone" },
  { key: "failed", label: "Attention · Failed", statuses: ["failed", "skipped", "needs_attention"], dot: "bg-danger", accent: "text-danger" },
];

const STATUS_PILL: Record<OrceTaskStatus, string> = {
  running: "bg-prompt/15 text-prompt",
  pending: "bg-iron/60 text-stone",
  done: "bg-bone/10 text-bone",
  failed: "bg-danger/15 text-danger",
  skipped: "bg-iron/50 text-bone",
  needs_attention: "bg-gold/15 text-gold",
};

export function TasksPage({ onOpenTask }: { onOpenTask: (runId: string, taskId: string) => void }) {
  const [tasks, setTasks] = useState<OrceTaskFull[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | null>(null);

  const load = () => api.listAllTasks().then((t) => { setTasks(t); setLoaded(true); }).catch(() => {});

  useEffect(() => {
    load();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  // Live-refresh while anything is in flight so background progress shows here.
  const anyActive = tasks.some((t) => t.status === "running" || t.status === "pending");
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (anyActive) timer.current = window.setInterval(load, 2500);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [anyActive]);

  const grouped = useMemo(() => {
    const g: Record<ColumnKey, OrceTaskFull[]> = { running: [], pending: [], done: [], failed: [] };
    for (const t of tasks) {
      const col = COLUMNS.find((c) => c.statuses.includes(t.status));
      if (col) g[col.key].push(t);
    }
    return g;
  }, [tasks]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <div className="mb-5 flex items-center justify-between border-b border-line pb-2">
        <div className="flex items-baseline gap-3">
          <span className="heading text-[19px] text-ink">Tasks</span>
          <span className="font-mono text-[11px] text-bone">{tasks.length} across all runs</span>
        </div>
        {anyActive && (
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-prompt">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-prompt" />
            live
          </span>
        )}
      </div>

      {loaded && tasks.length === 0 ? (
        <div className="rounded-lg border border-line bg-charcoal px-5 py-10 text-center">
          <p className="text-[14px] text-stone">No tasks yet.</p>
          <p className="mt-1 text-[12px] text-bone">Start an orchestration run — its tasks land here.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => (
            <section key={col.key} className="flex min-w-0 flex-col">
              <div className="mb-2.5 flex items-center gap-2 px-1">
                <span className={`h-1.5 w-1.5 rounded-full ${col.dot}`} />
                <span className={`text-[13px] font-medium ${col.accent}`}>{col.label}</span>
                <span className="font-mono text-[11px] text-bone">{grouped[col.key].length}</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {grouped[col.key].length === 0 && (
                  <div className="rounded-lg border border-dashed border-line-soft px-3 py-6 text-center font-mono text-[11px] text-bone">
                    empty
                  </div>
                )}
                {grouped[col.key].map((t) => (
                  <TaskCard key={t.id} task={t} onClick={() => onOpenTask(t.run_id, t.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onClick }: { task: OrceTaskFull; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-2 rounded-lg border border-line bg-charcoal p-3 text-left transition hover:border-iron hover:bg-iron/20"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-medium tracking-wide text-gold">{task.ticket}</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${STATUS_PILL[task.status]}`}>
          {task.status}
        </span>
      </div>

      <div className="line-clamp-2 text-[13.5px] leading-snug text-ink">{task.title}</div>

      <div className="truncate font-mono text-[10.5px] text-bone" title={task.run_goal}>
        {task.run_goal}
      </div>

      <div className="mt-0.5 flex items-center gap-3 border-t border-line-soft pt-2 font-mono text-[10px] text-bone">
        <span className="flex items-center gap-1 text-stone">
          <span className="text-bone">◈</span> {task.agent_label}
        </span>
        {task.depends_on.length > 0 && (
          <span className="flex items-center gap-1" title="dependencies">
            <span>⧉</span> {task.depends_on.length}
          </span>
        )}
        {task.cost_usd != null && <span className="ml-auto text-bone">${task.cost_usd.toFixed(3)}</span>}
      </div>
    </button>
  );
}
