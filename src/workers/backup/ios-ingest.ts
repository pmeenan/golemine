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
import { getAvailableOpfsQuotaBytes } from "../shared/opfs";
import {
  asReadonlySourceDirectory,
  type ReadonlySourceDirectoryHandle,
} from "./read-only-source";
import { detectIosBackup } from "./ios-backup";
import { resetBackupSourceCaches } from "./attachment-read";
import {
  BackupSessionError,
  captureEncryptedSessionEpoch,
  openEncryptedBackupSession,
  resetEncryptedBackupSession,
  toBackupSessionWorkerError,
} from "./encrypted-session";
import {
  getBackupSourceOverridesForTests,
  getStoredSourceFile,
  ManifestDbError,
  ManifestDbReader,
  readSourceFileBlob,
  readSourceFileBytes,
  maxStagedSourceFileBytes,
  SourceFileTooLargeError,
  type DecryptedPlaintextDestination,
  type RootSourceFileInfo,
  type SourceFileBytes,
  type SourceFileBlob,
  type SourceFileInfo,
  type ReadSourceFileBytesOptions,
  type ManifestFileRecord,
} from "./manifest-db";
import { normalizeIosMessages, type IosNormalizedData } from "./ios-normalize";
import {
  openSourceSqliteDatabase,
  SourceSqliteOpenError,
  type SourceSqliteDatabase,
} from "./source-sqlite";

const batchSize = 500;
// Streaming OPFS staging removes the sqlite-wasm heap from the source-size
// ceiling. This generous absolute set limit remains as a hostile-metadata
// sanity bound; the required set is also checked against remaining OPFS quota
// before the single destructive prepare boundary (D-041).
export const maxStagedSourceDatabaseSetBytes = 8 * 1024 * 1024 * 1024 * 1024;
const stagingQuotaReserveBytes = 64 * 1024 * 1024;

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

type BackupSourceBlobReader = (
  record: ManifestFileRecord,
  options?: ReadSourceFileBytesOptions,
) => Promise<SourceFileBlob>;

/**
 * Decrypt-streams one encrypted source file into a caller-owned destination
 * (the source-sqlite workspace's staged main file) and returns its digests
 * and provenance. Present only when an encrypted session is active.
 */
type BackupSourceStager = (
  record: ManifestFileRecord,
  destination: DecryptedPlaintextDestination,
  options?: ReadSourceFileBytesOptions,
) => Promise<SourceFileInfo>;

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
   * The in-memory staging/open replacements used by non-OPFS test runs are
   * NOT options — they register once through manifest-db's
   * `setBackupSourceOverridesForTests`.
   */
  sourceDatabaseBudgetBytes?: number;
}

