import { Fragment, type ReactNode } from "react";

/**
 * Tiny dependency-free markdown renderer. Code is a terminal context, so the
 * chromatic accents (gold strings, cobalt language tag) are allowed here.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = splitFences(text);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <pre
            key={i}
            className="overflow-x-auto rounded border border-line-soft bg-onyx p-3 font-mono text-[12.5px] leading-relaxed text-stone"
          >
            {b.lang && <span className="mb-1 block text-[10px] uppercase tracking-widest text-cobalt">{b.lang}</span>}
            {b.content}
          </pre>
        ) : (
          <Prose key={i} text={b.content} />
        )
      )}
    </div>
  );
}

type Block = { type: "code"; content: string; lang?: string } | { type: "text"; content: string };

function splitFences(text: string): Block[] {
  const out: Block[] = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", content: text.slice(last, m.index) });
    out.push({ type: "code", content: m[2].replace(/\n$/, ""), lang: m[1] || undefined });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: "text", content: text.slice(last) });
  return out.filter((b) => b.content.trim().length > 0);
}

function Prose({ text }: { text: string }) {
  const lines = text.replace(/^\n+|\n+$/g, "").split("\n");
  return (
    <div className="prose-chat text-[15px] text-ink">
      {lines.map((line, i) => {
        const h = line.match(/^(#{1,3})\s+(.*)$/);
        if (h) {
          return (
            <div key={i} className="heading mt-1 text-[16px] text-ink">
              {inline(h[2])}
            </div>
          );
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <div key={i} className="flex gap-2">
              <span className="select-none text-bone">–</span>
              <span>{inline(bullet[1])}</span>
            </div>
          );
        }
        return <div key={i}>{line ? inline(line) : " "}</div>;
      })}
    </div>
  );
}

/** Inline: `code` (gold) and **bold**. */
function inline(s: string): ReactNode {
  const parts = s.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded-sm border border-line-soft bg-onyx px-1 py-px font-mono text-[13px] text-gold"
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    const bold = p.split(/(\*\*[^*]+\*\*)/g);
    return (
      <Fragment key={i}>
        {bold.map((b, j) =>
          b.startsWith("**") && b.endsWith("**") ? (
            <strong key={j} className="font-semibold text-ink">
              {b.slice(2, -2)}
            </strong>
          ) : (
            // italic (single *…*) within non-bold runs
            <Fragment key={j}>
              {b.split(/(\*[^*]+\*)/g).map((it, k) =>
                it.startsWith("*") && it.endsWith("*") && it.length > 2 ? (
                  <em key={k} className="italic text-stone">
                    {it.slice(1, -1)}
                  </em>
                ) : (
                  <Fragment key={k}>{it}</Fragment>
                )
              )}
            </Fragment>
          )
        )}
      </Fragment>
    );
  });
}
