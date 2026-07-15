import { useRef } from "react";
import type { ImageAttachment, ImageContent } from "../types";
import { IMAGE_ACCEPT, imageUrl } from "../lib/images";

export function ImageGallery({ images, compact = false }: { images: ImageContent[]; compact?: boolean }) {
  if (images.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${compact ? "mt-2" : "mb-2 justify-end"}`}>
      {images.map((image, index) => (
        <a
          key={`${image.name ?? "image"}-${index}`}
          href={imageUrl(image)}
          target="_blank"
          rel="noreferrer"
          title={image.name || `Image ${index + 1}`}
          className="block overflow-hidden rounded-md border border-iron bg-onyx transition hover:border-stone"
        >
          <img
            src={imageUrl(image)}
            alt={image.name || `Attached image ${index + 1}`}
            className={compact ? "h-16 w-20 object-cover" : "max-h-64 max-w-full object-contain sm:max-w-sm"}
          />
        </a>
      ))}
    </div>
  );
}
export function AttachmentTray({
  images,
  onRemove,
}: {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-b border-line-soft px-4 py-3">
      {images.map((image) => (
        <div key={image.id} className="group relative overflow-hidden rounded-md border border-iron bg-onyx">
          <img src={imageUrl(image)} alt={image.name} className="h-16 w-20 object-cover" />
          <button
            type="button"
            onClick={() => onRemove(image.id)}
            aria-label={`Remove ${image.name}`}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/75 font-mono text-[12px] text-ink opacity-80 transition hover:bg-danger group-hover:opacity-100"
          >
            ×
          </button>
          <span className="absolute inset-x-0 bottom-0 truncate bg-black/70 px-1 py-0.5 font-mono text-[9px] text-stone">
            {image.name}
          </span>
        </div>
      ))}
    </div>
  );
}

export function AttachImageButton({
  onFiles,
  disabled,
  withLabel = false,
}: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
  withLabel?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) onFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="flex shrink-0 items-center gap-1.5 rounded border border-transparent p-1.5 font-mono text-[11px] text-bone transition hover:border-iron hover:text-ink disabled:opacity-30"
        title="Attach images (JPG, PNG, GIF, or WebP)"
        aria-label="Attach images"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M20.5 11.5 12 20a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.6l-9 9a2 2 0 1 1-2.9-2.8l8.4-8.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        {withLabel && <span>image</span>}
      </button>
    </>
  );
}
