import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
  removeEntryIfFound,
} from "../../lib/recents";
import {
  toWorkerError,
  workerFail,
  workerOk,
  type ClearDerivedDataStorageResponse,
  type DbWorkerApi,
  type DerivedDataStorageSummary,
  type WorkerProgressCallback,
  type WorkerResult,
} from "../../lib/worker-types";
import { emitWorkerProgress } from "../shared/progress";
import { hasOpfsStorage, isSafeOpfsPathSegment } from "../shared/opfs";

type StorageApi = Pick<
  DbWorkerApi,
  "clearDerivedDataStorage" | "getDerivedDataStorageSummary"
>;

interface StorageFileHandle {
  kind: "file";
  getFile(): Promise<Pick<File, "size">>;
}

interface StorageDirectoryHandle {
  kind: "directory";
  values(): AsyncIterableIterator<StorageDirectoryHandle | StorageFileHandle>;
}

export interface DbWorkerStorageApiOptions {
  getBackupDirectory?: (
    backupId: string,
  ) => Promise<StorageDirectoryHandle | undefined>;
  removeBackupDirectory?: (backupId: string) => Promise<void>;
}

interface MutableStorageSummary {
  byteLength: number;
  directoryCount: number;
  fileCount: number;
}

export function createDbWorkerStorageApi(
  options: DbWorkerStorageApiOptions = {},
): StorageApi {
  const getBackupDirectory =
    options.getBackupDirectory ?? getOpfsBackupDirectoryIfPresent;
  const removeBackupDirectory =
    options.removeBackupDirectory ?? removeOpfsBackupDirectory;

  return {
    getDerivedDataStorageSummary: (backupId, progress) =>
      readStorageSummary(backupId, getBackupDirectory, progress),
    clearDerivedDataStorage: async (backupId, progress) => {
      const summaryResult = await readStorageSummary(
        backupId,
        getBackupDirectory,
        progress,
      );

      if (!summaryResult.ok) {
        return summaryResult;
      }

      try {
        await emitWorkerProgress(
          "db",
          progress,
          "writing",
          "Clearing derived data",
          0,
          1,
        );
        await removeBackupDirectory(assertBackupId(backupId));
        await emitWorkerProgress(
          "db",
          progress,
          "complete",
          "Derived data cleared",
          1,
          1,
        );

        return workerOk({
          backupId: summaryResult.value.backupId,
          clearedByteLength: summaryResult.value.byteLength,
          clearedDirectoryCount: summaryResult.value.directoryCount,
          clearedFileCount: summaryResult.value.fileCount,
        });
      } catch (cause) {
        return storageFailure<ClearDerivedDataStorageResponse>(
          "The derived data could not be cleared.",
          cause,
        );
      }
    },
  };
}

export async function measureDerivedDataDirectory(
  directory: StorageDirectoryHandle,
): Promise<Omit<DerivedDataStorageSummary, "backupId">> {
  const summary: MutableStorageSummary = {
    byteLength: 0,
    directoryCount: 0,
    fileCount: 0,
  };

  await measureDirectoryEntries(directory, summary);

  return summary;
}

async function readStorageSummary(
  backupId: string,
  getBackupDirectory: NonNullable<
    DbWorkerStorageApiOptions["getBackupDirectory"]
  >,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<DerivedDataStorageSummary>> {
  try {
    const safeBackupId = assertBackupId(backupId);
    await emitWorkerProgress(
      "db",
      progress,
      "scanning",
      "Measuring derived data",
    );
    const directory = await getBackupDirectory(safeBackupId);
    const measured =
      directory === undefined
        ? { byteLength: 0, directoryCount: 0, fileCount: 0 }
        : await measureDerivedDataDirectory(directory);
    await emitWorkerProgress(
      "db",
      progress,
      "complete",
      "Derived data measured",
      measured.fileCount,
      measured.fileCount,
    );

    return workerOk({ backupId: safeBackupId, ...measured });
  } catch (cause) {
    return storageFailure<DerivedDataStorageSummary>(
      "The derived data size could not be measured.",
      cause,
    );
  }
}

async function measureDirectoryEntries(
  directory: StorageDirectoryHandle,
  summary: MutableStorageSummary,
): Promise<void> {
  for await (const handle of directory.values()) {
    if (handle.kind === "directory") {
      summary.directoryCount += 1;
      await measureDirectoryEntries(handle, summary);
      continue;
    }

    const file = await handle.getFile();
    summary.fileCount += 1;
    summary.byteLength = addSafeByteLength(summary.byteLength, file.size);
  }
}

async function getOpfsBackupDirectoryIfPresent(
  backupId: string,
): Promise<StorageDirectoryHandle | undefined> {
  assertOpfsAvailable();

  try {
    const root = await navigator.storage.getDirectory();
    const appDirectory = await root.getDirectoryHandle(
      derivedDataOpfsAppDirectoryName,
      { create: false },
    );
    const backupsDirectory = await appDirectory.getDirectoryHandle(
      derivedDataOpfsBackupsDirectoryName,
      { create: false },
    );

    return (await backupsDirectory.getDirectoryHandle(backupId, {
      create: false,
    })) as unknown as StorageDirectoryHandle;
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return undefined;
    }

    throw cause;
  }
}

async function removeOpfsBackupDirectory(backupId: string): Promise<void> {
  assertOpfsAvailable();

  try {
    const root = await navigator.storage.getDirectory();
    const appDirectory = await root.getDirectoryHandle(
      derivedDataOpfsAppDirectoryName,
      { create: false },
    );
    const backupsDirectory = await appDirectory.getDirectoryHandle(
      derivedDataOpfsBackupsDirectoryName,
      { create: false },
    );

    await removeEntryIfFound(backupsDirectory, backupId);
  } catch (cause) {
    if (!isNotFoundError(cause)) {
      throw cause;
    }
  }
}

function assertBackupId(backupId: string): string {
  if (!isSafeOpfsPathSegment(backupId)) {
    throw new Error("The backup id is not a safe OPFS path segment.");
  }

  return backupId.trim();
}

function assertOpfsAvailable(): void {
  if (!hasOpfsStorage()) {
    throw new Error("OPFS is not available in this worker.");
  }
}

function addSafeByteLength(total: number, next: number): number {
  if (!Number.isSafeInteger(next) || next < 0 || total > Number.MAX_SAFE_INTEGER - next) {
    throw new Error("A derived-data file reported an invalid byte length.");
  }

  return total + next;
}

function isNotFoundError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "NotFoundError";
}

function storageFailure<TValue>(
  message: string,
  cause: unknown,
): WorkerResult<TValue> {
  return workerFail(
    toWorkerError({
      worker: "db",
      code: "derived_data_storage_failed",
      message,
      cause,
      recoverable: true,
    }),
  );
}
