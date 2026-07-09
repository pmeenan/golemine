import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
} from "../../lib/recents";
import {
  toWorkerError,
  workerFail,
  workerOk,
  type AttachmentThumbnailOkResponse,
  type CreateAttachmentThumbnailRequest,
  type CreateAttachmentThumbnailResponse,
  type GetCachedAttachmentThumbnailRequest,
  type GetCachedAttachmentThumbnailResponse,
  type WorkerProgressCallback,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import { isObjectRecord } from "../shared/guards";
import { stableHash } from "../shared/hash";
import { defaultThumbnailMaxPixelSize } from "../shared/media-limits";
import { nativeImageMimeTypes, normalizeMimeType } from "../shared/media-mime";
import { getOpfsBackupDirectoryHandle, hasOpfsStorage } from "../shared/opfs";
import { emitWorkerProgress } from "../shared/progress";

const attachmentThumbsDirectoryName = "attachments";
const thumbsDirectoryName = "thumbs";
const thumbnailMime = "image/jpeg";
const thumbnailExtension = "jpg";
const thumbnailJpegQuality = 0.86;
const thumbnailJpegBackground = "#fff";
const maxSafeSegmentLength = 80;
const rgbaBytesPerPixel = 4;
const maxHeicDecodedRgbaBytes = 256 * 1024 * 1024;
const maxHeicDecodedPixels = maxHeicDecodedRgbaBytes / rgbaBytesPerPixel;
const maxHeicThumbnailCandidates = 16;
const heifErrorStructBytes = 16;
const pointerBytes = 4;
const libheifModuleUrl =
  "/vendor/libheif-js/1.19.8/libheif-wasm/libheif-bundle.mjs";

interface LibHeifModule {
  HeifDecoder: new () => LibHeifDecoder;
  HeifImage?: new (handle: unknown) => HeifImage;
  HEAP32?: Int32Array;
  HEAPU32?: Uint32Array;
  _free?: (pointer: number) => void;
  _malloc?: (bytes: number) => number;
  heif_image_handle_get_list_of_thumbnail_IDs?: (
    handle: unknown,
    idsPointer: number,
    count: number,
  ) => number;
  heif_image_handle_get_number_of_thumbnails?: (handle: unknown) => number;
  heif_image_handle_get_thumbnail?: (
    errorPointer: number,
    handle: unknown,
    thumbnailId: number,
    outHandlePointer: number,
  ) => void;
  heif_context_free?: (context: unknown) => void;
  heif_image_handle_release?: (handle: unknown) => void;
}

interface LibHeifDecoder {
  decode(bytes: Uint8Array): HeifImage[];
  decoder?: unknown;
}

interface HeifImage {
  free?(): void;
  display(
    imageData: ImageData,
    callback: (displayData: unknown) => void,
  ): void;
  get_height(): number;
  get_width(): number;
  handle?: unknown;
}

interface ThumbnailDimensions {
  width: number;
  height: number;
}

interface HeifThumbnailCandidate extends ThumbnailDimensions {
  image: HeifImage;
}

type LibHeifFactory = () => unknown;

interface DevPublicModuleLoader {
  createObjectURL(blob: Blob): string;
  fetchModule(moduleUrl: string, init: RequestInit): Promise<Response>;
  importModule(moduleUrl: string): Promise<unknown>;
  revokeObjectURL(moduleUrl: string): void;
}

let libheifPromise: Promise<LibHeifModule> | undefined;
let thumbnailGenerationTail: Promise<void> = Promise.resolve();

const defaultDevPublicModuleLoader: DevPublicModuleLoader = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  fetchModule: (moduleUrl, init) => fetch(moduleUrl, init),
  importModule: (moduleUrl) => import(/* @vite-ignore */ moduleUrl),
  revokeObjectURL: (moduleUrl) => {
    URL.revokeObjectURL(moduleUrl);
  },
};

class MediaThumbnailError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, WorkerStructuredValue>,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MediaThumbnailError";
  }
}

