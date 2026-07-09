/**
 * MIME classification for attachment media shared by db-worker media-kind
 * mapping (queries.ts) and the media-worker thumbnail pipeline
 * (thumbnails.ts). Values must stay lowercase; callers normalize the
 * candidate MIME with normalizeMimeType below before testing membership so
 * both workers classify identical inputs identically.
 */

/**
 * Normalizes a raw MIME value to its lowercase base type for membership
 * checks against the sets below: strips any ";parameter" suffix, trims
 * whitespace, and lowercases. Returns "" for missing/blank input.
 */
export function normalizeMimeType(value: string | undefined): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Image MIME types the media worker can decode natively with createImageBitmap. */
export const nativeImageMimeTypes: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** HEIC/HEIF MIME types routed to the isolated libheif decoder path. */
export const heicMimeTypes: ReadonlySet<string> = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);
