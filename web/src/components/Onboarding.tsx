import { useEffect, useRef, useState } from "react";
import { api, streamProposeAgents, type ProposedAgent } from "../api";
import type { Project } from "../types";
import { ModelPicker } from "./ModelPicker";
import { FolderPicker } from "./FolderPicker";

export function Onboarding({
  mode = "onboard",
  onDone,
  onCancel,
}: {
  mode?: "onboard" | "add";
  onDone: (p: Project) => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<"fresh" | "imported" | null>(null);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [provider, setProvider] = useState<"nexotao" | "claude">("nexotao");
  const [claudeAvailable, setClaudeAvailable] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(true);
  const [fullTeam, setFullTeam] = useState(true);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Project | null>(null);

  useEffect(() => {
    api.aiSettings().then((s) => {
      setHasKey(s.hasKey);
      setClaudeAvailable(s.claudeAvailable);
    }).catch(() => {});
  }, []);

  // Claude adapter: no key, model optional. Nexotao: needs a key + a model.
  const providerOk = provider === "claude" ? true : hasKey || apiKey.trim().length > 0;
  const modelOk = provider === "claude" ? true : Boolean(model);
  const ready = name.trim() && modelOk && (kind !== "imported" || path.trim()) && providerOk;

  async function create() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject({
        name: name.trim(),
        kind: kind!,
        path: kind === "imported" ? path.trim() : undefined,
        agents: kind === "fresh" ? "one" : fullTeam ? "all" : "one",
        model: model ?? undefined,
        provider,
        apiKey: provider === "nexotao" && !hasKey ? apiKey.trim() : undefined,
      });
      if (kind === "imported") setCreated(p); // → setup step (graph + AI agents)
      else onDone(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (created) return <SetupStep project={created} onDone={() => onDone(created)} />;

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-ember p-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-baseline gap-2.5">
          <span className="font-mono text-sm text-ink">◆</span>
          <span className="heading text-[20px] text-ink">
            nexotao <span className="text-bone">orce</span>
          </span>
          <span className="eyebrow ml-auto self-center">{mode === "add" ? "new project" : "welcome"}</span>
        </div>

        {!kind ? (
          <div className="space-y-3">
            <p className="mb-4 text-[15px] text-stone">
              {mode === "add" ? "Add a project to work in." : "Let’s set up your first project."}
            </p>
            <Choice
              glyph="›"
              title="Start fresh"
              desc="A brand-new empty workspace with one Generalist agent. Great for building something from scratch."
              onClick={() => setKind("fresh")}
            />
            <Choice
              glyph="◇"
              title="Use an existing project"
              desc="Point at a folder you already have. Gets the full agent team, and a knowledge graph so agents understand your code."
              onClick={() => setKind("imported")}
            />
            {onCancel && (
              <button onClick={onCancel} className="mt-2 font-mono text-[12px] text-bone hover:text-ink">
                cancel
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-charcoal">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3">
              <span className="eyebrow">{kind === "fresh" ? "start fresh" : "existing project"}</span>
              <button onClick={() => setKind(null)} className="ml-auto font-mono text-[11px] text-bone hover:text-ink">
                ← back
              </button>
            </div>
            <div className="space-y-4 p-5">
              <Field label="project name">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={kind === "fresh" ? "my-app" : "My Existing Project"}
                  className="w-full rounded border border-iron bg-onyx px-3 py-2 text-[14px] text-ink outline-none focus:border-stone"
                />
              </Field>

              {kind === "imported" ? (
                <>
                  <Field label="project path (absolute)">
                    <div className="flex gap-2">
                      <input
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        placeholder="/Users/you/code/my-project"
                        className="w-full rounded border border-iron bg-onyx px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-stone"
                      />
                      <button
                        type="button"
                        onClick={() => setPicking(true)}
                        className="shrink-0 rounded border border-iron px-3 font-mono text-[12px] text-stone transition hover:border-ink hover:text-ink"
                      >
                        Browse…
                      </button>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-bone">
                      Type a path, or <span className="text-stone">Browse…</span> to open a folder on this machine.
                    </p>
                  </Field>
                  <label className="flex items-center gap-2 text-[13px] text-stone">
                    <input type="checkbox" checked={fullTeam} onChange={(e) => setFullTeam(e.target.checked)} />
                    Seed the full agent team (Generalist · Researcher · Implementer · Reviewer)
                  </label>
                  <p className="font-mono text-[11px] leading-relaxed text-bone">
                    A knowledge graph is built automatically so agents understand this project’s structure.
                  </p>
                </>
              ) : (
                <p className="font-mono text-[12px] leading-relaxed text-bone">
                  Creates a fresh folder in your data dir and seeds <span className="text-stone">1 Generalist agent</span>.
                </p>
              )}

              {/* Provider adapter */}
              <Field label="ai provider">
                <div className="grid grid-cols-2 gap-2">
                  <ProviderCard
                    active={provider === "nexotao"}
                    onClick={() => setProvider("nexotao")}
                    title="Nexotao"
                    tag="recommended"
                    desc="Hosted gateway. Paste a key, pick a model."
                  />
                  <ProviderCard
                    active={provider === "claude"}
                    onClick={() => setProvider("claude")}
                    title="Claude Code"
                    tag={claudeAvailable ? "detected" : "local"}
                    tagTone={claudeAvailable ? "text-prompt" : "text-bone"}
                    desc="Use this machine's logged-in Claude Code. No key."
                  />
                </div>
              </Field>

              {provider === "nexotao" && !hasKey && (
                <Field label="nexotao api key">
                  <input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-nexo-…"
                    className="w-full rounded border border-iron bg-onyx px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-stone"
                  />
                  <p className="mt-1 font-mono text-[11px] text-bone">
                    Get one at{" "}
                    <a href="https://nexotao.com" target="_blank" rel="noreferrer" className="text-cobalt hover:text-ink">
                      nexotao.com
                    </a>{" "}
                    · docs:{" "}
                    <a href="https://docs.nexotao.com" target="_blank" rel="noreferrer" className="text-cobalt hover:text-ink">
                      docs.nexotao.com
                    </a>
                  </p>
                </Field>
              )}

              {provider === "claude" && (
                <p className="rounded border border-line-soft bg-onyx px-3 py-2 font-mono text-[11px] leading-relaxed text-bone">
                  {claudeAvailable
                    ? "✓ Claude Code detected — agents connect directly using your local login."
                    : "⚠ Claude Code CLI not found on PATH. Install it and run "}
                  {!claudeAvailable && <span className="text-stone">claude</span>}
                  {!claudeAvailable && " to log in (or set ANTHROPIC_API_KEY)."}
                </p>
              )}

              {provider === "nexotao" && (
                <Field label="model">
                  <ModelPicker value={model} onChange={setModel} />
                </Field>
              )}

              {error && <p className="font-mono text-[12px] text-danger">⚠ {error}</p>}

              <button
                onClick={create}
                disabled={busy || !ready}
                className="w-full rounded bg-ink py-2.5 text-[14px] font-medium text-ember transition hover:bg-linen disabled:opacity-30"
              >
                {busy ? "creating…" : kind === "fresh" ? "Create project" : "Import project"}
              </button>
            </div>
          </div>
        )}
      </div>

      {picking && (
        <FolderPicker
          initial={path.trim() || undefined}
          onPick={(p) => {
            setPath(p);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function SetupStep({ project, onDone }: { project: Project; onDone: () => void }) {
  const [graph, setGraph] = useState<"idle" | "building" | "ready">("idle");
  const [proposing, setProposing] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [thinking, setThinking] = useState<string>("");
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposedAgent[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [added, setAdded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function buildGraph() {
    setGraph("building");
    try {
      const r = await api.buildGraph();
      setGraph(r.hasGraph ? "ready" : "idle");
    } catch {
      setGraph("idle");
    }
  }
  async function propose() {
    setProposing(true);
    setProposeError(null);
    setActivity(["Starting inspection…"]);
    setThinking("");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamProposeAgents((ev) => {
        if (ev.type === "activity") {
          setActivity((prev) => [...prev.slice(-6), ev.text]);
        } else if (ev.type === "thinking") {
          setThinking(ev.text);
        } else if (ev.type === "proposals") {
          setProposals(ev.agents);
          setSelected(new Set(ev.agents.map((_, i) => i)));
        } else if (ev.type === "error") {
          setProposeError(ev.message);
        }
      }, ac.signal);
    } catch (e) {
      setProposeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposing(false);
      setThinking("");
    }
  }
  async function addSelected() {
    if (!proposals) return;
    for (const i of selected) await api.createAgent(proposals[i] as any);
    setAdded(true);
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-ember p-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-baseline gap-2.5">
          <span className="font-mono text-sm text-ink">◆</span>
          <span className="heading text-[20px] text-ink">{project.name}</span>
          <span className="eyebrow ml-auto self-center">project ready</span>
        </div>

        <p className="mb-4 text-[14px] text-stone">Two quick recommendations to make agents smart about this project:</p>

        {/* 1. graph */}
        <div className="mb-3 rounded-lg border border-line bg-charcoal p-4">
          <div className="flex items-center gap-2">
            <span className="text-[15px] text-ink">1 · Build knowledge graph</span>
            {graph === "ready" && <span className="font-mono text-[11px] text-prompt">ready ✓</span>}
            <button
              onClick={buildGraph}
              disabled={graph === "building" || graph === "ready"}
              className="ml-auto rounded border border-iron px-3 py-1 font-mono text-[12px] text-stone transition hover:border-ink hover:text-ink disabled:opacity-40"
            >
              {graph === "building" ? "building…" : graph === "ready" ? "built" : "build now"}
            </button>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-bone">
            Maps your code so agents query the graph instead of grepping. Recommended for existing projects.
          </p>
        </div>

        {/* 2. agents */}
        <div className="mb-4 rounded-lg border border-line bg-charcoal p-4">
          <div className="flex items-center gap-2">
            <span className="text-[15px] text-ink">2 · Agents from this project</span>
            {!proposals && (
              <button
                onClick={propose}
                disabled={proposing}
                className="ml-auto rounded border border-iron px-3 py-1 font-mono text-[12px] text-stone transition hover:border-ink hover:text-ink disabled:opacity-40"
              >
                {proposing ? "inspecting…" : "propose"}
              </button>
            )}
          </div>
          {!proposals && !proposing && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-bone">
              An agent inspects your project and proposes a tailored team — you approve which to add.
            </p>
          )}

          {/* Live inspection progress */}
          {proposing && (
            <div className="mt-3 rounded border border-line-soft bg-onyx p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-prompt" />
                <span className="eyebrow">inspecting your project</span>
              </div>
              <ul className="space-y-1">
                {activity.map((line, i) => {
                  const last = i === activity.length - 1;
                  return (
                    <li
                      key={i}
                      className={`flex items-center gap-2 font-mono text-[12px] ${last ? "text-ink" : "text-bone"}`}
                    >
                      <span className={last ? "text-prompt" : "text-iron"}>{last ? "›" : "✓"}</span>
                      <span className="truncate">{line}</span>
                      {last && <span className="cursor text-prompt">▌</span>}
                    </li>
                  );
                })}
              </ul>
              {thinking && (
                <p className="mt-2 line-clamp-2 border-t border-line pt-2 font-mono text-[11px] italic leading-relaxed text-bone">
                  {thinking}
                </p>
              )}
            </div>
          )}

          {proposeError && !proposing && (
            <p className="mt-2 font-mono text-[12px] text-danger">⚠ {proposeError}</p>
          )}

          {proposals && !added && (
            <div className="mt-3 space-y-2">
              {proposals.map((a, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-2.5 rounded border border-line-soft p-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={(e) => {
                      const n = new Set(selected);
                      e.target.checked ? n.add(i) : n.delete(i);
                      setSelected(n);
                    }}
                    className="mt-1"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] text-ink">{a.name}</span>
                      {a.isolate && <span className="rounded bg-onyx px-1 py-px font-mono text-[10px] text-cobalt">isolated</span>}
                      <span className="font-mono text-[10px] text-bone">{a.tools ? `${a.tools.length} tools` : "all tools"}</span>
                    </div>
                    <div className="text-[12px] text-stone">{a.role}</div>
                  </div>
                </label>
              ))}
              <button
                onClick={addSelected}
                disabled={selected.size === 0}
                className="w-full rounded border border-iron py-2 font-mono text-[12px] text-ink transition hover:border-ink disabled:opacity-40"
              >
                add {selected.size} agent{selected.size !== 1 ? "s" : ""}
              </button>
            </div>
          )}
          {added && <p className="mt-2 font-mono text-[12px] text-prompt">agents added ✓</p>}
        </div>

        <button
          onClick={onDone}
          className="w-full rounded bg-ink py-2.5 text-[14px] font-medium text-ember transition hover:bg-linen"
        >
          Enter project →
        </button>
      </div>
    </div>
  );
}

function Choice({ glyph, title, desc, onClick }: { glyph: string; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg border border-line bg-charcoal p-4 text-left transition hover:border-iron hover:bg-iron/30"
    >
      <span className="mt-0.5 font-mono text-lg text-prompt">{glyph}</span>
      <div>
        <div className="text-[16px] text-ink">{title}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-bone">{desc}</div>
      </div>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="eyebrow mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function ProviderCard({
  active,
  onClick,
  title,
  tag,
  tagTone = "text-prompt",
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  tag: string;
  tagTone?: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition ${
        active ? "border-ink bg-iron/30" : "border-iron bg-onyx hover:border-stone"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-prompt" : "bg-iron"}`} />
        <span className="text-[14px] text-ink">{title}</span>
        <span className={`ml-auto font-mono text-[9px] uppercase tracking-wide ${tagTone}`}>{tag}</span>
      </div>
      <span className="text-[11.5px] leading-snug text-bone">{desc}</span>
    </button>
  );
}
