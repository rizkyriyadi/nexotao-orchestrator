import { runAgent, type AgentEvent } from "./agent.js";

/**
 * A small, deterministic orchestration: fan-out → barrier → synthesize.
 * Unlike a subagent (where the model decides the control flow on the fly),
 * the structure here is fixed in code: N worker agents run in parallel, each
 * through a different analytical lens; once ALL finish (the barrier), a
 * synthesizer agent reconciles their outputs into one answer.
 */

export interface WorkerRole {
  id: string;
  label: string;
  lens: string;
}

export const WORKER_ROLES: WorkerRole[] = [
  { id: "direct", label: "Direct", lens: "the most direct, practical solution" },
  { id: "risks", label: "Risks", lens: "edge cases, pitfalls, and what could go wrong" },
  { id: "alt", label: "Alternatives", lens: "alternative or creative approaches worth considering" },
];

export const SYNTH = { id: "synth", label: "Synthesis" };

export type OrchEvent =
  | { type: "orch_start"; task: string; workers: WorkerRole[]; synth: typeof SYNTH }
  | { type: "phase"; phase: "workers" | "synthesize" }
  | { type: "agent"; id: string; ev: AgentEvent }
  | { type: "agent_done"; id: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** Tag every event from a generator with the agent id it belongs to. */
async function* tag(id: string, gen: AsyncGenerator<AgentEvent>): AsyncGenerator<{ id: string; ev: AgentEvent }> {
  for await (const ev of gen) yield { id, ev };
}

/** Merge several async generators, yielding events as soon as any produces one. */
async function* merge<T>(gens: AsyncGenerator<T>[]): AsyncGenerator<T> {
  const iters = gens.map((g) => g[Symbol.asyncIterator]());
  const live = new Set(iters.map((_, i) => i));
  const nextOf = (i: number) => iters[i].next().then((r) => ({ i, r }));
  const pending = iters.map((_, i) => nextOf(i));

  while (live.size) {
    const { i, r } = await Promise.race([...live].map((i) => pending[i]));
    if (r.done) {
      live.delete(i);
    } else {
      yield r.value;
      pending[i] = nextOf(i);
    }
  }
}

export async function* runOrchestration(
  task: string,
  signal?: AbortSignal,
  workerIds?: string[]
): AsyncGenerator<OrchEvent> {
  const workers = workerIds ? WORKER_ROLES.filter((w) => workerIds.includes(w.id)) : WORKER_ROLES;

  yield { type: "orch_start", task, workers, synth: SYNTH };

  // ---- Phase 1: fan-out (parallel workers) ----
  yield { type: "phase", phase: "workers" };

  const finals = new Map<string, string>();
  const workerGens = workers.map((w) =>
    tag(
      w.id,
      runAgent(
        `${task}\n\nAnalyze this specifically through ONE lens: ${w.lens}. ` +
          `Be concise and focused — don't try to cover everything, just your angle.`,
        undefined,
        signal
      )
    )
  );

  for await (const { id, ev } of merge(workerGens)) {
    if (ev.type === "result") {
      finals.set(id, ev.text ?? "");
      yield { type: "agent_done", id };
    }
    yield { type: "agent", id, ev };
  }

  // ---- Barrier: all workers done. Phase 2: synthesize ----
  yield { type: "phase", phase: "synthesize" };

  const digest = workers
    .map((w) => `## ${w.label} (lens: ${w.lens})\n${finals.get(w.id) || "(no output)"}`)
    .join("\n\n");

  const synthPrompt =
    `You are the synthesizer in a multi-agent orchestration. The user's task was:\n\n"${task}"\n\n` +
    `${workers.length} agents each analyzed it through a different lens:\n\n${digest}\n\n` +
    `Produce ONE clear, non-redundant synthesis: the best answer, folding in the key risk and any ` +
    `strong alternative worth flagging. Be concise and decisive.`;

  for await (const ev of runAgent(synthPrompt, undefined, signal)) {
    if (ev.type === "result") yield { type: "agent_done", id: SYNTH.id };
    yield { type: "agent", id: SYNTH.id, ev };
  }

  yield { type: "done" };
}
