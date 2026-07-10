import {
  type BackupIngestReport,
  type BackupIngestRequest,
  type BackupCredentials,
  type IngestBatch,
  type IngestSinkApi,
  type IngestSourceFile,
  type IngestWarning,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  formatWorkerErrorPayload,
  toWorkerError,
  workerFail,
  workerOk,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import {
  createThrottledWorkerProgress,
  emitWorkerProgress,
  type ThrottledWorkerProgress,
} from "../shared/progress";
import {
  asReadonlySourceDirectory,
  type ReadonlySourceDirectoryHandle,
} from "./read-only-source";
import { detectIosBackup } from "./ios-backup";
import {
  BackupSessionError,
  captureEncryptedSessionEpoch,
  openEncryptedBackupSession,
  resetEncryptedBackupSession,
  toBackupSessionWorkerError,
} from "./encrypted-session";
import {
  getStoredSourceFile,
  ManifestDbError,
  ManifestDbReader,
  readSourceFileBytes,
  SourceFileTooLargeError,
  type RootSourceFileInfo,
  type SourceFileBytes,
  type ReadSourceFileBytesOptions,
  type ManifestFileRecord,
} from "./manifest-db";
import { zeroizeBuffers } from "../shared/zeroize";
import { normalizeIosMessages, type IosNormalizedData } from "./ios-normalize";
import {
  openSourceSqliteDatabase,
  SourceSqliteOpenError,
  type SourceSqliteDatabase,
} from "./source-sqlite";

const batchSize = 500;
// Source SQLite sets are reconstructed in worker memory and copied into
// sqlite-wasm's transient VFS, whose imported wasm memory maxes out at 2 GiB
// and is shared by the open Manifest copy and every concurrently open source
// set (D-039). 1 GiB per logical main/WAL/SHM set keeps the worst realistic
// case (decrypted Manifest + messages set + small contact sets) inside that
// ceiling while still bounding hostile sidecar combinations; a future
// streaming SQLite import can lift it further. The budget is validated
// against Manifest metadata BEFORE the destructive prepare boundary and
// charged with plaintext byte lengths at read time.
export const maxInMemorySourceDatabaseBytes = 1024 * 1024 * 1024;

type DatabaseRole = "messages" | "contacts" | "contact-images";

interface OpenedBackupDatabase {
  source: SourceSqliteDatabase;
  sourceFiles: IngestSourceFile[];
}

interface BatchWriteProgress {
  completedUnits: number;
  ticker: ThrottledWorkerProgress;
}

type BackupSourceReader = (
  record: ManifestFileRecord,
  options?: ReadSourceFileBytesOptions,
) => Promise<SourceFileBytes>;

export class BackupIngestError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
    readonly details?: Record<string, WorkerStructuredValue>,
    readonly originalCause?: unknown,
  ) {
    super(message);
    this.name = "BackupIngestError";
  }
}

export interface IngestBackupDirectoryOptions {
  /** Compatibility seam: reject encrypted backups before any session work. */
  unencryptedOnly?: boolean;
  /**
   * Test seam: overrides the aggregate per-set source budget so the
   * pre-prepare enforcement path can be exercised with fixture-sized data.
   */
  sourceDatabaseBudgetBytes?: number;
}

