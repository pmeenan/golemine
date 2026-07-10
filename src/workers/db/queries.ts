import {
  toWorkerError,
  workerFail,
  workerOk,
  type DbAttachmentMediaKind,
  type DbAttachmentSummary,
  type DbConversationSummary,
  type DbMessagePreview,
  type DbMessageRecord,
  type DbParticipantSummary,
  type DbReactionSummary,
  type DbSearchConversationSummary,
  type DbWorkerApi,
  type ListConversationsRequest,
  type ListConversationsResponse,
  type ListSearchConversationsRequest,
  type ListSearchConversationsResponse,
  type MessageDetailsRequest,
  type MessageDetailsResponse,
  type MessageTimelineMessagesPageResponse,
  type MessageTimelinePageRequest,
  type MessageTimelinePageResponse,
  type NormalizedConversationKind,
  type NormalizedParticipantKind,
  type NormalizedReactionKind,
  type SearchMessageResult,
  type SearchCoverage,
  type SearchConversationFilters,
  type SearchMessagesFilters,
  type SearchMessagesRequest,
  type SearchMessagesResponse,
  type SearchSnippetSegment,
  type WorkerErrorCode,
  type WorkerProgressCallback,
  type WorkerResult,
  type WorkerStructuredValue,
} from "../../lib/worker-types";
import {
  heicMimeTypes,
  nativeImageMimeTypes,
  normalizeMimeType,
} from "../shared/media-mime";
import {
  createThrottledWorkerProgress,
  emitWorkerProgress,
} from "../shared/progress";
import { classifyServiceKind } from "../shared/service-kind";
import { classifySqliteWasmError } from "../shared/sqlite-errors";
import {
  createOpfsDerivedDatabaseFactory,
  DbIngestError,
  type DerivedDatabaseFactory,
} from "./ingest-sink";
import type { DerivedSqliteDatabase } from "./schema";

type SqliteBindValue = string | number | null;
type QueryApi = Pick<
  DbWorkerApi,
  | "listConversations"
  | "listThreads"
  | "getMessageTimelinePage"
  | "getMessageTimelineMessagesPage"
  | "getMessageDetails"
  | "searchMessages"
  | "listSearchConversations"
>;

export interface DbWorkerQueryApiOptions {
  databaseFactory?: DerivedDatabaseFactory;
  /** Test seam; production uses `boundedSearchRowBudget`. */
  boundedSearchRowBudget?: number;
}

interface Pagination {
  limit: number;
  offset: number;
}

interface ConversationRow extends Record<string, unknown> {
  id: string;
  kind: string;
  displayName: string | null;
  service: string | null;
  lastMessageAt: string | null;
  messageCount: number | bigint;
}

interface ParticipantRow extends Record<string, unknown> {
  conversationId?: string;
  id: string;
  handle: string;
  kind: string;
  contactName: string | null;
  contactFirstName: string | null;
  isSelf: number | bigint;
  avatarSha256: string | null;
  avatarMime: string | null;
  avatarPath: string | null;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  conversationId: string;
  senderId: string | null;
  sentAtUtc: string | null;
  rawTimestamp: string;
  body: string;
  service: string | null;
  isFromMe: number | bigint;
  dateDelivered: string | null;
  dateRead: string | null;
  edited: number | bigint;
  unsent: number | bigint;
  sourceGuid: string | null;
  sourceRowId: number | bigint;
  isSystemEvent: number | bigint;
}

interface AttachmentRow extends Record<string, unknown> {
  id: string;
  messageId: string;
  filename: string | null;
  mime: string | null;
  bytes: number | bigint | null;
  sourcePath: string | null;
  sourceDomain: string | null;
  sha256: string | null;
  sourceGuid: string | null;
}

interface ReactionRow extends Record<string, unknown> {
  id: string;
  targetMessageId: string;
  senderId: string | null;
  kind: string;
  sentAtUtc: string | null;
  rawTimestamp: string;
  sourceGuid: string | null;
  sourceRowId: number | bigint;
}

interface MessageCountRow extends Record<string, unknown> {
  messageId: string;
  attachmentCount: number | bigint;
  reactionCount: number | bigint;
}

interface AnchorRow extends Record<string, unknown> {
  sentAtUtc: string | null;
  sourceRowId: number | bigint;
  id: string;
}

interface SearchMessageRow extends MessageRow {
  snippetText: string | null;
}

interface SearchConversationAggregateRow extends Record<string, unknown> {
  conversationId: string;
  hitCount: number | bigint;
  latestHitAtUtc: string | null;
}

interface SearchConversationCountsRow extends Record<string, unknown> {
  candidateRows: number | bigint;
  total: number | bigint;
}

const defaultPageLimit = 50;
const maxListLimit = 100;
const maxTimelineLimit = 200;
const maxSearchLimit = 100;
const previewLength = 160;
const maxSnippetLength = 220;
const snippetTokenCount = 32;
const snippetHighlightStart = "\u0001";
const snippetHighlightEnd = "\u0002";
const snippetEllipsis = "...";
const ftsTermPattern = /[\p{L}\p{N}_]+/gu;
const quotedFtsNarrowingTermPattern = /^[A-Za-z0-9_]+$/;
const definiteFtsSeparatorPattern =
  /[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}\p{Cs}\p{Cn}]/u;

/**
 * Maximum candidate messages examined newest-first by a quoted-literal
 * verification scan — both when the literal has no sound FTS5 narrowing key
 * (punctuation-only or a single mid-token substring) and when a narrowing key
 * matches more candidates than can be verified without stalling the worker.
 * The response coverage makes any omitted older rows explicit.
 */
export const boundedSearchRowBudget = 10_000;
const nativeImageExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const heicExtensions = new Set(["heic", "heif"]);
const videoExtensions = new Set([
  "3g2",
  "3gp",
  "avi",
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "webm",
]);

/**
 * Shared SELECT column list for message rows mapped by `MessageRow`. The
 * prefix is a compile-time literal at every call site ("" or "m."), never
 * backup content, so interpolating it keeps the SQL free of untrusted
 * strings (hard rule 4).
 */
function messageSelectColumns(prefix: "" | "m." = ""): string {
  return `
        ${prefix}id,
        ${prefix}conversation_id AS conversationId,
        ${prefix}sender_id AS senderId,
        ${prefix}sent_at_utc AS sentAtUtc,
        ${prefix}raw_timestamp AS rawTimestamp,
        ${prefix}body,
        ${prefix}service,
        ${prefix}is_from_me AS isFromMe,
        ${prefix}date_delivered AS dateDelivered,
        ${prefix}date_read AS dateRead,
        ${prefix}edited,
        ${prefix}unsent,
        ${prefix}source_guid AS sourceGuid,
        ${prefix}source_rowid AS sourceRowId,
        ${prefix}is_system_event AS isSystemEvent`;
}

/** Shared SELECT column list for conversation rows mapped by `ConversationRow`. */
const conversationSelectColumns = `
        id,
        kind,
        display_name AS displayName,
        service,
        last_message_at AS lastMessageAt,
        message_count AS messageCount`;

export function createDbWorkerQueryApi(
  options: DbWorkerQueryApiOptions = {},
): QueryApi {
  const controller = new DbQueryController(options);

  return {
    listConversations: (request, progress) =>
      controller.listConversations(request, progress),
    listThreads: (request, progress) =>
      controller.listConversations(request, progress),
    getMessageTimelinePage: (request, progress) =>
      controller.getMessageTimelinePage(request, progress),
    getMessageTimelineMessagesPage: (request, progress) =>
      controller.getMessageTimelineMessagesPage(request, progress),
    getMessageDetails: (request, progress) =>
      controller.getMessageDetails(request, progress),
    searchMessages: (request, progress) =>
      controller.searchMessages(request, progress),
    listSearchConversations: (request, progress) =>
      controller.listSearchConversations(request, progress),
  };
}

class DbQueryController {
  private readonly databaseFactory: DerivedDatabaseFactory;
  private readonly searchRowBudget: number;

  constructor(options: DbWorkerQueryApiOptions) {
    this.databaseFactory =
      options.databaseFactory ?? createOpfsDerivedDatabaseFactory();
    this.searchRowBudget = clampInteger(
      options.boundedSearchRowBudget ?? boundedSearchRowBudget,
      1,
      boundedSearchRowBudget,
    );
  }

