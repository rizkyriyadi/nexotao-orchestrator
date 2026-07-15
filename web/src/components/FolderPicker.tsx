import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * A modal that browses the *host* filesystem (where the server runs) so the user
 * can click into a folder and pick it. The browser can't hand us an absolute
 * path, so we navigate server-side and return the selected absolute path.
 */
export function FolderPicker({
  initial,
  onPick,
  onClose,
}: {
  initial?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string>(initial || "");
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState<string>("");
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function browse(to?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.fsBrowse(to);
      setPath(r.path);
      setParent(r.parent);
      setHome(r.home);
      setDirs(r.dirs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    browse(initial || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-lg border border-line bg-charcoal shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="eyebrow">choose folder</span>
          <button onClick={onClose} className="ml-auto font-mono text-[12px] text-bone hover:text-ink">
            esc
          </button>
        </div>

        {/* current path + nav */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <button
            onClick={() => parent && browse(parent)}
            disabled={!parent || busy}
            title="Up one level"
            className="rounded border border-iron px-2 py-1 font-mono text-[12px] text-stone transition hover:border-ink hover:text-ink disabled:opacity-30"
          >
            ↑
          </button>
          <button
            onClick={() => browse(home)}
            disabled={busy}
            title="Home"
            className="rounded border border-iron px-2 py-1 font-mono text-[12px] text-stone transition hover:border-ink hover:text-ink disabled:opacity-40"
          >
            ⌂
          </button>
          <span className="truncate font-mono text-[12px] text-ink" dir="rtl" title={path}>
            {path}
          </span>
        </div>

        {/* folder list */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? (
            <p className="p-3 font-mono text-[12px] text-danger">⚠ {error}</p>
          ) : busy ? (
            <p className="p-3 font-mono text-[12px] text-bone">loading…</p>
          ) : dirs.length === 0 ? (
            <p className="p-3 font-mono text-[12px] text-bone">no sub-folders here — pick this folder below.</p>
          ) : (
            <ul className="space-y-0.5">
              {dirs.map((d) => (
                <li key={d.path}>
                  <button
                    onClick={() => browse(d.path)}
                    className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-stone transition hover:bg-iron/40 hover:text-ink"
                  >
                    <span className="font-mono text-bone">▸</span>
                    <span className="truncate">{d.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* footer: pick current */}
        <div className="border-t border-line px-4 py-3">
          <button
            onClick={() => onPick(path)}
            disabled={busy || !path}
            className="w-full rounded bg-ink py-2 text-[13px] font-medium text-ember transition hover:bg-linen disabled:opacity-30"
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
