import type { AssistantPart } from "../types";
import { ToolCard } from "./ToolCard";
import { Markdown } from "./Markdown";
import { ImageGallery } from "./ImageAttachments";

/** Renders accumulated assistant parts: markdown text + terminal-style tool lines. */
export function PartsView({ parts, streaming }: { parts: AssistantPart[]; streaming?: boolean }) {
  const lastIdx = parts.length - 1;
  return (
    <>
      {parts.length === 0 && streaming && (
        <div className="cursor font-mono text-[13px] text-bone">thinking</div>
      )}
      {parts.map((part, i) => {
        const isLast = i === lastIdx && Boolean(streaming);
        if (part.kind === "thinking") {
          return (
            <div
              key={i}
              className={`my-1 border-l-2 border-iron pl-3 ${isLast ? "cursor" : ""}`}
            >
              <div className="eyebrow mb-1 flex items-center gap-1.5 text-cobalt">✦ thinking</div>
              <div className="prose-chat whitespace-pre-wrap text-[13px] italic leading-relaxed text-bone">
                {part.text}
              </div>
            </div>
          );
        }
        if (part.kind === "image") return <ImageGallery key={i} images={[part]} />;
        return part.kind === "text" ? (
          <div key={i} className={isLast ? "cursor" : ""}>
            <Markdown text={part.text} />
          </div>
        ) : (
          <ToolCard key={i} part={part} />
        );
      })}
    </>
  );
}