export function createAttachmentThumbnail(
  request: CreateAttachmentThumbnailRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<CreateAttachmentThumbnailResponse>> {
  return runThumbnailGenerationSerially(() =>
    createAttachmentThumbnailNow(request, progress),
  );
}

async function createAttachmentThumbnailNow(
  request: CreateAttachmentThumbnailRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<CreateAttachmentThumbnailResponse>> {
  try {
    await emitWorkerProgress(
      "media",
      progress,
      "starting",
      "Starting attachment thumbnail",
      0,
      4,
    );

    const unsupported = getUnsupportedThumbnailResponse(request);

    if (unsupported !== undefined) {
      return workerOk(unsupported);
    }

    const maxPixelSize = normalizeMaxPixelSize(request.maxPixelSize);

    if (!hasOpfsStorage()) {
      return workerOk(
        unsupportedResponse(
          request,
          "unsupported-environment",
          "OPFS is not available in this runtime, so attachment thumbnails cannot be cached.",
        ),
      );
    }

    const cachePath = getAttachmentThumbnailCachePath(request);
    const directory = await getAttachmentThumbsDirectory(
      cachePath.safeBackupId,
      true,
    );
    const cached = await readCachedThumbnail(directory, cachePath.fileName);

    if (cached !== undefined) {
      await emitWorkerProgress(
        "media",
        progress,
        "complete",
        "Attachment thumbnail cache hit",
        4,
        4,
      );

      return workerOk(
        cachedThumbnailResponse(request, cachePath.opfsPath, cached),
      );
    }

    if (!hasCanvasThumbnailSupport()) {
      return workerOk(
        unsupportedResponse(
          request,
          "unsupported-environment",
          "This worker runtime cannot decode native images with OffscreenCanvas.",
        ),
      );
    }

    await emitWorkerProgress(
      "media",
      progress,
      "decoding",
      "Decoding attachment image",
      1,
      4,
    );
    const thumbnail = await renderNativeImageThumbnail(request, maxPixelSize);

    await emitWorkerProgress(
      "media",
      progress,
      "writing",
      "Caching attachment thumbnail",
      3,
      4,
    );
    await writeCachedThumbnail(directory, cachePath.fileName, thumbnail.bytes);

    await emitWorkerProgress(
      "media",
      progress,
      "complete",
      "Attachment thumbnail complete",
      4,
      4,
    );

    return workerOk({
      ...cachedThumbnailResponse(request, cachePath.opfsPath, thumbnail),
      cacheHit: false,
    });
  } catch (cause) {
    return workerFail<CreateAttachmentThumbnailResponse>(
      toWorkerError({
        worker: "media",
        code: "worker_failed",
        message: "Attachment thumbnail generation failed.",
        recoverable: true,
        cause,
        details:
          cause instanceof MediaThumbnailError ? cause.details : undefined,
      }),
    );
  }
}

export async function getCachedAttachmentThumbnail(
  request: GetCachedAttachmentThumbnailRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<GetCachedAttachmentThumbnailResponse>> {
  try {
    await emitWorkerProgress(
      "media",
      progress,
      "starting",
      "Checking attachment thumbnail cache",
      0,
      1,
    );

    if (!isThumbnailCacheableMediaKind(request.mediaKind)) {
      return workerOk({
        status: "miss",
        backupId: request.backupId,
        cacheHit: false,
        cacheKey: request.cacheKey,
        mediaKind: request.mediaKind,
      });
    }

    if (!hasOpfsStorage()) {
      return workerOk({
        status: "miss",
        backupId: request.backupId,
        cacheHit: false,
        cacheKey: request.cacheKey,
        mediaKind: request.mediaKind,
      });
    }

    const cachePath = getAttachmentThumbnailCachePath(request);
    const directory = await getAttachmentThumbsDirectory(
      cachePath.safeBackupId,
      false,
    );
    const cached = await readCachedThumbnail(directory, cachePath.fileName);

    await emitWorkerProgress(
      "media",
      progress,
      "complete",
      cached === undefined
        ? "Attachment thumbnail cache miss"
        : "Attachment thumbnail cache hit",
      1,
      1,
    );

    return workerOk(
      cached === undefined
        ? {
            status: "miss",
            backupId: request.backupId,
            cacheHit: false,
            cacheKey: request.cacheKey,
            mediaKind: request.mediaKind,
          }
        : cachedThumbnailResponse(request, cachePath.opfsPath, cached),
    );
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return workerOk({
        status: "miss",
        backupId: request.backupId,
        cacheHit: false,
        cacheKey: request.cacheKey,
        mediaKind: request.mediaKind,
      });
    }

    return workerFail<GetCachedAttachmentThumbnailResponse>(
      toWorkerError({
        worker: "media",
        code: "worker_failed",
        message: "Attachment thumbnail cache lookup failed.",
        recoverable: true,
        cause,
      }),
    );
  }
}

export function getAttachmentThumbnailCachePath(request: {
  backupId: string;
  cacheKey: string;
}): {
  safeBackupId: string;
  safeCacheKey: string;
  fileName: string;
  opfsPath: string;
} {
  const safeBackupId = assertSafeBackupPathSegment(request.backupId);
  const safeCacheKey = sanitizeThumbnailPathSegment(request.cacheKey, "attachment");
  const fileName = `${safeCacheKey}.${thumbnailExtension}`;

  return {
    safeBackupId,
    safeCacheKey,
    fileName,
    opfsPath: [
      derivedDataOpfsAppDirectoryName,
      derivedDataOpfsBackupsDirectoryName,
      safeBackupId,
      thumbsDirectoryName,
      attachmentThumbsDirectoryName,
      fileName,
    ].join("/"),
  };
}

function cachedThumbnailResponse(
  request: {
    backupId: string;
    cacheKey: string;
    mediaKind: CreateAttachmentThumbnailRequest["mediaKind"];
  },
  opfsPath: string,
  thumbnail: ThumbnailDimensions & { bytes: Uint8Array },
): AttachmentThumbnailOkResponse {
  return {
    status: "ok",
    backupId: request.backupId,
    cacheHit: true,
    cacheKey: request.cacheKey,
    bytes: thumbnail.bytes,
    height: thumbnail.height,
    mediaKind: request.mediaKind,
    mime: thumbnailMime,
    opfsPath,
    width: thumbnail.width,
  };
}

export function sanitizeThumbnailPathSegment(
  value: string,
  fallback: string,
): string {
  const trimmed = value.trim();
  const replaced = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/[-.]{2,}/gu, "-")
    .replace(/^[-._]+|[-._]+$/gu, "");
  const hash = stableHash(trimmed);
  const base = replaced.length === 0 ? fallback : replaced;
  const limited = base.slice(0, maxSafeSegmentLength);
  const candidate = trimmed === replaced && limited === replaced
    ? limited
    : `${limited}-${hash}`;

  return candidate.length === 0 ? `${fallback}-${hash}` : candidate;
}

function assertSafeBackupPathSegment(value: string): string {
  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new MediaThumbnailError(
      "Attachment thumbnail backup id is not a safe OPFS path segment.",
    );
  }

  return trimmed;
}

