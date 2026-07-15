import { useEffect, useRef, useState } from "react";
import { api, streamOrceRun, streamOrceStart, streamOrceAttach } from "../../api";
import { reduceOrceRun } from "../../lib/parts";
import type { OrceEventRow, OrceRunMeta, OrceRunState, OrceTaskDb } from "../../types";
import { RunBoard } from "./RunBoard";
import { AgentsPanel } from "./AgentsPanel";
import { AttachImageButton, AttachmentTray } from "../ImageAttachments";
import { pastedImages, useImageAttachments } from "../../lib/images";

export type OrceViewKind = "orchestrate" | "agents" | "runs";

function fromDb(run: OrceRunMeta, tasks: OrceTaskDb[], events: OrceEventRow[]): OrceRunState {
  return {
    runId: run.id,
    goal: run.goal,
    images: run.attachments ?? [],
    phase: "done",
    status:
      run.status === "planning" || run.status === "running" || run.status === "awaiting_approval"
        ? undefined
        : run.status,
    costUsd: run.cost_usd,
    budget: { spent: run.cost_usd, limit: null, warn: false, stopped: run.status === "stopped" },
    activity: events.map((e) => ({ at: e.created_at, level: e.level, message: e.message, taskId: e.task_id ?? undefined })),
    error: run.error ?? undefined,
    tasks: tasks.map((t, i) => ({
      id: t.id,
      ticket: t.ticket || `TASK-${String(i + 1).padStart(4, "0")}`,
      key: t.key,
      title: t.title,
      agentLabel: t.agent_label,
      dependsOn: t.depends_on,
      status: t.status,
      parts: t.output
        ? [{ kind: "text", text: t.output }]
        : t.error
        ? [{ kind: "text", text: `⚠ ${t.error}` }]
        : [],
    })),
  };
}

