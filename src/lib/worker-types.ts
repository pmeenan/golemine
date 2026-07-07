export type WorkerKind = "backup" | "db" | "media";

export type WorkerProgressPhase =
  | "starting"
  | "scanning"
  | "sqlite-init"
  | "sqlite-opfs"
  | "sqlite-query"
  | "decoding"
  | "complete";

export type WorkerStructuredValue = string | number | boolean | null;

export type WorkerErrorCode =
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

export interface BackupWorkerApi {
  demoRoundTrip(
    request: WorkerDemoRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<WorkerDemoResponse>>;
}

export interface DbWorkerApi {
  demoRoundTrip(
    request: WorkerDemoRequest,
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<WorkerDemoResponse>>;
  runSqliteSmoke(
    progress?: WorkerProgressCallback,
  ): Promise<WorkerResult<SqliteSmokeStatus>>;
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