export function getUnsupportedThumbnailResponse(
  request: CreateAttachmentThumbnailRequest,
): CreateAttachmentThumbnailResponse | undefined {
  if (request.mediaKind === "video" || request.mediaKind === "file") {
    return unsupportedResponse(
      request,
      "unsupported-media-kind",
      `Thumbnail generation is not available for ${request.mediaKind} attachments yet.`,
    );
  }

  if (request.mediaKind === "heic") {
    return undefined;
  }

  // Shared normalization (lowercase + strip ";parameter" suffixes) keeps this
  // membership check aligned with db-worker media-kind classification, so an
  // attachment the db-worker calls "image" cannot bounce as unsupported here.
  const mime = normalizeMimeType(request.mime);

  if (!nativeImageMimeTypes.has(mime)) {
    return unsupportedResponse(
      request,
      "unsupported-mime",
      "This image MIME type is not supported by the native thumbnail path.",
    );
  }

  return undefined;
}

function isThumbnailCacheableMediaKind(
  mediaKind: CreateAttachmentThumbnailRequest["mediaKind"],
): boolean {
  return mediaKind === "image" || mediaKind === "heic";
}

function unsupportedResponse(
  request: CreateAttachmentThumbnailRequest,
  reason: Extract<
    CreateAttachmentThumbnailResponse,
    { status: "unsupported" }
  >["reason"],
  message: string,
): CreateAttachmentThumbnailResponse {
  return {
    status: "unsupported",
    backupId: request.backupId,
    cacheKey: request.cacheKey,
    mediaKind: request.mediaKind,
    ...(request.mime === undefined ? {} : { mime: request.mime }),
    message,
    reason,
    cacheHit: false,
  };
}

