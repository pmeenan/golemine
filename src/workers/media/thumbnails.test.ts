import { describe, expect, it, vi } from "vitest";

import {
  chooseHeicThumbnailCandidateIndex,
  createAttachmentThumbnail,
  getAttachmentThumbnailCachePath,
  getUnsupportedThumbnailResponse,
  importPublicModuleThroughBlobUrlForDev,
  parseJpegDimensions,
  sanitizeThumbnailPathSegment,
} from "./thumbnails";
import type { CreateAttachmentThumbnailRequest } from "../../lib/worker-types";

describe("attachment thumbnail helpers", () => {
  it("uses the backup derived-data segment and sanitizes cache keys before constructing OPFS paths", () => {
    const path = getAttachmentThumbnailCachePath({
      backupId: "backup-id",
      cacheKey: " ../../Library/SMS/Attachments/photo one ",
    });

    expect(path.safeBackupId).toBe("backup-id");
    expect(path.safeCacheKey).not.toContain("/");
    expect(path.safeCacheKey).not.toContain("\\");
    expect(path.safeCacheKey).not.toContain("..");
    expect(path.fileName).toBe(`${path.safeCacheKey}.jpg`);
    expect(path.opfsPath).toBe(
      `golemine/backups/${path.safeBackupId}/thumbs/attachments/${path.fileName}`,
    );
  });

  it("rejects unsafe backup cache directories instead of creating orphaned sanitized roots", () => {
    expect(() =>
      getAttachmentThumbnailCachePath({
        backupId: "backup/name",
        cacheKey: "attachment",
      }),
    ).toThrow("safe OPFS path segment");
  });

  it("keeps already-safe path segments readable", () => {
    expect(sanitizeThumbnailPathSegment("ABC-123_thing.png", "fallback")).toBe(
      "ABC-123_thing.png",
    );
  });

  it("routes HEIC to the decoder path while generic files stay unsupported", async () => {
    expect(
      getUnsupportedThumbnailResponse(
        thumbnailRequest({ mediaKind: "heic", mime: "image/heic" }),
      ),
    ).toBeUndefined();

    const heic = await createAttachmentThumbnail(
      thumbnailRequest({ mediaKind: "heic", mime: "image/heic" }),
    );
    const file = await createAttachmentThumbnail(
      thumbnailRequest({ mediaKind: "file", mime: "application/pdf" }),
    );

    expect(heic.ok).toBe(true);
    expect(file.ok).toBe(true);

    if (heic.ok) {
      expect(heic.value).toMatchObject({
        status: "unsupported",
        reason: "unsupported-environment",
        mediaKind: "heic",
        cacheHit: false,
      });
    }

    if (file.ok) {
      expect(file.value).toMatchObject({
        status: "unsupported",
        reason: "unsupported-media-kind",
        mediaKind: "file",
        cacheHit: false,
      });
    }
  });

  it("serializes thumbnail generation regardless of caller concurrency", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondProgress = vi.fn();
    const first = createAttachmentThumbnail(
      thumbnailRequest({ mediaKind: "file", mime: "application/pdf" }),
      async (progress) => {
        if (progress.phase === "starting") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
      },
    );

    await firstStarted.promise;

    const second = createAttachmentThumbnail(
      thumbnailRequest({ mediaKind: "file", mime: "application/pdf" }),
      secondProgress,
    );

    await Promise.resolve();
    expect(secondProgress).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(secondProgress).toHaveBeenCalled();
  });

  it("loads dev public vendor modules through a temporary blob URL", async () => {
    const importedModule = { default: () => "loaded" };
    const fetchModule = vi.fn((_moduleUrl: string, _init: RequestInit) =>
      Promise.resolve(new Response("export default () => 'loaded';", { status: 200 })),
    );
    const createObjectURL = vi.fn((_blob: Blob) => "blob:golemine-libheif-dev");
    const importModule = vi.fn((_moduleUrl: string) => Promise.resolve(importedModule));
    const revokeObjectURL = vi.fn((_moduleUrl: string) => undefined);

    await expect(
      importPublicModuleThroughBlobUrlForDev("/vendor/example.mjs", {
        createObjectURL,
        fetchModule,
        importModule,
        revokeObjectURL,
      }),
    ).resolves.toBe(importedModule);

    expect(fetchModule).toHaveBeenCalledWith("/vendor/example.mjs", {
      credentials: "same-origin",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(importModule).toHaveBeenCalledWith("blob:golemine-libheif-dev");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:golemine-libheif-dev");
  });

  it("chooses the smallest embedded HEIC thumbnail that satisfies the display target", () => {
    expect(
      chooseHeicThumbnailCandidateIndex(
        [
          { width: 320, height: 240 },
          { width: 2048, height: 1536 },
          { width: 640, height: 480 },
        ],
        512,
        false,
      ),
    ).toBe(2);
  });

  it("uses an undersized HEIC thumbnail only when the full image is over the memory cap", () => {
    const thumbnails = [
      { width: 160, height: 120 },
      { width: 320, height: 240 },
    ];

    expect(chooseHeicThumbnailCandidateIndex(thumbnails, 512, false)).toBeUndefined();
    expect(chooseHeicThumbnailCandidateIndex(thumbnails, 512, true)).toBe(1);
  });

  it("keeps a 48 MP HEIC image within the 256 MiB RGBA decode cap", () => {
    expect(
      chooseHeicThumbnailCandidateIndex(
        [{ width: 8064, height: 6048 }],
        512,
        false,
      ),
    ).toBe(0);
  });

  it("ignores embedded HEIC thumbnail candidates that exceed the decode cap", () => {
    expect(
      chooseHeicThumbnailCandidateIndex(
        [
          { width: 20_000, height: 20_000 },
          { width: 256, height: 256 },
        ],
        512,
        true,
      ),
    ).toBe(1);
  });

  it("returns a typed unsupported response for unsupported image MIME types", () => {
    const unsupported = getUnsupportedThumbnailResponse(
      thumbnailRequest({ mediaKind: "image", mime: "image/tiff" }),
    );

    expect(unsupported).toMatchObject({
      status: "unsupported",
      reason: "unsupported-mime",
      mediaKind: "image",
      mime: "image/tiff",
      cacheHit: false,
    });
  });

  it("accepts supported image MIME types that carry parameters, matching db-worker classification", () => {
    // The db-worker strips ";parameter" suffixes before media-kind
    // classification; the media worker must agree or db-classified images
    // would bounce here as unsupported-mime.
    expect(
      getUnsupportedThumbnailResponse(
        thumbnailRequest({ mediaKind: "image", mime: "image/png; charset=binary" }),
      ),
    ).toBeUndefined();
    expect(
      getUnsupportedThumbnailResponse(
        thumbnailRequest({ mediaKind: "image", mime: " IMAGE/JPEG ; q=1 " }),
      ),
    ).toBeUndefined();
  });

  it("parses JPEG dimensions from cached thumbnail bytes", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0,
      0x00, 0x04,
      0x4a, 0x46,
      0xff, 0xc0,
      0x00, 0x0b,
      0x08,
      0x00, 0xf0,
      0x01, 0x40,
      0x01,
      0x11, 0x00,
      0x00,
    ]);

    expect(parseJpegDimensions(jpeg)).toEqual({ width: 320, height: 240 });
    expect(parseJpegDimensions(new Uint8Array([0x00, 0x01]))).toBeUndefined();
  });
});

function thumbnailRequest(
  overrides: Partial<CreateAttachmentThumbnailRequest> = {},
): CreateAttachmentThumbnailRequest {
  return {
    backupId: "backup-id",
    cacheKey: "attachment-cache-key",
    mediaKind: "image",
    mime: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}
