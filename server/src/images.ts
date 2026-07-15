export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface ImageInput {
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Validate untrusted JSON image input before it reaches storage or the model. */
export function parseImageInputs(value: unknown): ImageInput[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("images must be an array");
  if (value.length > MAX_IMAGES) throw new Error(`attach at most ${MAX_IMAGES} images`);

  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`image ${index + 1} is invalid`);
    const item = raw as Record<string, unknown>;
    const mediaType = String(item.mediaType ?? "");
    if (!IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType)) {
      throw new Error(`image ${index + 1} must be JPG, PNG, GIF, or WebP`);
    }

    const data = String(item.data ?? "").replace(/\s/g, "");
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error(`image ${index + 1} has invalid base64 data`);
    }
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const byteLength = Math.floor((data.length * 3) / 4) - padding;
    if (byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`image ${index + 1} exceeds the 5 MB limit`);
    }

    const name = typeof item.name === "string" ? item.name.trim().slice(0, 160) : "";
    return { mediaType: mediaType as ImageMediaType, data, ...(name ? { name } : {}) };
  });
}
