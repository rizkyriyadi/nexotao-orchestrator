import { useCallback, useState } from "react";
import type { ImageAttachment, ImageContent, ImageMediaType } from "../types";

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

const SUPPORTED = new Set<ImageMediaType>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function imageUrl(image: ImageContent): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

async function fileToAttachment(file: File): Promise<ImageAttachment> {
  if (!SUPPORTED.has(file.type as ImageMediaType)) throw new Error(`${file.name} is not a supported image`);
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} exceeds the 5 MB limit`);

  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

  return {
    id: crypto.randomUUID(),
    name: file.name || "pasted-image",
    mediaType: file.type as ImageMediaType,
    data: url.slice(url.indexOf(",") + 1),
    size: file.size,
  };
}

export function useImageAttachments() {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  const addFiles = useCallback(
    async (files: File[] | FileList) => {
      const selected = Array.from(files);
      if (selected.length === 0) return;
      const remaining = MAX_IMAGES - images.length;
      if (remaining <= 0 || selected.length > remaining) {
        setImageError(`You can attach up to ${MAX_IMAGES} images`);
        return;
      }
      try {
        const added = await Promise.all(selected.map(fileToAttachment));
        setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
        setImageError(null);
      } catch (err) {
        setImageError(err instanceof Error ? err.message : "Could not attach image");
      }
    },
    [images.length]
  );

  const removeImage = useCallback((id: string) => {
    setImages((current) => current.filter((image) => image.id !== id));
    setImageError(null);
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
    setImageError(null);
  }, []);

  return { images, imageError, addFiles, removeImage, clearImages };
}

export function pastedImages(data: DataTransfer): File[] {
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}