async function renderNativeImageThumbnail(
  request: CreateAttachmentThumbnailRequest,
  maxPixelSize: number,
): Promise<ThumbnailDimensions & { bytes: Uint8Array }> {
  if (request.mediaKind === "heic") {
    return renderHeicThumbnail(request, maxPixelSize);
  }

  const sourceMime = normalizeMimeType(request.mime);
  // The app avoids SharedArrayBuffer entirely (D-008), so worker bytes are
  // ArrayBuffer-backed even though DOM typings keep Uint8Array generic.
  const blob = new Blob([request.bytes as Uint8Array<ArrayBuffer>], {
    type: sourceMime,
  });
  const bitmap = await createImageBitmap(blob);

  try {
    const dimensions = fitWithin(
      bitmap.width,
      bitmap.height,
      maxPixelSize,
    );
    const canvas = new OffscreenCanvas(dimensions.width, dimensions.height);
    const context = canvas.getContext("2d");

    if (context === null) {
      throw new MediaThumbnailError(
        "Could not create a 2D OffscreenCanvas context.",
      );
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = thumbnailJpegBackground;
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);

    return await renderCanvasToJpegThumbnail(canvas, dimensions);
  } finally {
    bitmap.close();
  }
}

async function renderHeicThumbnail(
  request: CreateAttachmentThumbnailRequest,
  maxPixelSize: number,
): Promise<ThumbnailDimensions & { bytes: Uint8Array }> {
  if (!hasHeicThumbnailSupport()) {
    throw new MediaThumbnailError(
      "This worker runtime cannot decode HEIC images with libheif.",
    );
  }

  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  let images: HeifImage[] = [];

  try {
    images = decoder.decode(request.bytes);

    if (images.length === 0) {
      throw new MediaThumbnailError("The HEIC file did not contain a decodable image.");
    }

    const image = images[0];
    const width = normalizeDecodedDimension(image.get_width(), "width");
    const height = normalizeDecodedDimension(image.get_height(), "height");
    const pixels = width * height;
    const fullDecodeOverCap = pixels > maxHeicDecodedPixels;
    const embeddedThumbnail = getBestEmbeddedHeifThumbnail(
      libheif,
      image,
      maxPixelSize,
      fullDecodeOverCap,
    );

    if (embeddedThumbnail !== undefined) {
      try {
        return await renderHeifImageToJpegThumbnail(
          embeddedThumbnail.image,
          maxPixelSize,
        );
      } finally {
        releaseHeifImage(embeddedThumbnail.image);
      }
    }

    if (fullDecodeOverCap) {
      throw new MediaThumbnailError(
        "The HEIC image is too large to decode for preview and does not contain a usable embedded thumbnail.",
        {
          height,
          maxDecodedRgbaBytes: maxHeicDecodedRgbaBytes,
          maxPixels: maxHeicDecodedPixels,
          width,
        },
      );
    }

    return await renderHeifImageToJpegThumbnail(image, maxPixelSize);
  } finally {
    releaseHeifImages(images);
    releaseHeifDecoder(libheif, decoder);
  }
}