export function OrceView({
  view,
  onNavigate,
  onOpenTask,
}: {
  view: OrceViewKind;
  onNavigate: (v: OrceViewKind) => void;
  onOpenTask: (runId: string, taskId: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [autoRun, setAutoRun] = useState(false); // review the generated plan before execution by default
  const [planning, setPlanning] = useState(false);
  const [run, setRun] = useState<OrceRunState | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [runs, setRuns] = useState<OrceRunMeta[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const imageInput = useImageAttachments();

  useEffect(() => {
    if (view === "runs") api.listRuns().then(setRuns).catch(() => {});
  }, [view, streaming]);

  // Reconnect: after a refresh, if a run is still executing in the background,
  // re-attach to its live stream (or load the finished state from the DB).
  useEffect(() => {
    if (view !== "orchestrate") return;
    let cancelled = false;
    (async () => {
      const list = await api.listRuns().catch(() => [] as OrceRunMeta[]);
      const candidate = list.find((r) => r.status === "running" || r.status === "planning");
      if (!candidate || cancelled) return;
      const { active } = await api.orceActive([candidate.id]).catch(() => ({ active: [] as string[] }));
      if (cancelled) return;
      if (active.includes(candidate.id)) {
        // Replay + live: the hub buffer rebuilds the whole run from run_start.
        streamRun((onEvent, signal) => streamOrceAttach(candidate.id, onEvent, signal));
      } else {
        const { run: r, tasks, events } = await api.getRun(candidate.id);
        if (!cancelled) setRun(fromDb(r, tasks, events));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only on entering the orchestrate view (mount / nav), not on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const capValue = () => {
    const c = parseFloat(budget);
    return isFinite(c) && c > 0 ? c : null;
  };

  function planStateFrom(plan: {
    runId: string;
    goal: string;
    budgetUsd: number | null;
    images: OrceRunState["images"];
    tasks: any[];
  }): OrceRunState {
    return {
      runId: plan.runId,
      goal: plan.goal,
      images: plan.images ?? [],
      phase: "awaiting_approval",
      tasks: plan.tasks.map((t) => ({
        id: t.id,
        ticket: t.ticket,
        key: t.key,
        title: t.title,
        agentLabel: t.agentLabel,
        dependsOn: t.dependsOn,
        status: t.status,
        parts: [],
      })),
      activity: [],
      budget: { spent: 0, limit: plan.budgetUsd, warn: false, stopped: false },
    };
  }

  async function streamRun(fn: (onEvent: (ev: any) => void, signal: AbortSignal) => Promise<void>) {
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await fn((ev) => setRun((prev) => reduceOrceRun(prev, ev)), ac.signal);
    } catch (err) {
      setRun((prev) => reduceOrceRun(prev, { type: "error", message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // Launch: plan → await approval (default) or run straight through (auto).
  async function launch() {
    const g = goal.trim();
    if ((!g && imageInput.images.length === 0) || streaming || planning) return;
    setRun(null);
    if (autoRun) {
      await streamRun((onEvent, signal) => streamOrceRun(g, imageInput.images, onEvent, signal, capValue()));
      return;
    }
    setPlanning(true);
    try {
      const plan = await api.planOrce(g, capValue(), imageInput.images);
      setRun(planStateFrom(plan));
    } catch (err) {
      setRun((prev) => reduceOrceRun(prev, { type: "error", message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPlanning(false);
    }
  }

  async function approve() {
    if (!run?.runId) return;
    await streamRun((onEvent, signal) => streamOrceStart(run.runId!, onEvent, signal));
  }

  async function discard() {
    if (run?.runId) await api.cancelOrce(run.runId);
    setRun(null);
  }

  async function openHistory(id: string) {
    const { run, tasks, events } = await api.getRun(id);
    setRun(fromDb(run, tasks, events));
    onNavigate("orchestrate");
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-6">
      <div className="mb-5 flex items-center justify-between border-b border-line pb-2">
        <span className="heading text-[19px] capitalize text-ink">
          {view === "orchestrate" ? "Orchestrate" : view === "agents" ? "Agents" : "Runs"}
        </span>
        <span className="eyebrow">planner · DAG · parallel</span>
      </div>

      {view === "orchestrate" && (
        <div className="flex flex-col gap-5">
          {/* Goal launcher */}
          <div
            className="rounded-lg border border-line bg-charcoal p-4"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void imageInput.addFiles(event.dataTransfer.files);
            }}
          >
            <label className="eyebrow mb-2 block">orchestration goal</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onPaste={(event) => {
                const files = pastedImages(event.clipboardData);
                if (files.length) {
                  event.preventDefault();
                  void imageInput.addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch();
              }}
              rows={2}
              placeholder="e.g. build a Next.js landing page for a coffee shop, then review it"
              className="w-full resize-none bg-transparent font-mono text-[14px] text-ink outline-none placeholder:text-bone"
            />
            <AttachmentTray images={imageInput.images} onRemove={imageInput.removeImage} />
            {imageInput.imageError && (
              <p className="mt-2 font-mono text-[11px] text-danger">{imageInput.imageError}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <AttachImageButton onFiles={(files) => void imageInput.addFiles(files)} withLabel />
                <span className="eyebrow">budget</span>
                <div className="flex items-center gap-1 rounded border border-iron bg-onyx px-2 py-1">
                  <span className="font-mono text-[12px] text-bone">$</span>
                  <input
                    value={budget}
                    onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="none"
                    inputMode="decimal"
                    className="w-16 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-bone"
                  />
                </div>
                <label className="flex items-center gap-1.5 font-mono text-[11px] text-bone">
                  <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
                  auto-run (skip approval)
                </label>
              </div>
              {streaming ? (
                <button
                  onClick={() => {
                    if (run?.runId) api.cancelOrce(run.runId).catch(() => {});
                    abortRef.current?.abort();
                  }}
                  className="rounded border border-iron px-3 py-1.5 font-mono text-[12px] text-stone transition hover:border-danger hover:text-danger"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={launch}
                  disabled={(!goal.trim() && imageInput.images.length === 0) || planning}
                  className="rounded bg-ink px-4 py-1.5 font-mono text-[12px] text-ember transition hover:bg-linen disabled:opacity-30"
                >
                  {planning ? "planning…" : autoRun ? "Orchestrate" : "Plan"}
                </button>
              )}
            </div>
          </div>

          {run ? (
            <RunBoard
              run={run}
              onOpenTask={(taskId) => run.runId && onOpenTask(run.runId, taskId)}
              onApprove={run.phase === "awaiting_approval" && !streaming ? approve : undefined}
              onDiscard={run.phase === "awaiting_approval" && !streaming ? discard : undefined}
            />
          ) : (
            <Empty />
          )}
        </div>
      )}

      {view === "agents" && <AgentsPanel />}

      {view === "runs" && (
        <div className="flex flex-col gap-2">
          <span className="eyebrow">recent runs · {runs.length}</span>
          {runs.length === 0 && <p className="text-[13px] text-bone">No runs yet.</p>}
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => openHistory(r.id)}
              className="flex items-center gap-3 rounded-lg border border-line bg-charcoal px-4 py-3 text-left transition hover:border-iron"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotForRun(r.status)}`} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-stone">{r.goal}</span>
              <span className="shrink-0 font-mono text-[11px] text-bone">${r.cost_usd.toFixed(3)}</span>
              <span className="shrink-0 font-mono text-[11px] text-bone">{r.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function dotForRun(status: string): string {
  if (status === "completed") return "bg-bone";
  if (status === "failed") return "bg-danger";
  if (status === "needs_attention") return "bg-gold";
  if (status === "running" || status === "planning") return "animate-pulse bg-prompt";
  return "bg-iron";
}

function Empty() {
  return (
    <div className="rounded-lg border border-line bg-charcoal px-5 py-8 text-center">
      <p className="mx-auto max-w-md text-[14px] leading-relaxed text-stone">
        Give a goal above. A <span className="text-ink">planner agent</span> decomposes it into a task
        DAG, assigns each task to the best <span className="text-ink">agent</span>, and the scheduler
        runs them — in parallel where dependencies allow, waiting where they don’t.
      </p>
    </div>
  );
}