export async function ingestUnencryptedBackupDirectory(
  rootHandle: FileSystemDirectoryHandle,
  request: BackupIngestRequest,
  sink: IngestSinkApi,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<BackupIngestReport>> {
  return ingestBackupDirectory(rootHandle, request, sink, undefined, progress, {
    unencryptedOnly: true,
  });
}

export async function ingestBackupDirectory(
  rootHandle: FileSystemDirectoryHandle,
  request: BackupIngestRequest,
  sink: IngestSinkApi,
  credentials?: BackupCredentials,
  progress?: WorkerProgressCallback,
  options: IngestBackupDirectoryOptions = {},
): Promise<WorkerResult<BackupIngestReport>> {
  const unencryptedOnly = options.unencryptedOnly === true;
  const sourceDatabaseBudgetBytes =
    options.sourceDatabaseBudgetBytes ?? maxInMemorySourceDatabaseBytes;
  const startedAt = new Date().toISOString();
  const encryptedSessionEpoch = captureEncryptedSessionEpoch();
  let password = credentials?.password;

  // Credentials are structured-cloned for the worker RPC, so this mutates
  // only the worker-owned DTO. Drop the DTO reference immediately; JS strings
  // cannot be zeroized, but no credential-bearing object survives ingest.
  if (credentials !== undefined) {
    credentials.password = "";
    credentials = undefined;
  }

  try {
    await emitWorkerProgress("backup", progress, "starting", "Starting backup ingest", 0, 9);
    const root = asReadonlySourceDirectory(rootHandle);
    const detection = await detectIosBackup(root);

    assertRequestMatchesDetection(request, detection);

    if (unencryptedOnly && (detection.isEncrypted || request.isEncrypted)) {
      throw new BackupIngestError(
        "backup_encrypted_unsupported",
        "This compatibility path only reads unencrypted backups. Use ingestBackupToDb for encrypted backups.",
        { backupId: request.backupId },
      );
    }

    if (!detection.isEncrypted) {
      // A worker can be reused through the generic API in tests/future flows.
      // Opening a different unencrypted backup must not retain an older
      // encrypted root's class keys/Manifest session.
      await resetEncryptedBackupSession();
    }

    await emitWorkerProgress("backup", progress, "manifest", "Opening Manifest.db file index", 1, 9);
    const encryptedSessionPromise = detection.isEncrypted
      ? openEncryptedBackupSession(
          rootHandle,
          root,
          detection,
          password,
          progress,
          encryptedSessionEpoch,
        )
      : undefined;
    // openEncryptedBackupSession synchronously dispatches the serialized
    // open/KDF operation, which now owns the only remaining string reference.
    password = undefined;
    const encryptedSession = await encryptedSessionPromise;
    const manifest =
      encryptedSession?.manifest ?? (await ManifestDbReader.open(root));
    const readBackupSourceFile: BackupSourceReader =
      encryptedSession === undefined
        ? (record, options) => readSourceFileBytes(root, record, options)
        : (record, options) => encryptedSession.readSourceFile(record, options);
    const closeManifestAfterIngest = encryptedSession === undefined;

    try {
      // The required source set must fit the in-memory budget BEFORE the
      // destructive prepare boundary: its sizes are knowable from Manifest
      // metadata and stored file handles, and a post-prepare budget failure
      // would wipe a previously good derived database that this version can
      // never rebuild.
      await assertRequiredSourceDatabaseSetWithinBudget({
        manifest,
        root,
        domain: "HomeDomain",
        relativePath: "Library/SMS/sms.db",
        isEncrypted: detection.isEncrypted,
        budgetBytes: sourceDatabaseBudgetBytes,
      });

      // This is the single ordered boundary immediately before destructive
      // db-worker work. Detection, password verification, key unwrapping,
      // Manifest.db decryption, the SQLite open, and the source-set budget
      // check have all succeeded before this event is emitted, so wrong
      // passwords and over-budget backups cannot downgrade a valid derived
      // database.
      await emitWorkerProgress("backup", progress, "prepare", "Preparing derived message database", 2, 9);
      await assertSinkOk(sink.prepareIngest(request), "prepare");

      const sourceFiles: IngestSourceFile[] = manifest.sourceFiles.map(
        (source) => manifestSourceFileEntry(source, detection.isEncrypted),
      );

      await emitWorkerProgress("backup", progress, "extracting", "Opening source message database", 3, 9);
      const messagesDb = await openBackupDatabase({
        manifest,
        role: "messages",
        domain: "HomeDomain",
        relativePath: "Library/SMS/sms.db",
        readSourceFile: readBackupSourceFile,
        budgetBytes: sourceDatabaseBudgetBytes,
      });
      sourceFiles.push(...messagesDb.sourceFiles);

      await emitWorkerProgress("backup", progress, "extracting", "Opening optional contacts databases", 4, 9);
      const optionalWarnings: IngestWarning[] = [];
      const contactsDb = await openOptionalBackupDatabase({
        manifest,
        role: "contacts",
        domain: "HomeDomain",
        relativePath: "Library/AddressBook/AddressBook.sqlitedb",
        warnings: optionalWarnings,
        readSourceFile: readBackupSourceFile,
        budgetBytes: sourceDatabaseBudgetBytes,
      });
      const contactImagesDb = await openOptionalBackupDatabase({
        manifest,
        role: "contact-images",
        domain: "HomeDomain",
        relativePath: "Library/AddressBook/AddressBookImages.sqlitedb",
        warnings: optionalWarnings,
        readSourceFile: readBackupSourceFile,
        budgetBytes: sourceDatabaseBudgetBytes,
      });

      if (contactsDb !== undefined) {
        sourceFiles.push(...contactsDb.sourceFiles);
      }
      if (contactImagesDb !== undefined) {
        sourceFiles.push(...contactImagesDb.sourceFiles);
      }

      try {
        await emitWorkerProgress("backup", progress, "normalizing", "Normalizing messages, contacts, and attachments", 5, 9);
        const normalized = await normalizeIosMessages({
          smsDb: messagesDb.source.db,
          ...(contactsDb === undefined ? {} : { contactsDb: contactsDb.source.db }),
          ...(contactImagesDb === undefined
            ? {}
            : { contactImagesDb: contactImagesDb.source.db }),
          manifest,
          root,
          readSourceFile: readBackupSourceFile,
          initialWarnings: optionalWarnings,
          progress,
        });

        await emitWorkerProgress("backup", progress, "writing", "Writing participants and conversations", 6, 9);
        const identityWriteProgress = createBatchWriteProgress(
          progress,
          "Writing participants and conversations",
          normalized.participants.length + normalized.conversations.length,
        );
        await writeBatches(
          request.backupId,
          sink,
          "participants",
          normalized.participants,
          identityWriteProgress,
        );
        await writeBatches(
          request.backupId,
          sink,
          "conversations",
          normalized.conversations,
          identityWriteProgress,
        );
        await identityWriteProgress.ticker.finish(identityWriteProgress.completedUnits);

        await emitWorkerProgress("backup", progress, "writing", "Writing messages and related records", 7, 9);
        const relatedWriteProgress = createBatchWriteProgress(
          progress,
          "Writing messages and related records",
          normalized.messages.length +
            normalized.attachments.length +
            normalized.reactions.length +
            normalized.contactAvatars.length,
        );
        await writeBatches(
          request.backupId,
          sink,
          "messages",
          normalized.messages,
          relatedWriteProgress,
        );
        await writeBatches(
          request.backupId,
          sink,
          "attachments",
          normalized.attachments,
          relatedWriteProgress,
        );
        await writeBatches(
          request.backupId,
          sink,
          "reactions",
          normalized.reactions,
          relatedWriteProgress,
        );
        await writeBatches(
          request.backupId,
          sink,
          "contact-avatars",
          normalized.contactAvatars,
          relatedWriteProgress,
        );
        await relatedWriteProgress.ticker.finish(relatedWriteProgress.completedUnits);

        await emitWorkerProgress("backup", progress, "writing", "Finalizing ingest metadata", 8, 9);
        const report = buildReport({
          backupId: request.backupId,
          provider: request.provider,
          startedAt,
          sourceFiles,
          normalized,
        });

        await assertSinkOk(sink.finalizeIngest(report), "finalize");
        await emitWorkerProgress("backup", progress, "complete", "Message ingest complete", 9, 9);

        return workerOk(report);
      } finally {
        messagesDb.source.close();
        contactsDb?.source.close();
        contactImagesDb?.source.close();
      }
    } finally {
      if (closeManifestAfterIngest) {
        manifest.close();
      }
    }
  } catch (cause) {
    return workerFail<BackupIngestReport>(toBackupIngestWorkerError(cause));
  } finally {
    password = undefined;
  }
}

function manifestSourceFileEntry(
  source: RootSourceFileInfo,
  isEncrypted: boolean,
): IngestSourceFile {
  return {
    role:
      source.relativePath === "Manifest.db-wal"
        ? "manifest-wal"
        : source.relativePath === "Manifest.db-shm"
          ? "manifest-shm"
          : "manifest-db",
    relativePath: source.relativePath,
    sha256: source.contentSha256 ?? source.sha256,
    bytes: source.contentByteLength ?? source.byteLength,
    sourceSha256: source.sha256,
    sourceBytes: source.byteLength,
    isEncrypted,
  };
}

async function openBackupDatabase(input: {
  manifest: ManifestDbReader;
  role: DatabaseRole;
  domain: string;
  relativePath: string;
  readSourceFile: BackupSourceReader;
  budgetBytes: number;
}): Promise<OpenedBackupDatabase> {
  // Distinguish "file genuinely absent from the manifest" (backup_file_missing)
  // from ManifestDbError, which findFile throws for malformed/unreadable
  // manifest records and which maps to backup_manifest_unreadable.
  const mainRecord = input.manifest.findFile(input.domain, input.relativePath);

  if (mainRecord === undefined) {
    throw new BackupIngestError(
      "backup_file_missing",
      `The backup's Manifest.db does not list ${input.domain}/${input.relativePath}.`,
      { domain: input.domain, relativePath: input.relativePath },
    );
  }

  const main = await input.readSourceFile(mainRecord, {
    maxReadBytes: input.budgetBytes,
    includeSourceSha256: true,
  });
  let wal: SourceFileBytes | undefined;
  let shm: SourceFileBytes | undefined;

  try {
    // The budget bounds in-memory reconstruction, so it is charged with the
    // plaintext byte lengths actually held (the per-read maxReadBytes guard
    // above already rejected any single over-budget file before allocation).
    // Charging ciphertext sizes here would re-reject encrypted sets whose
    // plaintext fits but whose PKCS#7 padding straddles the budget.
    let remainingSourceBytes = consumeSourceDatabaseBudget(
      input.budgetBytes,
      main.bytes.byteLength,
    );
    wal = await readOptionalSidecar(
      input.manifest,
      input.domain,
      `${input.relativePath}-wal`,
      input.readSourceFile,
      remainingSourceBytes,
    );
    if (wal !== undefined) {
      remainingSourceBytes = consumeSourceDatabaseBudget(
        remainingSourceBytes,
        wal.bytes.byteLength,
      );
    }
    shm = await readOptionalSidecar(
      input.manifest,
      input.domain,
      `${input.relativePath}-shm`,
      input.readSourceFile,
      remainingSourceBytes,
    );
    if (shm !== undefined) {
      consumeSourceDatabaseBudget(
        remainingSourceBytes,
        shm.bytes.byteLength,
      );
    }
    const sourceFiles = sourceFileEntries(input.role, main, wal, shm);
    const source = await openSourceSqliteDatabase({
      label: input.role,
      main: main.bytes,
      ...(wal === undefined ? {} : { wal: wal.bytes }),
      ...(shm === undefined ? {} : { shm: shm.bytes }),
    });

    return { source, sourceFiles };
  } finally {
    zeroizeBuffers(main.bytes, wal?.bytes, shm?.bytes);
  }
}

/**
 * Pre-prepare budget guard for a REQUIRED database set. Missing records and
 * sidecars are skipped (the reads decide their own error surface later);
 * only a provably over-budget set fails here, before any destructive
 * db-worker call.
 */
export async function assertRequiredSourceDatabaseSetWithinBudget(input: {
  manifest: ManifestDbReader;
  root: ReadonlySourceDirectoryHandle;
  domain: string;
  relativePath: string;
  isEncrypted: boolean;
  budgetBytes?: number;
}): Promise<void> {
  let remaining = input.budgetBytes ?? maxInMemorySourceDatabaseBytes;

  for (const relativePath of [
    input.relativePath,
    `${input.relativePath}-wal`,
    `${input.relativePath}-shm`,
  ]) {
    const record = input.manifest.findFile(input.domain, relativePath);

    if (record === undefined) {
      continue;
    }

    remaining = consumeSourceDatabaseBudget(
      remaining,
      await estimatePlaintextByteLength(input.root, record, input.isEncrypted),
    );
  }
}

async function estimatePlaintextByteLength(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  isEncrypted: boolean,
): Promise<number> {
  const metadataSize = record.metadata.size;
  const validMetadataSize =
    metadataSize !== undefined &&
    Number.isSafeInteger(metadataSize) &&
    metadataSize >= 0
      ? metadataSize
      : undefined;

  if (isEncrypted && validMetadataSize !== undefined) {
    return validMetadataSize;
  }

  // Size probe only; no bytes are read. CBC never shrinks below plaintext
  // and unencrypted reads are truncated to a valid declared size, so the
  // stored size (capped by any valid metadata size) bounds what the read
  // will charge.
  const file = await getStoredSourceFile(root, record);

  return validMetadataSize === undefined
    ? file.size
    : Math.min(validMetadataSize, file.size);
}

export function consumeSourceDatabaseBudget(
  remainingBytes: number,
  sourceByteLength: number,
): number {
  if (
    !Number.isSafeInteger(remainingBytes) ||
    remainingBytes < 0 ||
    !Number.isSafeInteger(sourceByteLength) ||
    sourceByteLength < 0 ||
    sourceByteLength > remainingBytes
  ) {
    throw new SourceFileTooLargeError(
      "The combined source database main/WAL/SHM set exceeds the in-memory ingest limit.",
    );
  }

  return remainingBytes - sourceByteLength;
}

async function openOptionalBackupDatabase(input: {
  manifest: ManifestDbReader;
  role: DatabaseRole;
  domain: string;
  relativePath: string;
  warnings: IngestWarning[];
  readSourceFile: BackupSourceReader;
  budgetBytes: number;
}): Promise<OpenedBackupDatabase | undefined> {
  try {
    if (input.manifest.findFile(input.domain, input.relativePath) === undefined) {
      return undefined;
    }

    return await openBackupDatabase(input);
  } catch (cause) {
    input.warnings.push({
      code: `${input.role}-database-unreadable`,
      message: `Skipped optional ${input.role} database because it could not be opened.`,
      source: input.relativePath,
    });
    console.warn(`Skipping optional ${input.role} database.`, cause);

    return undefined;
  }
}

async function readOptionalSidecar(
  manifest: ManifestDbReader,
  domain: string,
  relativePath: string,
  readSourceFile: BackupSourceReader,
  maxReadBytes: number,
): Promise<SourceFileBytes | undefined> {
  const record = manifest.findFile(domain, relativePath);

  return record === undefined
    ? undefined
    : readSourceFile(record, {
        maxReadBytes,
        includeSourceSha256: true,
      });
}

function sourceFileEntries(
  role: DatabaseRole,
  main: SourceFileBytes,
  wal: SourceFileBytes | undefined,
  shm: SourceFileBytes | undefined,
): IngestSourceFile[] {
  return [
    sourceFileEntry(main, sourceRole(role, "db")),
    ...(wal === undefined ? [] : [sourceFileEntry(wal, sourceRole(role, "wal"))]),
    ...(shm === undefined ? [] : [sourceFileEntry(shm, sourceRole(role, "shm"))]),
  ];
}

function sourceFileEntry(
  source: SourceFileBytes,
  role: IngestSourceFile["role"],
): IngestSourceFile {
  return {
    role,
    fileId: source.record.fileId,
    domain: source.record.domain,
    relativePath: source.record.relativePath,
    sha256: source.sha256,
    bytes: source.bytes.byteLength,
    // Database reads always request the stored-source hash (provenance rule
    // 9); the guard is only absent for reads that opted out.
    ...(source.sourceSha256 === undefined
      ? {}
      : { sourceSha256: source.sourceSha256 }),
    sourceBytes: source.sourceByteLength,
    isEncrypted: source.isEncrypted,
  };
}

function sourceRole(
  databaseRole: DatabaseRole,
  sidecar: "db" | "wal" | "shm",
): IngestSourceFile["role"] {
  if (databaseRole === "messages") {
    return sidecar === "db" ? "messages-db" : sidecar === "wal" ? "messages-wal" : "messages-shm";
  }

  if (databaseRole === "contacts") {
    return sidecar === "db" ? "contacts-db" : sidecar === "wal" ? "contacts-wal" : "contacts-shm";
  }

  return sidecar === "db"
    ? "contact-images-db"
    : sidecar === "wal"
      ? "contact-images-wal"
      : "contact-images-shm";
}

function createBatchWriteProgress(
  progress: WorkerProgressCallback | undefined,
  label: string,
  totalUnits: number,
): BatchWriteProgress {
  return {
    completedUnits: 0,
    ticker: createThrottledWorkerProgress({
      worker: "backup",
      progress,
      phase: "writing",
      label,
      totalUnits,
    }),
  };
}

async function writeBatches<TKey extends IngestBatch["kind"]>(
  backupId: string,
  sink: IngestSinkApi,
  kind: TKey,
  items: Extract<IngestBatch, { kind: TKey }>["items"],
  progress?: BatchWriteProgress,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = {
      backupId,
      kind,
      items: items.slice(offset, offset + batchSize),
    } as Extract<IngestBatch, { kind: TKey }>;

    await assertSinkOk(sink.writeIngestBatch(batch), kind);

    if (progress !== undefined) {
      progress.completedUnits += batch.items.length;
      await progress.ticker.maybeEmit(progress.completedUnits);
    }
  }
}

