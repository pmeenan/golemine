import { parsePhoneNumberFromString } from "libphonenumber-js";

import type {
  IngestWarning,
  NormalizedAttachment,
  NormalizedContactAvatar,
  NormalizedConversation,
  NormalizedConversationKind,
  NormalizedMessage,
  NormalizedParticipant,
  NormalizedParticipantKind,
  NormalizedReaction,
  NormalizedReactionKind,
  WorkerProgressCallback,
} from "../../lib/worker-types";
import {
  readSourceFileBytes,
  sha256Hex,
  SourceFileTooLargeError,
  type ManifestDbReader,
  type ManifestFileRecord,
} from "./manifest-db";
import { bytesStartWith } from "../shared/binary";
import {
  createThrottledWorkerProgress,
  type ThrottledWorkerProgress,
} from "../shared/progress";
import { appleEpochMs } from "./apple-time";
import type { ReadonlySourceDirectoryHandle } from "./read-only-source";
import {
  sqliteRows,
  sqliteTableColumns,
  sqliteTableExists,
  type SqliteDatabase,
} from "./source-sqlite";
import { extractTypedstreamText } from "./typedstream";

const appleEpochSeconds = appleEpochMs / 1000;
const appleEpochMilliseconds = BigInt(appleEpochMs);
const maxDateMilliseconds = 8_640_000_000_000_000;
const maxDateMillisecondsBigInt = BigInt(maxDateMilliseconds);
const reactionKinds = new Map<number, NormalizedReactionKind>([
  [2000, "loved"],
  [2001, "liked"],
  [2002, "disliked"],
  [2003, "laughed"],
  [2004, "emphasized"],
  [2005, "questioned"],
]);
const tapbackAddTypeMin = 2000;
const tapbackAddTypeMax = 2999;
const tapbackRemoveTypeMin = 3000;
const tapbackRemoveTypeMax = 3999;
const maxInlineAttachmentHashBytes = 64 * 1024 * 1024;
const maxInlineAttachmentHashTotalBytes = 256 * 1024 * 1024;
const attachmentPathMarker = "Library/SMS/Attachments/";

export interface IosNormalizeInput {
  smsDb: SqliteDatabase;
  contactsDb?: SqliteDatabase;
  contactImagesDb?: SqliteDatabase;
  manifest: ManifestDbReader;
  root: ReadonlySourceDirectoryHandle;
  initialWarnings?: IngestWarning[];
  progress?: WorkerProgressCallback;
}

export interface IosNormalizedData {
  participants: NormalizedParticipant[];
  conversations: NormalizedConversation[];
  messages: NormalizedMessage[];
  attachments: NormalizedAttachment[];
  reactions: NormalizedReaction[];
  contactAvatars: NormalizedContactAvatar[];
  warnings: IngestWarning[];
}

interface HandleRow {
  rowid: unknown;
  id: unknown;
  service: unknown;
  uncanonicalized_id: unknown;
}

interface ChatRow {
  rowid: unknown;
  guid: unknown;
  chat_identifier: unknown;
  service_name: unknown;
  display_name: unknown;
  style: unknown;
}

interface ChatHandleRow {
  chat_id: unknown;
  handle_id: unknown;
}

interface ChatMessageRow {
  chat_id: unknown;
  message_id: unknown;
}

interface MessageRow {
  rowid: unknown;
  guid: unknown;
  text: unknown;
  attributedBody: unknown;
  handle_id: unknown;
  service: unknown;
  date: unknown;
  date_read: unknown;
  date_delivered: unknown;
  is_from_me: unknown;
  item_type: unknown;
  group_action_type: unknown;
  associated_message_guid: unknown;
  associated_message_type: unknown;
  date_edited: unknown;
  date_retracted: unknown;
}

interface AttachmentRow {
  attachment_rowid: unknown;
  message_id: unknown;
  guid: unknown;
  filename: unknown;
  mime_type: unknown;
  transfer_name: unknown;
  total_bytes: unknown;
}

interface ContactRow {
  rowid: unknown;
  first: unknown;
  last: unknown;
  organization: unknown;
}

interface ContactValueRow {
  record_id: unknown;
  property: unknown;
  value: unknown;
}

interface ContactImageRow {
  record_id: unknown;
  data: unknown;
}

interface ContactRecord {
  displayName: string;
  firstName?: string;
  phones: Set<string>;
  emails: Set<string>;
  avatar?: {
    sha256: string;
    mime: NormalizedContactAvatar["mime"];
    byteLength: number;
    bytes: Uint8Array;
  };
}

interface ResolvedContact {
  displayName: string;
  firstName?: string;
  avatar?: ContactRecord["avatar"];
}

interface ConversationStats {
  messageCount: number;
  lastMessageAt?: string;
  participantIds: Set<string>;
}

