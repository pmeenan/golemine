export type WorkerKind = "backup" | "db" | "media";

export type WorkerProgressPhase =
  | "starting"
  | "prepare"
  | "scanning"
  | "manifest"
  | "extracting"
  | "normalizing"
  | "writing"
  | "hashing"
  | "sqlite-init"
  | "sqlite-opfs"
  | "sqlite-query"
  | "decoding"
  | "complete";

export type WorkerStructuredValue = string | number | boolean | null;

export type WorkerErrorCode =
  | "backup_access_failed"
  | "backup_encrypted_unsupported"
  | "backup_file_missing"
  | "backup_ingest_failed"
  | "backup_invalid"
  | "backup_manifest_unreadable"
  | "backup_not_found"
  | "backup_parse_failed"
  | "db_ingest_failed"
  | "unsupported_environment"
  | "sqlite_unavailable"
  | "sqlite_init_failed"
  | "sqlite_opfs_unavailable"
  | "sqlite_query_failed"
  | "worker_failed";

export interface WorkerErrorPayload {
  worker: WorkerKind;
  code: WorkerErrorCode;
  message: string;
  recoverable: boolean;
  causeName?: string;
  causeMessage?: string;
  details?: Record<string, WorkerStructuredValue>;
}

export interface WorkerProgressEvent {
  worker: WorkerKind;
  phase: WorkerProgressPhase;
  label: string;
  completedUnits?: number;
  totalUnits?: number;
  at: string;
}

export type WorkerProgressCallback = (
  progress: WorkerProgressEvent,
) => void | Promise<void>;

export type WorkerResult<TValue> =
  | {
      ok: true;
      value: TValue;
    }
  | {
      ok: false;
      error: WorkerErrorPayload;
    };

export interface WorkerDemoRequest {
  message: string;
  requestId?: string;
}

export interface WorkerDemoResponse {
  worker: WorkerKind;
  message: string;
  echo: string;
  requestId?: string;
  derivedDbVersion: number;
  at: string;
}

export interface SqliteSmokeStatus {
  worker: "db";
  sqliteVersion: string;
  databaseName: string;
  vfs: "opfs-sahpool";
  poolCapacity: number;
  poolFileCount: number;
  selectedLabel: string;
  selectedDerivedDbVersion: number;
  insertedRows: number;
  at: string;
}

export type BackupProviderId = "ios-itunes";

/**
 * Provider-agnostic device identity (Architecture §5). Providers translate
 * their source-specific metadata (Apple plist keys, future Android formats)
 * into this shape before it crosses the worker boundary; UI and storage
 * layers never see provider-specific field names.
 */
export interface BackupDeviceInfo {
  udid: string;
  name?: string;
  model?: string;
  osVersion?: string;
  serialNumber?: string;
  phoneNumber?: string;
}

export interface BackupDetectionResult {
  provider: BackupProviderId;
  sourceKind: "itunes-finder";
  id: string;
  friendlyName: string;
  sourceFolderName: string;
  isEncrypted: boolean;
  deviceInfo: BackupDeviceInfo;
  lastBackupDate?: string;
  backupDate?: string;
  backupFormatVersion?: string;
}

export type NormalizedParticipantKind = "phone" | "email" | "unknown" | "self";
export type NormalizedConversationKind = "direct" | "group";
export type NormalizedReactionKind =
  | "loved"
  | "liked"
  | "disliked"
  | "laughed"
  | "emphasized"
  | "questioned"
  | "unknown";

export interface NormalizedContactAvatar {
  participantId: string;
  sha256: string;
  mime: "image/jpeg" | "image/png";
  byteLength: number;
  bytes: Uint8Array;
}

export interface NormalizedParticipant {
  id: string;
  handle: string;
  kind: NormalizedParticipantKind;
  contactName?: string;
  isSelf: boolean;
  avatarSha256?: string;
  avatarMime?: "image/jpeg" | "image/png";
}

export interface NormalizedConversation {
  id: string;
  providerKey: string;
  kind: NormalizedConversationKind;
  displayName?: string;
  service?: string;
  lastMessageAt?: string;
  messageCount: number;
  participantIds: string[];
}

export interface NormalizedMessage {
  id: string;
  conversationId: string;
  senderId?: string;
  sentAtUtc?: string;
  rawTimestamp: string;
  body: string;
  service?: string;
  isFromMe: boolean;
  dateDelivered?: string;
  dateRead?: string;
  edited: boolean;
  unsent: boolean;
  sourceGuid?: string;
  sourceRowId: number;
  isSystemEvent: boolean;
}

export interface NormalizedAttachment {
  id: string;
  messageId: string;
  filename?: string;
  mime?: string;
  bytes?: number;
  sourcePath?: string;
  sourceDomain?: string;
  sha256?: string;
  sourceGuid?: string;
}

export interface NormalizedReaction {
  id: string;
  targetMessageId: string;
  senderId?: string;
  kind: NormalizedReactionKind;
  sentAtUtc?: string;
  rawTimestamp: string;
  sourceGuid?: string;
  sourceRowId: number;
}

