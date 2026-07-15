import { useEffect, useState } from "react";
import { api } from "../../api";
import type { ModelInfo, OrceAgent } from "../../types";

const ALL_TOOLS = ["Read", "Grep", "Glob", "Bash", "Write", "Edit", "WebSearch", "WebFetch", "Task"];

type Draft = {
  id?: string;
  name: string;
  role: string;
  system_prompt: string;
  model: string;
  tools: string[];
  isolate: boolean;
};

const EMPTY: Draft = { name: "", role: "", system_prompt: "", model: "", tools: [], isolate: false };

export function AgentsPanel() {
  const [agents, setAgents] = useState<OrceAgent[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<{ value: string; label: string }[]>([{ value: "", label: "default" }]);

  useEffect(() => {
    api
      .aiModels()
      .then((r) => setModels([{ value: "", label: "default (project)" }, ...r.models.map((m: ModelInfo) => ({ value: m.id, label: m.name }))]))
      .catch(() => {});
  }, []);

  const load = () => api.listAgents().then(setAgents).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!draft) return;
    const payload = {
      name: draft.name,
      role: draft.role,
      system_prompt: draft.system_prompt,
      model: draft.model || null,
      tools: draft.tools.length ? draft.tools : null,
      isolate: draft.isolate,
    };
    if (draft.id) await api.updateAgent(draft.id, payload);
    else await api.createAgent(payload);
    setDraft(null);
    load();
  }

  async function remove(id: string) {
    await api.deleteAgent(id);
    load();
  }

  function editFrom(a: OrceAgent) {
    setDraft({
      id: a.id,
      name: a.name,
      role: a.role,
      system_prompt: a.system_prompt,
      model: a.model ?? "",
      tools: a.tools ?? [],
      isolate: a.isolate,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">agents · {agents.length}</span>
        <button
          onClick={() => setDraft({ ...EMPTY })}
          className="rounded border border-iron px-3 py-1 font-mono text-[12px] text-stone transition hover:border-ink hover:text-ink"
        >
          + new agent
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {agents.map((a) => (
          <div key={a.id} className="flex flex-col rounded-lg border border-line bg-charcoal p-4">
            <div className="flex items-center gap-2">
              <span className="text-[15px] text-ink">{a.name}</span>
              {a.builtin && <span className="rounded bg-onyx px-1.5 py-0.5 font-mono text-[10px] text-bone">builtin</span>}
              {a.isolate && <span className="rounded bg-onyx px-1.5 py-0.5 font-mono text-[10px] text-cobalt">isolated</span>}
            </div>
            <p className="mt-1 text-[13px] text-stone">{a.role}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[10px] text-bone">
              <span className="rounded bg-onyx px-1.5 py-0.5">{a.model ? a.model.replace("claude-", "") : "default model"}</span>
              <span className="rounded bg-onyx px-1.5 py-0.5">{a.tools ? `${a.tools.length} tools` : "all tools"}</span>
            </div>
            <div className="mt-3 flex gap-3 font-mono text-[11px]">
              <button onClick={() => editFrom(a)} className="text-bone transition hover:text-ink">
                edit
              </button>
              {!a.builtin && (
                <button onClick={() => remove(a.id)} className="text-bone transition hover:text-danger">
                  delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={() => setDraft(null)}>
          <div
            className="w-full max-w-lg rounded-lg border border-iron bg-charcoal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-line px-5 py-3">
              <span className="eyebrow">{draft.id ? "edit agent" : "new agent"}</span>
            </div>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5">
              <Field label="name">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="w-full rounded border border-iron bg-onyx px-3 py-2 text-[14px] text-ink outline-none focus:border-stone"
                />
              </Field>
              <Field label="role (short)">
                <input
                  value={draft.role}
                  onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                  className="w-full rounded border border-iron bg-onyx px-3 py-2 text-[14px] text-ink outline-none focus:border-stone"
                />
              </Field>
              <Field label="system prompt">
                <textarea
                  value={draft.system_prompt}
                  onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
                  rows={4}
                  className="w-full resize-none rounded border border-iron bg-onyx px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-stone"
                />
              </Field>
              <Field label="model">
                <div className="flex flex-wrap gap-2">
                  {models.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => setDraft({ ...draft, model: m.value })}
                      className={`rounded border px-2.5 py-1 font-mono text-[12px] ${
                        draft.model === m.value ? "border-ink text-ink" : "border-iron text-bone"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="tools (none = all)">
                <div className="flex flex-wrap gap-2">
                  {ALL_TOOLS.map((tool) => {
                    const on = draft.tools.includes(tool);
                    return (
                      <button
                        key={tool}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            tools: on ? draft.tools.filter((x) => x !== tool) : [...draft.tools, tool],
                          })
                        }
                        className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                          on ? "border-ink text-ink" : "border-iron text-bone"
                        }`}
                      >
                        {tool}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <label className="flex items-center gap-2 text-[13px] text-stone">
                <input
                  type="checkbox"
                  checked={draft.isolate}
                  onChange={(e) => setDraft({ ...draft, isolate: e.target.checked })}
                />
                Run in an isolated working directory (safe for parallel writes)
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <button onClick={() => setDraft(null)} className="rounded border border-iron px-3 py-1.5 font-mono text-[12px] text-bone">
                cancel
              </button>
              <button
                onClick={save}
                disabled={!draft.name.trim()}
                className="rounded bg-ink px-4 py-1.5 font-mono text-[12px] text-ember disabled:opacity-40"
              >
                save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
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