export async function normalizeIosMessages(
  input: IosNormalizeInput,
): Promise<IosNormalizedData> {
  const warnings: IngestWarning[] = [...(input.initialWarnings ?? [])];
  const contacts = await readContacts(input.contactsDb, input.contactImagesDb, warnings);
  const handleRows = readHandles(input.smsDb);
  const { participants, contactAvatars } = buildParticipants(handleRows, contacts);
  const participantByHandleRowId = new Map<number, NormalizedParticipant>();

  for (const participant of participants) {
    if (participant.id.startsWith("handle:")) {
      participantByHandleRowId.set(Number(participant.id.slice("handle:".length)), participant);
    }
  }

  const { chats, chatRowIdRemap } = dedupeChatsByGuid(
    readChats(input.smsDb),
    warnings,
  );
  const chatHandles = readChatHandles(input.smsDb);
  const chatMessages = readChatMessages(input.smsDb);
  const chatIdsByMessageId = mapChatIdsByMessageId(chatMessages, chatRowIdRemap);
  const messageRows = readMessages(input.smsDb);
  const {
    messages,
    messageIdByRowId,
    messageIdByGuid,
    pendingReactionRows,
    conversationStats,
  } = await buildMessages(
    messageRows,
    chatIdsByMessageId,
    participantByHandleRowId,
    warnings,
    createThrottledWorkerProgress({
      worker: "backup",
      progress: input.progress,
      phase: "normalizing",
      label: "Normalizing messages",
      totalUnits: messageRows.length,
    }),
  );
  const conversations = buildConversations(
    chats,
    chatHandles,
    participants,
    conversationStats,
    chatRowIdRemap,
    warnings,
  );
  const reactions = buildReactions(
    pendingReactionRows,
    messageIdByGuid,
    participantByHandleRowId,
    warnings,
  );
  const attachments = await buildAttachments(
    input.root,
    input.manifest,
    input.smsDb,
    messageIdByRowId,
    warnings,
    input.progress,
  );

  return {
    participants,
    conversations,
    messages,
    attachments,
    reactions,
    contactAvatars,
    warnings,
  };
}