export async function ingestUnencryptedBackupDirectory(
  rootHandle: FileSystemDirectoryHandle,
  request: BackupIngestRequest,
  sink: IngestSinkApi,
  progress?: WorkerProgressCallback,
  options: Omit<IngestBackupDirectoryOptions, "unencryptedOnly"> = {},
): Promise<WorkerResult<BackupIngestReport>> {
  return ingestBackupDirectory(
    rootHandle,
    request,
    sink,
    undefined,
    progress,
    { ...options, unencryptedOnly: true },
  );
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
    options.sourceDatabaseBudgetBytes ?? maxStagedSourceDatabaseSetBytes;
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
      encryptedSession?.manifest ??
      (await ManifestDbReader.open(root, { backupId: detection.id }));
    const readBackupSourceFile: BackupSourceReader =
      encryptedSession === undefined
        ? (record, options) => readSourceFileBytes(root, record, options)
        : (record, options) => encryptedSession.readSourceFile(record, options);
    const readBackupSourceBlob: BackupSourceBlobReader =
      encryptedSession === undefined
        ? (record, options) => readSourceFileBlob(root, record, options)
        : (record, options) => encryptedSession.readSourceFileBlob(record, options);
    const stageBackupSourceFile: BackupSourceStager | undefined =
      encryptedSession === undefined
        ? undefined
        : (record, destination, options) =>
            encryptedSession.stageSourceFile(record, destination, options);
    const closeManifestAfterIngest = encryptedSession === undefined;

    const runTrackedSourceOpen = <
      TValue extends OpenedBackupDatabase | undefined,
    >(
      operation: () => Promise<TValue>,
    ): Promise<TValue> =>
      encryptedSession === undefined
        ? operation()
        : encryptedSession.runTrackedOperation(async (tracked) => {
            const opened = await operation();
            try {
              return tracked.finalize(opened);
            } catch (cause) {
              // A lock can invalidate the session after sahpool import has
              // returned but before this handoff. The caller never receives
              // that database, so close it here instead of orphaning an OPFS
              // pool slot and its imported plaintext. The lock failure owns
              // the outcome; a cleanup failure must not replace it.
              if (opened !== undefined) {
                const cleanupFailure = await cleanupSourceDatabases(opened.source);

                if (cleanupFailure !== undefined) {
                  console.warn(
                    "Could not remove an orphaned source database after a session lock.",
                    cleanupFailure,
                  );
                }
              }
              throw cause;
            }
          });

    try {
      // The required source set must pass staged-disk sanity, crypto-key, and
      // quota checks BEFORE the destructive prepare boundary. Those failures
      // are knowable from Manifest metadata and stored file handles; finding
      // one after prepare would wipe a previously good derived database.
      await assertRequiredSourceDatabaseSetWithinBudget({
        manifest,
        root,
        domain: "HomeDomain",
        relativePath: "Library/SMS/sms.db",
        isEncrypted: detection.isEncrypted,
        budgetBytes: sourceDatabaseBudgetBytes,
        ...(encryptedSession === undefined
          ? {}
          : { verifyEncryptedFileKey: (record) =>
              encryptedSession.verifySourceFileKey(record) }),
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
      const messagesDb = await runTrackedSourceOpen(() =>
        openBackupDatabase({
          backupId: request.backupId,
          manifest,
          role: "messages",
          domain: "HomeDomain",
          relativePath: "Library/SMS/sms.db",
          readSourceFile: readBackupSourceBlob,
          budgetBytes: sourceDatabaseBudgetBytes,
          ...(stageBackupSourceFile === undefined
            ? {}
            : { stageSourceFile: stageBackupSourceFile }),
        }),
      );
      let contactsDb: OpenedBackupDatabase | undefined;
      let contactImagesDb: OpenedBackupDatabase | undefined;
      let report: BackupIngestReport;

      try {
        sourceFiles.push(...messagesDb.sourceFiles);

        await emitWorkerProgress("backup", progress, "extracting", "Opening optional contacts databases", 4, 9);
        const optionalWarnings: IngestWarning[] = [];
        contactsDb = await runTrackedSourceOpen(() =>
          openOptionalBackupDatabase({
            backupId: request.backupId,
            manifest,
            role: "contacts",
            domain: "HomeDomain",
            relativePath: "Library/AddressBook/AddressBook.sqlitedb",
            warnings: optionalWarnings,
            readSourceFile: readBackupSourceBlob,
            budgetBytes: sourceDatabaseBudgetBytes,
            ...(stageBackupSourceFile === undefined
              ? {}
              : { stageSourceFile: stageBackupSourceFile }),
          }),
        );
        contactImagesDb = await runTrackedSourceOpen(() =>
          openOptionalBackupDatabase({
            backupId: request.backupId,
            manifest,
            role: "contact-images",
            domain: "HomeDomain",
            relativePath: "Library/AddressBook/AddressBookImages.sqlitedb",
            warnings: optionalWarnings,
            readSourceFile: readBackupSourceBlob,
            budgetBytes: sourceDatabaseBudgetBytes,
            ...(stageBackupSourceFile === undefined
              ? {}
              : { stageSourceFile: stageBackupSourceFile }),
          }),
        );

        if (contactsDb !== undefined) {
          sourceFiles.push(...contactsDb.sourceFiles);
        }
        if (contactImagesDb !== undefined) {
          sourceFiles.push(...contactImagesDb.sourceFiles);
        }

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
        report = buildReport({
          backupId: request.backupId,
          provider: request.provider,
          startedAt,
          sourceFiles,
          normalized,
        });

        await assertSinkOk(sink.finalizeIngest(report), "finalize");
        await emitWorkerProgress("backup", progress, "complete", "Message ingest complete", 9, 9);
      } catch (cause) {
        // The original ingest error owns this outcome; a staging cleanup
        // failure here is secondary and must never mask it.
        const cleanupFailure = await cleanupSourceDatabases(
          messagesDb.source,
          contactsDb?.source,
          contactImagesDb?.source,
        );

        if (cleanupFailure !== undefined) {
          console.warn(
            "Could not remove transient source database staging after a failed ingest.",
            cleanupFailure,
          );
        }
        throw cause;
      }

      // The derived database is already finalized: the ingest succeeded, so a
      // cleanup failure downgrades to a report warning instead of replacing
      // the successful outcome. Leftover transient staging is swept when the
      // backup is next opened.
      const cleanupFailure = await cleanupSourceDatabases(
        messagesDb.source,
        contactsDb?.source,
        contactImagesDb?.source,
      );

      if (cleanupFailure !== undefined) {
        console.warn(
          "Could not remove transient source database staging after ingest.",
          cleanupFailure,
        );
        report = appendReportWarning(report, {
          code: "source-staging-cleanup-failed",
          message:
            "Ingest succeeded, but transient source database staging could not be fully removed. Leftovers are swept the next time this backup is opened.",
        });
      }

      return workerOk(report);
    } finally {
      if (closeManifestAfterIngest) {
        // The ingest outcome (success report or original error) is already
        // decided; a Manifest staging cleanup failure must never replace it.
        try {
          manifest.close();
          await manifest.cleanup();
        } catch (cause) {
          console.warn(
            "Could not remove transient Manifest staging after ingest.",
            cause,
          );
        }
      } else {
        // Encrypted path: the Manifest reader belongs to the worker-global
        // session, whose staged plaintext lives under the backup's transient/
        // directory. No production caller needs that session after this call
        // — the overview route ingests on a one-shot worker it terminates
        // (which cannot clean OPFS staging), and the messages route never
        // ingests on its route-scoped worker — so lock the session here, at
        // the ingest layer, so the no-plaintext-after-ingest guarantee does
        // not depend on route discipline. Goes through the single
        // resetBackupSourceCaches seam (manifest cache + session in tandem)
        // and must never replace the already-decided ingest outcome.
        try {
          await resetBackupSourceCaches();
        } catch (cause) {
          console.warn(
            "Could not fully remove encrypted-session plaintext staging after ingest.",
            cause,
          );
        }
      }
    }
  } catch (cause) {
    return workerFail<BackupIngestReport>(toBackupIngestWorkerError(cause));
  } finally {
    password = undefined;
  }
}

/**
 * Closes and removes staged source databases. Deliberately never throws:
 * every caller runs this while an outcome (success report or original error)
 * is already decided, so the combined failure is returned for the caller to
 * report as a warning or log without replacing that outcome.
 */
async function cleanupSourceDatabases(
  ...sources: (SourceSqliteDatabase | undefined)[]
): Promise<unknown> {
  const active = sources.filter(
    (source): source is SourceSqliteDatabase => source !== undefined,
  );
  const closeFailures: unknown[] = [];

  for (const source of active) {
    try {
      source.close();
    } catch (cause) {
      closeFailures.push(cause);
    }
  }

  const cleanupResults = await Promise.allSettled(
    active.map((source) => source.cleanup()),
  );
  for (const result of cleanupResults) {
    if (result.status === "rejected") {
      closeFailures.push(result.reason as unknown);
    }
  }

  if (closeFailures.length === 1) {
    return closeFailures[0];
  }
  if (closeFailures.length > 1) {
    return new AggregateError(
      closeFailures,
      "Could not remove transient source database staging.",
    );
  }

  return undefined;
}

function appendReportWarning(
  report: BackupIngestReport,
  warning: IngestWarning,
): BackupIngestReport {
  return {
    ...report,
    counts: { ...report.counts, warnings: report.counts.warnings + 1 },
    warnings: [...report.warnings, warning],
  };
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

type OpenBackupDatabaseMainSource =
  | { kind: "blob"; blob: SourceFileBlob }
  | {
      kind: "staged";
      record: ManifestFileRecord;
      declaredByteLength: number;
      stage: BackupSourceStager;
    };

async function openBackupDatabase(input: {
  backupId: string;
  manifest: ManifestDbReader;
  role: DatabaseRole;
  domain: string;
  relativePath: string;
  readSourceFile: BackupSourceBlobReader;
  /** Present only for encrypted sessions; the main database decrypt-streams. */
  stageSourceFile?: BackupSourceStager;
  budgetBytes: number;
  /**
   * Optional sets bound every read/stage by the remaining set budget so a
   * hostile declared Size is rejected before any decrypt or staging I/O. The
   * required set keeps the independent absolute per-file cap: it was already
   * charged pre-prepare, and an aligned ciphertext tail may be larger than
   * its logical Size without defeating the set accounting.
   */
  boundReadsToBudget?: boolean;
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

  const boundToBudget = input.boundReadsToBudget === true;
  const mainReadCap = boundToBudget
    ? Math.min(input.budgetBytes, maxStagedSourceFileBytes)
    : maxStagedSourceFileBytes;
  // Encrypted main databases decrypt-stream directly into the source-sqlite
  // workspace (no intermediate staged plaintext copy); unencrypted mains stay
  // read-only Blobs over the stored source file, which the opener copies.
  const mainSource: OpenBackupDatabaseMainSource =
    input.stageSourceFile === undefined
      ? {
          kind: "blob",
          blob: await input.readSourceFile(mainRecord, {
            maxReadBytes: mainReadCap,
            includeSourceSha256: true,
          }),
        }
      : {
          kind: "staged",
          record: mainRecord,
          declaredByteLength: declaredEncryptedPlaintextByteLength(mainRecord),
          stage: input.stageSourceFile,
        };

  let wal: SourceFileBlob | undefined;
  let shm: SourceFileBlob | undefined;

  try {
    // The set budget bounds staged logical plaintext, so charge the plaintext
    // byte lengths — for a streamed main the declared logical size, BEFORE
    // any decrypt or staging work runs. Charging ciphertext sizes here would
    // re-reject encrypted sets whose plaintext fits but whose PKCS#7 padding
    // straddles the budget.
    if (
      mainSource.kind === "staged" &&
      mainSource.declaredByteLength > mainReadCap
    ) {
      throw new SourceFileTooLargeError(
        `Source file ${input.domain}/${input.relativePath} is larger than the read limit.`,
      );
    }
    let remainingSourceBytes = consumeSourceDatabaseBudget(
      input.budgetBytes,
      mainSource.kind === "blob"
        ? mainSource.blob.byteLength
        : mainSource.declaredByteLength,
    );
    wal = await readOptionalSidecar(
      input.manifest,
      input.domain,
      `${input.relativePath}-wal`,
      input.readSourceFile,
      boundToBudget
        ? Math.min(remainingSourceBytes, maxStagedSourceFileBytes)
        : maxStagedSourceFileBytes,
    );
    if (wal !== undefined) {
      remainingSourceBytes = consumeSourceDatabaseBudget(
        remainingSourceBytes,
        wal.byteLength,
      );
    }
    shm = await readOptionalSidecar(
      input.manifest,
      input.domain,
      `${input.relativePath}-shm`,
      input.readSourceFile,
      boundToBudget
        ? Math.min(remainingSourceBytes, maxStagedSourceFileBytes)
        : maxStagedSourceFileBytes,
    );
    if (shm !== undefined) {
      consumeSourceDatabaseBudget(
        remainingSourceBytes,
        shm.byteLength,
      );
    }

    const openSourceSqlite =
      getBackupSourceOverridesForTests().openSourceSqlite ??
      openSourceSqliteDatabase;
    let main: SourceFileInfo;
    let source: SourceSqliteDatabase;

    if (mainSource.kind === "blob") {
      main = mainSource.blob;
      source = await openSourceSqlite({
        backupId: input.backupId,
        label: input.role,
        main: mainSource.blob.blob,
        ...(wal === undefined ? {} : { wal: wal.blob }),
        ...(shm === undefined ? {} : { shm: shm.blob }),
      });
    } else {
      let stagedMain: SourceFileInfo | undefined;
      source = await openSourceSqlite({
        backupId: input.backupId,
        label: input.role,
        main: {
          declaredByteLength: mainSource.declaredByteLength,
          stage: async (destination) => {
            stagedMain = await mainSource.stage(mainSource.record, destination, {
              maxReadBytes: mainReadCap,
              includeSourceSha256: true,
            });
          },
        },
        ...(wal === undefined ? {} : { wal: wal.blob }),
        ...(shm === undefined ? {} : { shm: shm.blob }),
      });

      if (stagedMain === undefined) {
        // Defensive invariant: the opener must run the stage callback exactly
        // once before returning a usable database.
        const cleanupFailure = await cleanupSourceDatabases(source);

        if (cleanupFailure !== undefined) {
          console.warn(
            "Could not remove an unstaged source database.",
            cleanupFailure,
          );
        }
        throw new BackupIngestError(
          "backup_ingest_failed",
          `The source SQLite opener did not stage the ${input.role} main database.`,
          { domain: input.domain, relativePath: input.relativePath },
        );
      }
      main = stagedMain;
    }

    const sourceFiles = sourceFileEntries(input.role, main, wal, shm);

    return { source, sourceFiles };
  } finally {
    await Promise.all([
      ...(mainSource.kind === "blob" ? [mainSource.blob.cleanup()] : []),
      ...(wal === undefined ? [] : [wal.cleanup()]),
      ...(shm === undefined ? [] : [shm.cleanup()]),
    ]);
  }
}

function declaredEncryptedPlaintextByteLength(
  record: ManifestFileRecord,
): number {
  const size = record.metadata.size;

  if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new BackupSessionError(
      "backup_crypto_malformed",
      "An encrypted source database has malformed size metadata.",
      false,
      {
        fileId: record.fileId,
        domain: record.domain,
        relativePath: record.relativePath,
      },
    );
  }

  return size;
}

/**
 * Pre-prepare guard for a REQUIRED database set. The main record is required;
 * absent sidecars are allowed. Every present file is shape/budget checked and
 * encrypted keys are trial-unwrapped before any destructive db-worker call.
 */
export async function assertRequiredSourceDatabaseSetWithinBudget(input: {
  manifest: ManifestDbReader;
  root: ReadonlySourceDirectoryHandle;
  domain: string;
  relativePath: string;
  isEncrypted: boolean;
  budgetBytes?: number;
  verifyEncryptedFileKey?: (record: ManifestFileRecord) => Promise<void>;
}): Promise<void> {
  const budget = input.budgetBytes ?? maxStagedSourceDatabaseSetBytes;
  let remaining = budget;

  for (const relativePath of [
    input.relativePath,
    `${input.relativePath}-wal`,
    `${input.relativePath}-shm`,
  ]) {
    const record = input.manifest.findFile(input.domain, relativePath);

    if (record === undefined) {
      if (relativePath === input.relativePath) {
        throw new BackupIngestError(
          "backup_file_missing",
          `The backup's Manifest.db does not list ${input.domain}/${input.relativePath}.`,
          { domain: input.domain, relativePath: input.relativePath },
        );
      }
      continue;
    }

    const byteLength = await estimatePlaintextByteLength(
      input.root,
      record,
      input.isEncrypted,
    );

    if (input.isEncrypted) {
      if (input.verifyEncryptedFileKey === undefined) {
        throw new BackupSessionError(
          "backup_crypto_malformed",
          "The encrypted source database key verifier is unavailable.",
          false,
          {
            fileId: record.fileId,
            domain: record.domain,
            relativePath: record.relativePath,
          },
        );
      }

      await input.verifyEncryptedFileKey(record);
    }

    remaining = consumeSourceDatabaseBudget(remaining, byteLength);
  }

  await assertOpfsQuotaForSourceSet(budget - remaining);
}

async function estimatePlaintextByteLength(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  isEncrypted: boolean,
): Promise<number> {
  const file = await getStoredSourceFile(root, record);
  const metadataSize = record.metadata.size;
  const validMetadataSize =
    metadataSize !== undefined &&
    Number.isSafeInteger(metadataSize) &&
    metadataSize >= 0
      ? metadataSize
      : undefined;

  if (isEncrypted) {
    if (
      validMetadataSize === undefined ||
      validMetadataSize > maxStagedSourceFileBytes ||
      record.metadata.encryptionKey === undefined ||
      file.size % 16 !== 0 ||
      file.size > maxStagedSourceFileBytes
    ) {
      throw new BackupSessionError(
        "backup_crypto_malformed",
        "A required encrypted source database has malformed size or key metadata.",
        false,
        {
          fileId: record.fileId,
          domain: record.domain,
          relativePath: record.relativePath,
        },
      );
    }
    return validMetadataSize;
  }

  if (file.size > maxStagedSourceFileBytes) {
    throw new SourceFileTooLargeError(
      "A required source database exceeds the staged per-file sanity limit.",
    );
  }

  // Size probe only; no bytes are read. CBC never shrinks below plaintext
  // and unencrypted reads are truncated to a valid declared size, so the
  // stored size (capped by any valid metadata size) bounds what the read
  // will charge.
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
      "The combined source database main/WAL/SHM set exceeds the staged ingest sanity limit.",
    );
  }

  return remainingBytes - sourceByteLength;
}