async function renderHeifImageToJpegThumbnail(
  image: HeifImage,
  maxPixelSize: number,
): Promise<ThumbnailDimensions & { bytes: Uint8Array }> {
  const width = normalizeDecodedDimension(image.get_width(), "width");
  const height = normalizeDecodedDimension(image.get_height(), "height");
  const pixels = width * height;

  if (pixels > maxHeicDecodedPixels) {
    throw new MediaThumbnailError(
      "The HEIC image is too large to decode for preview.",
      {
        height,
        maxDecodedRgbaBytes: maxHeicDecodedRgbaBytes,
        maxPixels: maxHeicDecodedPixels,
        width,
      },
    );
  }

  const imageData = new ImageData(
    new Uint8ClampedArray(pixels * rgbaBytesPerPixel),
    width,
    height,
  );
  await displayHeifImage(image, imageData);

  const sourceCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  const sourceContext = sourceCanvas.getContext("2d");

  if (sourceContext === null) {
    throw new MediaThumbnailError(
      "Could not create a 2D OffscreenCanvas context for decoded HEIC pixels.",
    );
  }

  try {
    sourceContext.putImageData(imageData, 0, 0);

    const dimensions = fitWithin(imageData.width, imageData.height, maxPixelSize);
    const outputCanvas = new OffscreenCanvas(dimensions.width, dimensions.height);
    const outputContext = outputCanvas.getContext("2d");

    if (outputContext === null) {
      throw new MediaThumbnailError(
        "Could not create a 2D OffscreenCanvas context for HEIC thumbnail output.",
      );
    }

    try {
      outputContext.imageSmoothingEnabled = true;
      outputContext.imageSmoothingQuality = "high";
      outputContext.fillStyle = thumbnailJpegBackground;
      outputContext.fillRect(0, 0, dimensions.width, dimensions.height);
      outputContext.drawImage(
        sourceCanvas,
        0,
        0,
        dimensions.width,
        dimensions.height,
      );

      return await renderCanvasToJpegThumbnail(outputCanvas, dimensions);
    } finally {
      outputCanvas.width = 0;
      outputCanvas.height = 0;
    }
  } finally {
    sourceCanvas.width = 0;
    sourceCanvas.height = 0;
  }
}

