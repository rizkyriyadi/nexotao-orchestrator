import { useEffect, useState } from "react";
import { api, type Stats } from "../api";
import type { SessionMeta } from "../types";

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 3 ? "/" + parts.join("/") : "…/" + parts.slice(-3).join("/");
}

export function Dashboard({
  sessions,
  onNewChat,
  onOrchestrate,
  onSelect,
}: {
  sessions: SessionMeta[];
  onNewChat: () => void;
  onOrchestrate: () => void;
  onSelect: (id: string) => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch(() => {});
  }, [sessions.length]);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="mb-6">
        <span className="eyebrow">overview</span>
        <h1 className="display mt-2 text-[44px] text-ink">Nexotao Orce</h1>
        <p className="mt-1 max-w-lg text-[15px] text-stone">
          Claude Code plus multi-agent orchestration, self-hosted. Chat, plan, and run agent teams —
          all on your server’s workspace.
        </p>
      </div>

      {/* Bento grid */}
      <div className="grid auto-rows-[minmax(0,auto)] grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Identity — terminal mockup (2x2) */}
        <div className="overflow-hidden rounded-lg border border-line bg-charcoal sm:col-span-2 lg:row-span-2">
          <div className="flex items-center gap-2 border-b border-line bg-iron px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#febc20" }} />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} />
            <span className="ml-2 font-mono text-[11px] text-bone">workspace</span>
          </div>
          <div className="space-y-2.5 p-5 font-mono text-[13px] leading-relaxed">
            <div className="text-stone">
              <span className="text-prompt">›</span> pwd
            </div>
            <div className="text-gold">{stats ? shortPath(stats.cwd) : "…"}</div>
            <div className="text-stone">
              <span className="text-prompt">›</span> claude --resume
            </div>
            <div className="text-cobalt">
              session ready · <span className="text-stone">{stats?.permissionMode ?? "—"}</span>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <span className={`h-1.5 w-1.5 rounded-full ${stats?.dbConnected ? "animate-pulse bg-prompt" : "bg-bone"}`} />
              <span className="text-bone">{stats ? `storage · ${stats.storage}` : "…"}</span>
            </div>
          </div>
        </div>

        {/* Sessions count */}
        <Stat label="sessions" value={stats?.sessions ?? "—"} />
        {/* Messages count */}
        <Stat label="messages" value={stats?.messages ?? "—"} />

        {/* Activity strip (2 wide) */}
        <div className="rounded-lg border border-line bg-charcoal p-5 sm:col-span-2">
          <span className="eyebrow">last activity</span>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <span className="text-[18px] text-ink">{relTime(stats?.lastActivityAt ?? null)}</span>
            <span className="font-mono text-[12px] text-bone">
              storage: {stats ? (stats.storage.includes("Neon") ? "neon" : stats.dbConnected ? "local" : "memory") : "—"}
            </span>
            <span className="font-mono text-[12px] text-bone">mode: {stats?.permissionMode ?? "—"}</span>
          </div>
        </div>

        {/* Recent sessions (2x2) */}
        <div className="rounded-lg border border-line bg-charcoal sm:col-span-2 lg:row-span-2">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <span className="eyebrow">recent sessions</span>
            <span className="eyebrow">{sessions.length}</span>
          </div>
          <div className="max-h-72 overflow-y-auto p-2">
            {sessions.length === 0 && (
              <p className="px-3 py-4 text-[13px] text-bone">No sessions yet. Start one below.</p>
            )}
            {sessions.slice(0, 8).map((s) => (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className="flex w-full items-center gap-3 rounded px-3 py-2 text-left transition hover:bg-iron"
              >
                <span className="min-w-0 flex-1 truncate text-[14px] text-stone">{s.title || "untitled"}</span>
                <span className="shrink-0 font-mono text-[11px] text-bone">{relTime(s.updated_at)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Quick action: new chat */}
        <Action title="New session" desc="Single agent" glyph="›" onClick={onNewChat} />
        {/* Quick action: orchestrate */}
        <Action title="Orchestrate" desc="Fan-out → synthesize" glyph="⟐" onClick={onOrchestrate} />

        {/* Modes explainer (2 wide) */}
        <div className="rounded-lg border border-line bg-charcoal p-5 sm:col-span-2">
          <span className="eyebrow">two modes</span>
          <div className="mt-3 grid grid-cols-2 gap-4 text-[13px]">
            <div>
              <div className="font-mono text-[13px] text-ink">chat</div>
              <p className="mt-1 leading-relaxed text-bone">
                One agent, full toolset — bash, edit, subagents, web.
              </p>
            </div>
            <div>
              <div className="font-mono text-[13px] text-ink">orchestrate</div>
              <p className="mt-1 leading-relaxed text-bone">
                Parallel agents by lens, reconciled by a synthesizer.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col justify-between rounded-lg border border-line bg-charcoal p-5">
      <span className="eyebrow">{label}</span>
      <span className="mt-4 text-[40px] leading-none text-ink" style={{ letterSpacing: "-1.44px", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}

function Action({
  title,
  desc,
  glyph,
  onClick,
}: {
  title: string;
  desc: string;
  glyph: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-start rounded-lg border border-line bg-charcoal p-5 text-left transition hover:border-iron hover:bg-iron"
    >
      <span className="font-mono text-lg text-prompt">{glyph}</span>
      <span className="mt-3 text-[16px] text-ink">{title}</span>
      <span className="mt-0.5 text-[12px] text-bone">{desc}</span>
      <span className="mt-3 font-mono text-[11px] text-bone transition group-hover:text-stone">open →</span>
    </button>
  );
}
