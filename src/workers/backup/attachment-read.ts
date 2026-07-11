import {
  toWorkerError,
  workerFail,
  workerOk,
  type BackupDetectionResult,
  type ExtractSourceFileResponse,
  type ReadSourceFileRequest,
  type ReadSourceFileResponse,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import { defaultMaxReadBytes } from "../shared/media-limits";
import { emitWorkerProgress } from "../shared/progress";
import {
  BackupDetectionError,
  backupIdMatchesDetection,
  detectIosBackup,
} from "./ios-backup";
import {
  BackupSessionError,
  type EncryptedBackupSessionContext,
  type EncryptedSessionTrackedOperation,
  findEncryptedBackupSession,
  requireEncryptedBackupSession,
  resetEncryptedBackupSession,
  toBackupSessionWorkerError,
} from "./encrypted-session";
import {
  ManifestDbError,
  ManifestDbReader,
  type ManifestFileRecord,
  readSourceFileBlob,
  type ReadSourceFileBytesOptions,
  type SourceFileBlob,
  type SourceFileInfo,
  writeSourceFileToSink,
  SourceFileTooLargeError,
} from "./manifest-db";
import {
  asReadonlySourceDirectory,
  isSameDirectoryHandle,
  type ReadonlySourceDirectoryHandle,
} from "./read-only-source";
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
const pendingManifestCleanups = new Set<Promise<void>>();

/** Closes and clears the cached Manifest.db reader (used by tests/teardown). */
export function resetUnencryptedSourceFileCache(): void {
  const manifest = manifestReaderCache?.manifest;
  manifestReaderCache = undefined;

  if (manifest === undefined) {
    return;
  }

  try {
    manifest.close();
  } catch {
    // cleanup() repeats close and returns the observable failure below.
  }
  const cleanup = manifest.cleanup().finally(() => {
    pendingManifestCleanups.delete(cleanup);
  });
  pendingManifestCleanups.add(cleanup);
  void cleanup.catch(() => undefined);
}

/**
 * Single lock/teardown seam for every per-backup source cache this worker
 * holds: the unencrypted Manifest reader cache above and the encrypted
 * session (keys + its transient Manifest reader). Callers must never reset
 * one without the other, so the pairing lives here instead of at call sites.
 */
export async function resetBackupSourceCaches(): Promise<void> {
  resetUnencryptedSourceFileCache();
  await Promise.all([
    resetEncryptedBackupSession(),
    ...pendingManifestCleanups,
  ]);
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

interface ResolvedSourceManifest {
  detection: BackupDetectionResult;
  manifest: ManifestDbReader;
  encryptedReadSession?: EncryptedBackupSessionContext;
  /** True when the caller owns close/cleanup of the manifest after its read. */
  closeManifestAfterRead: boolean;
}

/**
 * Shared manifest-resolution preamble for source-file reads and extractions.
 * Every cache population/eviction rule lives here and only here: a cached
 * reader is reused only for the same backupId presented from the same root
 * directory identity (the same backupId from a different root evicts and
 * rebuilds instead of trusting a stale manifest index), requests without a
 * backupId bypass the cache entirely (open/close per call), and encrypted
 * backups resolve through the active session's Manifest reader instead of
 * the unencrypted reader cache.
 */
async function resolveManifestForSourceRequest(
  rootHandle: FileSystemDirectoryHandle,
  root: ReadonlySourceDirectoryHandle,
  request: ReadSourceFileRequest,
  unencryptedOnly: boolean,
): Promise<ResolvedSourceManifest> {
  const cacheKey = normalizedBackupId(request.backupId);
  const encryptedSession = unencryptedOnly
    ? undefined
    : await findEncryptedBackupSession(rootHandle, cacheKey);
  let cached =
    cacheKey !== undefined && manifestReaderCache?.backupId === cacheKey
      ? manifestReaderCache
      : undefined;

  if (cached !== undefined && !(await isSameDirectoryHandle(cached.root, rootHandle))) {
    resetUnencryptedSourceFileCache();
    cached = undefined;
  }

  const detection =
    encryptedSession?.detection ??
    cached?.detection ??
    (await detectIosBackup(root));

  assertBackupCanBeRead(request, detection, unencryptedOnly);

  if (detection.isEncrypted) {
    const session =
      encryptedSession ??
      (await requireEncryptedBackupSession(rootHandle, request, detection));
    return {
      detection,
      manifest: session.manifest,
      encryptedReadSession: session,
      closeManifestAfterRead: false,
    };
  }

  if (cached !== undefined) {
    return {
      detection,
      manifest: cached.manifest,
      closeManifestAfterRead: false,
    };
  }

  const manifest = await ManifestDbReader.open(root, {
    backupId: detection.id,
  });

  if (cacheKey === undefined) {
    return { detection, manifest, closeManifestAfterRead: true };
  }

  // Evict (and close) the previous backup's reader before caching.
  resetUnencryptedSourceFileCache();
  manifestReaderCache = {
    backupId: cacheKey,
    root: rootHandle,
    detection,
    manifest,
  };
  return { detection, manifest, closeManifestAfterRead: false };
}

export async function readUnencryptedSourceFile(
  rootHandle: FileSystemDirectoryHandle,
  request: ReadSourceFileRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<ReadSourceFileResponse>> {
  return readSourceFileInternal(rootHandle, request, progress, true);
}

export async function readSourceFile(
  rootHandle: FileSystemDirectoryHandle,
  request: ReadSourceFileRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<ReadSourceFileResponse>> {
  return readSourceFileInternal(rootHandle, request, progress, false);
}

export async function extractSourceFile(
  rootHandle: FileSystemDirectoryHandle,
  request: ReadSourceFileRequest,
  destination: FileSystemFileHandle,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<ExtractSourceFileResponse>> {
  try {
    await emitWorkerProgress(
      "backup",
      progress,
      "starting",
      "Starting source file extraction",
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

    const { manifest, encryptedReadSession, closeManifestAfterRead } =
      await resolveManifestForSourceRequest(rootHandle, root, request, false);

    // Set once writable.close() has succeeded. That is the commit point: the
    // destination file is final, so no tail-window failure (the tracked
    // session operation's post-close lock assert, progress emits) may convert
    // the committed extraction into a reported failure or abort the writable.
    let committed: { source: SourceFileInfo; sourceSha256: string } | undefined;

    try {
      await emitWorkerProgress(
        "backup",
        progress,
        "manifest",
        "Reading Manifest.db file index",
        2,
        5,
      );

      let foundRecord: ManifestFileRecord | undefined;

      try {
        foundRecord = manifest.findFile(
          request.sourceDomain,
          request.sourcePath,
        );
      } catch (cause) {
        // A lock racing this extraction can close the session-owned transient
        // Manifest DB before this synchronous query. Re-checking activity
        // converts that raw sqlite error into the recoverable needs-password
        // code instead of a generic failure.
        encryptedReadSession?.assertActive();
        throw cause;
      }

      if (foundRecord === undefined) {
        throw new SourceFileReadError(
          "backup_file_missing",
          `The backup's Manifest.db does not list ${request.sourceDomain}/${request.sourcePath}.`,
          true,
          { domain: request.sourceDomain, relativePath: request.sourcePath },
        );
      }
      const record = foundRecord;

      await emitWorkerProgress(
        "backup",
        progress,
        "extracting",
        "Streaming source file to the selected destination",
        3,
        5,
      );

      const writable = await destination.createWritable();
      const sink = {
        write: async (bytes: Uint8Array) => {
          await writable.write(bytes as Uint8Array<ArrayBuffer>);
        },
      };
      const options = {
        ...(request.maxReadBytes === undefined
          ? {}
          : { maxReadBytes: request.maxReadBytes }),
        includeSourceSha256: true,
      };
      const expectedSha256 = normalizedSha256(request.expectedSha256);
      const finalizeSource = async (source: SourceFileInfo): Promise<void> => {
        await emitWorkerProgress(
          "backup",
          progress,
          "hashing",
          "Verifying extracted source file",
          4,
          5,
        );
        if (expectedSha256 !== undefined && expectedSha256 !== source.sha256) {
          throw new SourceFileReadError(
            "backup_access_failed",
            "The source file hash no longer matches the derived attachment record.",
            true,
            {
              expectedSha256,
              actualSha256: source.sha256,
              fileId: record.fileId,
            },
          );
        }
        const sourceSha256 = source.sourceSha256;
        if (sourceSha256 === undefined) {
          throw new SourceFileReadError(
            "backup_access_failed",
            "The stored-source hash was not computed for this extraction.",
            true,
            { fileId: record.fileId },
          );
        }

        encryptedReadSession?.assertActive();
        await writable.close();
        committed = { source, sourceSha256 };
      };

      try {
        if (encryptedReadSession === undefined) {
          await finalizeSource(
            await writeSourceFileToSink(root, record, sink, options),
          );
        } else {
          await encryptedReadSession.writeSourceFile(
            record,
            sink,
            options,
            finalizeSource,
          );
        }
      } catch (cause) {
        if (committed === undefined) {
          try {
            await writable.abort();
          } catch {
            // Preserve the source error. Aborting the atomic writable keeps
            // any pre-existing destination contents intact.
          }
          throw cause;
        }
        // Committed: writable.close() already succeeded, so this failure came
        // from the post-close tail (a session lock landing after the commit).
        // The destination file is final; fall through to the success response.
      }

      if (committed === undefined) {
        throw new SourceFileReadError(
          "backup_access_failed",
          "The extraction finished without reaching its commit point.",
          true,
          { fileId: record.fileId },
        );
      }

      try {
        await emitWorkerProgress(
          "backup",
          progress,
          "complete",
          "Source file extraction complete",
          5,
          5,
        );
      } catch {
        // Post-commit progress failures cannot fail a committed extraction.
      }

      const { source, sourceSha256 } = committed;
      return workerOk({
        ...requestMetadata(request),
        fileId: record.fileId,
        domain: record.domain,
        relativePath: record.relativePath,
        byteLength: source.byteLength,
        sourceByteLength: source.sourceByteLength,
        isEncrypted: source.isEncrypted,
        sourceSha256,
        sha256: source.sha256,
        ...(expectedSha256 === undefined
          ? {}
          : { expectedSha256, hashMatchesExpectedSha256: true }),
      });
    } finally {
      if (closeManifestAfterRead) {
        // The extraction outcome (committed success or the original error) is
        // already decided; a Manifest staging cleanup failure must never
        // replace it — a committed extraction must not be reported as failed,
        // and a failed one must surface its actionable original error. The
        // next open rebuilds the transient reader anyway.
        try {
          manifest.close();
          await manifest.cleanup();
        } catch (cause) {
          console.warn(
            "Could not remove transient Manifest staging after a source file extraction.",
            cause,
          );
        }
      }
    }
  } catch (cause) {
    return workerFail<ExtractSourceFileResponse>(
      toSourceFileReadWorkerError(cause, request),
    );
  }
}

async function readSourceFileInternal(
  rootHandle: FileSystemDirectoryHandle,
  request: ReadSourceFileRequest,
  progress: WorkerProgressCallback | undefined,
  unencryptedOnly: boolean,
): Promise<WorkerResult<ReadSourceFileResponse>> {
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

    const { manifest, encryptedReadSession, closeManifestAfterRead } =
      await resolveManifestForSourceRequest(
        rootHandle,
        root,
        request,
        unencryptedOnly,
      );

    let readRecord: (
      record: ManifestFileRecord,
      options: ReadSourceFileBytesOptions,
    ) => Promise<SourceFileBlob> = (record, options) =>
      readSourceFileBlob(root, record, options);

    if (encryptedReadSession !== undefined) {
      const session = encryptedReadSession;
      readRecord = async (record, options) => {
        // Bounded preview/report reads decrypt into memory: the response Blob
        // copies the plaintext at construction, so the intermediate buffer is
        // zeroized immediately and no transient OPFS plaintext is created or
        // retained for this read path.
        const source = await session.readSourceFile(record, options);
        const blob = new Blob([source.bytes as Uint8Array<ArrayBuffer>]);
        source.bytes.fill(0);
        return {
          record: source.record,
          blob,
          sha256: source.sha256,
          ...(source.sourceSha256 === undefined
            ? {}
            : { sourceSha256: source.sourceSha256 }),
          byteLength: blob.size,
          sourceByteLength: source.sourceByteLength,
          isEncrypted: source.isEncrypted,
          cleanup: () => Promise.resolve(),
        };
      };
    }

    const performRead = async (
      tracked?: EncryptedSessionTrackedOperation,
    ): Promise<WorkerResult<ReadSourceFileResponse>> => {
      try {
        await emitWorkerProgress(
          "backup",
          progress,
          "manifest",
          "Reading Manifest.db file index",
          2,
          5,
        );
        tracked?.assertActive();

        let record: ReturnType<typeof manifest.findFile>;

        try {
          record = manifest.findFile(
            request.sourceDomain,
            request.sourcePath,
          );
        } catch (cause) {
          // A lock racing this read can close the session-owned transient
          // Manifest DB between session acquisition and this synchronous
          // query. Re-checking activity converts that raw sqlite error into
          // the recoverable needs-password code instead of a generic failure.
          tracked?.assertActive();
          throw cause;
        }

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
      const source = await readRecord(record, {
        maxReadBytes: request.maxReadBytes ?? defaultMaxReadBytes,
        // The RPC response carries stored-source provenance (report export
        // labels both hashes), so this read pays the ciphertext digest.
        includeSourceSha256: true,
      });

      try {
        await emitWorkerProgress(
          "backup",
          progress,
          "hashing",
          "Hashing source file bytes",
          4,
          5,
        );

        const expectedSha256 = normalizedSha256(request.expectedSha256);
        // Requested via includeSourceSha256 above; absence would be an
        // internal contract violation, not a recoverable read outcome.
        const sourceSha256 = source.sourceSha256;

        if (sourceSha256 === undefined) {
          throw new SourceFileReadError(
            "backup_access_failed",
            "The stored-source hash was not computed for this read.",
            true,
            { fileId: record.fileId },
          );
        }

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

        const response: ReadSourceFileResponse = {
          ...requestMetadata(request),
          fileId: record.fileId,
          domain: record.domain,
          relativePath: record.relativePath,
          blob: source.blob,
          byteLength: source.byteLength,
          sourceByteLength: source.sourceByteLength,
          isEncrypted: source.isEncrypted,
          sourceSha256,
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

        return tracked?.finalize(workerOk(response)) ?? workerOk(response);
      } catch (cause) {
        await source.cleanup();
        throw cause;
      }
    } finally {
      if (closeManifestAfterRead) {
        // The read outcome (response or the original error) is already
        // decided; a Manifest staging cleanup failure must never replace it.
        // The next open rebuilds the transient reader anyway.
        try {
          manifest.close();
          await manifest.cleanup();
        } catch (cause) {
          console.warn(
            "Could not remove transient Manifest staging after a source file read.",
            cause,
          );
        }
      }
      }
    };

    return encryptedReadSession === undefined
      ? await performRead()
      : await encryptedReadSession.runTrackedOperation(performRead);
  } catch (cause) {
    return workerFail<ReadSourceFileResponse>(
      toSourceFileReadWorkerError(cause, request),
    );
  }
}

function validateSourceFileRequest(
  request: ReadSourceFileRequest,
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
  request: ReadSourceFileRequest,
  detection: BackupDetectionResult,
  unencryptedOnly: boolean,
): void {
  if (!backupIdMatchesDetection(request.backupId, detection)) {
    throw new SourceFileReadError(
      "backup_invalid",
      "The selected folder no longer matches this recent backup. Open the backup folder again before reading source files.",
      true,
      {
        expectedBackupId: request.backupId?.trim() ?? "",
        actualBackupId: detection.id,
        actualUdid: detection.deviceInfo.udid,
      },
    );
  }

  if (unencryptedOnly && detection.isEncrypted) {
    throw new SourceFileReadError(
      "backup_encrypted_unsupported",
      "Encrypted source file reads are scheduled for M5. This path only reads unencrypted backup files.",
      true,
      { backupId: request.backupId ?? detection.id },
    );
  }
}

function requestMetadata(
  request: ReadSourceFileRequest,
): Pick<
  ReadSourceFileResponse,
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
  request: ReadSourceFileRequest,
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

  if (cause instanceof BackupSessionError) {
    return toBackupSessionWorkerError(cause);
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
