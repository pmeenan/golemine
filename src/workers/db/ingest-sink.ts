import { derivedDbVersion } from "../../lib/constants";
import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
  getDerivedDataDirectoryNames,
  removeEntryIfFound,
} from "../../lib/recents";
import {
  toWorkerError,
  workerFail,
  workerOk,
  type BackupDeviceInfo,
  type BackupIngestReport,
  type BackupIngestRequest,
  type DbIngestSummary,
  type DbWorkerApi,
  type IngestBatch,
  type IngestBatchReceipt,
  type IngestCounts,
  type NormalizedAttachment,
  type NormalizedContactAvatar,
  type NormalizedConversation,
  type NormalizedMessage,
  type NormalizedParticipant,
  type NormalizedReaction,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import { stableHash } from "../shared/hash";
import {
  getOpfsBackupDirectoryHandle,
  hasOpfsStorage,
  isSafeOpfsPathSegment,
} from "../shared/opfs";
import { isObjectRecord } from "../shared/guards";
import { emitWorkerProgress } from "../shared/progress";
import { retryAsyncOperation } from "../shared/retry";
import { classifySqliteWasmError } from "../shared/sqlite-errors";
import { getSqlite, type Sqlite3Api } from "../shared/sqlite-init";
import {
  contactAvatarRelativeDirectory,
  derivedDatabaseFilename,
  resetDerivedDatabaseSchema,
  type DerivedSqliteDatabase,
  type DerivedSqliteStatement,
} from "./schema";

type SahPool = Awaited<ReturnType<Sqlite3Api["installOpfsSAHPoolVfs"]>>;
/**
 * The installed @sqlite.org/sqlite-wasm index.d.ts omits the runtime-supported
 * `forceReinitIfPreviouslyFailed` option (present in the shipped
 * sqlite3-bundler-friendly.mjs option defaults), so extend the declared
 * options type here instead of casting at the call site.
 */
type InstallOpfsSahPoolVfsOptions = Parameters<
  Sqlite3Api["installOpfsSAHPoolVfs"]
>[0] & {
  forceReinitIfPreviouslyFailed?: boolean;
};
type SqliteBindValue = string | number | null | Uint8Array;
type IngestApi = Pick<
  DbWorkerApi,
  "prepareIngest" | "writeIngestBatch" | "finalizeIngest" | "getIngestSummary"
>;

export interface DerivedDatabaseOpenRequest {
  backupId: string;
  deviceInfo?: BackupDeviceInfo;
}

export interface OpenedDerivedDatabase {
  db: DerivedSqliteDatabase;
  databaseName: string;
  backupDirectoryName: string;
  close(): void;
}

export type DerivedDatabaseFactory = (
  request: DerivedDatabaseOpenRequest,
) => Promise<OpenedDerivedDatabase>;

export interface ContactAvatarStore {
  reset(backupDirectoryName: string): Promise<void>;
  write(
    backupDirectoryName: string,
    avatar: NormalizedContactAvatar,
  ): Promise<string>;
}

export interface DbWorkerIngestApiOptions {
  databaseFactory?: DerivedDatabaseFactory;
  avatarStore?: ContactAvatarStore;
  now?: () => Date;
}

interface ActiveIngestContext extends OpenedDerivedDatabase {
  request: BackupIngestRequest;
  preparedAt: string;
}

interface ContactAvatarRow {
  avatar: NormalizedContactAvatar;
  opfsPath: string;
  createdAt: string;
}

interface IngestMetaEntry {
  key: string;
  value: string;
}

const sqliteSahPoolDirectoryName = "sqlite-sahpool";
const sqliteSahPoolVfsPrefix = "golemine-db";
const sqliteSahPoolMinimumCapacity = 16;
const sha256HexPattern = /^[a-fA-F0-9]{64}$/u;
const ingestCountSql = {
  conversations: "SELECT COUNT(*) FROM conversations;",
  participants: "SELECT COUNT(*) FROM participants;",
  messages: "SELECT COUNT(*) FROM messages;",
  attachments: "SELECT COUNT(*) FROM attachments;",
  reactions: "SELECT COUNT(*) FROM reactions;",
  contact_avatars: "SELECT COUNT(*) FROM contact_avatars;",
} as const;

type IngestCountTable = keyof typeof ingestCountSql;

const sahPoolPromises = new Map<string, Promise<SahPool>>();

export function createDbWorkerIngestApi(
  options: DbWorkerIngestApiOptions = {},
): IngestApi {
  const controller = new DbIngestController(options);

  return {
    prepareIngest: (request, progress) =>
      controller.prepareIngest(request, progress),
    writeIngestBatch: (batch, progress) =>
      controller.writeIngestBatch(batch, progress),
    finalizeIngest: (report, progress) =>
      controller.finalizeIngest(report, progress),
    getIngestSummary: (backupId, progress) =>
      controller.getIngestSummary(backupId, progress),
  };
}

export function createOpfsDerivedDatabaseFactory(): DerivedDatabaseFactory {
  return async (request) => {
    if (!hasOpfsStorage()) {
      throw new DbIngestError({
        code: "sqlite_opfs_unavailable",
        message:
          "OPFS is not available in this runtime, so the derived database was not opened.",
        recoverable: false,
        details: { vfs: "opfs-sahpool" },
      });
    }

    const backupDirectoryName = getBackupDerivedDataDirectoryName(request);
    const sqlite3 = await getSqlite();
    const poolConfig = getSahPoolConfig(backupDirectoryName);
    let pool: SahPool | undefined;
    let db: DerivedSqliteDatabase;

    try {
      pool = await getSahPool(sqlite3, backupDirectoryName);
      db = new pool.OpfsSAHPoolDb(derivedDatabaseFilename);
    } catch (cause) {
      // Pool installation/open failures happen before anything destructive
      // runs (prepareIngest opens the DB before dropping schema or wiping the
      // avatar cache), so this distinct code tells callers the derived data
      // was NOT modified — e.g. another tab holds this backup's SAH pool.
      throw new DbIngestError({
        code: "derived_db_pool_unavailable",
        message:
          "The derived SQLite database could not be opened (its OPFS pool may be held by another tab). Existing derived data was not modified.",
        recoverable: true,
        details: {
          databaseName: derivedDatabaseFilename,
          vfs: "opfs-sahpool",
          opfsDirectory: poolConfig.opfsDirectory,
          vfsName: poolConfig.vfsName,
          minimumPoolCapacity: sqliteSahPoolMinimumCapacity,
          poolCapacity: pool?.getCapacity() ?? null,
          poolFileCount: pool?.getFileCount() ?? null,
        },
        cause,
      });
    }

    return {
      db,
      databaseName: derivedDatabaseFilename,
      backupDirectoryName,
      close: () => {
        db.close();
      },
    };
  };
}

export function createOpfsContactAvatarStore(): ContactAvatarStore {
  return {
    reset: async (backupDirectoryName) => {
      const backupDirectory = await getOpfsBackupDirectory(
        backupDirectoryName,
        true,
      );

      const thumbsDirectory = await backupDirectory.getDirectoryHandle("thumbs", {
        create: true,
      });

      await removeEntryIfFound(thumbsDirectory, "contact-avatars");
      await thumbsDirectory.getDirectoryHandle("contact-avatars", { create: true });
    },
    write: async (backupDirectoryName, avatar) => {
      const fileName = getContactAvatarFileName(avatar);
      const backupDirectory = await getOpfsBackupDirectory(
        backupDirectoryName,
        true,
      );
      const thumbsDirectory = await backupDirectory.getDirectoryHandle("thumbs", {
        create: true,
      });
      const avatarsDirectory = await thumbsDirectory.getDirectoryHandle(
        "contact-avatars",
        { create: true },
      );
      const fileHandle = await avatarsDirectory.getFileHandle(fileName, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      const bytes = new Uint8Array(avatar.bytes);

      try {
        await writable.write(bytes);
      } finally {
        await writable.close();
      }

      return `${contactAvatarRelativeDirectory}/${fileName}`;
    },
  };
}

class DbIngestController {
  private readonly databaseFactory: DerivedDatabaseFactory;
  private readonly avatarStore: ContactAvatarStore;
  private readonly now: () => Date;
  private readonly activeIngests = new Map<string, ActiveIngestContext>();

  constructor(options: DbWorkerIngestApiOptions) {
    this.databaseFactory =
      options.databaseFactory ?? createOpfsDerivedDatabaseFactory();
    this.avatarStore = options.avatarStore ?? createOpfsContactAvatarStore();
    this.now = options.now ?? (() => new Date());
  }

  async prepareIngest(
    request: BackupIngestRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<IngestBatchReceipt>> {
    return this.runWorkerOperation(
      "Preparing the derived message database failed.",
      { backupId: request.backupId, operation: "prepare" },
      async () => {
        await emitWorkerProgress("db", progress, "starting", "Preparing derived database", 0, 4);
        validateBackupIngestRequest(request);
        await requestStoragePersistence();

        const existing = this.activeIngests.get(request.backupId);

        if (existing !== undefined) {
          existing.close();
          this.activeIngests.delete(request.backupId);
        }

        await emitWorkerProgress("db", progress, "sqlite-init", "Opening derived SQLite database", 1, 4);
        const opened = await this.databaseFactory({
          backupId: request.backupId,
          deviceInfo: request.deviceInfo,
        });

        await emitWorkerProgress("db", progress, "sqlite-query", "Creating derived schema", 2, 4);
        resetDerivedDatabaseSchema(opened.db);

        await emitWorkerProgress("db", progress, "writing", "Resetting derived avatar cache", 3, 4);
        await this.avatarStore.reset(opened.backupDirectoryName);

        const preparedAt = this.now().toISOString();
        const context: ActiveIngestContext = {
          ...opened,
          request,
          preparedAt,
        };

        withTransaction(opened.db, () => {
          writeIngestMeta(opened.db, [
            { key: "backup_id", value: request.backupId },
            { key: "provider", value: request.provider },
            { key: "source_kind", value: request.sourceKind },
            { key: "source_folder_name", value: request.sourceFolderName },
            { key: "friendly_name", value: request.friendlyName },
            { key: "device_info_json", value: JSON.stringify(request.deviceInfo) },
            { key: "is_encrypted", value: String(request.isEncrypted) },
            { key: "derived_db_version", value: String(derivedDbVersion) },
            { key: "prepared_at", value: preparedAt },
          ]);
        });

        this.activeIngests.set(request.backupId, context);

        await emitWorkerProgress("db", progress, "complete", "Derived database is ready", 4, 4);

        return {
          backupId: request.backupId,
          kind: "prepare",
          accepted: 0,
        };
      },
    );
  }

  async writeIngestBatch(
    batch: IngestBatch,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<IngestBatchReceipt>> {
    return this.runWorkerOperation(
      "Writing a derived database ingest batch failed.",
      { backupId: batch.backupId, operation: "write", kind: batch.kind },
      async () => {
        const context = this.requireActiveIngest(batch.backupId);

        await emitWorkerProgress(
          "db",
          progress,
          "writing",
          `Writing ${batch.kind} batch`,
          0,
          batch.items.length,
        );

        const accepted = await this.writeBatchToContext(context, batch);

        await emitWorkerProgress(
          "db",
          progress,
          "writing",
          `Wrote ${batch.kind} batch`,
          accepted,
          batch.items.length,
        );

        return {
          backupId: batch.backupId,
          kind: batch.kind,
          accepted,
        };
      },
    );
  }

  async finalizeIngest(
    report: BackupIngestReport,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<DbIngestSummary>> {
    return this.runWorkerOperation(
      "Finalizing derived database ingest failed.",
      { backupId: report.backupId, operation: "finalize" },
      async () => {
        const context = this.requireActiveIngest(report.backupId);

        await emitWorkerProgress("db", progress, "writing", "Writing ingest summary", 0, 2);

        const counts = readStoredIngestCounts(
          context.db,
          report.warnings.length,
        );
        const summary: DbIngestSummary = {
          ...report,
          counts,
          databaseName: context.databaseName,
          derivedDbVersion,
        };

        withTransaction(context.db, () => {
          writeIngestMeta(context.db, createFinalizeMetadata(summary));
        });

        await emitWorkerProgress("db", progress, "complete", "Derived database ingest complete", 2, 2);

        this.activeIngests.delete(report.backupId);
        context.close();

        return summary;
      },
    );
  }

  async getIngestSummary(
    backupId: string,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<DbIngestSummary | undefined>> {
    return this.runWorkerOperation(
      "Reading the derived database ingest summary failed.",
      { backupId, operation: "summary" },
      async () => {
        await emitWorkerProgress("db", progress, "sqlite-query", "Reading ingest summary", 0, 1);

        const active = this.activeIngests.get(backupId);

        if (active !== undefined) {
          const summary = readDbIngestSummary(active.db);

          await emitWorkerProgress("db", progress, "complete", "Ingest summary read", 1, 1);

          return summary;
        }

        const opened = await this.databaseFactory({ backupId });

        try {
          const summary = readDbIngestSummary(opened.db);

          await emitWorkerProgress("db", progress, "complete", "Ingest summary read", 1, 1);

          return summary;
        } finally {
          opened.close();
        }
      },
    );
  }

  private async writeBatchToContext(
    context: ActiveIngestContext,
    batch: IngestBatch,
  ): Promise<number> {
    if (batch.kind === "contact-avatars") {
      const rows: ContactAvatarRow[] = [];

      for (const avatar of batch.items) {
        rows.push({
          avatar,
          opfsPath: await this.avatarStore.write(
            context.backupDirectoryName,
            avatar,
          ),
          createdAt: this.now().toISOString(),
        });
      }

      withTransaction(context.db, () => {
        insertContactAvatars(context.db, rows);
      });

      return batch.items.length;
    }

    writeEntityBatch(context.db, batch.kind, batch.items);

    return batch.items.length;
  }

  private requireActiveIngest(backupId: string): ActiveIngestContext {
    const context = this.activeIngests.get(backupId);

    if (context === undefined) {
      throw new DbIngestError({
        code: "db_ingest_failed",
        message: `No active ingest is prepared for backup "${backupId}".`,
        recoverable: true,
        details: { backupId },
      });
    }

    return context;
  }

  private async runWorkerOperation<TValue>(
    fallbackMessage: string,
    details: Record<string, WorkerStructuredValue>,
    operation: () => Promise<TValue>,
  ): Promise<WorkerResult<TValue>> {
    try {
      return workerOk(await operation());
    } catch (cause) {
      return workerFail(toDbWorkerError(cause, fallbackMessage, details));
    }
  }
}

export class DbIngestError extends Error {
  readonly code: WorkerErrorCode;
  readonly recoverable: boolean;
  readonly details?: Record<string, WorkerStructuredValue>;

  constructor(input: {
    code: WorkerErrorCode;
    message: string;
    recoverable: boolean;
    details?: Record<string, WorkerStructuredValue>;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "DbIngestError";
    this.code = input.code;
    this.recoverable = input.recoverable;
    this.details = input.details;
  }
}

function validateBackupIngestRequest(request: BackupIngestRequest): void {
  if (request.derivedDbVersion !== derivedDbVersion) {
    throw new DbIngestError({
      code: "db_ingest_failed",
      message: `Cannot prepare derived DB version ${String(request.derivedDbVersion)}; this build expects ${String(derivedDbVersion)}.`,
      recoverable: false,
      details: {
        backupId: request.backupId,
        requestedDerivedDbVersion: request.derivedDbVersion,
        derivedDbVersion,
      },
    });
  }
}

/**
 * Declarative upsert spec for one derived table. Table and column identifiers
 * are hardcoded constants below — never derived from backup content — so the
 * generated SQL contains no untrusted strings; backup values only ever flow
 * through bound parameters.
 */
interface EntityUpsertSpec<TItem> {
  table: string;
  conflictKey: string;
  columns: readonly string[];
  /**
   * Columns written on insert but left untouched by the ON CONFLICT update
   * set, so re-upserting an existing row cannot clobber values that other
   * writers (e.g. the contact-avatar back-reference update) own.
   */
  excludeFromUpdate?: readonly string[];
  values(item: TItem): SqliteBindValue[];
}

const participantUpsertSpec: EntityUpsertSpec<NormalizedParticipant> = {
  table: "participants",
  conflictKey: "id",
  columns: [
    "id",
    "handle",
    "kind",
    "contact_name",
    "is_self",
    "avatar_sha256",
    "avatar_mime",
    "avatar_path",
  ],
  // insertContactAvatars owns these back-references; a later participants
  // upsert must not wipe avatar links that were already written.
  excludeFromUpdate: ["avatar_sha256", "avatar_mime", "avatar_path"],
  values: (item) => [
    item.id,
    item.handle,
    item.kind,
    item.contactName ?? null,
    boolToSql(item.isSelf),
    item.avatarSha256 ?? null,
    item.avatarMime ?? null,
    null,
  ],
};

const conversationUpsertSpec: EntityUpsertSpec<NormalizedConversation> = {
  table: "conversations",
  conflictKey: "id",
  columns: [
    "id",
    "provider_key",
    "kind",
    "display_name",
    "service",
    "last_message_at",
    "message_count",
  ],
  values: (item) => [
    item.id,
    item.providerKey,
    item.kind,
    item.displayName ?? null,
    item.service ?? null,
    item.lastMessageAt ?? null,
    item.messageCount,
  ],
};

const messageUpsertSpec: EntityUpsertSpec<NormalizedMessage> = {
  table: "messages",
  conflictKey: "id",
  columns: [
    "id",
    "conversation_id",
    "sender_id",
    "sent_at_utc",
    "raw_timestamp",
    "body",
    "service",
    "is_from_me",
    "date_delivered",
    "date_read",
    "edited",
    "unsent",
    "source_guid",
    "source_rowid",
    "is_system_event",
  ],
  values: (item) => [
    item.id,
    item.conversationId,
    item.senderId ?? null,
    item.sentAtUtc ?? null,
    item.rawTimestamp,
    item.body,
    item.service ?? null,
    boolToSql(item.isFromMe),
    item.dateDelivered ?? null,
    item.dateRead ?? null,
    boolToSql(item.edited),
    boolToSql(item.unsent),
    item.sourceGuid ?? null,
    item.sourceRowId,
    boolToSql(item.isSystemEvent),
  ],
};

const attachmentUpsertSpec: EntityUpsertSpec<NormalizedAttachment> = {
  table: "attachments",
  conflictKey: "id",
  columns: [
    "id",
    "message_id",
    "filename",
    "mime",
    "bytes",
    "source_path",
    "source_domain",
    "sha256",
    "source_guid",
  ],
  values: (item) => [
    item.id,
    item.messageId,
    item.filename ?? null,
    item.mime ?? null,
    item.bytes ?? null,
    item.sourcePath ?? null,
    item.sourceDomain ?? null,
    item.sha256 ?? null,
    item.sourceGuid ?? null,
  ],
};

const reactionUpsertSpec: EntityUpsertSpec<NormalizedReaction> = {
  table: "reactions",
  conflictKey: "id",
  columns: [
    "id",
    "target_message_id",
    "sender_id",
    "kind",
    "sent_at_utc",
    "raw_timestamp",
    "source_guid",
    "source_rowid",
  ],
  values: (item) => [
    item.id,
    item.targetMessageId,
    item.senderId ?? null,
    item.kind,
    item.sentAtUtc ?? null,
    item.rawTimestamp,
    item.sourceGuid ?? null,
    item.sourceRowId,
  ],
};

const contactAvatarUpsertSpec: EntityUpsertSpec<ContactAvatarRow> = {
  table: "contact_avatars",
  conflictKey: "participant_id",
  columns: [
    "participant_id",
    "sha256",
    "mime",
    "byte_length",
    "opfs_path",
    "created_at",
  ],
  values: (row) => [
    row.avatar.participantId,
    row.avatar.sha256,
    row.avatar.mime,
    row.avatar.byteLength,
    row.opfsPath,
    row.createdAt,
  ],
};

type EntityBatch = Exclude<IngestBatch, { kind: "contact-avatars" }>;
type EntityBatchKind = EntityBatch["kind"];
type EntityBatchItems = {
  [K in EntityBatchKind]: Extract<EntityBatch, { kind: K }>["items"];
};

const entityBatchWriters: {
  [K in EntityBatchKind]: (
    db: DerivedSqliteDatabase,
    items: EntityBatchItems[K],
  ) => void;
} = {
  participants: (db, items) => {
    upsertMany(db, participantUpsertSpec, items);
  },
  conversations: (db, items) => {
    upsertMany(db, conversationUpsertSpec, items);
    replaceConversationParticipants(db, items);
  },
  messages: (db, items) => {
    upsertMany(db, messageUpsertSpec, items);
  },
  attachments: (db, items) => {
    upsertMany(db, attachmentUpsertSpec, items);
  },
  reactions: (db, items) => {
    upsertMany(db, reactionUpsertSpec, items);
  },
};

function writeEntityBatch<K extends EntityBatchKind>(
  db: DerivedSqliteDatabase,
  kind: K,
  items: EntityBatchItems[K],
): void {
  withTransaction(db, () => {
    entityBatchWriters[kind](db, items);
  });
}

function buildUpsertSql<TItem>(spec: EntityUpsertSpec<TItem>): string {
  const placeholders = spec.columns.map(() => "?").join(", ");
  const excludedFromUpdate = new Set(spec.excludeFromUpdate ?? []);
  const updates = spec.columns
    .filter(
      (column) => column !== spec.conflictKey && !excludedFromUpdate.has(column),
    )
    .map((column) => `${column} = excluded.${column}`)
    .join(",\n      ");

  return `
    INSERT INTO ${spec.table} (${spec.columns.join(", ")})
    VALUES (${placeholders})
    ON CONFLICT(${spec.conflictKey}) DO UPDATE SET
      ${updates};
  `;
}

function upsertMany<TItem>(
  db: DerivedSqliteDatabase,
  spec: EntityUpsertSpec<TItem>,
  items: readonly TItem[],
): void {
  const statement = db.prepare(buildUpsertSql(spec));

  try {
    for (const item of items) {
      runPrepared(statement, spec.values(item));
    }
  } finally {
    statement.finalize();
  }
}

function replaceConversationParticipants(
  db: DerivedSqliteDatabase,
  items: readonly NormalizedConversation[],
): void {
  const deleteStatement = db.prepare(
    "DELETE FROM conversation_participants WHERE conversation_id = ?;",
  );
  const insertStatement = db.prepare(`
    INSERT OR IGNORE INTO conversation_participants (
      conversation_id,
      participant_id
    )
    VALUES (?, ?);
  `);

  try {
    for (const item of items) {
      runPrepared(deleteStatement, [item.id]);

      for (const participantId of item.participantIds) {
        runPrepared(insertStatement, [item.id, participantId]);
      }
    }
  } finally {
    deleteStatement.finalize();
    insertStatement.finalize();
  }
}

function insertContactAvatars(
  db: DerivedSqliteDatabase,
  rows: readonly ContactAvatarRow[],
): void {
  upsertMany(db, contactAvatarUpsertSpec, rows);

  const participantStatement = db.prepare(`
    UPDATE participants
    SET avatar_sha256 = ?,
        avatar_mime = ?,
        avatar_path = ?
    WHERE id = ?;
  `);

  try {
    for (const row of rows) {
      runPrepared(participantStatement, [
        row.avatar.sha256,
        row.avatar.mime,
        row.opfsPath,
        row.avatar.participantId,
      ]);
    }
  } finally {
    participantStatement.finalize();
  }
}

function writeIngestMeta(
  db: DerivedSqliteDatabase,
  entries: readonly IngestMetaEntry[],
): void {
  const statement = db.prepare(`
    INSERT INTO ingest_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);

  try {
    for (const entry of entries) {
      runPrepared(statement, [entry.key, entry.value]);
    }
  } finally {
    statement.finalize();
  }
}

function createFinalizeMetadata(summary: DbIngestSummary): IngestMetaEntry[] {
  // summary_json is the only machine-read representation (readDbIngestSummary);
  // the scalar rows are cheap debugging aids for inspecting a derived DB directly.
  return [
    { key: "provider", value: summary.provider },
    { key: "started_at", value: summary.startedAt },
    { key: "completed_at", value: summary.completedAt },
    { key: "database_name", value: summary.databaseName },
    { key: "derived_db_version", value: String(summary.derivedDbVersion) },
    { key: "summary_json", value: JSON.stringify(summary) },
  ];
}

function readStoredIngestCounts(
  db: DerivedSqliteDatabase,
  warnings: number,
): IngestCounts {
  return {
    conversations: countRows(db, "conversations"),
    participants: countRows(db, "participants"),
    messages: countRows(db, "messages"),
    attachments: countRows(db, "attachments"),
    reactions: countRows(db, "reactions"),
    contactAvatars: countRows(db, "contact_avatars"),
    warnings,
  };
}

function countRows(db: DerivedSqliteDatabase, tableName: IngestCountTable): number {
  const value = db.selectValue(ingestCountSql[tableName]);

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new DbIngestError({
    code: "sqlite_query_failed",
    message: `Could not count rows in table "${tableName}".`,
    recoverable: true,
    details: { tableName },
  });
}

function readDbIngestSummary(
  db: DerivedSqliteDatabase,
): DbIngestSummary | undefined {
  let value: unknown;

  try {
    value = db.selectValue(
      "SELECT value FROM ingest_meta WHERE key = ?;",
      ["summary_json"],
    );
  } catch (cause) {
    if (isMissingIngestMetaTableError(cause)) {
      return undefined;
    }

    throw cause;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed: unknown = JSON.parse(value);

  if (!isDbIngestSummary(parsed)) {
    throw new DbIngestError({
      code: "db_ingest_failed",
      message: "The stored ingest summary is malformed.",
      recoverable: true,
    });
  }

  if (parsed.derivedDbVersion !== derivedDbVersion) {
    // A structurally-valid summary written by a different derivedDbVersion is
    // not malformed; it is simply stale. Treat it like the no-summary case so
    // callers fall back to the re-ingest path.
    return undefined;
  }

  return parsed;
}

function withTransaction<TValue>(
  db: DerivedSqliteDatabase,
  operation: () => TValue,
): TValue {
  db.exec("BEGIN IMMEDIATE;");

  try {
    const result = operation();

    db.exec("COMMIT;");

    return result;
  } catch (cause) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original failure; rollback errors are secondary cleanup.
    }

    throw cause;
  }
}

function runPrepared(
  statement: DerivedSqliteStatement,
  values: SqliteBindValue[],
): void {
  statement.clearBindings();
  statement.bind(values);
  statement.stepReset();
}

function boolToSql(value: boolean): number {
  return value ? 1 : 0;
}

async function getSahPool(
  sqlite3: Sqlite3Api,
  backupDirectoryName: string,
): Promise<SahPool> {
  const { opfsDirectory, vfsName } = getSahPoolConfig(backupDirectoryName);
  const existing = sahPoolPromises.get(opfsDirectory);

  if (existing !== undefined) {
    return existing;
  }

  // installOpfsSAHPoolVfs can transiently reject (e.g. with
  // NoModificationAllowedError) when a just-terminated worker's sync access
  // handles are still releasing during a route switch, so retry with a
  // growing backoff (total budget ~1.05 s; slow machines can take >450 ms to
  // release handles) before surfacing the failure.
  //
  // sqlite-wasm memoizes the install promise per VFS name and replays a
  // memoized REJECTION on re-call unless forceReinitIfPreviouslyFailed is set
  // (verified in sqlite-wasm 3.x sqlite3-bundler-friendly.mjs: option
  // defaults to false; on a memoized rejection it deletes the failed memo
  // and reinstalls). Without it every retry — and every later getSahPool
  // call after this worker's memo was deleted on failure — would just replay
  // the first failure. The option is a no-op when the memoized install
  // succeeded, so passing it on every attempt is safe.
  const installOptions: InstallOpfsSahPoolVfsOptions = {
    initialCapacity: sqliteSahPoolMinimumCapacity,
    name: vfsName,
    directory: opfsDirectory,
    forceReinitIfPreviouslyFailed: true,
  };
  const promise = retryAsyncOperation(
    () => sqlite3.installOpfsSAHPoolVfs(installOptions),
    { attempts: 4, delayMs: [150, 300, 600] },
  )
    .then(async (pool) => {
      await pool.reserveMinimumCapacity(sqliteSahPoolMinimumCapacity);

      return pool;
    })
    .catch((cause: unknown) => {
      sahPoolPromises.delete(opfsDirectory);
      throw cause;
    });

  sahPoolPromises.set(opfsDirectory, promise);

  return promise;
}

function getSahPoolConfig(backupDirectoryName: string): {
  opfsDirectory: string;
  vfsName: string;
} {
  const opfsDirectory = getBackupSqliteSahPoolDirectory(backupDirectoryName);

  return {
    opfsDirectory,
    vfsName: `${sqliteSahPoolVfsPrefix}-${stableHash(opfsDirectory)}`,
  };
}

function getBackupSqliteSahPoolDirectory(backupDirectoryName: string): string {
  const safeDirectoryName = assertSafeOpfsPathSegment(backupDirectoryName);

  return [
    "",
    derivedDataOpfsAppDirectoryName,
    derivedDataOpfsBackupsDirectoryName,
    safeDirectoryName,
    sqliteSahPoolDirectoryName,
  ].join("/");
}

function getBackupDerivedDataDirectoryName(
  request: Pick<DerivedDatabaseOpenRequest, "backupId" | "deviceInfo">,
): string {
  const names =
    request.deviceInfo === undefined
      ? [request.backupId.trim()]
      : getDerivedDataDirectoryNames({
          id: request.backupId,
          deviceInfo: request.deviceInfo,
        });

  const directoryName = names[0];

  if (directoryName.trim().length === 0) {
    throw new DbIngestError({
      code: "db_ingest_failed",
      message: "Cannot open derived data without a backup id or UDID.",
      recoverable: false,
    });
  }

  return assertSafeOpfsPathSegment(directoryName);
}

async function getOpfsBackupDirectory(
  backupDirectoryName: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  if (!hasOpfsStorage()) {
    throw new DbIngestError({
      code: "sqlite_opfs_unavailable",
      message:
        "OPFS is not available in this runtime, so avatar derived data was not opened.",
      recoverable: false,
      details: { storage: "opfs" },
    });
  }

  return getOpfsBackupDirectoryHandle(
    assertSafeOpfsPathSegment(backupDirectoryName),
    create,
  );
}

function getContactAvatarFileName(avatar: NormalizedContactAvatar): string {
  const sha256 = avatar.sha256.trim().toLowerCase();

  if (!sha256HexPattern.test(sha256)) {
    throw new DbIngestError({
      code: "db_ingest_failed",
      message: "Contact avatar SHA-256 was not a 64-character hex digest.",
      recoverable: true,
      details: { participantId: avatar.participantId },
    });
  }

  const extension = avatar.mime === "image/jpeg" ? "jpg" : "png";

  return `${sha256}.${extension}`;
}

function assertSafeOpfsPathSegment(value: string): string {
  if (!isSafeOpfsPathSegment(value)) {
    throw new DbIngestError({
      code: "db_ingest_failed",
      message: "Derived data directory name is not a safe OPFS path segment.",
      recoverable: false,
    });
  }

  return value.trim();
}

async function requestStoragePersistence(): Promise<void> {
  if (hasOpfsStorage() && typeof navigator.storage.persist === "function") {
    await navigator.storage.persist();
  }
}

function toDbWorkerError(
  cause: unknown,
  fallbackMessage: string,
  fallbackDetails: Record<string, WorkerStructuredValue>,
) {
  if (cause instanceof DbIngestError) {
    return toWorkerError({
      worker: "db",
      code: cause.code,
      message: cause.message,
      cause,
      recoverable: cause.recoverable,
      details: {
        ...fallbackDetails,
        ...(cause.details ?? {}),
      },
    });
  }

  return toWorkerError({
    worker: "db",
    code: classifySqliteWasmError(cause, "db_ingest_failed"),
    message: fallbackMessage,
    cause,
    recoverable: true,
    details: fallbackDetails,
  });
}

function isMissingIngestMetaTableError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("no such table: ingest_meta");
}

/**
 * Shallow structural check for a stored summary. This module wrote the JSON
 * itself and the derived-db-version gate handles schema drift, so per-field
 * deep guards are unnecessary. Providers stay agnostic: any non-empty provider
 * string is accepted. Version staleness is intentionally not checked here —
 * readDbIngestSummary treats a valid summary from another derivedDbVersion as
 * absent rather than malformed.
 */
function isDbIngestSummary(value: unknown): value is DbIngestSummary {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.derivedDbVersion === "number" &&
    isObjectRecord(value.counts) &&
    Object.values(value.counts).every(
      (count) => typeof count === "number" && Number.isFinite(count),
    ) &&
    Array.isArray(value.sourceFiles) &&
    Array.isArray(value.warnings)
  );
}