export interface IngestSourceFile {
  role: string;
  fileId?: string;
  domain?: string;
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface IngestWarning {
  code: string;
  message: string;
  source?: string;
}

export interface IngestCounts {
  conversations: number;
  participants: number;
  messages: number;
  attachments: number;
  reactions: number;
  contactAvatars: number;
  warnings: number;
}

export interface BackupIngestRequest {
  backupId: string;
  provider: BackupProviderId;
  sourceKind: BackupDetectionResult["sourceKind"];
  sourceFolderName: string;
  friendlyName: string;
  deviceInfo: BackupDeviceInfo;
  isEncrypted: boolean;
  derivedDbVersion: number;
}

export interface BackupIngestReport {
  backupId: string;
  provider: BackupProviderId;
  startedAt: string;
  completedAt: string;
  counts: IngestCounts;
  sourceFiles: IngestSourceFile[];
  warnings: IngestWarning[];
}

export interface DbIngestSummary extends BackupIngestReport {
  databaseName: string;
  derivedDbVersion: number;
}

export type IngestBatch =
  | {
      backupId: string;
      kind: "participants";
      items: NormalizedParticipant[];
    }
  | {
      backupId: string;
      kind: "conversations";
      items: NormalizedConversation[];
    }
  | {
      backupId: string;
      kind: "messages";
      items: NormalizedMessage[];
    }
  | {
      backupId: string;
      kind: "attachments";
      items: NormalizedAttachment[];
    }
  | {
      backupId: string;
      kind: "reactions";
      items: NormalizedReaction[];
    }
  | {
      backupId: string;
      kind: "contact-avatars";
      items: NormalizedContactAvatar[];
    };

export interface IngestBatchReceipt {
  backupId: string;
  kind: IngestBatch["kind"] | "prepare" | "finalize";
  accepted: number;
}

export interface IngestSinkApi {
  prepareIngest(request: BackupIngestRequest): Promise<WorkerResult<IngestBatchReceipt>>;
  writeIngestBatch(batch: IngestBatch): Promise<WorkerResult<IngestBatchReceipt>>;
  finalizeIngest(report: BackupIngestReport): Promise<WorkerResult<DbIngestSummary>>;
}

export interface BackupWorkerApi {
  demoRoundTrip(
    request: WorkerDemoRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<WorkerDemoResponse>>;
  detectBackup(
    root: FileSystemDirectoryHandle,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<BackupDetectionResult>>;
  ingestUnencryptedBackup(
    root: FileSystemDirectoryHandle,
    request: BackupIngestRequest,
    sink: IngestSinkApi,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<BackupIngestReport>>;
  ingestUnencryptedBackupToDb(
    root: FileSystemDirectoryHandle,
    request: BackupIngestRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<BackupIngestReport>>;
}

export interface DbWorkerApi {
  demoRoundTrip(
    request: WorkerDemoRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<WorkerDemoResponse>>;
  runSqliteSmoke(
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<SqliteSmokeStatus>>;
  prepareIngest(
    request: BackupIngestRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<IngestBatchReceipt>>;
  writeIngestBatch(
    batch: IngestBatch,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<IngestBatchReceipt>>;
  finalizeIngest(
    report: BackupIngestReport,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<DbIngestSummary>>;
  getIngestSummary(
    backupId: string,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<DbIngestSummary | undefined>>;
}

export interface MediaWorkerApi {
  demoRoundTrip(
    request: WorkerDemoRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<WorkerDemoResponse>>;
}

export function workerOk<TValue>(value: TValue): WorkerResult<TValue> {
  return { ok: true, value };
}

export function workerFail<TValue>(
  error: WorkerErrorPayload,
): WorkerResult<TValue> {
  return { ok: false, error };
}

export function createWorkerProgressEvent(input: {
  worker: WorkerKind;
  phase: WorkerProgressPhase;
  label: string;
  completedUnits?: number;
  totalUnits?: number;
}): WorkerProgressEvent {
  return {
    ...input,
    at: new Date().toISOString(),
  };
}

export function toWorkerError(input: {
  worker: WorkerKind;
  code: WorkerErrorCode;
  message: string;
  cause?: unknown;
  recoverable?: boolean;
  details?: Record<string, WorkerStructuredValue>;
}): WorkerErrorPayload {
  const causeFields =
    input.cause instanceof Error
      ? {
          causeName: input.cause.name,
          causeMessage: input.cause.message,
        }
      : input.cause === undefined
        ? {}
        : {
            causeMessage: formatUnknownCause(input.cause),
          };

  return {
    worker: input.worker,
    code: input.code,
    message: input.message,
    recoverable: input.recoverable ?? true,
    ...causeFields,
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

export function formatWorkerErrorPayload(error: WorkerErrorPayload): string {
  return error.causeMessage === undefined
    ? error.message
    : `${error.message} (${error.causeMessage})`;
}

function formatUnknownCause(cause: unknown): string {
  if (typeof cause === "string") {
    return cause;
  }

  if (
    typeof cause === "number" ||
    typeof cause === "boolean" ||
    typeof cause === "bigint" ||
    typeof cause === "symbol"
  ) {
    return String(cause);
  }

  if (cause === null) {
    return "null";
  }

  return Object.prototype.toString.call(cause);
}
