import {
  toWorkerError,
  workerFail,
  workerOk,
  type BackupDetectionResult,
  type ReadUnencryptedSourceFileRequest,
  type ReadUnencryptedSourceFileResponse,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import { defaultMaxReadBytes } from "../shared/media-limits";
import { emitWorkerProgress } from "../shared/progress";
import { BackupDetectionError, detectIosBackup } from "./ios-backup";
import {
  ManifestDbError,
  ManifestDbReader,
  readSourceFileBytes,
  SourceFileTooLargeError,
} from "./manifest-db";
import { asReadonlySourceDirectory } from "./read-only-source";
import { SourceSqliteOpenError } from "./source-sqlite";

/**
 * Most-recent-backup cache of the detection result and opened Manifest.db
 * reader, keyed by the caller-supplied backupId. Memoization is sound because
 * source backups are strictly read-only while open (hard rule 2): the
 * Manifest.db bytes for a given backup cannot change underneath this worker,
 * and the reader queries a private transient sqlite copy of those bytes, so
 * it is safe for repeated queries across calls. The backup worker is
 * route-scoped, so at most one backup is browsed at a time (cache size 1).
 */
interface ManifestReaderCacheEntry {
  backupId: string;
  /**
   * The raw root directory handle the cached manifest was built from. Cache
   * hits must verify identity via isSameEntry: the same backupId presented
   * with a different root directory (e.g. a re-picked copy of the backup)
   * must not reuse a manifest index built from the old root while reading
   * bytes from the new one.
   */
  root: FileSystemDirectoryHandle;
  detection: BackupDetectionResult;
  manifest: ManifestDbReader;
}

let manifestReaderCache: ManifestReaderCacheEntry | undefined;

/** Closes and clears the cached Manifest.db reader (used by tests/teardown). */
export function resetUnencryptedSourceFileCache(): void {
  try {
    manifestReaderCache?.manifest.close();
  } finally {
    manifestReaderCache = undefined;
  }
}

export class SourceFileReadError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly details?: Record<string, WorkerStructuredValue>,
    readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = "SourceFileReadError";
  }
}

