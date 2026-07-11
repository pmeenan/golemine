import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
} from "../../lib/recents";
import { isObjectRecord } from "./guards";

/**
 * True when this runtime exposes OPFS (`navigator.storage.getDirectory`).
 * Probed defensively because workers can run in stripped-down test runtimes.
 */
export function hasOpfsStorage(): boolean {
  const navigatorValue: unknown = Reflect.get(globalThis, "navigator");

  if (!isObjectRecord(navigatorValue)) {
    return false;
  }

  const storageValue: unknown = Reflect.get(navigatorValue, "storage");

  if (!isObjectRecord(storageValue)) {
    return false;
  }

  return typeof Reflect.get(storageValue, "getDirectory") === "function";
}

/**
 * True when `value` (after trimming) can be used as a single OPFS path
 * segment: non-empty and free of separators and NUL. Callers that need a
 * typed error should test this and throw their own error class.
 */
export function isSafeOpfsPathSegment(value: string): boolean {
  const trimmed = value.trim();

  return (
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes("\0")
  );
}

/**
 * Walks OPFS to the per-backup derived-data directory
 * `golemine/backups/<backupDirectoryName>`. The segment is re-validated here
 * as defense in depth; callers are expected to assert it first with their own
 * typed error so this generic throw never fires in practice.
 */
export async function getOpfsBackupDirectoryHandle(
  backupDirectoryName: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  if (!isSafeOpfsPathSegment(backupDirectoryName)) {
    throw new Error(
      "Derived data directory name is not a safe OPFS path segment.",
    );
  }

  const safeDirectoryName = backupDirectoryName.trim();
  const root = await navigator.storage.getDirectory();
  const appDirectory = await root.getDirectoryHandle(
    derivedDataOpfsAppDirectoryName,
    { create },
  );
  const backupsDirectory = await appDirectory.getDirectoryHandle(
    derivedDataOpfsBackupsDirectoryName,
    { create },
  );

  return backupsDirectory.getDirectoryHandle(safeDirectoryName, { create });
}

/**
 * Probes the OPFS storage estimate and returns the available byte budget
 * (`quota - usage`, floored at zero). Returns `undefined` when this runtime
 * has no OPFS storage, no `navigator.storage.estimate`, or the estimate
 * reports an unusable shape (non-number, non-finite, or unsafe-integer
 * values). This helper only probes: callers own the error policy and must
 * treat an unknown budget as "do not block".
 */
export async function getAvailableOpfsQuotaBytes(): Promise<number | undefined> {
  if (!hasOpfsStorage()) {
    return undefined;
  }

  const storage = navigator.storage;
  if (typeof storage.estimate !== "function") {
    return undefined;
  }

  const estimate = await storage.estimate();
  if (
    !isUsableQuotaByteValue(estimate.quota) ||
    !isUsableQuotaByteValue(estimate.usage)
  ) {
    return undefined;
  }

  return Math.max(0, estimate.quota - estimate.usage);
}

function isUsableQuotaByteValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value)
  );
}

/**
 * Removes an OPFS entry when it exists. Missing entries are an expected part
 * of idempotent staging cleanup, while all other storage failures still reach
 * the caller.
 */
export async function removeOpfsEntryIfFound(
  directory: Pick<FileSystemDirectoryHandle, "removeEntry">,
  name: string,
  options?: FileSystemRemoveOptions,
): Promise<void> {
  try {
    await directory.removeEntry(name, options);
  } catch (cause) {
    if (!isNotFoundError(cause)) {
      throw cause;
    }
  }
}

function isNotFoundError(cause: unknown): boolean {
  return isObjectRecord(cause) && cause.name === "NotFoundError";
}
