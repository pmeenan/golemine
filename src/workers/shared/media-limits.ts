/**
 * Named byte/size budgets for attachment reads, previews, and thumbnails.
 * This module is intentionally tiny with no imports so UI code can import the
 * constants without pulling worker-only dependencies into app chunks.
 */

/** Default cap for a single source-file read when the caller sets no limit. */
export const defaultMaxReadBytes = 128 * 1024 * 1024;

/** Byte budget for inline image previews (full-size image fetch for viewing). */
export const previewImageMaxBytes = 32 * 1024 * 1024;

/** Byte budget for inline video previews. */
export const previewVideoMaxBytes = 128 * 1024 * 1024;

/** Default longest-edge pixel size for generated attachment thumbnails. */
export const defaultThumbnailMaxPixelSize = 512;

/**
 * Byte budget for user-initiated extraction (the user explicitly chose a
 * destination, so a much larger read is acceptable).
 */
export const extractMaxReadBytes = 1024 * 1024 * 1024;