  async listConversations(
    request: ListConversationsRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<ListConversationsResponse>> {
    return this.runWorkerOperation(
      "Listing conversations from the derived database failed.",
      { backupId: request.backupId, operation: "listConversations" },
      async () => {
        validateBackupId(request.backupId);
        const page = normalizePagination(request, maxListLimit);

        await emitWorkerProgress("db", progress, "sqlite-query", "Listing conversations", 0, 1);

        const opened = await this.databaseFactory({ backupId: request.backupId });

        try {
          const total = readCount(
            opened.db,
            "SELECT COUNT(*) FROM conversations;",
          );
          const conversations = readConversationPage(opened.db, page);

          hydrateConversations(opened.db, conversations);

          await emitWorkerProgress("db", progress, "complete", "Conversations listed", 1, 1);

          return {
            conversations,
            limit: page.limit,
            offset: page.offset,
            total,
          };
        } finally {
          opened.close();
        }
      },
    );
  }

  async getMessageTimelinePage(
    request: MessageTimelinePageRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<MessageTimelinePageResponse>> {
    return this.runWorkerOperation(
      "Reading a message timeline page from the derived database failed.",
      {
        backupId: request.backupId,
        operation: "getMessageTimelinePage",
        conversationId: request.conversationId,
      },
      async () => {
        validateBackupId(request.backupId);
        validateRequiredText(request.conversationId, "conversationId");
        const page = normalizePagination(request, maxTimelineLimit);

        await emitWorkerProgress("db", progress, "sqlite-query", "Reading message timeline", 0, 1);

        const opened = await this.databaseFactory({ backupId: request.backupId });

        try {
          const conversation = readConversation(opened.db, request.conversationId);

          if (conversation === undefined) {
            throw new DbQueryError({
              code: "sqlite_query_failed",
              message: `Conversation "${request.conversationId}" was not found in the derived database.`,
              recoverable: true,
              details: { conversationId: request.conversationId },
            });
          }

          hydrateConversations(opened.db, [conversation]);

          const total = readCount(
            opened.db,
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?;",
            [request.conversationId],
          );
          const anchorOffset =
            request.anchorMessageId === undefined
              ? undefined
              : readAnchorOffset(opened.db, request);
          const offset =
            anchorOffset === undefined
              ? (request.offset ?? Math.max(0, total - page.limit))
              : Math.max(0, anchorOffset - Math.floor(page.limit / 2));
          const messages = readMessagePage(opened.db, request.conversationId, {
            limit: page.limit,
            offset,
          });

          hydrateMessages(opened.db, messages);

          await emitWorkerProgress("db", progress, "complete", "Message timeline read", 1, 1);

          return {
            conversation,
            messages,
            limit: page.limit,
            offset,
            total,
            ...(request.anchorMessageId === undefined
              ? {}
              : { anchorMessageId: request.anchorMessageId }),
            ...(anchorOffset === undefined ? {} : { anchorOffset }),
            hasMoreBefore: offset > 0,
            hasMoreAfter: offset + messages.length < total,
          };
        } finally {
          opened.close();
        }
      },
    );
  }

  async getMessageTimelineMessagesPage(
    request: MessageTimelinePageRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<MessageTimelineMessagesPageResponse>> {
    return this.runWorkerOperation(
      "Reading a message timeline page from the derived database failed.",
      {
        backupId: request.backupId,
        operation: "getMessageTimelineMessagesPage",
        conversationId: request.conversationId,
      },
      async () => {
        validateBackupId(request.backupId);
        validateRequiredText(request.conversationId, "conversationId");
        const page = normalizePagination(request, maxTimelineLimit);

        await emitWorkerProgress("db", progress, "sqlite-query", "Reading message timeline", 0, 1);

        const opened = await this.databaseFactory({ backupId: request.backupId });

        try {
          // Load-more pagination intentionally skips conversation hydration:
          // the UI already holds the conversation from the first page.
          const total = readCount(
            opened.db,
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?;",
            [request.conversationId],
          );
          const anchorOffset =
            request.anchorMessageId === undefined
              ? undefined
              : readAnchorOffset(opened.db, request);
          const offset =
            anchorOffset === undefined
              ? (request.offset ?? Math.max(0, total - page.limit))
              : Math.max(0, anchorOffset - Math.floor(page.limit / 2));
          const messages = readMessagePage(opened.db, request.conversationId, {
            limit: page.limit,
            offset,
          });

          hydrateMessages(opened.db, messages);

          await emitWorkerProgress("db", progress, "complete", "Message timeline read", 1, 1);

          return {
            messages,
            limit: page.limit,
            offset,
            total,
            ...(request.anchorMessageId === undefined
              ? {}
              : { anchorMessageId: request.anchorMessageId }),
            ...(anchorOffset === undefined ? {} : { anchorOffset }),
            hasMoreBefore: offset > 0,
            hasMoreAfter: offset + messages.length < total,
          };
        } finally {
          opened.close();
        }
      },
    );
  }

  async getMessageDetails(
    request: MessageDetailsRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<MessageDetailsResponse | undefined>> {
    return this.runWorkerOperation(
      "Reading message details from the derived database failed.",
      {
        backupId: request.backupId,
        operation: "getMessageDetails",
        messageId: request.messageId,
      },
      async () => {
        validateBackupId(request.backupId);
        validateRequiredText(request.messageId, "messageId");

        await emitWorkerProgress("db", progress, "sqlite-query", "Reading message details", 0, 1);

        const opened = await this.databaseFactory({ backupId: request.backupId });

        try {
          const message = readMessageById(opened.db, request.messageId);

          if (message === undefined) {
            await emitWorkerProgress("db", progress, "complete", "Message details read", 1, 1);

            return undefined;
          }

          hydrateMessages(opened.db, [message]);

          const conversation = readConversation(opened.db, message.conversationId);

          if (conversation === undefined) {
            throw new DbQueryError({
              code: "sqlite_query_failed",
              message: `Conversation "${message.conversationId}" was not found for message "${message.id}".`,
              recoverable: true,
              details: {
                messageId: message.id,
                conversationId: message.conversationId,
              },
            });
          }

          hydrateConversations(opened.db, [conversation]);

          await emitWorkerProgress("db", progress, "complete", "Message details read", 1, 1);

          return { conversation, message };
        } finally {
          opened.close();
        }
      },
    );
  }

  async searchMessages(
    request: SearchMessagesRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<SearchMessagesResponse>> {
    return this.runWorkerOperation(
      "Searching messages in the derived database failed.",
      { backupId: request.backupId, operation: "searchMessages" },
      async () => {
        validateBackupId(request.backupId);
        const page = normalizePagination(request, maxSearchLimit);
        const compiled = compileUserTextToFtsExpression(request.text);

        if (!compiled.hasSearchCriteria) {
          return {
            results: [],
            queryTerms: [],
            limit: page.limit,
            offset: page.offset,
            total: 0,
            coverage: completeSearchCoverage(0),
          };
        }

        await emitWorkerProgress("db", progress, "sqlite-query", "Searching messages", 0, 1);

        const opened = await this.databaseFactory({ backupId: request.backupId });

        try {
          const searchPage = await readSearchMessagePage(
            opened.db,
            compiled,
            request.filters,
            page,
            this.searchRowBudget,
            progress,
          );
          const { rows } = searchPage;
          const messages = rows.map(mapMessageRow);
          const snippetByMessageId = new Map(
            rows.map((row) => [row.id, optionalString(row.snippetText)]),
          );

          hydrateMessages(opened.db, messages);

          const conversationIds = uniqueStrings(
            messages.map((message) => message.conversationId),
          );
          const conversations = readConversationsByIds(opened.db, conversationIds);
          const conversationById = new Map(
            conversations.map((conversation) => [conversation.id, conversation]),
          );

          hydrateConversations(opened.db, conversations);

          const results: SearchMessageResult[] = messages.flatMap((message) => {
            const conversation = conversationById.get(message.conversationId);

            if (conversation === undefined) {
              return [];
            }

            return [
              {
                message,
                conversation,
                snippets: buildSearchSnippetSegments(
                  snippetByMessageId.get(message.id),
                  message.body,
                  compiled,
                ),
              },
            ];
          });

          await emitWorkerProgress("db", progress, "complete", "Messages searched", 1, 1);

          return {
            results,
            queryTerms: compiled.terms,
            limit: page.limit,
            offset: page.offset,
            total: searchPage.total,
            coverage: searchPage.coverage,
          };
        } finally {
          opened.close();
        }
      },
    );
  }

  async listSearchConversations(
    request: ListSearchConversationsRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<ListSearchConversationsResponse>> {
    return this.runWorkerOperation(
      "Listing conversations with search hits failed.",
      { backupId: request.backupId, operation: "listSearchConversations" },
      async () => {
        validateBackupId(request.backupId);
        const page = normalizePagination(request, maxListLimit);
        const compiled = compileUserTextToFtsExpression(request.text);

        if (!compiled.hasSearchCriteria) {
          return {
            conversations: [],
            queryTerms: [],
            limit: page.limit,
            offset: page.offset,
            total: 0,
            coverage: completeSearchCoverage(0),
          };
        }

        await emitWorkerProgress(
          "db",
          progress,
          "sqlite-query",
          "Listing conversations with search hits",
          0,
          1,
        );

        const opened = await this.databaseFactory({ backupId: request.backupId });

        try {
          const searchPage = await readSearchConversationPage(
            opened.db,
            compiled,
            request.filters,
            page,
            this.searchRowBudget,
            progress,
          );

          hydrateConversations(opened.db, searchPage.conversations);

          await emitWorkerProgress(
            "db",
            progress,
            "complete",
            "Search conversations listed",
            1,
            1,
          );

          return {
            conversations: searchPage.conversations,
            queryTerms: compiled.terms,
            limit: page.limit,
            offset: page.offset,
            total: searchPage.total,
            coverage: searchPage.coverage,
          };
        } finally {
          opened.close();
        }
      },
    );
  }

  private async runWorkerOperation<TValue>(
    fallbackMessage: string,
    details: Record<string, WorkerStructuredValue>,
    operation: () => Promise<TValue>,
  ): Promise<WorkerResult<TValue>> {
    try {
      return workerOk(await operation());
    } catch (cause) {
      return workerFail(toDbQueryWorkerError(cause, fallbackMessage, details));
    }
  }
}

class DbQueryError extends Error {
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
    this.name = "DbQueryError";
    this.code = input.code;
    this.recoverable = input.recoverable;
    this.details = input.details;
  }
}

function readConversationPage(
  db: DerivedSqliteDatabase,
  page: Pagination,
): DbConversationSummary[] {
  const rows = selectRows<ConversationRow>(
    db,
    `
      SELECT${conversationSelectColumns}
      FROM conversations
      ORDER BY last_message_at IS NULL, last_message_at DESC, id DESC
      LIMIT ? OFFSET ?;
    `,
    [page.limit, page.offset],
  );

  return rows.map(mapConversationRow);
}

function readConversation(
  db: DerivedSqliteDatabase,
  conversationId: string,
): DbConversationSummary | undefined {
  const row = selectRows<ConversationRow>(
    db,
    `
      SELECT${conversationSelectColumns}
      FROM conversations
      WHERE id = ?;
    `,
    [conversationId],
  ).at(0);

  return row === undefined ? undefined : mapConversationRow(row);
}

function readConversationsByIds(
  db: DerivedSqliteDatabase,
  conversationIds: readonly string[],
): DbConversationSummary[] {
  if (conversationIds.length === 0) {
    return [];
  }

  const placeholders = createPlaceholders(conversationIds.length);
  const rows = selectRows<ConversationRow>(
    db,
    `
      SELECT${conversationSelectColumns}
      FROM conversations
      WHERE id IN (${placeholders})
      ORDER BY last_message_at IS NULL, last_message_at DESC, id DESC;
    `,
    [...conversationIds],
  );

  return rows.map(mapConversationRow);
}

function hydrateConversations(
  db: DerivedSqliteDatabase,
  conversations: DbConversationSummary[],
): void {
  if (conversations.length === 0) {
    return;
  }

  const conversationIds = conversations.map((conversation) => conversation.id);
  const participantsByConversation = readParticipantsForConversations(
    db,
    conversationIds,
  );
  const lastMessagesByConversation = readLastMessagesForConversations(
    db,
    conversationIds,
  );

  hydrateMessagePreviews(db, [...lastMessagesByConversation.values()]);

  for (const conversation of conversations) {
    conversation.participants =
      participantsByConversation.get(conversation.id) ?? [];
    conversation.lastMessage = lastMessagesByConversation.get(conversation.id);
  }
}

function readParticipantsForConversations(
  db: DerivedSqliteDatabase,
  conversationIds: readonly string[],
): Map<string, DbParticipantSummary[]> {
  if (conversationIds.length === 0) {
    return new Map();
  }

  const placeholders = createPlaceholders(conversationIds.length);
  const rows = selectRows<ParticipantRow>(
    db,
    `
      SELECT
        cp.conversation_id AS conversationId,
        p.id,
        p.handle,
        p.kind,
        p.contact_name AS contactName,
        p.contact_first_name AS contactFirstName,
        p.is_self AS isSelf,
        p.avatar_sha256 AS avatarSha256,
        p.avatar_mime AS avatarMime,
        p.avatar_path AS avatarPath
      FROM conversation_participants cp
      JOIN participants p ON p.id = cp.participant_id
      WHERE cp.conversation_id IN (${placeholders})
      ORDER BY cp.conversation_id, p.is_self, COALESCE(p.contact_name, p.handle), p.id;
    `,
    [...conversationIds],
  );
  const byConversation = new Map<string, DbParticipantSummary[]>();

  for (const row of rows) {
    const conversationId = requireString(row.conversationId, "conversationId");
    const participants = byConversation.get(conversationId) ?? [];

    participants.push(mapParticipantRow(row));
    byConversation.set(conversationId, participants);
  }

  return byConversation;
}

function readLastMessagesForConversations(
  db: DerivedSqliteDatabase,
  conversationIds: readonly string[],
): Map<string, DbMessagePreview> {
  if (conversationIds.length === 0) {
    return new Map();
  }

  // One correlated LIMIT-1 lookup per listed conversation instead of
  // window-ranking every message of those conversations. The subquery's
  // ordering must stay identical to the previous ROW_NUMBER() ordering:
  // COALESCE(sent_at_utc, '') DESC, source_rowid DESC, id DESC.
  const placeholders = createPlaceholders(conversationIds.length);
  const rows = selectRows<MessageRow>(
    db,
    `
      SELECT${messageSelectColumns("m.")}
      FROM conversations c
      JOIN messages m ON m.id = (
        SELECT m2.id
        FROM messages m2
        WHERE m2.conversation_id = c.id
        ORDER BY COALESCE(m2.sent_at_utc, '') DESC, m2.source_rowid DESC, m2.id DESC
        LIMIT 1
      )
      WHERE c.id IN (${placeholders});
    `,
    [...conversationIds],
  );
  const byConversation = new Map<string, DbMessagePreview>();

  for (const row of rows) {
    const preview = mapMessagePreview(row);

    byConversation.set(preview.conversationId, preview);
  }

  return byConversation;
}

function readMessagePage(
  db: DerivedSqliteDatabase,
  conversationId: string,
  page: Pagination,
): DbMessageRecord[] {
  const rows = selectRows<MessageRow>(
    db,
    `
      SELECT${messageSelectColumns()}
      FROM messages
      WHERE conversation_id = ?
      ORDER BY COALESCE(sent_at_utc, ''), source_rowid, id
      LIMIT ? OFFSET ?;
    `,
    [conversationId, page.limit, page.offset],
  );

  return rows.map(mapMessageRow);
}

function readMessageById(
  db: DerivedSqliteDatabase,
  messageId: string,
): DbMessageRecord | undefined {
  const row = selectRows<MessageRow>(
    db,
    `
      SELECT${messageSelectColumns()}
      FROM messages
      WHERE id = ?;
    `,
    [messageId],
  ).at(0);

  return row === undefined ? undefined : mapMessageRow(row);
}

function hydrateMessagePreviews(
  db: DerivedSqliteDatabase,
  messages: DbMessagePreview[],
): void {
  if (messages.length === 0) {
    return;
  }

  const countsByMessage = readMessageCounts(
    db,
    messages.map((message) => message.id),
  );
  const senders = readParticipantsByIds(
    db,
    uniqueStrings(messages.flatMap((message) => optionalArray(message.senderId))),
  );

  for (const message of messages) {
    const counts = countsByMessage.get(message.id);

    message.attachmentCount = counts?.attachmentCount ?? 0;
    message.reactionCount = counts?.reactionCount ?? 0;

    if (message.senderId !== undefined) {
      message.sender = senders.get(message.senderId);
    }
  }
}

function hydrateMessages(
  db: DerivedSqliteDatabase,
  messages: DbMessageRecord[],
): void {
  if (messages.length === 0) {
    return;
  }

  const messageIds = messages.map((message) => message.id);
  const senderIds = uniqueStrings(
    messages.flatMap((message) => optionalArray(message.senderId)),
  );
  const attachmentsByMessage = readAttachmentsForMessages(db, messageIds);
  const reactionsByMessage = readReactionsForMessages(db, messageIds);

  for (const reactions of reactionsByMessage.values()) {
    for (const reaction of reactions) {
      if (reaction.senderId !== undefined) {
        senderIds.push(reaction.senderId);
      }
    }
  }

  const senders = readParticipantsByIds(db, uniqueStrings(senderIds));

  for (const message of messages) {
    message.attachments = attachmentsByMessage.get(message.id) ?? [];
    message.reactions = reactionsByMessage.get(message.id) ?? [];

    if (message.senderId !== undefined) {
      message.sender = senders.get(message.senderId);
    }

    for (const reaction of message.reactions) {
      if (reaction.senderId !== undefined) {
        reaction.sender = senders.get(reaction.senderId);
      }
    }
  }
}

function readParticipantsByIds(
  db: DerivedSqliteDatabase,
  participantIds: readonly string[],
): Map<string, DbParticipantSummary> {
  if (participantIds.length === 0) {
    return new Map();
  }

  const placeholders = createPlaceholders(participantIds.length);
  const rows = selectRows<ParticipantRow>(
    db,
    `
      SELECT
        id,
        handle,
        kind,
        contact_name AS contactName,
        contact_first_name AS contactFirstName,
        is_self AS isSelf,
        avatar_sha256 AS avatarSha256,
        avatar_mime AS avatarMime,
        avatar_path AS avatarPath
      FROM participants
      WHERE id IN (${placeholders});
    `,
    [...participantIds],
  );

  return new Map(rows.map((row) => [row.id, mapParticipantRow(row)]));
}

function readAttachmentsForMessages(
  db: DerivedSqliteDatabase,
  messageIds: readonly string[],
): Map<string, DbAttachmentSummary[]> {
  if (messageIds.length === 0) {
    return new Map();
  }

  const placeholders = createPlaceholders(messageIds.length);
  const rows = selectRows<AttachmentRow>(
    db,
    `
      SELECT
        id,
        message_id AS messageId,
        filename,
        mime,
        bytes,
        source_path AS sourcePath,
        source_domain AS sourceDomain,
        sha256,
        source_guid AS sourceGuid
      FROM attachments
      WHERE message_id IN (${placeholders})
      ORDER BY message_id, id;
    `,
    [...messageIds],
  );
  const byMessage = new Map<string, DbAttachmentSummary[]>();

  for (const row of rows) {
    const attachment = mapAttachmentRow(row);
    const attachments = byMessage.get(attachment.messageId) ?? [];

    attachments.push(attachment);
    byMessage.set(attachment.messageId, attachments);
  }

  return byMessage;
}

function readReactionsForMessages(
  db: DerivedSqliteDatabase,
  messageIds: readonly string[],
): Map<string, DbReactionSummary[]> {
  if (messageIds.length === 0) {
    return new Map();
  }

  const placeholders = createPlaceholders(messageIds.length);
  const rows = selectRows<ReactionRow>(
    db,
    `
      SELECT
        id,
        target_message_id AS targetMessageId,
        sender_id AS senderId,
        kind,
        sent_at_utc AS sentAtUtc,
        raw_timestamp AS rawTimestamp,
        source_guid AS sourceGuid,
        source_rowid AS sourceRowId
      FROM reactions
      WHERE target_message_id IN (${placeholders})
      ORDER BY target_message_id, COALESCE(sent_at_utc, ''), source_rowid, id;
    `,
    [...messageIds],
  );
  const byMessage = new Map<string, DbReactionSummary[]>();

  for (const row of rows) {
    const reaction = mapReactionRow(row);
    const reactions = byMessage.get(reaction.targetMessageId) ?? [];

    reactions.push(reaction);
    byMessage.set(reaction.targetMessageId, reactions);
  }

  return byMessage;
}

function readMessageCounts(
  db: DerivedSqliteDatabase,
  messageIds: readonly string[],
): Map<string, { attachmentCount: number; reactionCount: number }> {
  if (messageIds.length === 0) {
    return new Map();
  }

  const placeholders = createPlaceholders(messageIds.length);
  const rows = selectRows<MessageCountRow>(
    db,
    `
      SELECT
        m.id AS messageId,
        COUNT(DISTINCT a.id) AS attachmentCount,
        COUNT(DISTINCT r.id) AS reactionCount
      FROM messages m
      LEFT JOIN attachments a ON a.message_id = m.id
      LEFT JOIN reactions r ON r.target_message_id = m.id
      WHERE m.id IN (${placeholders})
      GROUP BY m.id;
    `,
    [...messageIds],
  );

  return new Map(
    rows.map((row) => [
      row.messageId,
      {
        attachmentCount: toSafeNumber(row.attachmentCount, "attachmentCount"),
        reactionCount: toSafeNumber(row.reactionCount, "reactionCount"),
      },
    ]),
  );
}

function readAnchorOffset(
  db: DerivedSqliteDatabase,
  request: MessageTimelinePageRequest,
): number | undefined {
  if (request.anchorMessageId === undefined) {
    return undefined;
  }

  const anchor = selectRows<AnchorRow>(
    db,
    `
      SELECT
        sent_at_utc AS sentAtUtc,
        source_rowid AS sourceRowId,
        id
      FROM messages
      WHERE id = ? AND conversation_id = ?;
    `,
    [request.anchorMessageId, request.conversationId],
  ).at(0);

  if (anchor === undefined) {
    return undefined;
  }

  const sentAtUtc = anchor.sentAtUtc ?? "";
  const sourceRowId = toSafeNumber(anchor.sourceRowId, "sourceRowId");

  return readCount(
    db,
    `
      SELECT COUNT(*)
      FROM messages
      WHERE conversation_id = ?
        AND (
          COALESCE(sent_at_utc, '') < ?
          OR (
            COALESCE(sent_at_utc, '') = ?
            AND source_rowid < ?
          )
          OR (
            COALESCE(sent_at_utc, '') = ?
            AND source_rowid = ?
            AND id < ?
          )
        );
    `,
    [
      request.conversationId,
      sentAtUtc,
      sentAtUtc,
      sourceRowId,
      sentAtUtc,
      sourceRowId,
      anchor.id,
    ],
  );
}

export interface CompiledFtsText {
  expression: string;
  terms: string[];
  /** Terms typed outside quotes; snippet builders highlight these too. */
  unquotedTerms: string[];
  quotedSubstrings: string[];
  hasSearchCriteria: boolean;
  requiresVerification: boolean;
}

export function compileUserTextToFtsExpression(text: string): CompiledFtsText {
  const parts = parseUserSearchText(text);
  const allTerms: string[] = [];
  const allUnquotedTerms: string[] = [];
  const allNarrowingTerms: string[] = [];
  const quotedSubstrings: string[] = [];
  let unquotedTermCount = 0;

  for (const part of parts) {
    const partTerms = readFtsTerms(part.text);

    allTerms.push(...partTerms);

    if (!part.quoted) {
      allNarrowingTerms.push(...partTerms);
      allUnquotedTerms.push(...partTerms);
      unquotedTermCount += partTerms.length;
      continue;
    }

    if (part.text.length === 0) {
      continue;
    }

    quotedSubstrings.push(part.text);
    allNarrowingTerms.push(
      ...Array.from(part.text.matchAll(ftsTermPattern), (match) => ({
        term: match[0],
        index: match.index,
      }))
        // A token whose left boundary is inside the literal must begin at an
        // FTS token boundary in every raw substring match. It is therefore a
        // sound prefix narrowing key. A token with no known separator on its
        // left may begin mid-token ("rass" in "brass") and must never be used
        // to exclude candidates. Quoted verification uses JavaScript's newer
        // Unicode case folding, so only ASCII terms may gate SQLite unicode61
        // candidates without risking version-skew false negatives.
        .filter(({ index }) => hasSoundFtsLeftBoundary(part.text, index))
        .filter(({ term }) => quotedFtsNarrowingTermPattern.test(term))
        .map(({ term }) => term),
    );
  }

  const terms = uniqueCaseFoldedStrings(allTerms);
  const narrowingTerms = uniqueCaseFoldedStrings(allNarrowingTerms);

  return {
    expression: narrowingTerms.map(quoteFtsPrefixTerm).join(" "),
    terms,
    unquotedTerms: uniqueCaseFoldedStrings(allUnquotedTerms),
    quotedSubstrings,
    hasSearchCriteria:
      unquotedTermCount > 0 || quotedSubstrings.length > 0,
    requiresVerification: quotedSubstrings.length > 0,
  };
}

interface UserSearchTextPart {
  text: string;
  quoted: boolean;
}

function parseUserSearchText(text: string): UserSearchTextPart[] {
  const parts: UserSearchTextPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const quoteStart = text.indexOf('"', cursor);

    if (quoteStart < 0) {
      parts.push({ text: text.slice(cursor), quoted: false });
      break;
    }

    if (quoteStart > cursor) {
      parts.push({ text: text.slice(cursor, quoteStart), quoted: false });
    }

    const quoteEnd = text.indexOf('"', quoteStart + 1);

    if (quoteEnd < 0) {
      parts.push({ text: text.slice(quoteStart + 1), quoted: true });
      break;
    }

    parts.push({
      text: text.slice(quoteStart + 1, quoteEnd),
      quoted: true,
    });
    cursor = quoteEnd + 1;
  }

  return parts;
}

function readFtsTerms(text: string): string[] {
  return Array.from(text.matchAll(ftsTermPattern), (match) => match[0]).filter(
    (term) => term.length > 0,
  );
}

function hasSoundFtsLeftBoundary(literal: string, tokenIndex: number): boolean {
  const precedingCodePoint = Array.from(literal.slice(0, tokenIndex)).at(-1);

  return (
    precedingCodePoint !== undefined &&
    definiteFtsSeparatorPattern.test(precedingCodePoint)
  );
}

function quoteFtsPrefixTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"*`;
}

interface SearchSql {
  fromSql: string;
  whereSql: string;
  bind: SqliteBindValue[];
  usesFts: boolean;
}

function buildSearchSql(
  filters: SearchMessagesFilters | undefined,
  ftsExpression?: string,
): SearchSql {
  const usesFts = ftsExpression !== undefined && ftsExpression.length > 0;
  const predicates: string[] = [];
  const bind: SqliteBindValue[] = [];

  if (usesFts) {
    predicates.push("messages_fts MATCH ?");
    bind.push(ftsExpression);
  }

  if (filters?.conversationId !== undefined) {
    validateRequiredText(filters.conversationId, "conversationId");
    predicates.push("m.conversation_id = ?");
    bind.push(filters.conversationId);
  }

  if (filters?.participantId !== undefined) {
    validateRequiredText(filters.participantId, "participantId");
    predicates.push(`
      EXISTS (
        SELECT 1
        FROM conversation_participants cp_filter
        WHERE cp_filter.conversation_id = m.conversation_id
          AND cp_filter.participant_id = ?
      )
    `);
    bind.push(filters.participantId);
  }

  if (filters?.participantQuery !== undefined) {
    const participantQuery = filters.participantQuery.trim();

    if (participantQuery.length > 0) {
      predicates.push(`
        EXISTS (
          SELECT 1
          FROM conversation_participants cp_match
          JOIN participants p_match ON p_match.id = cp_match.participant_id
          WHERE cp_match.conversation_id = m.conversation_id
            AND (
              LOWER(p_match.handle) LIKE LOWER(?) ESCAPE '\\'
              OR LOWER(COALESCE(p_match.contact_name, '')) LIKE LOWER(?) ESCAPE '\\'
            )
        )
      `);
      const pattern = `%${escapeLikePattern(participantQuery)}%`;

      bind.push(pattern, pattern);
    }
  }

  if (filters?.fromUtc !== undefined) {
    validateRequiredText(filters.fromUtc, "fromUtc");
    predicates.push("m.sent_at_utc >= ?");
    bind.push(filters.fromUtc);
  }

  if (filters?.toUtcExclusive !== undefined) {
    validateRequiredText(filters.toUtcExclusive, "toUtcExclusive");
    predicates.push("m.sent_at_utc < ?");
    bind.push(filters.toUtcExclusive);
  }

  if (filters?.hasAttachment === true) {
    predicates.push(`
      EXISTS (
        SELECT 1
        FROM attachments a_filter
        WHERE a_filter.message_id = m.id
      )
    `);
  } else if (filters?.hasAttachment === false) {
    predicates.push(`
      NOT EXISTS (
        SELECT 1
        FROM attachments a_filter
        WHERE a_filter.message_id = m.id
      )
    `);
  }

  return {
    fromSql: usesFts
      ? `
          FROM messages_fts
          JOIN messages m ON m.rowid = messages_fts.rowid
        `
      : "FROM messages m",
    whereSql:
      predicates.length === 0
        ? ""
        : `WHERE ${predicates.join("\n        AND ")}`,
    bind,
    usesFts,
  };
}

interface SearchMessagePageResult {
  rows: SearchMessageRow[];
  total: number;
  coverage: SearchCoverage;
}

interface SearchConversationPageResult {
  conversations: DbSearchConversationSummary[];
  total: number;
  coverage: SearchCoverage;
}

interface ConversationHitAggregate {
  conversationId: string;
  hitCount: number;
  latestHitAtUtc?: string;
}

interface VerifiedSearchScan {
  rows: SearchMessageRow[];
  total: number;
  conversationHits: ConversationHitAggregate[];
  coverage: SearchCoverage;
}

async function readSearchMessagePage(
  db: DerivedSqliteDatabase,
  compiled: CompiledFtsText,
  filters: SearchMessagesFilters | undefined,
  page: Pagination,
  rowBudget: number,
  progress?: WorkerProgressCallback,
): Promise<SearchMessagePageResult> {
  if (compiled.requiresVerification) {
    return scanVerifiedSearchMatches(
      db,
      compiled,
      filters,
      page,
      rowBudget,
      progress,
    );
  }

  const search = buildSearchSql(filters, compiled.expression);
  const total = readSearchCandidateCount(db, search);

  return {
    rows: readSearchRows(db, search, page),
    total,
    coverage: completeSearchCoverage(total),
  };
}

async function readSearchConversationPage(
  db: DerivedSqliteDatabase,
  compiled: CompiledFtsText,
  filters: SearchConversationFilters | undefined,
  page: Pagination,
  rowBudget: number,
  progress?: WorkerProgressCallback,
): Promise<SearchConversationPageResult> {
  const messageFilters = withoutConversationFilter(filters);

  if (compiled.requiresVerification) {
    const scan = await scanVerifiedSearchMatches(
      db,
      compiled,
      messageFilters,
      undefined,
      rowBudget,
      progress,
    );
    const pageHits = scan.conversationHits.slice(
      page.offset,
      page.offset + page.limit,
    );

    return {
      conversations: readSearchConversationSummaries(db, pageHits),
      total: scan.conversationHits.length,
      coverage: scan.coverage,
    };
  }

  const search = buildSearchSql(messageFilters, compiled.expression);
  const counts = selectRows<SearchConversationCountsRow>(
    db,
    `
      SELECT
        COUNT(*) AS candidateRows,
        COUNT(DISTINCT m.conversation_id) AS total
      ${search.fromSql}
      ${search.whereSql};
    `,
    search.bind,
  ).at(0);
  const candidateRows = toSafeNumber(counts?.candidateRows, "candidateRows");
  const total = toSafeNumber(counts?.total, "total");
  const rows = selectRows<SearchConversationAggregateRow>(
    db,
    `
      WITH ranked_hits AS (
        SELECT
          m.conversation_id AS conversationId,
          m.sent_at_utc AS latestHitAtUtc,
          m.source_rowid AS latestHitSourceRowId,
          m.id AS latestHitMessageId,
          COUNT(*) OVER (
            PARTITION BY m.conversation_id
          ) AS hitCount,
          ROW_NUMBER() OVER (
            PARTITION BY m.conversation_id
            ORDER BY
              COALESCE(m.sent_at_utc, '') DESC,
              m.source_rowid DESC,
              m.id DESC
          ) AS hitRank
        ${search.fromSql}
        ${search.whereSql}
      )
      SELECT
        conversationId,
        hitCount,
        latestHitAtUtc
      FROM ranked_hits
      WHERE hitRank = 1
      ORDER BY
        COALESCE(latestHitAtUtc, '') DESC,
        latestHitSourceRowId DESC,
        latestHitMessageId DESC,
        conversationId DESC
      LIMIT ? OFFSET ?;
    `,
    [...search.bind, page.limit, page.offset],
  );
  const hits = rows.map((row) => ({
    conversationId: requireString(row.conversationId, "conversationId"),
    hitCount: toSafeNumber(row.hitCount, "hitCount"),
    ...(optionalString(row.latestHitAtUtc) === undefined
      ? {}
      : { latestHitAtUtc: optionalString(row.latestHitAtUtc) }),
  }));

  return {
    conversations: readSearchConversationSummaries(db, hits),
    total,
    coverage: completeSearchCoverage(candidateRows),
  };
}

async function scanVerifiedSearchMatches(
  db: DerivedSqliteDatabase,
  compiled: CompiledFtsText,
  filters: SearchMessagesFilters | undefined,
  page: Pagination | undefined,
  rowBudget: number,
  progress?: WorkerProgressCallback,
): Promise<VerifiedSearchScan> {
  const isBoundedScan = compiled.expression.length === 0;
  const boundedConversationId = isBoundedScan
    ? filters?.conversationId
    : undefined;

  if (boundedConversationId !== undefined) {
    validateRequiredText(boundedConversationId, "conversationId");
  }

  const search = buildSearchSql(
    isBoundedScan ? withoutConversationFilter(filters) : filters,
    isBoundedScan ? undefined : compiled.expression,
  );
  const availableCandidateRows = readSearchCandidateCount(db, search);
  // The verification budget applies to FTS-narrowed candidates too: a quoted
  // literal whose narrowing token is common ("the") can otherwise match most
  // of a real backup and stall the worker. Truncation is disclosed below.
  const scanLimit = Math.min(availableCandidateRows, rowBudget);
  const selectedRows: SearchMessageRow[] = [];
  const conversationHits = new Map<string, ConversationHitAggregate>();
  const quotedLiteralMatchers = compileQuotedLiteralMatchers(
    compiled.quotedSubstrings,
  );
  const throttledProgress = createThrottledWorkerProgress({
    worker: "db",
    progress,
    phase: "sqlite-query",
    label: "Verifying quoted matches",
    totalUnits: scanLimit,
  });
  let scannedRows = 0;
  let total = 0;

  // A single ordered statement stepped row-by-row: one FTS match and one sort
  // for the whole scan (the previous LIMIT/OFFSET batches re-executed both per
  // batch), while holding only the current row and the requested page.
  const statement = db.prepare(`
    SELECT${messageSelectColumns("m.")},
      NULL AS snippetText
    ${search.fromSql}
    ${search.whereSql}
    ORDER BY
      COALESCE(m.sent_at_utc, '') DESC,
      m.source_rowid DESC,
      m.id DESC
    LIMIT ?;
  `);

  try {
    statement.bind([...search.bind, scanLimit]);

    while (statement.step()) {
      const row = statement.get({}) as SearchMessageRow;

      scannedRows += 1;

      const emission = throttledProgress.maybeEmit(scannedRows);

      if (emission !== undefined) {
        await emission;
      }

      const body = requireString(row.body, "body");
      const conversationId = requireString(
        row.conversationId,
        "conversationId",
      );

      if (
        (boundedConversationId !== undefined &&
          conversationId !== boundedConversationId) ||
        !matchesQuotedSubstrings(body, quotedLiteralMatchers)
      ) {
        continue;
      }

      if (
        page !== undefined &&
        total >= page.offset &&
        selectedRows.length < page.limit
      ) {
        selectedRows.push(row);
      }

      total += 1;

      const existing = conversationHits.get(conversationId);

      if (existing === undefined) {
        const latestHitAtUtc = optionalString(row.sentAtUtc);

        conversationHits.set(conversationId, {
          conversationId,
          hitCount: 1,
          ...(latestHitAtUtc === undefined ? {} : { latestHitAtUtc }),
        });
      } else {
        existing.hitCount += 1;
      }
    }
  } finally {
    statement.finalize();
  }

  await throttledProgress.finish(scannedRows);

  const truncated = availableCandidateRows > scannedRows;

  return {
    rows: selectedRows,
    total,
    conversationHits: [...conversationHits.values()],
    // A complete FTS-narrowed scan keeps the "fts" coverage shape; any scan
    // that could not examine every candidate reports the bounded-scan shape so
    // the UI discloses the budget, and the no-narrowing path always reports it
    // (its newest-first budget is the defining semantic, D-034).
    coverage:
      isBoundedScan || truncated
        ? {
            strategy: "bounded-scan",
            candidateRows: availableCandidateRows,
            truncated,
            rowBudget,
          }
        : completeSearchCoverage(availableCandidateRows),
  };
}

function readSearchCandidateCount(
  db: DerivedSqliteDatabase,
  search: SearchSql,
): number {
  return readCount(
    db,
    `SELECT COUNT(*) ${search.fromSql} ${search.whereSql};`,
    search.bind,
  );
}

function readSearchRows(
  db: DerivedSqliteDatabase,
  search: SearchSql,
  page: Pagination,
): SearchMessageRow[] {
  const useFtsSnippet = search.usesFts;
  const snippetSql = useFtsSnippet
    ? "snippet(messages_fts, 0, ?, ?, ?, ?)"
    : "NULL";
  const snippetBind: SqliteBindValue[] = useFtsSnippet
    ? [
        snippetHighlightStart,
        snippetHighlightEnd,
        snippetEllipsis,
        snippetTokenCount,
      ]
    : [];

  return selectRows<SearchMessageRow>(
    db,
    `
      SELECT${messageSelectColumns("m.")},
        ${snippetSql} AS snippetText
      ${search.fromSql}
      ${search.whereSql}
      ORDER BY
        COALESCE(m.sent_at_utc, '') DESC,
        m.source_rowid DESC,
        m.id DESC
      LIMIT ? OFFSET ?;
    `,
    [
      ...snippetBind,
      ...search.bind,
      page.limit,
      page.offset,
    ],
  );
}

function readSearchConversationSummaries(
  db: DerivedSqliteDatabase,
  hits: readonly ConversationHitAggregate[],
): DbSearchConversationSummary[] {
  const conversations = readConversationsByIds(
    db,
    hits.map((hit) => hit.conversationId),
  );
  const conversationById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );

  return hits.map((hit) => {
    const conversation = conversationById.get(hit.conversationId);

    if (conversation === undefined) {
      throw malformedRow("conversationId");
    }

    return {
      ...conversation,
      hitCount: hit.hitCount,
      ...(hit.latestHitAtUtc === undefined
        ? {}
        : { latestHitAtUtc: hit.latestHitAtUtc }),
    };
  });
}

function withoutConversationFilter(
  filters: SearchMessagesFilters | SearchConversationFilters | undefined,
): SearchMessagesFilters | undefined {
  if (filters === undefined) {
    return undefined;
  }

  // Copy everything except the conversation scope so future filter fields
  // flow through without needing to be enumerated here.
  const rest: SearchMessagesFilters = { ...filters };

  delete rest.conversationId;

  return rest;
}

function compileQuotedLiteralMatchers(
  quotedSubstrings: readonly string[],
): RegExp[] {
  return quotedSubstrings.map(
    (literal) => new RegExp(escapeRegExp(literal), "iu"),
  );
}

function matchesQuotedSubstrings(
  body: string,
  quotedLiteralMatchers: readonly RegExp[],
): boolean {
  return quotedLiteralMatchers.every((matcher) => matcher.test(body));
}

function foldSearchCase(value: string): string {
  return value.toLowerCase();
}

function completeSearchCoverage(candidateRows: number): SearchCoverage {
  return {
    strategy: "fts",
    candidateRows,
    truncated: false,
  };
}

function stripSnippetSentinels(text: string): string {
  return text
    .replaceAll(snippetHighlightStart, "")
    .replaceAll(snippetHighlightEnd, "");
}

function containsSnippetSentinels(text: string): boolean {
  return (
    text.includes(snippetHighlightStart) || text.includes(snippetHighlightEnd)
  );
}

function fallbackSnippetSegments(fallbackBody: string): SearchSnippetSegment[] {
  const text = truncateText(stripSnippetSentinels(fallbackBody), maxSnippetLength);

  // A body consisting entirely of sentinel characters strips to nothing;
  // return no segments (the UI omits the snippet) instead of an empty one.
  if (text.length === 0) {
    return [];
  }

  return [{ text, highlighted: false }];
}

function buildSearchSnippetSegments(
  snippetText: string | undefined,
  fallbackBody: string,
  compiled: CompiledFtsText,
): SearchSnippetSegment[] {
  if (compiled.quotedSubstrings.length > 0) {
    const literalSegments = buildQuotedLiteralSnippetSegments(
      fallbackBody,
      compiled.quotedSubstrings,
    );

    if (literalSegments.some((segment) => segment.highlighted)) {
      // Quoted searches skip FTS snippet(), so any unquoted AND-terms that
      // land inside the literal-centered window must be highlighted here or
      // the user cannot tell why a mixed query matched.
      return highlightUnquotedTermTokens(
        literalSegments,
        compiled.unquotedTerms,
      );
    }
  }

  return buildSnippetSegments(snippetText, fallbackBody);
}

/**
 * Highlights whole tokens whose prefix matches an unquoted search term inside
 * non-highlighted snippet segments, mirroring FTS5 prefix-token semantics.
 */
function highlightUnquotedTermTokens(
  segments: readonly SearchSnippetSegment[],
  unquotedTerms: readonly string[],
): SearchSnippetSegment[] {
  const terms = unquotedTerms.filter((term) => term.length > 0);

  if (terms.length === 0) {
    return [...segments];
  }

  const matcher = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${terms.map(escapeRegExp).join("|")})[\\p{L}\\p{N}_]*`,
    "giu",
  );
  const result: SearchSnippetSegment[] = [];

  for (const segment of segments) {
    if (segment.highlighted) {
      pushSnippetSegment(result, segment.text, true);
      continue;
    }

    let cursor = 0;

    for (const match of segment.text.matchAll(matcher)) {
      const index = match.index;

      pushSnippetSegment(result, segment.text.slice(cursor, index), false);
      pushSnippetSegment(result, match[0], true);
      cursor = index + match[0].length;
    }

    pushSnippetSegment(result, segment.text.slice(cursor), false);
  }

  return result;
}

/**
 * Builds hostile-safe highlights for verified quoted literals, including the
 * bounded non-FTS path where SQLite cannot provide an FTS snippet.
 */
export function buildQuotedLiteralSnippetSegments(
  body: string,
  quotedSubstrings: readonly string[],
): SearchSnippetSegment[] {
  if (containsSnippetSentinels(body)) {
    return fallbackSnippetSegments(body);
  }

  const literals = uniqueCaseFoldedStrings(
    quotedSubstrings.filter((literal) => literal.length > 0),
  ).sort((left, right) => right.length - left.length);

  if (literals.length === 0) {
    return fallbackSnippetSegments(body);
  }

  const literalPattern = literals.map(escapeRegExp).join("|");
  const firstMatch = new RegExp(literalPattern, "iu").exec(body);

  if (firstMatch?.index === undefined) {
    return fallbackSnippetSegments(body);
  }

  const matchedLength = firstMatch[0].length;

  if (matchedLength > maxSnippetLength) {
    const segments: SearchSnippetSegment[] = [];

    if (firstMatch.index > 0) {
      pushSnippetSegment(segments, snippetEllipsis, false);
    }

    // The full literal was already verified against the hostile-safe body.
    // Preserve the visible part as a real hit even though a bounded snippet
    // cannot contain enough text for the full-literal regexp to match again.
    pushSnippetSegment(
      segments,
      firstMatch[0].slice(0, alignSliceEnd(firstMatch[0], maxSnippetLength)),
      true,
    );
    pushSnippetSegment(segments, snippetEllipsis, false);

    return segments;
  }

  const contextLength = Math.max(0, maxSnippetLength - matchedLength);
  const start = alignSliceStart(
    body,
    Math.max(0, firstMatch.index - Math.floor(contextLength / 2)),
  );
  const end = alignSliceEnd(
    body,
    Math.min(body.length, start + maxSnippetLength),
  );
  const windowText = body.slice(start, end);
  const matcher = new RegExp(literalPattern, "giu");
  const segments: SearchSnippetSegment[] = [];
  let cursor = 0;

  if (start > 0) {
    pushSnippetSegment(segments, snippetEllipsis, false);
  }

  for (const match of windowText.matchAll(matcher)) {
    const index = match.index;

    pushSnippetSegment(segments, windowText.slice(cursor, index), false);
    pushSnippetSegment(segments, match[0], true);
    cursor = index + match[0].length;
  }

  pushSnippetSegment(segments, windowText.slice(cursor), false);

  if (end < body.length) {
    pushSnippetSegment(segments, snippetEllipsis, false);
  }

  return segments.length === 0
    ? fallbackSnippetSegments(body)
    : segments;
}

/** Exported for unit tests; production callers stay inside searchMessages. */
export function buildSnippetSegments(
  snippetText: string | undefined,
  fallbackBody: string,
): SearchSnippetSegment[] {
  if (snippetText === undefined || snippetText.length === 0) {
    return fallbackSnippetSegments(fallbackBody);
  }

  if (containsSnippetSentinels(fallbackBody)) {
    // Hostile message bodies can contain the sentinel characters snippet()
    // uses as highlight delimiters, letting them forge or suppress
    // highlights. Degrade gracefully: strip all sentinels and return the
    // snippet as a single non-highlighted segment.
    const stripped = stripSnippetSentinels(snippetText);

    return stripped.length === 0
      ? fallbackSnippetSegments(fallbackBody)
      : [{ text: stripped, highlighted: false }];
  }

  const segments: SearchSnippetSegment[] = [];
  let cursor = 0;
  let foundHighlight = false;

  while (cursor < snippetText.length) {
    const start = snippetText.indexOf(snippetHighlightStart, cursor);

    if (start < 0) {
      pushSnippetSegment(segments, snippetText.slice(cursor), false);
      break;
    }

    pushSnippetSegment(segments, snippetText.slice(cursor, start), false);

    const highlightedStart = start + snippetHighlightStart.length;
    const end = snippetText.indexOf(snippetHighlightEnd, highlightedStart);

    if (end < 0) {
      return fallbackSnippetSegments(fallbackBody);
    }

    pushSnippetSegment(
      segments,
      snippetText.slice(highlightedStart, end),
      true,
    );
    foundHighlight = true;
    cursor = end + snippetHighlightEnd.length;
  }

  if (!foundHighlight || segments.length === 0) {
    return fallbackSnippetSegments(fallbackBody);
  }

  return segments;
}

function pushSnippetSegment(
  segments: SearchSnippetSegment[],
  rawText: string,
  highlighted: boolean,
): void {
  // Belt-and-braces: no sentinel character may ever reach the UI, even if a
  // future snippet format change leaks one into a parsed segment.
  const text = stripSnippetSentinels(rawText);

  if (text.length === 0) {
    return;
  }

  const previous = segments.at(-1);

  if (previous?.highlighted === highlighted) {
    previous.text += text;
    return;
  }

  segments.push({ text, highlighted });
}

function mapConversationRow(row: ConversationRow): DbConversationSummary {
  return {
    id: requireString(row.id, "id"),
    kind: normalizeConversationKind(row.kind),
    ...(optionalString(row.displayName) === undefined
      ? {}
      : { displayName: optionalString(row.displayName) }),
    ...(optionalString(row.service) === undefined
      ? {}
      : { service: optionalString(row.service) }),
    ...(optionalString(row.lastMessageAt) === undefined
      ? {}
      : { lastMessageAt: optionalString(row.lastMessageAt) }),
    messageCount: toSafeNumber(row.messageCount, "messageCount"),
    participants: [],
  };
}

function mapParticipantRow(row: ParticipantRow): DbParticipantSummary {
  return {
    id: requireString(row.id, "id"),
    handle: requireString(row.handle, "handle"),
    kind: normalizeParticipantKind(row.kind),
    ...(optionalString(row.contactName) === undefined
      ? {}
      : { contactName: optionalString(row.contactName) }),
    ...(optionalString(row.contactFirstName) === undefined
      ? {}
      : { contactFirstName: optionalString(row.contactFirstName) }),
    isSelf: sqlBool(row.isSelf),
    ...(optionalString(row.avatarSha256) === undefined
      ? {}
      : { avatarSha256: optionalString(row.avatarSha256) }),
    ...(normalizeAvatarMime(row.avatarMime) === undefined
      ? {}
      : { avatarMime: normalizeAvatarMime(row.avatarMime) }),
    ...(optionalString(row.avatarPath) === undefined
      ? {}
      : { avatarPath: optionalString(row.avatarPath) }),
  };
}

function mapMessagePreview(row: MessageRow): DbMessagePreview {
  return {
    id: requireString(row.id, "id"),
    conversationId: requireString(row.conversationId, "conversationId"),
    ...(optionalString(row.senderId) === undefined
      ? {}
      : { senderId: optionalString(row.senderId) }),
    ...(optionalString(row.sentAtUtc) === undefined
      ? {}
      : { sentAtUtc: optionalString(row.sentAtUtc) }),
    bodyPreview: truncateText(requireString(row.body, "body"), previewLength),
    ...(optionalString(row.service) === undefined
      ? {}
      : { service: optionalString(row.service) }),
    serviceKind: classifyServiceKind(optionalString(row.service)),
    isFromMe: sqlBool(row.isFromMe),
    edited: sqlBool(row.edited),
    unsent: sqlBool(row.unsent),
    isSystemEvent: sqlBool(row.isSystemEvent),
    attachmentCount: 0,
    reactionCount: 0,
  };
}

function mapMessageRow(row: MessageRow): DbMessageRecord {
  return {
    id: requireString(row.id, "id"),
    conversationId: requireString(row.conversationId, "conversationId"),
    ...(optionalString(row.senderId) === undefined
      ? {}
      : { senderId: optionalString(row.senderId) }),
    ...(optionalString(row.sentAtUtc) === undefined
      ? {}
      : { sentAtUtc: optionalString(row.sentAtUtc) }),
    rawTimestamp: requireString(row.rawTimestamp, "rawTimestamp"),
    body: requireString(row.body, "body"),
    ...(optionalString(row.service) === undefined
      ? {}
      : { service: optionalString(row.service) }),
    serviceKind: classifyServiceKind(optionalString(row.service)),
    isFromMe: sqlBool(row.isFromMe),
    ...(optionalString(row.dateDelivered) === undefined
      ? {}
      : { dateDelivered: optionalString(row.dateDelivered) }),
    ...(optionalString(row.dateRead) === undefined
      ? {}
      : { dateRead: optionalString(row.dateRead) }),
    edited: sqlBool(row.edited),
    unsent: sqlBool(row.unsent),
    ...(optionalString(row.sourceGuid) === undefined
      ? {}
      : { sourceGuid: optionalString(row.sourceGuid) }),
    sourceRowId: toSafeNumber(row.sourceRowId, "sourceRowId"),
    isSystemEvent: sqlBool(row.isSystemEvent),
    attachments: [],
    reactions: [],
  };
}

function mapAttachmentRow(row: AttachmentRow): DbAttachmentSummary {
  const id = requireString(row.id, "id");
  const filename = optionalString(row.filename);
  const mime = optionalString(row.mime);
  const sha256 = optionalString(row.sha256);
  const sourceGuid = optionalString(row.sourceGuid);
  const bytes = toOptionalNonNegativeSafeInteger(row.bytes);

  return {
    id,
    messageId: requireString(row.messageId, "messageId"),
    mediaKind: classifyAttachmentMediaKind({ filename, mime }),
    thumbnailCacheKey: sha256 ?? sourceGuid ?? id,
    ...(filename === undefined
      ? {}
      : { filename }),
    ...(mime === undefined
      ? {}
      : { mime }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(optionalString(row.sourcePath) === undefined
      ? {}
      : { sourcePath: optionalString(row.sourcePath) }),
    ...(optionalString(row.sourceDomain) === undefined
      ? {}
      : { sourceDomain: optionalString(row.sourceDomain) }),
    ...(sha256 === undefined
      ? {}
      : { sha256 }),
    ...(sourceGuid === undefined
      ? {}
      : { sourceGuid }),
  };
}

function classifyAttachmentMediaKind(input: {
  filename?: string;
  mime?: string;
}): DbAttachmentMediaKind {
  const baseMime = normalizeMimeType(input.mime);

  if (baseMime.length > 0) {
    if (heicMimeTypes.has(baseMime)) {
      return "heic";
    }

    if (nativeImageMimeTypes.has(baseMime)) {
      return "image";
    }

    if (baseMime.startsWith("video/")) {
      return "video";
    }
  }

  const extension = getFilenameExtension(input.filename);

  if (extension === undefined) {
    return "file";
  }

  if (heicExtensions.has(extension)) {
    return "heic";
  }

  if (nativeImageExtensions.has(extension)) {
    return "image";
  }

  if (videoExtensions.has(extension)) {
    return "video";
  }

  return "file";
}

function getFilenameExtension(filename: string | undefined): string | undefined {
  const trimmed = filename?.trim();

  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  const lastDotIndex = trimmed.lastIndexOf(".");

  if (lastDotIndex < 0 || lastDotIndex === trimmed.length - 1) {
    return undefined;
  }

  return trimmed.slice(lastDotIndex + 1).toLocaleLowerCase();
}

function mapReactionRow(row: ReactionRow): DbReactionSummary {
  return {
    id: requireString(row.id, "id"),
    targetMessageId: requireString(row.targetMessageId, "targetMessageId"),
    ...(optionalString(row.senderId) === undefined
      ? {}
      : { senderId: optionalString(row.senderId) }),
    kind: normalizeReactionKind(row.kind),
    ...(optionalString(row.sentAtUtc) === undefined
      ? {}
      : { sentAtUtc: optionalString(row.sentAtUtc) }),
    rawTimestamp: requireString(row.rawTimestamp, "rawTimestamp"),
    ...(optionalString(row.sourceGuid) === undefined
      ? {}
      : { sourceGuid: optionalString(row.sourceGuid) }),
    sourceRowId: toSafeNumber(row.sourceRowId, "sourceRowId"),
  };
}

function normalizePagination(
  input: { limit?: number; offset?: number },
  maxLimit: number,
): Pagination {
  return {
    limit: clampInteger(input.limit ?? defaultPageLimit, 1, maxLimit),
    offset: clampInteger(input.offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function validateBackupId(backupId: string): void {
  validateRequiredText(backupId, "backupId");
}

function validateRequiredText(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new DbQueryError({
      code: "sqlite_query_failed",
      message: `The ${fieldName} query field is required.`,
      recoverable: true,
      details: { fieldName },
    });
  }
}

function selectRows<TRow extends Record<string, unknown>>(
  db: DerivedSqliteDatabase,
  sql: string,
  bind: readonly SqliteBindValue[] = [],
): TRow[] {
  return (
    bind.length === 0 ? db.selectObjects(sql) : db.selectObjects(sql, [...bind])
  ) as TRow[];
}

function readCount(
  db: DerivedSqliteDatabase,
  sql: string,
  bind: readonly SqliteBindValue[] = [],
): number {
  const value =
    bind.length === 0 ? db.selectValue(sql) : db.selectValue(sql, [...bind]);

  return toSafeNumber(value, "count");
}

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function uniqueCaseFoldedStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const folded = foldSearchCase(value);

    if (seen.has(folded)) {
      continue;
    }

    seen.add(folded);
    result.push(value);
  }

  return result;
}

function optionalArray(value: string | undefined): string[] {
  return value === undefined ? [] : [value];
}

function truncateText(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, alignSliceEnd(value, Math.max(0, length - 3)))}...`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Moves a slice boundary off the middle of a surrogate pair so text windows
 * never split an astral character (emoji are routine in phone messages) into
 * lone surrogates that render as U+FFFD. Hostile bodies that already contain
 * lone surrogates are left untouched.
 */
function alignSliceStart(text: string, index: number): number {
  return index > 0 &&
    isLowSurrogate(text.charCodeAt(index)) &&
    isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

function alignSliceEnd(text: string, index: number): number {
  return index > 0 &&
    index < text.length &&
    isLowSurrogate(text.charCodeAt(index)) &&
    isHighSurrogate(text.charCodeAt(index - 1))
    ? index + 1
    : index;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw malformedRow(fieldName);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toSafeNumber(value: unknown, fieldName: string): number {
  const numberValue =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;

  if (!Number.isSafeInteger(numberValue)) {
    throw malformedRow(fieldName);
  }

  return numberValue;
}

function toOptionalNonNegativeSafeInteger(value: unknown): number | undefined {
  const numberValue =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;

  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    return undefined;
  }

  return numberValue;
}

function sqlBool(value: unknown): boolean {
  return toSafeNumber(value, "boolean") !== 0;
}

function normalizeConversationKind(value: string): NormalizedConversationKind {
  if (value === "direct" || value === "group") {
    return value;
  }

  throw malformedRow("kind");
}

function normalizeParticipantKind(value: string): NormalizedParticipantKind {
  if (
    value === "phone" ||
    value === "email" ||
    value === "unknown" ||
    value === "self"
  ) {
    return value;
  }

  throw malformedRow("kind");
}

function normalizeReactionKind(value: string): NormalizedReactionKind {
  if (
    value === "loved" ||
    value === "liked" ||
    value === "disliked" ||
    value === "laughed" ||
    value === "emphasized" ||
    value === "questioned" ||
    value === "unknown"
  ) {
    return value;
  }

  throw malformedRow("kind");
}

function normalizeAvatarMime(
  value: string | null,
): "image/jpeg" | "image/png" | undefined {
  if (value === null) {
    return undefined;
  }

  if (value === "image/jpeg" || value === "image/png") {
    return value;
  }

  throw malformedRow("avatarMime");
}

function malformedRow(fieldName: string): DbQueryError {
  return new DbQueryError({
    code: "sqlite_query_failed",
    message: `The derived database returned a malformed query row for "${fieldName}".`,
    recoverable: true,
    details: { fieldName },
  });
}

function toDbQueryWorkerError(
  cause: unknown,
  fallbackMessage: string,
  fallbackDetails: Record<string, WorkerStructuredValue>,
) {
  // The OPFS database factory (ingest-sink) throws typed DbIngestErrors
  // before sqlite-wasm runs (e.g. sqlite_opfs_unavailable when OPFS is
  // missing); preserve those codes instead of mapping them to a generic
  // sqlite_query_failed.
  if (cause instanceof DbQueryError || cause instanceof DbIngestError) {
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
    code: classifySqliteWasmError(cause, "sqlite_query_failed"),
    message: fallbackMessage,
    cause,
    recoverable: true,
    details: fallbackDetails,
  });
}
