import {
  workerFail,
  workerOk,
  type CreateReportRequest,
  type DbMessageRecord,
  type DbReport,
  type DbReportItem,
  type DbReportSummary,
  type DbWorkerApi,
  type DeleteReportRequest,
  type GetMessageReportMembershipRequest,
  type GetMessageReportMembershipResponse,
  type GetReportRequest,
  type ListReportsRequest,
  type ListReportsResponse,
  type ReportCaseMetadata,
  type SaveReportRequest,
  type SetMessageReportMembershipRequest,
  type WorkerProgressCallback,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import { isObjectRecord } from "../shared/guards";
import { emitWorkerProgress } from "../shared/progress";
import {
  maxCaseFieldLength,
  maxReportItems,
  maxReportNoteLength,
  maxReportTitleLength,
} from "../shared/report-limits";
import {
  createOpfsDerivedDatabaseFactory,
  type DerivedDatabaseFactory,
} from "./ingest-sink";
import {
  hydrateConversations,
  hydrateMessages,
  readConversationsByIds,
  readMessagesByIds,
  toDbQueryWorkerError,
  toSafeNumber,
} from "./queries";
import type { DerivedSqliteDatabase } from "./schema";
import { runPrepared, selectRows, withTransaction } from "./sqlite-helpers";

type ReportApi = Pick<
  DbWorkerApi,
  | "listReports"
  | "createReport"
  | "getReport"
  | "getMessageReportMembership"
  | "setMessageReportMembership"
  | "saveReport"
  | "deleteReport"
>;

interface ReportRow extends Record<string, unknown> {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  caseMetaJson: string;
  itemCount: number | bigint;
}

interface ReportItemRow extends Record<string, unknown> {
  messageId: string;
  addedAt: string;
  note: string | null;
  position: number | bigint;
}

interface ReportIdRow extends Record<string, unknown> {
  reportId: string;
}

interface ExistingAddedAtRow extends Record<string, unknown> {
  messageId: string;
  addedAt: string;
}

export interface DbWorkerReportApiOptions {
  databaseFactory?: DerivedDatabaseFactory;
  now?: () => Date;
  randomId?: () => string;
}

export function createDbWorkerReportApi(
  options: DbWorkerReportApiOptions = {},
): ReportApi {
  const controller = new DbReportController(options);

  return {
    listReports: (request, progress) =>
      controller.listReports(request, progress),
    createReport: (request, progress) =>
      controller.createReport(request, progress),
    getReport: (request, progress) => controller.getReport(request, progress),
    getMessageReportMembership: (request, progress) =>
      controller.getMessageReportMembership(request, progress),
    setMessageReportMembership: (request, progress) =>
      controller.setMessageReportMembership(request, progress),
    saveReport: (request, progress) => controller.saveReport(request, progress),
    deleteReport: (request, progress) =>
      controller.deleteReport(request, progress),
  };
}

class DbReportController {
  private readonly databaseFactory: DerivedDatabaseFactory;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(options: DbWorkerReportApiOptions) {
    this.databaseFactory =
      options.databaseFactory ?? createOpfsDerivedDatabaseFactory();
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
  }

  async listReports(
    request: ListReportsRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<ListReportsResponse>> {
    return this.run(
      request.backupId,
      "Listing reports from the derived database failed.",
      { operation: "listReports" },
      progress,
      "Listing reports",
      (db) => ({ reports: readReportSummaries(db) }),
    );
  }

  async createReport(
    request: CreateReportRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<DbReportSummary>> {
    return this.run(
      request.backupId,
      "Creating the report failed.",
      { operation: "createReport" },
      progress,
      "Creating report",
      (db) => {
        const title = validateBoundedText(
          request.title,
          "title",
          maxReportTitleLength,
          false,
        );
        const timezone = validateTimezone(request.timezone);
        const id = this.randomId();
        const timestamp = this.now().toISOString();
        const caseMetadata: ReportCaseMetadata = {
          matter: "",
          preparer: "",
          timezone,
        };

        db.exec({
          sql: `
            INSERT INTO reports (
              id, title, created_at, updated_at, case_meta_json
            ) VALUES (?, ?, ?, ?, ?);
          `,
          bind: [id, title, timestamp, timestamp, JSON.stringify(caseMetadata)],
        });

        return requireReportSummary(db, id);
      },
    );
  }

  async getReport(
    request: GetReportRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<DbReport | undefined>> {
    return this.run(
      request.backupId,
      "Reading the report failed.",
      { operation: "getReport", reportId: request.reportId },
      progress,
      "Reading report",
      (db) => readReport(db, requireNonEmptyText(request.reportId, "reportId")),
    );
  }

  async getMessageReportMembership(
    request: GetMessageReportMembershipRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<GetMessageReportMembershipResponse>> {
    return this.run(
      request.backupId,
      "Reading report selections for the message failed.",
      {
        operation: "getMessageReportMembership",
        messageId: request.messageId,
      },
      progress,
      "Reading report selections",
      (db) => ({
        reportIds: readReportMemberships(
          db,
          requireNonEmptyText(request.messageId, "messageId"),
        ),
      }),
    );
  }

  async setMessageReportMembership(
    request: SetMessageReportMembershipRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<GetMessageReportMembershipResponse>> {
    return this.run(
      request.backupId,
      "Updating the report selection failed.",
      {
        operation: "setMessageReportMembership",
        messageId: request.messageId,
        reportId: request.reportId,
      },
      progress,
      "Updating report selection",
      (db) => {
        const messageId = requireNonEmptyText(request.messageId, "messageId");
        const reportId = requireNonEmptyText(request.reportId, "reportId");
        const timestamp = this.now().toISOString();

        withTransaction(db, () => {
          if (request.selected) {
            db.exec({
              sql: `
                INSERT OR IGNORE INTO report_items (
                  report_id, message_id, added_at, position, note
                ) VALUES (
                  ?, ?, ?,
                  COALESCE((SELECT MAX(position) + 1 FROM report_items WHERE report_id = ?), 0),
                  NULL
                );
              `,
              bind: [reportId, messageId, timestamp, reportId],
            });

            // Enforced on the picker's add path too — saveReport rejects
            // oversized reports, so unbounded adds would strand the report.
            const itemCount = toSafeNumber(
              db.selectValue(
                "SELECT COUNT(*) FROM report_items WHERE report_id = ?;",
                [reportId],
              ),
              "itemCount",
            );

            if (itemCount > maxReportItems) {
              throw new Error(
                `A report cannot contain more than ${String(maxReportItems)} items.`,
              );
            }
          } else {
            // Positions may become sparse after removal; nothing requires
            // density (reads order by position, inserts use MAX + 1, and
            // saveReport rewrites positions 0..n).
            db.exec({
              sql: "DELETE FROM report_items WHERE report_id = ? AND message_id = ?;",
              bind: [reportId, messageId],
            });
          }

          touchReport(db, reportId, timestamp);
        });

        return { reportIds: readReportMemberships(db, messageId) };
      },
    );
  }

  async saveReport(
    request: SaveReportRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<DbReport>> {
    return this.run(
      request.backupId,
      "Saving the report failed.",
      { operation: "saveReport", reportId: request.reportId },
      progress,
      "Saving report",
      (db) => {
        const reportId = requireNonEmptyText(request.reportId, "reportId");
        const title = validateBoundedText(
          request.title,
          "title",
          maxReportTitleLength,
          false,
        );
        const caseMetadata = validateCaseMetadata(request.caseMetadata);
        const items = validateSaveItems(request.items);
        const timestamp = this.now().toISOString();
        const existing = selectRows<ExistingAddedAtRow>(
          db,
          `
            SELECT message_id AS messageId, added_at AS addedAt
            FROM report_items
            WHERE report_id = ?;
          `,
          [reportId],
        );
        const addedAtByMessageId = new Map(
          existing.map((row) => [row.messageId, row.addedAt]),
        );

        withTransaction(db, () => {
          db.exec({
            sql: `
              UPDATE reports
              SET title = ?, updated_at = ?, case_meta_json = ?
              WHERE id = ?;
            `,
            bind: [title, timestamp, JSON.stringify(caseMetadata), reportId],
          });

          if (db.changes() === 0) {
            throw new Error(`Report "${reportId}" was not found.`);
          }

          db.exec({
            sql: "DELETE FROM report_items WHERE report_id = ?;",
            bind: [reportId],
          });

          const statement = db.prepare(`
            INSERT INTO report_items (
              report_id, message_id, added_at, position, note
            ) VALUES (?, ?, ?, ?, ?);
          `);

          try {
            items.forEach((item, position) => {
              runPrepared(statement, [
                reportId,
                item.messageId,
                addedAtByMessageId.get(item.messageId) ?? timestamp,
                position,
                item.note.length === 0 ? null : item.note,
              ]);
            });
          } finally {
            statement.finalize();
          }
        });

        const report = readReport(db, reportId);

        if (report === undefined) {
          throw new Error(`Report "${reportId}" was not found after saving.`);
        }

        return report;
      },
    );
  }

  async deleteReport(
    request: DeleteReportRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<boolean>> {
    return this.run(
      request.backupId,
      "Deleting the report failed.",
      { operation: "deleteReport", reportId: request.reportId },
      progress,
      "Deleting report",
      (db) => {
        const reportId = requireNonEmptyText(request.reportId, "reportId");

        // Delete items explicitly instead of relying on ON DELETE CASCADE:
        // foreign-key enforcement is per-connection in SQLite, so cascade
        // alone would orphan report_items on connections that never ran
        // PRAGMA foreign_keys = ON.
        return withTransaction(db, () => {
          db.exec({
            sql: "DELETE FROM report_items WHERE report_id = ?;",
            bind: [reportId],
          });
          db.exec({
            sql: "DELETE FROM reports WHERE id = ?;",
            bind: [reportId],
          });

          return db.changes() > 0;
        });
      },
    );
  }

  private async run<TValue>(
    backupId: string,
    fallbackMessage: string,
    details: Record<string, WorkerStructuredValue>,
    progress: WorkerProgressCallback | undefined,
    label: string,
    operation: (db: DerivedSqliteDatabase) => Promise<TValue> | TValue,
  ): Promise<WorkerResult<TValue>> {
    const errorDetails = { ...details, backupId };

    try {
      requireNonEmptyText(backupId, "backupId");
      await emitWorkerProgress("db", progress, "sqlite-query", label, 0, 1);
      const opened = await this.databaseFactory({ backupId });

      try {
        const value = await operation(opened.db);
        await emitWorkerProgress("db", progress, "complete", `${label} complete`, 1, 1);
        return workerOk(value);
      } finally {
        opened.close();
      }
    } catch (cause) {
      // toDbQueryWorkerError preserves typed DbQueryError/DbIngestError codes
      // (notably the factory's recoverable derived_db_pool_unavailable)
      // instead of flattening them to a generic sqlite_query_failed.
      return workerFail(toDbQueryWorkerError(cause, fallbackMessage, errorDetails));
    }
  }
}

function readReportSummaries(db: DerivedSqliteDatabase): DbReportSummary[] {
  const rows = selectRows<ReportRow>(
    db,
    `
      SELECT
        r.id,
        r.title,
        r.created_at AS createdAt,
        r.updated_at AS updatedAt,
        r.case_meta_json AS caseMetaJson,
        COUNT(ri.message_id) AS itemCount
      FROM reports r
      LEFT JOIN report_items ri ON ri.report_id = r.id
      GROUP BY r.id
      ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC;
    `,
  );
  const summaries: DbReportSummary[] = [];

  for (const row of rows) {
    try {
      summaries.push(mapReportRow(row));
    } catch {
      // Skip-and-continue: one corrupt stored row must not hide every other
      // report from the list.
    }
  }

  return summaries;
}

function requireReportSummary(
  db: DerivedSqliteDatabase,
  reportId: string,
): DbReportSummary {
  const report = requireOptionalReportSummary(db, reportId);

  if (report === undefined) {
    throw new Error(`Report "${reportId}" was not found.`);
  }

  return report;
}

function readReport(
  db: DerivedSqliteDatabase,
  reportId: string,
): DbReport | undefined {
  const summary = requireOptionalReportSummary(db, reportId);

  if (summary === undefined) {
    return undefined;
  }

  const rows = selectRows<ReportItemRow>(
    db,
    `
      SELECT
        message_id AS messageId,
        added_at AS addedAt,
        note,
        position
      FROM report_items
      WHERE report_id = ?
      ORDER BY position, added_at, message_id;
    `,
    [reportId],
  );
  const messagesById = readMessagesByIds(
    db,
    rows.map((row) => row.messageId),
  );
  const messages: DbMessageRecord[] = [];
  const conversationIds = new Set<string>();

  for (const message of messagesById.values()) {
    messages.push(message);
    conversationIds.add(message.conversationId);
  }

  const conversations = readConversationsByIds(db, [...conversationIds]);
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );

  hydrateMessages(db, messages);
  hydrateConversations(db, conversations);

  const items: DbReportItem[] = [];

  for (const row of rows) {
    const message = messagesById.get(row.messageId);

    if (message === undefined) {
      continue;
    }

    const conversation = conversationsById.get(message.conversationId);

    if (conversation === undefined) {
      continue;
    }

    items.push({
      message,
      conversation,
      addedAt: row.addedAt,
      note: typeof row.note === "string" ? row.note : "",
      position: toSafeNumber(row.position, "position"),
    });
  }

  return { ...summary, items };
}

function requireOptionalReportSummary(
  db: DerivedSqliteDatabase,
  reportId: string,
): DbReportSummary | undefined {
  const row = selectRows<ReportRow>(
    db,
    `
      SELECT
        r.id,
        r.title,
        r.created_at AS createdAt,
        r.updated_at AS updatedAt,
        r.case_meta_json AS caseMetaJson,
        COUNT(ri.message_id) AS itemCount
      FROM reports r
      LEFT JOIN report_items ri ON ri.report_id = r.id
      WHERE r.id = ?
      GROUP BY r.id;
    `,
    [reportId],
  ).at(0);

  return row === undefined ? undefined : mapReportRow(row);
}

/**
 * Read-side row mapping is deliberately lenient: stored rows were validated
 * when written, and re-validating against current bounds (or the current
 * runtime's timezone support) would make previously-valid reports unreadable.
 */
function mapReportRow(row: ReportRow): DbReportSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    caseMetadata: parseCaseMetadata(row.caseMetaJson),
    itemCount: toSafeNumber(row.itemCount, "itemCount"),
  };
}

function readReportMemberships(
  db: DerivedSqliteDatabase,
  messageId: string,
): string[] {
  return selectRows<ReportIdRow>(
    db,
    `
      SELECT report_id AS reportId
      FROM report_items
      WHERE message_id = ?
      ORDER BY report_id;
    `,
    [messageId],
  ).map((row) => row.reportId);
}

function touchReport(
  db: DerivedSqliteDatabase,
  reportId: string,
  updatedAt: string,
): void {
  db.exec({
    sql: "UPDATE reports SET updated_at = ? WHERE id = ?;",
    bind: [updatedAt, reportId],
  });

  if (db.changes() === 0) {
    throw new Error(`Report "${reportId}" was not found.`);
  }
}

function validateCaseMetadata(value: ReportCaseMetadata): ReportCaseMetadata {
  return {
    matter: validateBoundedText(
      value.matter,
      "matter",
      maxCaseFieldLength,
      true,
    ),
    preparer: validateBoundedText(
      value.preparer,
      "preparer",
      maxCaseFieldLength,
      true,
    ),
    timezone: validateTimezone(value.timezone),
  };
}

/**
 * Lenient read-side parse: a malformed stored payload or a timezone the
 * current runtime no longer supports degrades that report to defaults instead
 * of throwing and hiding the whole reports list.
 */
function parseCaseMetadata(value: string): ReportCaseMetadata {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }

  const record = isObjectRecord(parsed) ? parsed : {};
  const timezone =
    typeof record.timezone === "string" ? record.timezone : "UTC";

  return {
    matter: typeof record.matter === "string" ? record.matter : "",
    preparer: typeof record.preparer === "string" ? record.preparer : "",
    timezone: isSupportedTimezone(timezone) ? timezone : "UTC",
  };
}

function validateSaveItems(items: SaveReportRequest["items"]): SaveReportRequest["items"] {
  if (items.length > maxReportItems) {
    throw new Error(`A report cannot contain more than ${String(maxReportItems)} items.`);
  }

  const seen = new Set<string>();

  return items.map((item) => {
    const messageId = requireNonEmptyText(item.messageId, "messageId");

    if (seen.has(messageId)) {
      throw new Error(`Report item message "${messageId}" was repeated.`);
    }

    seen.add(messageId);
    return {
      messageId,
      note: validateBoundedText(
        item.note,
        "note",
        maxReportNoteLength,
        true,
      ),
    };
  });
}

function isSupportedTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validateTimezone(value: string): string {
  const timezone = requireNonEmptyText(value, "timezone");

  if (!isSupportedTimezone(timezone)) {
    throw new Error(`Report timezone "${timezone}" is not supported.`);
  }

  return timezone;
}

function validateBoundedText(
  value: string,
  field: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  const normalized = value.trim();

  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`Report ${field} cannot be empty.`);
  }

  if (normalized.length > maxLength) {
    throw new Error(`Report ${field} cannot exceed ${String(maxLength)} characters.`);
  }

  return normalized;
}

function requireNonEmptyText(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }

  return normalized;
}
