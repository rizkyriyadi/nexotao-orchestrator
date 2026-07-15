import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, streamChatAttach, type ServerInfo } from "./api";
import type { AssistantPart, ChatMessage, ImageAttachment, SessionMeta } from "./types";
import { Login } from "./components/Login";
import { SetPassword } from "./components/SetPassword";
import { NavRail, type Page } from "./components/NavRail";
import { SessionsPanel } from "./components/SessionsPanel";
import { Message } from "./components/Message";
import { Composer } from "./components/Composer";
import { Dashboard } from "./components/Dashboard";
import { Onboarding } from "./components/Onboarding";
import { SettingsPage } from "./components/SettingsPage";
import { OrceView } from "./components/orce/OrceView";
import type { Project } from "./types";
import { TasksPage } from "./components/orce/TasksPage";
import { TaskDetailPage } from "./components/orce/TaskDetailPage";
import { FilesPage } from "./components/FilesPage";

interface TurnStat {
  costUsd?: number;
  durationMs?: number;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [lastTurn, setLastTurn] = useState<TurnStat | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [page, setPage] = useState<Page>("dashboard");
  const [taskRef, setTaskRef] = useState<{ runId: string; taskId: string } | null>(null);
  const [taskFrom, setTaskFrom] = useState<Page>("tasks");
  const [projects, setProjects] = useState<Project[]>([]);
  const [addProject, setAddProject] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      // First-run? Show the create-password screen before anything else.
      const status = await api.authStatus().catch(() => ({ needsSetup: false }));
      if (status.needsSetup) {
        setNeedsSetup(true);
        setAuthed(false);
        return;
      }
      const i = await api.info();
      setInfo(i);
      setAuthed(Boolean(i));
    })();
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch {
      /* not authed */
    }
  }, []);

  useEffect(() => {
    if (authed && !info?.needsOnboarding) api.listProjects().then((r) => setProjects(r.projects)).catch(() => {});
  }, [authed, info]);

  async function switchProject(id: string) {
    await api.activateProject(id);
    window.location.reload();
  }

  useEffect(() => {
    if (authed) refreshSessions();
  }, [authed, refreshSessions]);

  // Remember the current session so a refresh can reopen + reconnect to it.
  useEffect(() => {
    if (activeId) localStorage.setItem("orce.activeSession", activeId);
  }, [activeId]);

  // On load, if the last session has a turn still running in the background,
  // reopen it and re-attach to the live stream.
  useEffect(() => {
    if (!authed || info?.needsOnboarding) return;
    const saved = localStorage.getItem("orce.activeSession");
    if (!saved) return;
    (async () => {
      try {
        const { messages, streaming } = await api.getMessages(saved);
        if (streaming) {
          setActiveId(saved);
          setMessages(messages);
          setPage("chat");
          reconnectChat(saved);
        }
      } catch {
        localStorage.removeItem("orce.activeSession");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, info?.needsOnboarding]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function onAuthed() {
    const i = await api.info();
    setInfo(i);
    setAuthed(true);
  }

  async function selectSession(id: string) {
    setActiveId(id);
    setSessionsOpen(false);
    setLastTurn(null);
    setPage("chat");
    const { messages, streaming } = await api.getMessages(id);
    setMessages(messages);
    // If a turn is still running in the background, re-attach to it.
    if (streaming) reconnectChat(id);
  }

  function newChat() {
    setActiveId(null);
    localStorage.removeItem("orce.activeSession");
    setMessages([]);
    setLastTurn(null);
    setSessionsOpen(false);
    setPage("chat");
  }

  async function deleteSession(id: string) {
    await api.deleteSession(id);
    if (id === activeId) newChat();
    refreshSessions();
  }

  async function logout() {
    await api.logout();
    localStorage.removeItem("orce.activeSession");
    setAuthed(false);
    setInfo(null);
    setSessions([]);
    setMessages([]);
    setActiveId(null);
  }

  function patchAssistant(fn: (parts: AssistantPart[]) => void) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") return prev;
      const parts = [...last.content];
      fn(parts);
      next[next.length - 1] = { ...last, content: parts };
      return next;
    });
  }

  function applyChatEvent(ev: any) {
    switch (ev.type) {
      case "text_delta":
      case "thinking_delta":
        patchAssistant((parts) => {
          const last = parts[parts.length - 1];
          if (last && last.kind === "text") last.text += ev.text;
          else parts.push({ kind: "text", text: ev.text });
        });
        break;
      case "tool_use":
        patchAssistant((parts) => {
          parts.push({ kind: "tool", id: ev.id, name: ev.name, input: ev.input });
        });
        break;
      case "tool_result":
        patchAssistant((parts) => {
          const t = [...parts]
            .reverse()
            .find((p) => p.kind === "tool" && p.id === ev.toolUseId) as
            | Extract<AssistantPart, { kind: "tool" }>
            | undefined;
          if (t) {
            t.result = ev.content;
            t.isError = ev.isError;
          }
        });
        break;
      case "result":
        setLastTurn({ costUsd: ev.costUsd, durationMs: ev.durationMs });
        break;
      case "error":
        patchAssistant((parts) => {
          parts.push({ kind: "text", text: `\n\n⚠ ${ev.message}` });
        });
        break;
      case "done":
        if (!activeId) setActiveId(ev.dbSessionId);
        break;
    }
  }

  // Shared stream lifecycle for a live turn OR a reconnected background turn.
  async function runChatStream(fn: (onEvent: (ev: any) => void, signal: AbortSignal) => Promise<void>) {
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await fn(applyChatEvent, ac.signal);
    } catch (err) {
      patchAssistant((parts) => {
        parts.push({ kind: "text", text: `\n\n⚠ ${err instanceof Error ? err.message : err}` });
      });
    } finally {
      setStreaming(false);
      abortRef.current = null;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = { ...last, streaming: false };
        return next;
      });
      refreshSessions();
    }
  }

  async function send(text: string, images: ImageAttachment[]) {
    if (streaming) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: [
        ...(text ? [{ kind: "text" as const, text }] : []),
        ...images.map(({ mediaType, data, name }) => ({ kind: "image" as const, mediaType, data, name })),
      ],
    };
    const assistantMsg: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: [], streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setLastTurn(null);
    await runChatStream((onEvent, signal) => streamChat(activeId, text, images, onEvent, signal));
  }

  // Re-attach to a turn still running in the background (after a refresh).
  function reconnectChat(sessionId: string) {
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: [], streaming: true }]);
    setLastTurn(null);
    void runChatStream((onEvent, signal) => streamChatAttach(sessionId, onEvent, signal));
  }

  function stop() {
    if (activeId) api.stopChat(activeId).catch(() => {});
    abortRef.current?.abort();
  }

  function openTaskDetail(runId: string, taskId: string) {
    setTaskRef({ runId, taskId });
    setTaskFrom((p) => (p === "taskdetail" ? taskFrom : p));
    setPage("taskdetail");
  }

  if (authed === null) {
    return (
      <div className="flex h-full items-center justify-center bg-ember">
        <span className="cursor font-mono text-xs text-bone">connecting</span>
      </div>
    );
  }
  if (needsSetup) return <SetPassword onDone={() => window.location.reload()} />;
  if (!authed) return <Login onSuccess={onAuthed} />;
  if (info?.needsOnboarding) return <Onboarding onDone={() => window.location.reload()} />;

  const isOrce = page === "orchestrate" || page === "agents" || page === "runs";

  return (
    <div className="flex h-full bg-ember">
      {info?.dangerousMode && (
        <div className="fixed inset-x-0 top-0 z-[100] border-b border-danger bg-onyx px-3 py-1.5 text-center font-mono text-[11px] text-danger">
          DANGEROUS MODE ACKNOWLEDGED · agents may execute arbitrary commands
        </div>
      )}
      {addProject && (
        <div className="fixed inset-0 z-50 bg-ember">
          <Onboarding mode="add" onDone={() => window.location.reload()} onCancel={() => setAddProject(false)} />
        </div>
      )}
      <NavRail
        page={page}
        onPage={setPage}
        onLogout={logout}
        open={navOpen}
        onClose={() => setNavOpen(false)}
        projects={projects}
        activeProjectId={info?.project?.id ?? null}
        onSwitchProject={switchProject}
        onAddProject={() => setAddProject(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          page={page}
          info={info}
          streaming={streaming}
          lastTurn={lastTurn}
          onMenu={() => setNavOpen(true)}
          onSessions={page === "chat" ? () => setSessionsOpen(true) : undefined}
        />

        {page === "chat" ? (
          <div className="flex min-h-0 flex-1">
            <SessionsPanel
              sessions={sessions}
              activeId={activeId}
              open={sessionsOpen}
              onSelect={selectSession}
              onNew={newChat}
              onDelete={deleteSession}
              onClose={() => setSessionsOpen(false)}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-8">
                  {messages.length === 0 ? (
                    <Welcome info={info} />
                  ) : (
                    messages.map((m) => <Message key={m.id} message={m} />)
                  )}
                </div>
              </div>
              <Composer onSend={send} onStop={stop} streaming={streaming} />
            </div>
          </div>
        ) : page === "files" ? (
          <div className="min-h-0 flex-1">
            <FilesPage />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {page === "dashboard" ? (
              <Dashboard
                sessions={sessions}
                onNewChat={newChat}
                onOrchestrate={() => setPage("orchestrate")}
                onSelect={selectSession}
              />
            ) : page === "settings" ? (
              <SettingsPage />
            ) : page === "tasks" ? (
              <TasksPage onOpenTask={openTaskDetail} />
            ) : page === "taskdetail" && taskRef ? (
              <TaskDetailPage
                runId={taskRef.runId}
                taskId={taskRef.taskId}
                onBack={() => setPage(taskFrom)}
                onOpenTask={openTaskDetail}
              />
            ) : (
              isOrce && <OrceView view={page} onNavigate={setPage} onOpenTask={openTaskDetail} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

/* --- Instrument readout: the signature element --- */
const PAGE_TITLE: Record<Page, string> = {
  dashboard: "Dashboard",
  chat: "Chat",
  orchestrate: "Orchestrate",
  tasks: "Tasks",
  agents: "Agents",
  runs: "Runs",
  files: "Files",
  settings: "Settings",
  taskdetail: "Task",
};

function TopBar({
  page,
  info,
  streaming,
  lastTurn,
  onMenu,
  onSessions,
}: {
  page: Page;
  info: ServerInfo | null;
  streaming: boolean;
  lastTurn: TurnStat | null;
  onMenu: () => void;
  onSessions?: () => void;
}) {
  const cwd = info ? shortenPath(info.cwd) : "—";
  return (
    <header className="flex items-center gap-3 border-b border-line bg-ember px-4 py-2.5">
      <button
        onClick={onMenu}
        className="rounded border border-iron px-2 py-0.5 font-mono text-xs text-stone md:hidden"
        aria-label="Open navigation"
      >
        ≡
      </button>

      <span className="text-[15px] text-ink">{PAGE_TITLE[page]}</span>

      {onSessions && (
        <button
          onClick={onSessions}
          className="rounded border border-iron px-2 py-0.5 font-mono text-[11px] text-stone md:hidden"
        >
          sessions
        </button>
      )}

      <div className="ml-3 flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${streaming ? "animate-pulse bg-prompt" : "bg-bone"}`} />
        <span className="eyebrow">{streaming ? "working" : "idle"}</span>
      </div>

      <span className="hidden font-mono text-[12px] text-stone lg:inline" title={info?.cwd}>
        {cwd}
      </span>

      <div className="ml-auto flex items-center gap-4">
        {info && (
          <span className="hidden font-mono text-[11px] text-bone sm:inline">{info.permissionMode}</span>
        )}
        {lastTurn?.costUsd != null && (
          <span className="font-mono text-[11px] text-bone" title="last turn cost">
            ${lastTurn.costUsd.toFixed(4)}
          </span>
        )}
      </div>
    </header>
  );
}

function OrchWelcome() {
  return (
    <div className="mt-6 rounded-lg border border-line bg-charcoal">
      <div className="border-b border-line px-5 py-3">
        <span className="eyebrow">orchestration · fan-out → synthesize</span>
      </div>
      <div className="px-5 py-5">
        <p className="max-w-xl text-[15px] leading-relaxed text-stone">
          Give one task and watch <span className="text-ink">3 agents run in parallel</span>, each
          through a different lens — <span className="text-ink">direct</span>,{" "}
          <span className="text-ink">risks</span>, <span className="text-ink">alternatives</span>. When
          all finish, a <span className="text-ink">synthesizer</span> reconciles them into one answer.
          The structure is fixed in code — that’s orchestration, not a single agent improvising.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {["should I use SQLite or Postgres here?", "review this architecture", "how to scale this to 10k users?"].map(
            (s) => (
              <span key={s} className="rounded border border-line-soft px-2.5 py-1 font-mono text-[12px] text-bone">
                › {s}
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function Welcome({ info }: { info: ServerInfo | null }) {
  return (
    <div className="mt-10 rounded-lg border border-line bg-charcoal">
      <div className="border-b border-line px-5 py-3">
        <span className="eyebrow">session ready</span>
      </div>
      <div className="px-5 py-5">
        <p className="max-w-md text-[15px] leading-relaxed text-stone">
          Your agent is standing by
          {info ? (
            <>
              {" "}
              in <span className="font-mono text-[13px] text-gold">{shortenPath(info.cwd)}</span>
            </>
          ) : null}
          . Instruct it to write code, run commands, or explore a repo — every operation it runs is
          logged below.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {["read the repo and summarize it", "run the tests", "scaffold a new endpoint"].map((s) => (
            <span key={s} className="rounded border border-line-soft px-2.5 py-1 font-mono text-[12px] text-bone">
              › {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return "/" + parts.join("/");
  return "…/" + parts.slice(-2).join("/");
}
