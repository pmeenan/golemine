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