async function assertSinkOk(
  promise: Promise<WorkerResult<unknown>>,
  operation: string,
): Promise<void> {
  const result = await promise;

  if (!result.ok) {
    // derived_db_pool_unavailable must survive this boundary: it is the
    // caller's only signal that prepare failed before touching the derived
    // DB (e.g. another tab holds the backup's SAH pool), so a previously
    // ingested record must not be downgraded. Everything else stays folded
    // into db_ingest_failed.
    throw new BackupIngestError(
      result.error.code === "derived_db_pool_unavailable"
        ? result.error.code
        : "db_ingest_failed",
      `db-worker rejected the ${operation} ingest step.`,
      { operation },
      formatWorkerErrorPayload(result.error),
    );
  }
}

function buildReport(input: {
  backupId: string;
  provider: BackupIngestRequest["provider"];
  startedAt: string;
  sourceFiles: IngestSourceFile[];
  normalized: IosNormalizedData;
}): BackupIngestReport {
  return {
    backupId: input.backupId,
    provider: input.provider,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    counts: {
      conversations: input.normalized.conversations.length,
      participants: input.normalized.participants.length,
      messages: input.normalized.messages.length,
      attachments: input.normalized.attachments.length,
      reactions: input.normalized.reactions.length,
      contactAvatars: input.normalized.contactAvatars.length,
      warnings: input.normalized.warnings.length,
    },
    sourceFiles: input.sourceFiles,
    warnings: input.normalized.warnings,
  };
}

