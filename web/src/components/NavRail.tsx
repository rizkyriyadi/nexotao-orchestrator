import { useState } from "react";
import type { Project } from "../types";

export type Page =
  | "dashboard"
  | "chat"
  | "orchestrate"
  | "tasks"
  | "agents"
  | "runs"
  | "files"
  | "settings"
  | "taskdetail";

const NAV: { id: Page; label: string; glyph: string }[] = [
  { id: "dashboard", label: "Dashboard", glyph: "▦" },
  { id: "chat", label: "Chat", glyph: "▤" },
  { id: "orchestrate", label: "Orchestrate", glyph: "⟐" },
  { id: "tasks", label: "Tasks", glyph: "☑" },
  { id: "agents", label: "Agents", glyph: "◈" },
  { id: "runs", label: "Runs", glyph: "≡" },
  { id: "files", label: "Files", glyph: "▢" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

export function NavRail({
  page,
  onPage,
  onLogout,
  open,
  onClose,
  projects,
  activeProjectId,
  onSwitchProject,
  onAddProject,
}: {
  page: Page;
  onPage: (p: Page) => void;
  onLogout: () => void;
  open: boolean;
  onClose: () => void;
  projects: Project[];
  activeProjectId: string | null;
  onSwitchProject: (id: string) => void;
  onAddProject: () => void;
}) {
  const [projOpen, setProjOpen] = useState(false);
  const active = projects.find((p) => p.id === activeProjectId);

  return (
    <>
      {open && <div className="fixed inset-0 z-20 bg-black/60 md:hidden" onClick={onClose} />}
      <nav
        className={`fixed z-30 flex h-full w-56 flex-col border-r border-line bg-onyx transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-baseline gap-2.5 px-5 pb-2 pt-4">
          <span className="font-mono text-sm text-ink">◆</span>
          <span className="heading text-[18px] text-ink">
            nexotao <span className="text-bone">orce</span>
          </span>
        </div>

        {/* Project switcher */}
        <div className="relative border-b border-line px-2 pb-2">
          <button
            onClick={() => setProjOpen((o) => !o)}
            className="flex w-full items-center gap-2 rounded border border-iron bg-charcoal px-3 py-2 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="eyebrow block">project</span>
              <span className="truncate text-[13px] text-ink">{active?.name ?? "—"}</span>
            </span>
            <span className="font-mono text-[11px] text-bone">{projOpen ? "▴" : "▾"}</span>
          </button>
          {projOpen && (
            <div className="absolute left-2 right-2 z-40 mt-1 overflow-hidden rounded border border-iron bg-charcoal shadow-xl">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setProjOpen(false);
                    if (p.id !== activeProjectId) onSwitchProject(p.id);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-iron ${
                    p.id === activeProjectId ? "text-ink" : "text-stone"
                  }`}
                  title={p.path}
                >
                  <span className={`h-1 w-1 rounded-full ${p.id === activeProjectId ? "bg-prompt" : "bg-transparent"}`} />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
              <button
                onClick={() => {
                  setProjOpen(false);
                  onAddProject();
                }}
                className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left font-mono text-[12px] text-bone transition hover:text-ink"
              >
                <span className="text-prompt">+</span> new project
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => {
            const active = page === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onPage(item.id);
                  onClose();
                }}
                className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left text-[14px] transition ${
                  active ? "bg-charcoal text-ink" : "text-stone hover:bg-charcoal/50 hover:text-ink"
                }`}
              >
                <span className={`w-4 text-center font-mono text-[13px] ${active ? "text-ink" : "text-bone"}`}>
                  {item.glyph}
                </span>
                {item.label}
              </button>
            );
          })}
        </div>

        <button
          onClick={onLogout}
          className="border-t border-line px-5 py-3 text-left text-[13px] text-bone transition hover:text-ink"
        >
          Sign out
        </button>
      </nav>
    </>
  );
}