function runThumbnailGenerationSerially<TResult>(
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const result = thumbnailGenerationTail.then(operation);

  thumbnailGenerationTail = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

function getBestEmbeddedHeifThumbnail(
  libheif: LibHeifModule,
  image: HeifImage,
  maxPixelSize: number,
  fullDecodeOverCap: boolean,
): HeifThumbnailCandidate | undefined {
  const candidates = getEmbeddedHeifThumbnailCandidates(libheif, image);
  const selectedIndex = chooseHeicThumbnailCandidateIndex(
    candidates,
    maxPixelSize,
    fullDecodeOverCap,
  );

  let selected: HeifThumbnailCandidate | undefined;

  candidates.forEach((candidate, index) => {
    if (index === selectedIndex) {
      selected = candidate;
      return;
    }

    releaseHeifImage(candidate.image);
  });

  return selected;
}

function getEmbeddedHeifThumbnailCandidates(
  libheif: LibHeifModule,
  image: HeifImage,
): HeifThumbnailCandidate[] {
  const ids = getEmbeddedHeifThumbnailIds(libheif, image);
  const candidates: HeifThumbnailCandidate[] = [];

  for (const id of ids) {
    const thumbnail = getEmbeddedHeifThumbnail(libheif, image, id);

    if (thumbnail === undefined) {
      continue;
    }

    try {
      const width = normalizeDecodedDimension(thumbnail.get_width(), "thumbnailWidth");
      const height = normalizeDecodedDimension(
        thumbnail.get_height(),
        "thumbnailHeight",
      );

      candidates.push({
        height,
        image: thumbnail,
        width,
      });
    } catch (cause) {
      releaseHeifImage(thumbnail);

      if (cause instanceof MediaThumbnailError) {
        continue;
      }

      throw cause;
    }
  }

  return candidates;
}

function getEmbeddedHeifThumbnailIds(
  libheif: LibHeifModule,
  image: HeifImage,
): number[] {
  if (
    image.handle === undefined ||
    libheif.HEAPU32 === undefined ||
    libheif._free === undefined ||
    libheif._malloc === undefined ||
    libheif.heif_image_handle_get_list_of_thumbnail_IDs === undefined ||
    libheif.heif_image_handle_get_number_of_thumbnails === undefined
  ) {
    return [];
  }

  const count = libheif.heif_image_handle_get_number_of_thumbnails(image.handle);

  if (!Number.isSafeInteger(count) || count < 1) {
    return [];
  }

  const boundedCount = Math.min(count, maxHeicThumbnailCandidates);
  const idsPointer = libheif._malloc(boundedCount * pointerBytes);

  if (!Number.isSafeInteger(idsPointer) || idsPointer === 0) {
    return [];
  }

  try {
    const readCount = libheif.heif_image_handle_get_list_of_thumbnail_IDs(
      image.handle,
      idsPointer,
      boundedCount,
    );
    const boundedReadCount = Number.isSafeInteger(readCount)
      ? Math.min(Math.max(readCount, 0), boundedCount)
      : boundedCount;
    const ids: number[] = [];

    for (let index = 0; index < boundedReadCount; index += 1) {
      const id = libheif.HEAPU32[(idsPointer >> 2) + index];

      if (Number.isSafeInteger(id)) {
        ids.push(id);
      }
    }

    return ids;
  } finally {
    libheif._free(idsPointer);
  }
}

function getEmbeddedHeifThumbnail(
  libheif: LibHeifModule,
  image: HeifImage,
  thumbnailId: number,
): HeifImage | undefined {
  if (
    image.handle === undefined ||
    libheif.HEAP32 === undefined ||
    libheif.HEAPU32 === undefined ||
    libheif.HeifImage === undefined ||
    libheif._free === undefined ||
    libheif._malloc === undefined ||
    libheif.heif_image_handle_get_thumbnail === undefined
  ) {
    return undefined;
  }

  const errorPointer = libheif._malloc(heifErrorStructBytes);
  const outHandlePointer = libheif._malloc(pointerBytes);

  if (
    !Number.isSafeInteger(errorPointer) ||
    !Number.isSafeInteger(outHandlePointer) ||
    errorPointer === 0 ||
    outHandlePointer === 0
  ) {
    safeFree(libheif, errorPointer);
    safeFree(libheif, outHandlePointer);
    return undefined;
  }

  try {
    libheif.HEAPU32[outHandlePointer >> 2] = 0;
    libheif.heif_image_handle_get_thumbnail(
      errorPointer,
      image.handle,
      thumbnailId,
      outHandlePointer,
    );

    const errorCode = libheif.HEAP32[errorPointer >> 2];
    const thumbnailHandlePointer = libheif.HEAPU32[outHandlePointer >> 2];

    if (errorCode !== 0 || thumbnailHandlePointer === 0) {
      return undefined;
    }

    const thumbnailHandle = wrapHeifHandle(image.handle, thumbnailHandlePointer);

    if (thumbnailHandle === undefined) {
      releaseRawHeifHandle(libheif, thumbnailHandlePointer);
      return undefined;
    }

    try {
      return new libheif.HeifImage(thumbnailHandle);
    } catch {
      releaseHeifHandle(libheif, thumbnailHandle);
      return undefined;
    }
  } finally {
    libheif._free(errorPointer);
    libheif._free(outHandlePointer);
  }
}

function wrapHeifHandle(
  sampleHandle: unknown,
  pointer: number,
): Record<string, unknown> | undefined {
  if (!isObjectRecord(sampleHandle)) {
    return undefined;
  }

  const handleState = Reflect.get(sampleHandle, "$$");

  if (!isObjectRecord(handleState)) {
    return undefined;
  }

  const prototypeValue: unknown = Object.getPrototypeOf(sampleHandle);

  if (
    typeof prototypeValue !== "object" &&
    typeof prototypeValue !== "function"
  ) {
    return undefined;
  }

  const prototype: object | null = prototypeValue;
  const wrapped = Object.create(prototype) as Record<string, unknown>;

  Reflect.set(wrapped, "$$", {
    ...handleState,
    count: { value: 1 },
    ptr: pointer,
  });

  return wrapped;
}

export function chooseHeicThumbnailCandidateIndex(
  candidates: readonly ThumbnailDimensions[],
  maxPixelSize: number,
  fullDecodeOverCap: boolean,
): number | undefined {
  let targetIndex: number | undefined;
  let targetMaxDimension = Number.POSITIVE_INFINITY;
  let targetPixels = Number.POSITIVE_INFINITY;
  let fallbackIndex: number | undefined;
  let fallbackMaxDimension = 0;
  let fallbackPixels = 0;

  candidates.forEach((candidate, index) => {
    const pixels = candidate.width * candidate.height;

    if (
      !Number.isSafeInteger(candidate.width) ||
      !Number.isSafeInteger(candidate.height) ||
      candidate.width < 1 ||
      candidate.height < 1 ||
      pixels > maxHeicDecodedPixels
    ) {
      return;
    }

    const maxDimension = Math.max(candidate.width, candidate.height);

    if (
      maxDimension >= maxPixelSize &&
      (maxDimension < targetMaxDimension ||
        (maxDimension === targetMaxDimension && pixels < targetPixels))
    ) {
      targetIndex = index;
      targetMaxDimension = maxDimension;
      targetPixels = pixels;
    }

    if (
      maxDimension > fallbackMaxDimension ||
      (maxDimension === fallbackMaxDimension && pixels > fallbackPixels)
    ) {
      fallbackIndex = index;
      fallbackMaxDimension = maxDimension;
      fallbackPixels = pixels;
    }
  });

  if (targetIndex !== undefined) {
    return targetIndex;
  }

  return fullDecodeOverCap ? fallbackIndex : undefined;
}

function releaseHeifImage(image: HeifImage): void {
  image.free?.();
}

function releaseHeifImages(images: readonly HeifImage[]): void {
  for (const image of images) {
    releaseHeifImage(image);
  }
}

function releaseHeifDecoder(
  libheif: LibHeifModule,
  decoder: LibHeifDecoder,
): void {
  if (decoder.decoder === undefined) {
    return;
  }

  try {
    libheif.heif_context_free?.(decoder.decoder);
    decoder.decoder = undefined;
  } catch {
    // Best-effort cleanup for the long-lived media worker.
  }
}

function releaseRawHeifHandle(libheif: LibHeifModule, handle: number): void {
  releaseHeifHandle(libheif, handle);
}

function releaseHeifHandle(libheif: LibHeifModule, handle: unknown): void {
  try {
    libheif.heif_image_handle_release?.(handle);
  } catch {
    // Best-effort cleanup for unexpected libheif wrapper shapes.
  }
}

function safeFree(libheif: LibHeifModule, pointer: number): void {
  if (Number.isSafeInteger(pointer) && pointer !== 0) {
    libheif._free?.(pointer);
  }
}

async function displayHeifImage(
  image: HeifImage,
  imageData: ImageData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    image.display(imageData, (displayData) => {
      if (displayData === null || displayData === undefined) {
        reject(new MediaThumbnailError("HEIC pixel decoding failed."));
        return;
      }

      resolve();
    });
  });
}