function assertRequestMatchesDetection(
  request: BackupIngestRequest,
  detection: Awaited<ReturnType<typeof detectIosBackup>>,
): void {
  const expectedUdid = request.deviceInfo.udid.trim();
  const actualUdid = detection.deviceInfo.udid.trim();

  if (
    request.backupId === detection.id &&
    expectedUdid === actualUdid &&
    request.isEncrypted === detection.isEncrypted
  ) {
    return;
  }

  throw new BackupIngestError(
    "backup_invalid",
    "The selected folder no longer matches this recent backup. Open the backup folder again before ingest.",
    {
      expectedBackupId: request.backupId,
      actualBackupId: detection.id,
      expectedUdid,
      actualUdid,
    },
  );
}

function toBackupIngestWorkerError(cause: unknown) {
  if (cause instanceof BackupIngestError) {
    return toWorkerError({
      worker:
        cause.code === "db_ingest_failed" ||
        cause.code === "derived_db_pool_unavailable"
          ? "db"
          : "backup",
      code: cause.code,
      message: cause.message,
      recoverable: true,
      cause: cause.originalCause,
      details: cause.details,
    });
  }

  if (cause instanceof BackupSessionError) {
    return toBackupSessionWorkerError(cause);
  }

  if (cause instanceof ManifestDbError) {
    return toWorkerError({
      worker: "backup",
      code: "backup_manifest_unreadable",
      message:
        "Manifest.db in this backup has an unreadable record, so the file index cannot be trusted. The backup may be damaged or incomplete.",
      recoverable: false,
      cause,
    });
  }

  if (cause instanceof SourceFileTooLargeError) {
    return toWorkerError({
      worker: "backup",
      code: "backup_ingest_failed",
      message:
        "A source database exceeds the safe in-memory ingest limit for this version.",
      recoverable: false,
      cause,
      details: { maxReadBytes: maxInMemorySourceDatabaseBytes },
    });
  }

  if (cause instanceof SourceSqliteOpenError) {
    return toWorkerError({
      worker: "backup",
      code: "backup_ingest_failed",
      message: "A source SQLite database from this backup could not be opened.",
      recoverable: true,
      cause,
      details: cause.details,
    });
  }

  return toWorkerError({
    worker: "backup",
    code: "backup_ingest_failed",
    message: "Backup ingest failed unexpectedly.",
    recoverable: true,
    cause,
  });
}