async function assertOpfsQuotaForSourceSet(sourceSetBytes: number): Promise<void> {
  const availableBytes = await getAvailableOpfsQuotaBytes();

  // An unknown quota (no OPFS or estimate in this runtime) must never block.
  if (availableBytes === undefined) {
    return;
  }

  // Peak staging: encrypted WAL/SHM sidecars stage to transient OPFS while
  // the main database decrypt-streams directly into the source-sqlite
  // workspace file, which WAL reconstruction then grows (bounded by main +
  // WAL) before the sahpool import copies it once more. Sidecar-dominated
  // sets still approach 3x the logical set size, so the conservative 3x
  // reserve stays.
  const stagedBytes = sourceSetBytes * 3 + stagingQuotaReserveBytes;
  if (!Number.isSafeInteger(stagedBytes) || stagedBytes > availableBytes) {
    throw new SourceFileTooLargeError(
      "There is not enough local OPFS quota to stage the required source database before ingest.",
    );
  }
}

/** Exported for unit tests of the pre-staging optional-set bound. */
export async function openOptionalBackupDatabase(input: {
  backupId: string;
  manifest: ManifestDbReader;
  role: DatabaseRole;
  domain: string;
  relativePath: string;
  warnings: IngestWarning[];
  readSourceFile: BackupSourceBlobReader;
  stageSourceFile?: BackupSourceStager;
  budgetBytes: number;
}): Promise<OpenedBackupDatabase | undefined> {
  try {
    if (input.manifest.findFile(input.domain, input.relativePath) === undefined) {
      return undefined;
    }

    // Optional sets get no pre-prepare preflight, so every read and stage is
    // bounded by the remaining set budget before decrypt/staging I/O starts;
    // an over-budget or hostile declared Size degrades to the warning below.
    return await openBackupDatabase({ ...input, boundReadsToBudget: true });
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
  readSourceFile: BackupSourceBlobReader,
  maxReadBytes: number,
): Promise<SourceFileBlob | undefined> {
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
  main: SourceFileInfo,
  wal: SourceFileBlob | undefined,
  shm: SourceFileBlob | undefined,
): IngestSourceFile[] {
  return [
    sourceFileEntry(main, sourceRole(role, "db")),
    ...(wal === undefined ? [] : [sourceFileEntry(wal, sourceRole(role, "wal"))]),
    ...(shm === undefined ? [] : [sourceFileEntry(shm, sourceRole(role, "shm"))]),
  ];
}

function sourceFileEntry(
  source: SourceFileInfo,
  role: IngestSourceFile["role"],
): IngestSourceFile {
  return {
    role,
    fileId: source.record.fileId,
    domain: source.record.domain,
    relativePath: source.record.relativePath,
    sha256: source.sha256,
    bytes: source.byteLength,
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
        "A source database exceeds the staged-file sanity limit or available local storage quota.",
      recoverable: true,
      cause,
      details: { maxStagedSetBytes: maxStagedSourceDatabaseSetBytes },
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