export function appleTimestampToIso(value: unknown): string | undefined {
  if (typeof value === "bigint") {
    if (value <= 0n) {
      return undefined;
    }

    const unixMilliseconds =
      value > 1_000_000_000_000n
        ? value / 1_000_000n + appleEpochMilliseconds
        : (value + BigInt(appleEpochSeconds)) * 1000n;

    return isoDateFromUnixMilliseconds(unixMilliseconds);
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const unixSeconds =
    Math.abs(value) > 1_000_000_000_000
      ? value / 1_000_000_000 + appleEpochSeconds
      : value + appleEpochSeconds;

  return isoDateFromUnixMilliseconds(unixSeconds * 1000);
}

function readHandles(db: SqliteDatabase): HandleRow[] {
  if (!sqliteTableExists(db, "handle")) {
    return [];
  }

  const columns = sqliteTableColumns(db, "handle");

  return sqliteRows<HandleRow>(
    db,
    `
      SELECT
        ROWID AS rowid,
        ${selectColumn(columns, "id", "NULL")},
        ${selectColumn(columns, "service", "NULL")},
        ${selectColumn(columns, "uncanonicalized_id", "NULL")}
      FROM handle
      ORDER BY ROWID;
    `,
  );
}

function readChats(db: SqliteDatabase): ChatRow[] {
  if (!sqliteTableExists(db, "chat")) {
    return [];
  }

  const columns = sqliteTableColumns(db, "chat");

  return sqliteRows<ChatRow>(
    db,
    `
      SELECT
        ROWID AS rowid,
        ${selectColumn(columns, "guid", "NULL")},
        ${selectColumn(columns, "chat_identifier", "NULL")},
        ${selectColumn(columns, "service_name", "NULL")},
        ${selectColumn(columns, "display_name", "NULL")},
        ${selectColumn(columns, "style", "0")}
      FROM chat
      ORDER BY ROWID;
    `,
  );
}

function readChatHandles(db: SqliteDatabase): ChatHandleRow[] {
  if (!sqliteTableExists(db, "chat_handle_join")) {
    return [];
  }

  return sqliteRows<ChatHandleRow>(
    db,
    "SELECT chat_id, handle_id FROM chat_handle_join ORDER BY chat_id, handle_id;",
  );
}

function readChatMessages(db: SqliteDatabase): ChatMessageRow[] {
  if (!sqliteTableExists(db, "chat_message_join")) {
    return [];
  }

  return sqliteRows<ChatMessageRow>(
    db,
    "SELECT chat_id, message_id FROM chat_message_join ORDER BY message_id, chat_id;",
  );
}

function readMessages(db: SqliteDatabase): MessageRow[] {
  if (!sqliteTableExists(db, "message")) {
    return [];
  }

  const columns = sqliteTableColumns(db, "message");

  return sqliteRows<MessageRow>(
    db,
    `
      SELECT
        ROWID AS rowid,
        ${selectColumn(columns, "guid", "NULL")},
        ${selectColumn(columns, "text", "NULL")},
        ${selectColumn(columns, "attributedBody", "NULL")},
        ${selectColumn(columns, "handle_id", "0")},
        ${selectColumn(columns, "service", "NULL")},
        ${selectColumn(columns, "date", "0")},
        ${selectColumn(columns, "date_read", "0")},
        ${selectColumn(columns, "date_delivered", "0")},
        ${selectColumn(columns, "is_from_me", "0")},
        ${selectColumn(columns, "item_type", "0")},
        ${selectColumn(columns, "group_action_type", "0")},
        ${selectColumn(columns, "associated_message_guid", "NULL")},
        ${selectColumn(columns, "associated_message_type", "0")},
        ${selectColumn(columns, "date_edited", "0")},
        ${selectColumn(columns, "date_retracted", "0")}
      FROM message
      ORDER BY date, ROWID;
    `,
  );
}

function buildParticipants(
  handles: readonly HandleRow[],
  contacts: ContactIndex,
): {
  participants: NormalizedParticipant[];
  contactAvatars: NormalizedContactAvatar[];
} {
  const participants: NormalizedParticipant[] = [
    {
      id: "self",
      handle: "self",
      kind: "self",
      isSelf: true,
    },
  ];
  const contactAvatars: NormalizedContactAvatar[] = [];

  for (const row of handles) {
    const rowid = readNumber(row.rowid);
    if (rowid === undefined) {
      continue;
    }

    const handle = readString(row.id) ?? readString(row.uncanonicalized_id) ?? "";
    const resolved = contacts.resolve(handle);
    const avatar = resolved?.avatar;
    const participantId = `handle:${String(rowid)}`;

    participants.push({
      id: participantId,
      handle,
      kind: classifyHandle(handle),
      isSelf: false,
      ...(resolved === undefined
        ? {}
        : {
            contactName: resolved.displayName,
            ...(resolved.firstName === undefined
              ? {}
              : { contactFirstName: resolved.firstName }),
          }),
      ...(avatar === undefined
        ? {}
        : {
            avatarSha256: avatar.sha256,
            avatarMime: avatar.mime,
          }),
    });

    if (avatar !== undefined) {
      contactAvatars.push({
        participantId,
        sha256: avatar.sha256,
        mime: avatar.mime,
        byteLength: avatar.byteLength,
        bytes: avatar.bytes,
      });
    }
  }

  return { participants, contactAvatars };
}

async function buildMessages(
  rows: readonly MessageRow[],
  chatIdsByMessageId: ReadonlyMap<number, number>,
  participantByHandleRowId: ReadonlyMap<number, NormalizedParticipant>,
  warnings: IngestWarning[],
  progress: ThrottledWorkerProgress,
): Promise<{
  messages: NormalizedMessage[];
  messageIdByRowId: Map<number, string>;
  messageIdByGuid: Map<string, string>;
  pendingReactionRows: MessageRow[];
  conversationStats: Map<string, ConversationStats>;
}> {
  const messages: NormalizedMessage[] = [];
  const messageIdByRowId = new Map<number, string>();
  const messageIdByGuid = new Map<string, string>();
  const pendingReactionRows: MessageRow[] = [];
  const conversationStats = new Map<string, ConversationStats>();
  let processedRows = 0;

  for (const row of rows) {
    try {
      const associatedType = readNumber(row.associated_message_type) ?? 0;

      if (classifyTapback(associatedType) !== undefined) {
        pendingReactionRows.push(row);
        continue;
      }

      const rowid = readNumber(row.rowid);
      if (rowid === undefined) {
        warnings.push({
          code: "message-rowid-missing",
          message: "Skipped a message row without a numeric ROWID.",
        });
        continue;
      }

      const hasConversationJoin = chatIdsByMessageId.has(rowid);
      const conversationId = conversationIdForMessage(rowid, chatIdsByMessageId);
      const senderId = senderParticipantId(row, participantByHandleRowId);
      const sentAtUtc = appleTimestampToIso(row.date);
      const messageId = `message:${String(rowid)}`;
      const guid = readString(row.guid);
      const service = readString(row.service);
      const dateDelivered = appleTimestampToIso(row.date_delivered);
      const dateRead = appleTimestampToIso(row.date_read);

      if (!hasConversationJoin) {
        warnings.push({
          code: "message-chat-missing",
          message: "Placed a message without a chat join into the unassigned conversation.",
          source: String(rowid),
        });
      }

      if (sentAtUtc === undefined && isPositiveIntegerish(row.date)) {
        warnings.push({
          code: "message-timestamp-invalid",
          message: "Kept a message row but omitted an out-of-range sent timestamp.",
          source: String(rowid),
        });
      }

      const message: NormalizedMessage = {
        id: messageId,
        conversationId,
        ...(senderId === undefined ? {} : { senderId }),
        ...(sentAtUtc === undefined ? {} : { sentAtUtc }),
        rawTimestamp: formatRawTimestamp(row.date),
        body: messageBody(row, rowid, warnings),
        ...(service === undefined ? {} : { service }),
        isFromMe: readBooleanish(row.is_from_me),
        ...(dateDelivered === undefined ? {} : { dateDelivered }),
        ...(dateRead === undefined ? {} : { dateRead }),
        edited: isPositiveIntegerish(row.date_edited),
        unsent: isPositiveIntegerish(row.date_retracted),
        ...(guid === undefined ? {} : { sourceGuid: guid }),
        sourceRowId: rowid,
        isSystemEvent: (readNumber(row.item_type) ?? 0) !== 0,
      };

      messages.push(message);
      messageIdByRowId.set(rowid, messageId);

      if (guid !== undefined) {
        messageIdByGuid.set(guid, messageId);
      }

      const stats =
        conversationStats.get(conversationId) ??
        { messageCount: 0, participantIds: new Set<string>(["self"]) };
      stats.messageCount += 1;
      if (senderId !== undefined) {
        stats.participantIds.add(senderId);
      }
      if (senderId !== "self") {
        stats.participantIds.add("self");
      }
      if (sentAtUtc !== undefined) {
        stats.lastMessageAt = sentAtUtc;
      }
      conversationStats.set(conversationId, stats);
    } finally {
      processedRows += 1;
      // Only await when something is emitted so this per-row loop stays
      // synchronous between throttled progress updates.
      const progressEmission = progress.maybeEmit(processedRows);

      if (progressEmission !== undefined) {
        await progressEmission;
      }
    }
  }

  await progress.finish(processedRows);

  return {
    messages,
    messageIdByRowId,
    messageIdByGuid,
    pendingReactionRows,
    conversationStats,
  };
}

/**
 * Drops chat rows whose GUID duplicates an earlier chat row (hostile or
 * malformed sms.db input; the derived schema requires provider_key to be
 * unique) and returns a remap so joins that reference a duplicate chat ROWID
 * land in the surviving conversation instead.
 */
function dedupeChatsByGuid(
  chats: readonly ChatRow[],
  warnings: IngestWarning[],
): { chats: ChatRow[]; chatRowIdRemap: Map<number, number> } {
  const deduped: ChatRow[] = [];
  const canonicalRowIdByGuid = new Map<string, number>();
  const chatRowIdRemap = new Map<number, number>();

  for (const chat of chats) {
    const guid = readString(chat.guid);
    const rowid = readNumber(chat.rowid) ?? 0;

    if (guid !== undefined) {
      const canonicalRowId = canonicalRowIdByGuid.get(guid);

      if (canonicalRowId !== undefined) {
        if (rowid !== canonicalRowId) {
          chatRowIdRemap.set(rowid, canonicalRowId);
        }

        warnings.push({
          code: "conversation-duplicate-guid",
          message:
            "Merged a chat row whose GUID duplicates an earlier chat into the first conversation.",
          source: String(rowid),
        });
        continue;
      }

      canonicalRowIdByGuid.set(guid, rowid);
    }

    deduped.push(chat);
  }

  return { chats: deduped, chatRowIdRemap };
}

function buildConversations(
  chats: readonly ChatRow[],
  chatHandles: readonly ChatHandleRow[],
  participants: readonly NormalizedParticipant[],
  stats: ReadonlyMap<string, ConversationStats>,
  chatRowIdRemap: ReadonlyMap<number, number>,
  warnings: IngestWarning[],
): NormalizedConversation[] {
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const knownParticipantIds = new Set(participantById.keys());
  const participantIdsByChatId = new Map<number, Set<string>>();

  for (const row of chatHandles) {
    const joinedChatId = readNumber(row.chat_id);
    const chatId =
      joinedChatId === undefined
        ? undefined
        : (chatRowIdRemap.get(joinedChatId) ?? joinedChatId);
    const handleId = readNumber(row.handle_id);

    if (chatId === undefined || handleId === undefined) {
      continue;
    }

    const participantId = `handle:${String(handleId)}`;
    if (!knownParticipantIds.has(participantId)) {
      warnings.push({
        code: "conversation-participant-missing",
        message: "Skipped a chat participant join whose handle row was not present.",
        source: `${String(chatId)}:${String(handleId)}`,
      });
      continue;
    }

    const set = participantIdsByChatId.get(chatId) ?? new Set<string>(["self"]);
    set.add(participantId);
    participantIdsByChatId.set(chatId, set);
  }

  const conversations = chats.map((chat) => {
    const chatId = readNumber(chat.rowid) ?? 0;
    const id = `chat:${String(chatId)}`;
    const participantIds = filterKnownParticipantIds(
      participantIdsByChatId.get(chatId) ?? new Set<string>(["self"]),
      knownParticipantIds,
    );
    const kind: NormalizedConversationKind =
      (readNumber(chat.style) ?? 0) === 43 ? "group" : "direct";
    const service = readString(chat.service_name);
    const explicitDisplayName = readString(chat.display_name);
    const displayName =
      kind === "group"
        ? explicitDisplayName
        : explicitDisplayName ??
          directConversationName(participantIds, participantById) ??
          readString(chat.chat_identifier);
    const chatStats = stats.get(id);

    return {
      id,
      providerKey: readString(chat.guid) ?? id,
      kind,
      ...(displayName === undefined ? {} : { displayName }),
      ...(service === undefined ? {} : { service }),
      ...(chatStats?.lastMessageAt === undefined ? {} : { lastMessageAt: chatStats.lastMessageAt }),
      messageCount: chatStats?.messageCount ?? 0,
      participantIds,
    };
  });
  const emittedIds = new Set(conversations.map((conversation) => conversation.id));

  for (const [id, chatStats] of stats) {
    if (emittedIds.has(id)) {
      continue;
    }

    conversations.push({
      id,
      providerKey: id,
      kind: "direct",
      displayName: "Unassigned messages",
      ...(chatStats.lastMessageAt === undefined
        ? {}
        : { lastMessageAt: chatStats.lastMessageAt }),
      messageCount: chatStats.messageCount,
      participantIds: filterKnownParticipantIds(
        chatStats.participantIds,
        knownParticipantIds,
      ),
    });
  }

  return conversations;
}

function buildReactions(
  rows: readonly MessageRow[],
  messageIdByGuid: ReadonlyMap<string, string>,
  participantByHandleRowId: ReadonlyMap<number, NormalizedParticipant>,
  warnings: IngestWarning[],
): NormalizedReaction[] {
  const reactions: NormalizedReaction[] = [];

  for (const row of rows) {
    const associatedType = readNumber(row.associated_message_type) ?? 0;
    const classification = classifyTapback(associatedType);

    if (classification === undefined || classification.action === "remove") {
      // Tapback removals are diverted from the message list but intentionally
      // not emitted as reactions (removal semantics are not implemented).
      continue;
    }

    const kind = classification.kind;

    const targetGuid = targetGuidFromAssociatedGuid(readString(row.associated_message_guid));
    const targetMessageId = targetGuid === undefined ? undefined : messageIdByGuid.get(targetGuid);
    const rowid = readNumber(row.rowid);

    if (targetMessageId === undefined || rowid === undefined) {
      warnings.push({
        code: "reaction-target-missing",
        message: "Skipped a tapback whose target message was not present.",
        source: targetGuid,
      });
      continue;
    }

    const senderId = senderParticipantId(row, participantByHandleRowId);
    const sentAtUtc = appleTimestampToIso(row.date);
    const guid = readString(row.guid);

    reactions.push({
      id: `reaction:${String(rowid)}`,
      targetMessageId,
      ...(senderId === undefined ? {} : { senderId }),
      kind,
      ...(sentAtUtc === undefined ? {} : { sentAtUtc }),
      rawTimestamp: formatRawTimestamp(row.date),
      ...(guid === undefined ? {} : { sourceGuid: guid }),
      sourceRowId: rowid,
    });
  }

  return reactions;
}

async function buildAttachments(
  root: ReadonlySourceDirectoryHandle,
  manifest: ManifestDbReader,
  db: SqliteDatabase,
  messageIdByRowId: ReadonlyMap<number, string>,
  warnings: IngestWarning[],
  progress: WorkerProgressCallback | undefined,
): Promise<NormalizedAttachment[]> {
  if (!sqliteTableExists(db, "attachment") || !sqliteTableExists(db, "message_attachment_join")) {
    return [];
  }

  const columns = sqliteTableColumns(db, "attachment");
  const rows = sqliteRows<AttachmentRow>(
    db,
    `
      SELECT
        attachment.ROWID AS attachment_rowid,
        message_attachment_join.message_id AS message_id,
        ${selectColumn(columns, "guid", "NULL")},
        ${selectColumn(columns, "filename", "NULL")},
        ${selectColumn(columns, "mime_type", "NULL")},
        ${selectColumn(columns, "transfer_name", "NULL")},
        ${selectColumn(columns, "total_bytes", "NULL")}
      FROM attachment
      JOIN message_attachment_join ON message_attachment_join.attachment_id = attachment.ROWID
      ORDER BY message_attachment_join.message_id, attachment.ROWID;
    `,
  );
  const attachments: NormalizedAttachment[] = [];
  let remainingAttachmentHashBytes = maxInlineAttachmentHashTotalBytes;
  let processedRows = 0;
  const attachmentProgress = createThrottledWorkerProgress({
    worker: "backup",
    progress,
    phase: "normalizing",
    label: "Normalizing attachments",
    totalUnits: rows.length,
  });

  for (const row of rows) {
    try {
      const attachmentRowId = readNumber(row.attachment_rowid);
      const sourceMessageId = readNumber(row.message_id);
      const messageId = sourceMessageId === undefined ? undefined : messageIdByRowId.get(sourceMessageId);

      if (attachmentRowId === undefined || messageId === undefined) {
        warnings.push({
          code: "attachment-message-missing",
          message: "Skipped an attachment whose message row was not present.",
        });
        continue;
      }

      const normalizedPath = normalizeAttachmentPath(readString(row.filename));
      let manifestRecord: ManifestFileRecord | undefined;
      let sourceSha256: string | undefined;

      if (normalizedPath !== undefined) {
        try {
          manifestRecord = manifest.findFile("MediaDomain", normalizedPath);

          if (manifestRecord === undefined) {
            warnings.push({
              code: "attachment-source-missing",
              message: "Attachment metadata was kept, but the source file was not present in Manifest.db.",
              source: normalizedPath,
            });
          } else if (shouldHashAttachmentSource(manifestRecord, remainingAttachmentHashBytes)) {
            const source = await readSourceFileBytes(root, manifestRecord, {
              maxReadBytes: Math.min(
                maxInlineAttachmentHashBytes,
                remainingAttachmentHashBytes,
              ),
            });
            sourceSha256 = source.sha256;
            remainingAttachmentHashBytes -= source.sourceByteLength;
          } else {
            warnings.push({
              code: "attachment-source-hash-deferred",
              message: "Attachment metadata was kept, but source hashing was deferred because the file is too large or its manifest size is unknown.",
              source: normalizedPath,
            });
          }
        } catch (cause) {
          if (cause instanceof SourceFileTooLargeError) {
            warnings.push({
              code: "attachment-source-hash-deferred",
              message: "Attachment metadata was kept, but source hashing was deferred because the file is too large or the ingest hash budget is exhausted.",
              source: normalizedPath,
            });
          } else {
            warnings.push({
              code: "attachment-source-unreadable",
              message: "Attachment metadata was kept, but the source file could not be hashed.",
              source: normalizedPath,
            });
            console.warn("Skipping attachment source hash.", cause);
          }
        }
      }

      const displayName = attachmentDisplayName(row, normalizedPath);
      const mime = readString(row.mime_type);
      const bytes = readNumber(row.total_bytes);
      const guid = readString(row.guid);

      attachments.push({
        id: `attachment:${String(attachmentRowId)}`,
        messageId,
        ...(displayName === undefined ? {} : { filename: displayName }),
        ...(mime === undefined ? {} : { mime }),
        ...(bytes === undefined ? {} : { bytes }),
        ...(normalizedPath === undefined ? {} : { sourcePath: normalizedPath }),
        ...(normalizedPath === undefined ? {} : { sourceDomain: "MediaDomain" }),
        ...(sourceSha256 === undefined ? {} : { sha256: sourceSha256 }),
        ...(guid === undefined ? {} : { sourceGuid: guid }),
      });
    } finally {
      processedRows += 1;
      // Only await when something is emitted so this per-row loop stays
      // synchronous between throttled progress updates.
      const progressEmission = attachmentProgress.maybeEmit(processedRows);

      if (progressEmission !== undefined) {
        await progressEmission;
      }
    }
  }

  await attachmentProgress.finish(processedRows);

  return attachments;
}

async function readContacts(
  contactsDb: SqliteDatabase | undefined,
  contactImagesDb: SqliteDatabase | undefined,
  warnings: IngestWarning[],
): Promise<ContactIndex> {
  const contacts = new Map<number, ContactRecord>();

  try {
    readContactPeople(contactsDb, contacts);
    readContactValues(contactsDb, contacts);
  } catch (cause) {
    warnings.push({
      code: "contacts-database-unreadable",
      message: "Skipped contacts resolution because AddressBook.sqlitedb could not be parsed.",
    });
    console.warn("Skipping contacts resolution.", cause);

    return new ContactIndex([]);
  }

  try {
    await readContactImages(contactImagesDb, contacts, warnings);
  } catch (cause) {
    warnings.push({
      code: "contact-images-database-unreadable",
      message: "Skipped contact avatars because AddressBookImages.sqlitedb could not be parsed.",
    });
    console.warn("Skipping contact avatars.", cause);
  }

  return new ContactIndex(Array.from(contacts.values()));
}

function readContactPeople(
  contactsDb: SqliteDatabase | undefined,
  contacts: Map<number, ContactRecord>,
): void {
  if (contactsDb === undefined || !sqliteTableExists(contactsDb, "ABPerson")) {
    return;
  }

  const personColumns = sqliteTableColumns(contactsDb, "ABPerson");
  const people = sqliteRows<ContactRow>(
    contactsDb,
    `
      SELECT
        ROWID AS rowid,
        ${selectColumn(personColumns, "First", "NULL", "first")},
        ${selectColumn(personColumns, "Last", "NULL", "last")},
        ${selectColumn(personColumns, "Organization", "NULL", "organization")}
      FROM ABPerson
      ORDER BY ROWID;
    `,
  );

  for (const person of people) {
    const recordId = readNumber(person.rowid);
    if (recordId === undefined) {
      continue;
    }

    const firstName = readString(person.first)?.trim();

    contacts.set(recordId, {
      displayName: contactDisplayName(person),
      ...(firstName === undefined ? {} : { firstName }),
      phones: new Set<string>(),
      emails: new Set<string>(),
    });
  }
}

function readContactValues(
  contactsDb: SqliteDatabase | undefined,
  contacts: Map<number, ContactRecord>,
): void {
  if (contactsDb === undefined || !sqliteTableExists(contactsDb, "ABMultiValue")) {
    return;
  }

  const multiValueColumns = sqliteTableColumns(contactsDb, "ABMultiValue");
  const values = sqliteRows<ContactValueRow>(
    contactsDb,
    `
      SELECT
        ${selectColumn(multiValueColumns, "record_id", "NULL")},
        ${selectColumn(multiValueColumns, "property", "NULL")},
        ${selectColumn(multiValueColumns, "value", "NULL")}
      FROM ABMultiValue
      ORDER BY ROWID;
    `,
  );

  for (const value of values) {
    const recordId = readNumber(value.record_id);
    const property = readNumber(value.property);
    const text = readString(value.value);
    const contact = recordId === undefined ? undefined : contacts.get(recordId);

    if (contact === undefined || property === undefined || text === undefined) {
      continue;
    }

    if (property === 3) {
      for (const key of phoneKeys(text)) {
        contact.phones.add(key);
      }
    } else if (property === 4) {
      contact.emails.add(text.trim().toLocaleLowerCase());
    }
  }
}

async function readContactImages(
  contactImagesDb: SqliteDatabase | undefined,
  contacts: Map<number, ContactRecord>,
  warnings: IngestWarning[],
): Promise<void> {
  if (
    contactImagesDb === undefined ||
    !sqliteTableExists(contactImagesDb, "ABThumbnailImage")
  ) {
    return;
  }

  const imageColumns = sqliteTableColumns(contactImagesDb, "ABThumbnailImage");
  const dataColumn = imageColumns.has("data")
    ? "data"
    : imageColumns.has("image")
      ? "image"
      : undefined;

  if (dataColumn === undefined || !imageColumns.has("record_id")) {
    return;
  }

  const images = sqliteRows<ContactImageRow>(
    contactImagesDb,
    `
      SELECT record_id, ${dataColumn} AS data
      FROM ABThumbnailImage
      ORDER BY record_id;
    `,
  );

  for (const image of images) {
    const recordId = readNumber(image.record_id);
    const contact = recordId === undefined ? undefined : contacts.get(recordId);
    const data = image.data instanceof Uint8Array ? image.data : undefined;

    if (contact === undefined || data === undefined) {
      continue;
    }

    const sniffed = sniffImageBytes(data);

    if (sniffed === undefined) {
      warnings.push({
        code: "contact-avatar-unreadable",
        message: "Skipped a contact avatar blob that was not JPEG or PNG.",
        source: String(recordId),
      });
      continue;
    }

    contact.avatar = {
      mime: sniffed.mime,
      bytes: sniffed.bytes,
      byteLength: sniffed.bytes.byteLength,
      sha256: await sha256Hex(sniffed.bytes),
    };
  }
}

class ContactIndex {
  private readonly byPhone = new Map<string, ContactRecord>();
  private readonly byEmail = new Map<string, ContactRecord>();

  constructor(contacts: readonly ContactRecord[]) {
    for (const contact of contacts) {
      for (const phone of contact.phones) {
        this.byPhone.set(phone, contact);
      }
      for (const email of contact.emails) {
        this.byEmail.set(email, contact);
      }
    }
  }

  resolve(handle: string): ResolvedContact | undefined {
    const email = handle.trim().toLocaleLowerCase();
    const byEmail = this.byEmail.get(email);
    const contact =
      byEmail ??
      phoneKeys(handle)
        .map((key) => this.byPhone.get(key))
        .find((entry) => entry !== undefined);

    return contact === undefined
      ? undefined
      : {
          displayName: contact.displayName,
          ...(contact.firstName === undefined
            ? {}
            : { firstName: contact.firstName }),
          ...(contact.avatar === undefined ? {} : { avatar: contact.avatar }),
        };
  }
}

function selectColumn(
  columns: ReadonlySet<string>,
  columnName: string,
  fallbackSql: string,
  alias: string = columnName,
): string {
  return columns.has(columnName)
    ? `${columnName} AS ${alias}`
    : `${fallbackSql} AS ${alias}`;
}

function mapChatIdsByMessageId(
  rows: readonly ChatMessageRow[],
  chatRowIdRemap: ReadonlyMap<number, number>,
): Map<number, number> {
  const map = new Map<number, number>();

  for (const row of rows) {
    const messageId = readNumber(row.message_id);
    const chatId = readNumber(row.chat_id);

    if (messageId !== undefined && chatId !== undefined && !map.has(messageId)) {
      map.set(messageId, chatRowIdRemap.get(chatId) ?? chatId);
    }
  }

  return map;
}

function filterKnownParticipantIds(
  participantIds: ReadonlySet<string>,
  knownParticipantIds: ReadonlySet<string>,
): string[] {
  const filtered = Array.from(participantIds).filter((id) =>
    knownParticipantIds.has(id),
  );

  return filtered.length > 0 ? filtered : ["self"];
}

function conversationIdForMessage(
  messageRowId: number,
  chatIdsByMessageId: ReadonlyMap<number, number>,
): string {
  return `chat:${String(chatIdsByMessageId.get(messageRowId) ?? 0)}`;
}

function senderParticipantId(
  row: MessageRow,
  participantByHandleRowId: ReadonlyMap<number, NormalizedParticipant>,
): string | undefined {
  if (readBooleanish(row.is_from_me)) {
    return "self";
  }

  const handleId = readNumber(row.handle_id);
  const participant = handleId === undefined ? undefined : participantByHandleRowId.get(handleId);

  return participant?.id;
}

function messageBody(row: MessageRow, rowid: number, warnings: IngestWarning[]): string {
  const text = readString(row.text);

  if (text !== undefined) {
    return text;
  }

  if (row.attributedBody instanceof Uint8Array && row.attributedBody.byteLength > 0) {
    const extracted = extractTypedstreamText(row.attributedBody);

    if (extracted !== undefined) {
      return extracted;
    }

    warnings.push({
      code: "message-body-undecodable",
      message:
        "Kept a message with an empty body because its attributedBody could not be decoded and no plain text was present.",
      source: String(rowid),
    });
  }

  return "";
}

type TapbackClassification =
  | { action: "add"; kind: NormalizedReactionKind }
  | { action: "remove" };

function classifyTapback(value: number): TapbackClassification | undefined {
  if (value >= tapbackAddTypeMin && value <= tapbackAddTypeMax) {
    return { action: "add", kind: reactionKinds.get(value) ?? "unknown" };
  }

  if (value >= tapbackRemoveTypeMin && value <= tapbackRemoveTypeMax) {
    return { action: "remove" };
  }

  return undefined;
}

function targetGuidFromAssociatedGuid(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  if (value.startsWith("bp:")) {
    return value.slice(3);
  }

  if (value.startsWith("p:")) {
    return value.slice(value.lastIndexOf("/") + 1);
  }

  return value;
}

function formatRawTimestamp(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }

  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function isoDateFromUnixMilliseconds(value: number | bigint): string | undefined {
  const milliseconds =
    typeof value === "bigint" ? safeNumberFromDateMilliseconds(value) : value;

  if (
    milliseconds === undefined ||
    !Number.isFinite(milliseconds) ||
    Math.abs(milliseconds) > maxDateMilliseconds
  ) {
    return undefined;
  }

  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeNumberFromDateMilliseconds(value: bigint): number | undefined {
  if (value < -maxDateMillisecondsBigInt || value > maxDateMillisecondsBigInt) {
    return undefined;
  }

  return Number(value);
}

function directConversationName(
  participantIds: readonly string[],
  participantById: ReadonlyMap<string, NormalizedParticipant>,
): string | undefined {
  for (const participantId of participantIds) {
    if (participantId === "self") {
      continue;
    }

    const participant = participantById.get(participantId);
    if (participant !== undefined) {
      return participant.contactName ?? participant.handle;
    }
  }

  return undefined;
}

function normalizeAttachmentPath(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const trimmed = value.trim();
  const markerIndex = trimmed.indexOf(attachmentPathMarker);

  if (markerIndex >= 0) {
    return trimmed.slice(markerIndex);
  }

  if (trimmed.startsWith("~/")) {
    return trimmed.slice(2);
  }

  if (trimmed.startsWith("/")) {
    return trimmed.slice(1);
  }

  return trimmed;
}

function shouldHashAttachmentSource(
  record: ManifestFileRecord,
  remainingHashBudgetBytes: number,
): boolean {
  const size = record.metadata.size;

  return (
    size !== undefined &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    size <= maxInlineAttachmentHashBytes &&
    size <= remainingHashBudgetBytes
  );
}

function attachmentDisplayName(
  row: AttachmentRow,
  normalizedPath: string | undefined,
): string | undefined {
  const transferName = readString(row.transfer_name);

  if (transferName !== undefined && transferName.length > 0) {
    return transferName;
  }

  if (normalizedPath === undefined) {
    return undefined;
  }

  return normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
}

function contactDisplayName(person: ContactRow): string {
  const name = [readString(person.first), readString(person.last)]
    .filter((part) => part !== undefined && part.trim().length > 0)
    .join(" ")
    .trim();

  if (name.length > 0) {
    return name;
  }

  return readString(person.organization) ?? "Unknown contact";
}

function classifyHandle(handle: string): NormalizedParticipantKind {
  if (handle.trim().length === 0) {
    return "unknown";
  }

  if (handle.includes("@")) {
    return "email";
  }

  return phoneKeys(handle).length > 0 ? "phone" : "unknown";
}

function phoneKeys(value: string): string[] {
  const keys = new Set<string>();
  const parsed =
    parsePhoneNumberFromString(value) ?? parsePhoneNumberFromString(value, "US");

  if (parsed !== undefined) {
    keys.add(parsed.number);
    keys.add(parsed.nationalNumber);
  }

  const digits = value.replace(/\D/gu, "");

  if (digits.length > 0) {
    keys.add(digits);
  }

  if (digits.length >= 10) {
    keys.add(digits.slice(-10));
  }

  if (digits.length >= 7) {
    keys.add(digits.slice(-7));
  }

  return Array.from(keys);
}

function sniffImageBytes(
  data: Uint8Array,
): { mime: NormalizedContactAvatar["mime"]; bytes: Uint8Array } | undefined {
  const pngMagic = [0x89, 0x50, 0x4e, 0x47] as const;
  const jpegMagic = [0xff, 0xd8, 0xff] as const;

  for (let offset = 0; offset < data.byteLength; offset += 1) {
    if (bytesStartWith(data, pngMagic, offset)) {
      return { mime: "image/png", bytes: data.slice(offset) };
    }

    if (bytesStartWith(data, jpegMagic, offset)) {
      return { mime: "image/jpeg", bytes: data.slice(offset) };
    }
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBooleanish(value: unknown): boolean {
  return value === true || value === 1 || value === 1n;
}

function isPositiveIntegerish(value: unknown): boolean {
  if (typeof value === "bigint") {
    return value > 0n;
  }

  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
