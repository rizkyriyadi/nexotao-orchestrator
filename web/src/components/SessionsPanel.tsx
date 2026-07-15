import type { SessionMeta } from "../types";

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function SessionsPanel({
  sessions,
  activeId,
  open,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  sessions: SessionMeta[];
  activeId: string | null;
  open: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      {open && <div className="fixed inset-0 z-20 bg-black/60 md:hidden" onClick={onClose} />}
      <aside
        className={`fixed left-0 top-0 z-30 flex h-full w-72 flex-col border-r border-line bg-ember transition-transform md:static md:z-0 md:w-64 md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          onClick={onNew}
          className="flex items-center gap-2 border-b border-line px-5 py-3 text-left text-[14px] text-stone transition hover:bg-charcoal hover:text-ink"
        >
          <span className="font-mono text-prompt">›</span> New session
        </button>

        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <span className="eyebrow">sessions</span>
          <span className="eyebrow">{sessions.length || ""}</span>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 && (
            <p className="px-3 py-3 text-[13px] leading-relaxed text-bone">No sessions yet.</p>
          )}
          {sessions.map((s) => {
            const active = s.id === activeId;
            return (
              <div
                key={s.id}
                className={`group flex items-stretch gap-2 rounded px-3 py-2 ${
                  active ? "bg-charcoal" : "hover:bg-charcoal/50"
                }`}
              >
                <span className={`w-0.5 rounded-full ${active ? "bg-ink" : "bg-transparent"}`} aria-hidden />
                <button onClick={() => onSelect(s.id)} className="min-w-0 flex-1 text-left" title={s.title}>
                  <div className={`truncate text-[14px] leading-tight ${active ? "text-ink" : "text-stone group-hover:text-ink"}`}>
                    {s.title || "untitled"}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-bone">{relTime(s.updated_at)} ago</div>
                </button>
                <button
                  onClick={() => onDelete(s.id)}
                  className="shrink-0 self-center px-1 font-mono text-xs text-bone opacity-0 transition hover:text-danger group-hover:opacity-100"
                  title="Delete session"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