async function renderCanvasToJpegThumbnail(
  canvas: OffscreenCanvas,
  dimensions: ThumbnailDimensions,
): Promise<ThumbnailDimensions & { bytes: Uint8Array }> {
  const jpeg = await canvas.convertToBlob({
    quality: thumbnailJpegQuality,
    type: thumbnailMime,
  });

  return {
    ...dimensions,
    bytes: new Uint8Array(await jpeg.arrayBuffer()),
  };
}

function fitWithin(
  sourceWidth: number,
  sourceHeight: number,
  maxPixelSize: number,
): ThumbnailDimensions {
  const width = Math.max(1, sourceWidth);
  const height = Math.max(1, sourceHeight);
  const scale = Math.min(1, maxPixelSize / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function getAttachmentThumbsDirectory(
  safeBackupId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  // The shared walk re-asserts the backup segment with the same semantics as
  // the db-worker's derived-data paths; callers validate it first with
  // assertSafeBackupPathSegment for a typed MediaThumbnailError.
  const backupDirectory = await getOpfsBackupDirectoryHandle(
    safeBackupId,
    create,
  );
  const thumbsDirectory = await backupDirectory.getDirectoryHandle(
    thumbsDirectoryName,
    { create },
  );

  return thumbsDirectory.getDirectoryHandle(attachmentThumbsDirectoryName, {
    create,
  });
}

async function readCachedThumbnail(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<(ThumbnailDimensions & { bytes: Uint8Array }) | undefined> {
  try {
    const file = await (await directory.getFileHandle(fileName)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dimensions = parseJpegDimensions(bytes);

    return dimensions === undefined ? undefined : { ...dimensions, bytes };
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return undefined;
    }

    throw cause;
  }
}

async function writeCachedThumbnail(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
  } finally {
    await writable.close();
  }
}

export function parseJpegDimensions(
  bytes: Uint8Array,
): ThumbnailDimensions | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }

    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= bytes.byteLength) {
      return undefined;
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) {
      return undefined;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > bytes.byteLength) {
      return undefined;
    }

    const segmentLength = readUint16BigEndian(bytes, offset);

    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return undefined;
    }

    if (isJpegStartOfFrameMarker(marker)) {
      if (segmentLength < 7) {
        return undefined;
      }

      const height = readUint16BigEndian(bytes, offset + 3);
      const width = readUint16BigEndian(bytes, offset + 5);

      if (width < 1 || height < 1) {
        return undefined;
      }

      return { height, width };
    }

    offset += segmentLength;
  }

  return undefined;
}

function isJpegStartOfFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function normalizeMaxPixelSize(value: number | undefined): number {
  if (value === undefined) {
    return defaultThumbnailMaxPixelSize;
  }

  if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new MediaThumbnailError(
      "Thumbnail maxPixelSize must be a positive integer.",
      { maxPixelSize: String(value) },
    );
  }

  return value;
}

function normalizeDecodedDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MediaThumbnailError(`HEIC decoded ${label} is invalid.`, {
      [label]: String(value),
    });
  }

  return value;
}

function hasCanvasThumbnailSupport(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas === "function"
  );
}

function hasHeicThumbnailSupport(): boolean {
  return hasCanvasThumbnailSupport() && typeof ImageData === "function";
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function isNotFoundError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "NotFoundError" || cause.name === "TypeMismatchError")
  );
}

async function loadLibheif(): Promise<LibHeifModule> {
  libheifPromise ??= importLibheifModule()
    .then((moduleValue: unknown) => {
      if (!isObjectRecord(moduleValue)) {
        throw new MediaThumbnailError("libheif module did not load.");
      }

      const factoryValue = Reflect.get(moduleValue, "default");

      if (typeof factoryValue !== "function") {
        throw new MediaThumbnailError("libheif module is missing its factory.");
      }

      const factory = factoryValue as LibHeifFactory;

      return factory();
    })
    .then((moduleValue: unknown) => {
      if (!isObjectRecord(moduleValue)) {
        throw new MediaThumbnailError("libheif factory returned an invalid module.");
      }

      const decoder = Reflect.get(moduleValue, "HeifDecoder");

      if (typeof decoder !== "function") {
        throw new MediaThumbnailError("libheif module is missing HeifDecoder.");
      }

      return moduleValue as unknown as LibHeifModule;
    });

  return libheifPromise;
}

async function importLibheifModule(): Promise<unknown> {
  if (import.meta.env.DEV) {
    return importPublicModuleThroughBlobUrlForDev(libheifModuleUrl);
  }

  return import(/* @vite-ignore */ libheifModuleUrl);
}

export async function importPublicModuleThroughBlobUrlForDev(
  moduleUrl: string,
  loader: DevPublicModuleLoader = defaultDevPublicModuleLoader,
): Promise<unknown> {
  const response = await loader.fetchModule(moduleUrl, {
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new MediaThumbnailError("Could not fetch the dev vendor module.", {
      status: response.status,
      statusText: response.statusText,
      url: moduleUrl,
    });
  }

  // Vite dev refuses to transform modules imported directly from public/.
  // Fetching the unmodified same-origin vendor file as an asset and importing
  // a temporary blob keeps dev mode aligned with the production isolation
  // model without routing LGPL files through Vite's source transform.
  const source = await response.text();
  const objectUrl = loader.createObjectURL(
    new Blob([source], { type: "text/javascript" }),
  );

  try {
    return await loader.importModule(objectUrl);
  } finally {
    loader.revokeObjectURL(objectUrl);
  }
}
