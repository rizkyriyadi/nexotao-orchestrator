import { useEffect, useState } from "react";
import { api } from "../api";
import type { FsFile, FsList } from "../types";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesPage() {
  const [path, setPath] = useState("");
  const [list, setList] = useState<FsList | null>(null);
  const [file, setFile] = useState<FsFile | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api
      .fsList(path)
      .then(setList)
      .catch((e) => setError(String(e)));
  }, [path]);

  function openDir(name: string) {
    setFile(null);
    setPath(path ? `${path}/${name}` : name);
  }

  async function openFile(name: string) {
    const fp = path ? `${path}/${name}` : name;
    setLoadingFile(true);
    try {
      setFile(await api.fsRead(fp));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingFile(false);
    }
  }

  const segments = path ? path.split("/") : [];

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-5 py-6">
      <div className="mb-4 flex items-center justify-between border-b border-line pb-2">
        <span className="heading text-[19px] text-ink">Files</span>
        <span className="eyebrow">agent workspace</span>
      </div>

      {/* Breadcrumb */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 font-mono text-[12px]">
        <button onClick={() => { setFile(null); setPath(""); }} className="text-cobalt hover:text-ink">
          workspace
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-bone">/</span>
            <button
              onClick={() => {
                setFile(null);
                setPath(segments.slice(0, i + 1).join("/"));
              }}
              className="text-cobalt hover:text-ink"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {error && <p className="mb-3 font-mono text-[12px] text-danger">⚠ {error}</p>}

      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,320px)_1fr]">
        {/* Directory listing */}
        <div className="min-h-0 overflow-y-auto rounded-lg border border-line bg-charcoal">
          {list?.items.length === 0 && <p className="px-4 py-4 text-[13px] text-bone">Empty directory.</p>}
          {list?.items.map((e) => (
            <button
              key={e.name}
              onClick={() => (e.type === "dir" ? openDir(e.name) : openFile(e.name))}
              className="flex w-full items-center gap-2.5 border-b border-line-soft px-4 py-2 text-left transition last:border-b-0 hover:bg-iron/40"
            >
              <span className={`font-mono text-[13px] ${e.type === "dir" ? "text-cobalt" : "text-bone"}`}>
                {e.type === "dir" ? "▸" : "·"}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[13px] ${e.type === "dir" ? "text-ink" : "text-stone"}`}>
                {e.name}
                {e.type === "dir" ? "/" : ""}
              </span>
              {e.type === "file" && <span className="shrink-0 font-mono text-[10px] text-bone">{fmtSize(e.size)}</span>}
            </button>
          ))}
        </div>

        {/* File preview */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-charcoal">
          {!file ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-bone">
              {loadingFile ? "loading…" : "Select a file to preview its contents."}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-gold">{file.path}</span>
                <span className="shrink-0 font-mono text-[10px] text-bone">{fmtSize(file.size)}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {file.binary ? (
                  <p className="p-4 font-mono text-[12px] text-bone">Binary file — no preview.</p>
                ) : file.truncated ? (
                  <p className="p-4 font-mono text-[12px] text-bone">{file.note}</p>
                ) : (
                  <pre className="p-4 font-mono text-[12px] leading-relaxed text-stone">{file.content}</pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