export async function readUnencryptedSourceFile(
  rootHandle: FileSystemDirectoryHandle,
  request: ReadUnencryptedSourceFileRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<ReadUnencryptedSourceFileResponse>> {
  try {
    await emitWorkerProgress(
      "backup",
      progress,
      "starting",
      "Starting source file read",
      0,
      5,
    );

    validateSourceFileRequest(request);

    const root = asReadonlySourceDirectory(rootHandle);

    await emitWorkerProgress(
      "backup",
      progress,
      "scanning",
      "Checking backup identity",
      1,
      5,
    );

    const cacheKey = normalizedBackupId(request.backupId);
    let cached =
      cacheKey !== undefined && manifestReaderCache?.backupId === cacheKey
        ? manifestReaderCache
        : undefined;

    if (cached !== undefined && !(await isSameRootDirectory(cached.root, rootHandle))) {
      // Same backupId but a different root directory: evict (closing the
      // reader) and rebuild from the new root instead of trusting a stale
      // manifest index.
      resetUnencryptedSourceFileCache();
      cached = undefined;
    }

    const detection = cached?.detection ?? (await detectIosBackup(root));

    assertBackupCanBeRead(request, detection);

    await emitWorkerProgress(
      "backup",
      progress,
      "manifest",
      "Reading Manifest.db file index",
      2,
      5,
    );

    let manifest: ManifestDbReader;
    let closeManifestAfterRead = false;

    if (cached !== undefined) {
      manifest = cached.manifest;
    } else {
      manifest = await ManifestDbReader.open(root);

      if (cacheKey === undefined) {
        // Without a backupId there is nothing safe to key the cache on, so
        // fall back to the uncached open/close-per-call behavior.
        closeManifestAfterRead = true;
      } else {
        // Evict (and close) the previous backup's reader before caching.
        resetUnencryptedSourceFileCache();
        manifestReaderCache = {
          backupId: cacheKey,
          root: rootHandle,
          detection,
          manifest,
        };
      }
    }

    try {
      const record = manifest.findFile(request.sourceDomain, request.sourcePath);

      if (record === undefined) {
        throw new SourceFileReadError(
          "backup_file_missing",
          `The backup's Manifest.db does not list ${request.sourceDomain}/${request.sourcePath}.`,
          true,
          {
            domain: request.sourceDomain,
            relativePath: request.sourcePath,
            ...(request.sourceGuid === undefined
              ? {}
              : { sourceGuid: request.sourceGuid }),
          },
        );
      }

      await emitWorkerProgress(
        "backup",
        progress,
        "extracting",
        "Reading source file bytes",
        3,
        5,
      );
      const source = await readSourceFileBytes(root, record, {
        maxReadBytes: request.maxReadBytes ?? defaultMaxReadBytes,
      });

      await emitWorkerProgress(
        "backup",
        progress,
        "hashing",
        "Hashing source file bytes",
        4,
        5,
      );

      const expectedSha256 = normalizedSha256(request.expectedSha256);

      if (expectedSha256 !== undefined && expectedSha256 !== source.sha256) {
        throw new SourceFileReadError(
          "backup_access_failed",
          "The source file hash no longer matches the derived attachment record.",
          true,
          {
            domain: record.domain,
            relativePath: record.relativePath,
            expectedSha256,
            actualSha256: source.sha256,
            fileId: record.fileId,
          },
        );
      }

      const response: ReadUnencryptedSourceFileResponse = {
        ...requestMetadata(request),
        fileId: record.fileId,
        domain: record.domain,
        relativePath: record.relativePath,
        bytes: source.bytes,
        byteLength: source.bytes.byteLength,
        sourceByteLength: source.sourceByteLength,
        sha256: source.sha256,
        ...(expectedSha256 === undefined
          ? {}
          : {
              expectedSha256,
              hashMatchesExpectedSha256: true,
            }),
      };

      await emitWorkerProgress(
        "backup",
        progress,
        "complete",
        "Source file read complete",
        5,
        5,
      );

      return workerOk(response);
    } finally {
      if (closeManifestAfterRead) {
        manifest.close();
      }
    }
  } catch (cause) {
    return workerFail<ReadUnencryptedSourceFileResponse>(
      toSourceFileReadWorkerError(cause, request),
    );
  }
}

function validateSourceFileRequest(
  request: ReadUnencryptedSourceFileRequest,
): void {
  if (request.sourceDomain.trim().length === 0) {
    throw new SourceFileReadError(
      "backup_invalid",
      "Cannot read a source file without a source domain.",
      true,
    );
  }

  if (request.sourcePath.trim().length === 0) {
    throw new SourceFileReadError(
      "backup_invalid",
      "Cannot read a source file without a source path.",
      true,
    );
  }

  if (
    request.maxReadBytes !== undefined &&
    (!Number.isFinite(request.maxReadBytes) ||
      request.maxReadBytes < 1 ||
      !Number.isInteger(request.maxReadBytes))
  ) {
    throw new SourceFileReadError(
      "backup_invalid",
      "Source file read limit must be a positive integer byte count.",
      true,
      { maxReadBytes: String(request.maxReadBytes) },
    );
  }
}

function assertBackupCanBeRead(
  request: ReadUnencryptedSourceFileRequest,
  detection: BackupDetectionResult,
): void {
  if (request.backupId !== undefined && request.backupId.trim().length > 0) {
    const backupId = request.backupId.trim();
    const candidates = new Set([
      detection.id.trim(),
      detection.deviceInfo.udid.trim(),
    ]);

    if (!candidates.has(backupId)) {
      throw new SourceFileReadError(
        "backup_invalid",
        "The selected folder no longer matches this recent backup. Open the backup folder again before reading source files.",
        true,
        {
          expectedBackupId: backupId,
          actualBackupId: detection.id,
          actualUdid: detection.deviceInfo.udid,
        },
      );
    }
  }

  if (detection.isEncrypted) {
    throw new SourceFileReadError(
      "backup_encrypted_unsupported",
      "Encrypted source file reads are scheduled for M4. This path only reads unencrypted backup files.",
      true,
      { backupId: request.backupId ?? detection.id },
    );
  }
}

function requestMetadata(
  request: ReadUnencryptedSourceFileRequest,
): Pick<
  ReadUnencryptedSourceFileResponse,
  | "backupId"
  | "sourceDomain"
  | "sourcePath"
  | "sourceGuid"
  | "filename"
  | "mime"
> {
  return {
    ...(request.backupId === undefined ? {} : { backupId: request.backupId }),
    sourceDomain: request.sourceDomain,
    sourcePath: request.sourcePath,
    ...(request.sourceGuid === undefined ? {} : { sourceGuid: request.sourceGuid }),
    ...(request.filename === undefined ? {} : { filename: request.filename }),
    ...(request.mime === undefined ? {} : { mime: request.mime }),
  };
}

async function isSameRootDirectory(
  cachedRoot: FileSystemDirectoryHandle,
  root: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    return await cachedRoot.isSameEntry(root);
  } catch {
    // Fail closed: if identity cannot be verified, rebuild from the supplied
    // root rather than reuse a manifest that may describe a different folder.
    return false;
  }
}

function normalizedBackupId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalizedSha256(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();

  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function toSourceFileReadWorkerError(
  cause: unknown,
  request: ReadUnencryptedSourceFileRequest,
) {
  if (cause instanceof SourceFileReadError) {
    return toWorkerError({
      worker: "backup",
      code: cause.code,
      message: cause.message,
      recoverable: cause.recoverable,
      cause: cause.originalCause,
      details: cause.details,
    });
  }

  if (cause instanceof BackupDetectionError) {
    return toWorkerError({
      worker: "backup",
      code: cause.code,
      message: cause.message,
      recoverable: true,
      cause: cause.originalCause,
      details: cause.details,
    });
  }

  if (cause instanceof ManifestDbError || cause instanceof SourceSqliteOpenError) {
    return toWorkerError({
      worker: "backup",
      code: "backup_manifest_unreadable",
      message:
        "Manifest.db in this backup could not be read, so the source file index cannot be trusted.",
      recoverable: false,
      cause,
    });
  }

  if (cause instanceof SourceFileTooLargeError) {
    return toWorkerError({
      worker: "backup",
      code: "backup_access_failed",
      message:
        "The requested source file is larger than the configured read limit.",
      recoverable: true,
      cause,
      details: {
        domain: request.sourceDomain,
        relativePath: request.sourcePath,
        maxReadBytes: request.maxReadBytes ?? defaultMaxReadBytes,
      },
    });
  }

  return toWorkerError({
    worker: "backup",
    code: "backup_access_failed",
    message: "Source file read failed unexpectedly.",
    recoverable: true,
    cause,
  });
}
