import { useState } from "react";
import type { AssistantPart } from "../types";

type ToolPart = Extract<AssistantPart, { kind: "tool" }>;

function summarize(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return input.command ?? "";
  if (name === "Read" || name === "Edit" || name === "Write") return input.file_path ?? "";
  if (name === "Glob" || name === "Grep") return input.pattern ?? "";
  if (name === "WebFetch" || name === "WebSearch") return input.url ?? input.query ?? "";
  if (name === "Task" || name === "Agent") return input.description ?? "";
  const firstStr = Object.values(input).find((v) => typeof v === "string");
  return (firstStr as string) ?? "";
}

/** A tool call rendered as an operator-log line; expandable for detail. */
export function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const summary = summarize(part.name, part.input);
  const running = part.result === undefined;

  const dot = running ? (
    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-prompt" />
  ) : part.isError ? (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
  ) : (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-bone" />
  );

  return (
    <div className="my-1 border-l border-iron pl-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2.5 py-1 text-left">
        {dot}
        <span className="font-mono text-[12px] text-ink">{part.name}</span>
        {summary && <span className="truncate font-mono text-[12px] text-cobalt">{summary}</span>}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-bone">
          {running ? "running" : part.isError ? <span className="text-danger">error</span> : open ? "hide" : "output"}
        </span>
      </button>

      {open && (
        <div className="mb-2 mt-1.5 space-y-2">
          <pre className="overflow-x-auto rounded border border-line-soft bg-onyx p-2.5 font-mono text-[12px] leading-relaxed text-stone">
            {JSON.stringify(part.input, null, 2)}
          </pre>
          {part.result !== undefined && (
            <pre
              className={`max-h-80 overflow-auto rounded border border-line-soft bg-onyx p-2.5 font-mono text-[12px] leading-relaxed ${
                part.isError ? "text-danger" : "text-stone"
              }`}
            >
              {part.result || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
