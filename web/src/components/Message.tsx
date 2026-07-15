import type { ChatMessage } from "../types";
import { PartsView } from "./PartsView";
import { ImageGallery } from "./ImageAttachments";

export function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.content.map((p) => (p.kind === "text" ? p.text : "")).join("");
    const images = message.content.filter((p) => p.kind === "image");
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] border-r-2 border-iron pr-3.5">
          <ImageGallery images={images} />
          {text && <div className="prose-chat text-right font-mono text-[13px] text-stone">{text}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 shrink-0 select-none font-mono text-sm text-ink" aria-hidden>
        ◆
      </div>
      <div className="min-w-0 flex-1 pt-px">
        <PartsView parts={message.content} streaming={message.streaming} />
      </div>
    </div>
  );
}
