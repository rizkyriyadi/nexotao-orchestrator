import { useRef, useState } from "react";
import type { ImageAttachment } from "../types";
import { pastedImages, useImageAttachments } from "../lib/images";
import { AttachImageButton, AttachmentTray } from "./ImageAttachments";

export function Composer({
  onSend,
  onStop,
  streaming,
  placeholder = "instruct the agent…",
  runLabel = "Run",
}: {
  onSend: (text: string, images: ImageAttachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  placeholder?: string;
  runLabel?: string;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { images, imageError, addFiles, removeImage, clearImages } = useImageAttachments();

  function send() {
    const t = text.trim();
    if ((!t && images.length === 0) || streaming) return;
    onSend(t, images);
    setText("");
    clearImages();
    if (ref.current) ref.current.style.height = "auto";
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function autoGrow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  return (
    <div className="border-t border-line bg-ember px-4 py-4">
      <div
        className={`mx-auto max-w-3xl overflow-hidden rounded-lg border bg-charcoal transition-shadow ${
          focused || dragging ? "signature-glow" : "border-iron"
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        <AttachmentTray images={images} onRemove={removeImage} />
        <div className="flex items-end gap-2 px-3 py-2.5">
          <span className="select-none py-1.5 font-mono text-sm text-prompt">›</span>
          <textarea
            ref={ref}
            value={text}
            rows={1}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onPaste={(event) => {
              const files = pastedImages(event.clipboardData);
              if (files.length) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="max-h-52 flex-1 resize-none bg-transparent py-1 font-mono text-[14px] text-ink outline-none placeholder:text-bone"
          />
          {!streaming && <AttachImageButton onFiles={(files) => void addFiles(files)} />}
          {streaming ? (
            <button
              onClick={onStop}
              className="shrink-0 rounded border border-iron px-3 py-1.5 text-[13px] text-stone transition hover:border-danger hover:text-danger"
              title="Stop the agent"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!text.trim() && images.length === 0}
              className="shrink-0 rounded bg-ink px-4 py-1.5 text-[14px] font-medium text-ember transition hover:bg-linen disabled:opacity-25"
              title="Send (Enter)"
            >
              {runLabel}
            </button>
          )}
        </div>
      </div>
      <div className="mx-auto mt-2 max-w-3xl">
        <span className={imageError ? "font-mono text-[11px] text-danger" : "eyebrow"}>
          {imageError || "enter to send · shift+enter for newline · paste or drop images"}
        </span>
      </div>
    </div>
  );
}
