import { useEffect, useState } from "react";
import { api } from "../api";
import type { AiSettings } from "../types";
import { ModelPicker } from "./ModelPicker";

export function SettingsPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [provider, setProvider] = useState<"nexotao" | "claude">("nexotao");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.aiSettings().then((s) => {
      setSettings(s);
      setProvider(s.provider);
      setModel(s.model);
    });
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const r = await api.updateAiSettings({
        provider,
        apiKey: provider === "nexotao" ? apiKey.trim() || undefined : undefined,
        model: provider === "nexotao" ? model ?? undefined : undefined,
      });
      setSettings((s) => (s ? { ...s, ...r } : s));
      setApiKey("");
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <div className="p-8 font-mono text-[13px] text-bone">loading…</div>;

  return (
    <div className="mx-auto max-w-2xl px-5 py-6">
      <div className="mb-5 flex items-center justify-between border-b border-line pb-2">
        <span className="heading text-[19px] text-ink">Settings</span>
        <span className="eyebrow">AI provider</span>
      </div>

      {/* Provider selector */}
      <div className="mb-4 rounded-lg border border-line bg-charcoal p-4">
        <span className="eyebrow">provider</span>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => setProvider("nexotao")}
            className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition ${
              provider === "nexotao" ? "border-ink bg-iron/30" : "border-iron bg-onyx hover:border-stone"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${provider === "nexotao" ? "bg-prompt" : "bg-iron"}`} />
              <span className="text-[14px] text-ink">Nexotao</span>
              <span className="ml-auto font-mono text-[9px] uppercase tracking-wide text-prompt">recommended</span>
            </div>
            <span className="text-[11.5px] leading-snug text-bone">Hosted gateway · key + model</span>
          </button>
          <button
            onClick={() => setProvider("claude")}
            className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition ${
              provider === "claude" ? "border-ink bg-iron/30" : "border-iron bg-onyx hover:border-stone"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${provider === "claude" ? "bg-prompt" : "bg-iron"}`} />
              <span className="text-[14px] text-ink">Claude Code</span>
              <span className={`ml-auto font-mono text-[9px] uppercase tracking-wide ${settings.claudeAvailable ? "text-prompt" : "text-bone"}`}>
                {settings.claudeAvailable ? "detected" : "local"}
              </span>
            </div>
            <span className="text-[11.5px] leading-snug text-bone">This machine's Claude login · no key</span>
          </button>
        </div>
      </div>

      {provider === "nexotao" ? (
        <>
          {/* API key */}
          <div className="mb-4 rounded-lg border border-line bg-charcoal p-4">
            <span className="eyebrow">nexotao api key</span>
            <p className="mb-2 mt-1 font-mono text-[12px] text-bone">
              {settings.hasKey ? `current: ${settings.maskedKey}` : "not set — agents won’t run until you add one"}
            </p>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings.hasKey ? "sk-nexo-… (leave blank to keep current)" : "sk-nexo-…"}
              className="w-full rounded border border-iron bg-onyx px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-stone"
            />
            <p className="mt-1 font-mono text-[11px] text-bone">{settings.baseUrl}</p>
          </div>

          {/* Model */}
          <div className="mb-4 rounded-lg border border-line bg-charcoal p-4">
            <span className="eyebrow">model · this project’s default</span>
            <div className="mt-3">
              <ModelPicker value={model} onChange={setModel} />
            </div>
            <p className="mt-2 font-mono text-[11px] text-bone">
              Agents with no model of their own use this. Per-agent overrides are set on the Agents page.
            </p>
          </div>
        </>
      ) : (
        <div className="mb-4 rounded-lg border border-line bg-charcoal p-4">
          <span className="eyebrow">claude code · local</span>
          <p className="mt-2 text-[13px] leading-relaxed text-stone">
            {settings.claudeAvailable
              ? "Claude Code is installed on this machine. Agents connect directly through your local login — no API key, no model to pick."
              : "Claude Code CLI wasn’t found on PATH. Install it and run `claude` to log in (or set ANTHROPIC_API_KEY on the host), then agents connect directly."}
          </p>
          <p className="mt-2 font-mono text-[11px] text-bone">
            {settings.claudeAvailable ? "✓ detected" : "⚠ not detected"} · uses your Claude subscription / host auth
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-ink px-5 py-2 text-[14px] font-medium text-ember transition hover:bg-linen disabled:opacity-40"
        >
          {saving ? "saving…" : "Save"}
        </button>
        {saved && <span className="font-mono text-[12px] text-prompt">saved ✓</span>}
      </div>
      <div className="mt-6 rounded-lg border border-line bg-charcoal p-4">
        <span className="eyebrow">sessions</span>
        <p className="mb-3 mt-1 text-[12px] text-bone">Immediately invalidate every signed-in browser, including this one.</p>
        <button onClick={async () => { await api.revokeSessions(); window.location.reload(); }}
          className="rounded border border-iron px-3 py-1.5 font-mono text-[12px] text-stone hover:border-danger hover:text-danger">
          Revoke all sessions
        </button>
      </div>
    </div>
  );
}
