import {
  type BackupIngestReport,
  type BackupIngestRequest,
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
import { asReadonlySourceDirectory, type ReadonlySourceDirectoryHandle } from "./read-only-source";
import { detectIosBackup } from "./ios-backup";
import {
  ManifestDbError,
  ManifestDbReader,
  readSourceFileBytes,
  type RootSourceFileInfo,
  type SourceFileBytes,
} from "./manifest-db";
import { normalizeIosMessages, type IosNormalizedData } from "./ios-normalize";
import {
  openSourceSqliteDatabase,
  SourceSqliteOpenError,
  type SourceSqliteDatabase,
} from "./source-sqlite";

const batchSize = 500;

type DatabaseRole = "messages" | "contacts" | "contact-images";

interface OpenedBackupDatabase {
  source: SourceSqliteDatabase;
  sourceFiles: IngestSourceFile[];
}

interface BatchWriteProgress {
  completedUnits: number;
  ticker: ThrottledWorkerProgress;
}

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

export async function ingestUnencryptedBackupDirectory(
  rootHandle: FileSystemDirectoryHandle,
  request: BackupIngestRequest,
  sink: IngestSinkApi,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<BackupIngestReport>> {
  const startedAt = new Date().toISOString();

  try {
    await emitWorkerProgress("backup", progress, "starting", "Starting unencrypted backup ingest", 0, 9);
    const root = asReadonlySourceDirectory(rootHandle);
    const detection = await detectIosBackup(root);

    assertRequestMatchesDetection(request, detection);

    if (detection.isEncrypted || request.isEncrypted) {
      throw new BackupIngestError(
        "backup_encrypted_unsupported",
        "Encrypted backup ingest is scheduled for M5. This M2 path only reads unencrypted backups.",
        { backupId: request.backupId },
      );
    }

    // This emit must complete before prepareIngest runs: prepareIngest is
    // destructive (drops derived tables, wipes the avatar cache), and the UI
    // uses the first non-"starting" progress event to persist the "ingesting"
    // status before destruction begins. emitWorkerProgress awaits the
    // Comlink-proxied callback round-trip, so ordering is guaranteed.
    await emitWorkerProgress("backup", progress, "prepare", "Preparing derived message database", 1, 9);
    await assertSinkOk(sink.prepareIngest(request), "prepare");

    await emitWorkerProgress("backup", progress, "manifest", "Reading Manifest.db file index", 2, 9);
    const manifest = await ManifestDbReader.open(root);

    try {
      const sourceFiles: IngestSourceFile[] = manifest.sourceFiles.map(
        manifestSourceFileEntry,
      );

      await emitWorkerProgress("backup", progress, "extracting", "Opening source message database", 3, 9);
      const messagesDb = await openBackupDatabase({
        root,
        manifest,
        role: "messages",
        domain: "HomeDomain",
        relativePath: "Library/SMS/sms.db",
      });
      sourceFiles.push(...messagesDb.sourceFiles);

      await emitWorkerProgress("backup", progress, "extracting", "Opening optional contacts databases", 4, 9);
      const optionalWarnings: IngestWarning[] = [];
      const contactsDb = await openOptionalBackupDatabase({
        root,
        manifest,
        role: "contacts",
        domain: "HomeDomain",
        relativePath: "Library/AddressBook/AddressBook.sqlitedb",
        warnings: optionalWarnings,
      });
      const contactImagesDb = await openOptionalBackupDatabase({
        root,
        manifest,
        role: "contact-images",
        domain: "HomeDomain",
        relativePath: "Library/AddressBook/AddressBookImages.sqlitedb",
        warnings: optionalWarnings,
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
      manifest.close();
    }
  } catch (cause) {
    return workerFail<BackupIngestReport>(toBackupIngestWorkerError(cause));
  }
}

function manifestSourceFileEntry(source: RootSourceFileInfo): IngestSourceFile {
  return {
    role:
      source.relativePath === "Manifest.db-wal"
        ? "manifest-wal"
        : source.relativePath === "Manifest.db-shm"
          ? "manifest-shm"
          : "manifest-db",
    relativePath: source.relativePath,
    sha256: source.sha256,
    bytes: source.byteLength,
  };
}

async function openBackupDatabase(input: {
  root: ReadonlySourceDirectoryHandle;
  manifest: ManifestDbReader;
  role: DatabaseRole;
  domain: string;
  relativePath: string;
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

  const main = await readSourceFileBytes(input.root, mainRecord);
  const wal = await readOptionalSidecar(input.root, input.manifest, input.domain, `${input.relativePath}-wal`);
  const shm = await readOptionalSidecar(input.root, input.manifest, input.domain, `${input.relativePath}-shm`);
  const source = await openSourceSqliteDatabase({
    label: input.role,
    main: main.bytes,
    ...(wal === undefined ? {} : { wal: wal.bytes }),
    ...(shm === undefined ? {} : { shm: shm.bytes }),
  });

  return {
    source,
    sourceFiles: sourceFileEntries(input.role, main, wal, shm),
  };
}

async function openOptionalBackupDatabase(input: {
  root: ReadonlySourceDirectoryHandle;
  manifest: ManifestDbReader;
  role: DatabaseRole;
  domain: string;
  relativePath: string;
  warnings: IngestWarning[];
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
  root: ReadonlySourceDirectoryHandle,
  manifest: ManifestDbReader,
  domain: string,
  relativePath: string,
): Promise<SourceFileBytes | undefined> {
  const record = manifest.findFile(domain, relativePath);

  return record === undefined ? undefined : readSourceFileBytes(root, record);
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
    message: "Unencrypted backup ingest failed unexpectedly.",
    recoverable: true,
    cause,
  });
}
