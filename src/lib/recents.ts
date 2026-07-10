import { derivedDbVersion } from "./constants";
import type { BackupDetectionResult, BackupDeviceInfo } from "./worker-types";

export type RecentBackupIngestStatus =
  | "not-ingested"
  | "ingesting"
  | "ingested"
  | "needs-reingest"
  | "failed";

export interface RecentBackupDeviceInfo extends Partial<BackupDeviceInfo> {
  lastBackupDate?: string;
}

export interface RecentBackupRecord {
  id: string;
  friendlyName: string;
  directoryHandle: FileSystemDirectoryHandle;
  deviceInfo: RecentBackupDeviceInfo;
  isEncrypted: boolean;
  lastOpened: string;
  ingestStatus: RecentBackupIngestStatus;
  derivedDbVersion: number;
}

export interface RecentBackupInput {
  id: string;
  friendlyName?: string;
  directoryHandle: FileSystemDirectoryHandle;
  deviceInfo?: RecentBackupDeviceInfo;
  isEncrypted: boolean;
  lastOpened?: string | Date;
  ingestStatus?: RecentBackupIngestStatus;
  derivedDbVersion?: number;
}

export interface RecentBackupPersistence {
  list(): Promise<RecentBackupRecord[]>;
  get(id: string): Promise<RecentBackupRecord | undefined>;
  put(record: RecentBackupRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface DerivedDataStorage {
  wipeDirectories(directoryNames: readonly string[]): Promise<void>;
}

export interface RecordDetectionOptions {
  /**
   * The id of the recent record the user re-opened, when known. If the folder
   * now detects as a different backup, the stale record and its derived data
   * are retired instead of being stranded.
   */
  previousRecordId?: string;
  /**
   * The user explicitly chose to replace an existing backup snapshot for the
   * same detected device. Wipe every derived-data directory before updating
   * the recent and force a clean ingest state.
   */
  replaceExisting?: boolean;
}

export interface BackupRecentsStore {
  list(): Promise<RecentBackupRecord[]>;
  get(id: string): Promise<RecentBackupRecord | undefined>;
  findReplacementCandidate(
    detection: BackupDetectionResult,
    directoryHandle: FileSystemDirectoryHandle,
  ): Promise<RecentBackupRecord | undefined>;
  recordDetection(
    detection: BackupDetectionResult,
    directoryHandle: FileSystemDirectoryHandle,
    options?: RecordDetectionOptions,
  ): Promise<RecentBackupRecord>;
  updateIngestStatus(
    id: string,
    ingestStatus: RecentBackupIngestStatus,
  ): Promise<RecentBackupRecord>;
  rename(id: string, friendlyName: string): Promise<RecentBackupRecord>;
  remove(id: string): Promise<void>;
}

export interface BackupRecentsStoreOptions {
  persistence?: RecentBackupPersistence;
  derivedDataStorage?: DerivedDataStorage;
}

export interface OpfsDirectoryHandle {
  name: string;
  getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<OpfsDirectoryHandle>;
  removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void>;
}

export interface OpfsRootProvider {
  getDirectory(): Promise<OpfsDirectoryHandle>;
}

export interface OpfsDerivedDataStorageOptions {
  rootProvider?: OpfsRootProvider;
}

export const recentBackupsDatabaseName = "golemine-recents";
export const recentBackupsStoreName = "backups";
export const derivedDataOpfsAppDirectoryName = "golemine";
export const derivedDataOpfsBackupsDirectoryName = "backups";

const recentsDatabaseVersion = 1;

export function createBackupRecentsStore(
  options: BackupRecentsStoreOptions = {},
): BackupRecentsStore {
  const persistence = options.persistence ?? createIndexedDbRecentBackupPersistence();
  const derivedDataStorage = options.derivedDataStorage ?? createOpfsDerivedDataStorage();

  return {
    list: async () =>
      sortRecentBackups((await persistence.list()).map(recoverInterruptedIngest)),
    get: async (id) => {
      const record = await persistence.get(normalizeRecentBackupId(id));

      return record === undefined ? undefined : recoverInterruptedIngest(record);
    },
    findReplacementCandidate: async (detection, directoryHandle) => {
      const existing = await findRecordForDetection(persistence, detection);

      if (existing === undefined) {
        return undefined;
      }

      const sameDirectory = await isSameDirectoryEntry(
        existing.directoryHandle,
        directoryHandle,
      );
      const sameBackupDate =
        existing.deviceInfo.lastBackupDate === detection.lastBackupDate;

      return sameDirectory && sameBackupDate ? undefined : existing;
    },
    // Detection writes go through recordDetection only — a raw upsert would
    // bypass the rename/ingest-status preservation and staleness handling.
    recordDetection: async (detection, directoryHandle, options = {}) => {
      const id = normalizeRecentBackupId(detection.id);
      const existing = await findRecordForDetection(persistence, detection);
      const replaceExisting = options.replaceExisting === true;

      if (replaceExisting && existing !== undefined) {
        // Replacement is deliberately destructive only after explicit UI
        // confirmation. First make the old record non-browsable, then wipe
        // before publishing the new source handle. A partial/failed wipe can
        // therefore never leave either snapshot looking ready to browse.
        await persistence.put({
          ...existing,
          ingestStatus: "needs-reingest",
        });
        await derivedDataStorage.wipeDirectories(
          getDerivedDataDirectoryNames(existing),
        );
      }

      const record: RecentBackupRecord = {
        id,
        // Preserve the user's rename and prior ingest state when the same
        // backup is re-opened from any entry point (picker, drop, recents).
        friendlyName:
          existing?.friendlyName ?? normalizeFriendlyName(detection.friendlyName),
        directoryHandle,
        deviceInfo: {
          ...detection.deviceInfo,
          ...(detection.lastBackupDate === undefined
            ? {}
            : { lastBackupDate: detection.lastBackupDate }),
        },
        isEncrypted: detection.isEncrypted,
        lastOpened: new Date().toISOString(),
        ingestStatus: replaceExisting
          ? "not-ingested"
          : reconcileIngestStatus(existing),
        derivedDbVersion: replaceExisting
          ? derivedDbVersion
          : existing?.derivedDbVersion ?? derivedDbVersion,
      };

      await persistence.put(record);

      const currentNames = getDerivedDataDirectoryNames(record);
      const retireStaleRecord = async (stale: RecentBackupRecord) => {
        // Wipe only the directories the new record does not also use, so a
        // rename-style id migration cannot delete the live derived data.
        const staleNames = getDerivedDataDirectoryNames(stale).filter(
          (name) => !currentNames.includes(name),
        );

        if (staleNames.length > 0) {
          await derivedDataStorage.wipeDirectories(staleNames);
        }

        await persistence.delete(stale.id);
      };

      if (existing !== undefined && existing.id !== id) {
        // The same backup previously stored under another key (e.g. a
        // folder-name fallback id before Info.plist carried the UDID).
        await retireStaleRecord(existing);
      }

      const previousRecordId = options.previousRecordId?.trim();

      if (
        previousRecordId !== undefined &&
        previousRecordId.length > 0 &&
        previousRecordId !== id &&
        previousRecordId !== existing?.id
      ) {
        // The reopened recent's folder now holds a different backup: retire
        // the stale record instead of leaving a duplicate behind.
        const previous = await persistence.get(previousRecordId);

        if (previous !== undefined) {
          await retireStaleRecord(previous);
        }
      }

      return record;
    },
    updateIngestStatus: async (id, ingestStatus) => {
      const normalizedId = normalizeRecentBackupId(id);
      const existing = await persistence.get(normalizedId);

      if (existing === undefined) {
        throw new RecentBackupStoreError(
          `Cannot update ingest status for missing recent backup "${normalizedId}".`,
        );
      }

      const updated: RecentBackupRecord = {
        ...existing,
        ingestStatus,
        derivedDbVersion:
          ingestStatus === "ingested" ? derivedDbVersion : existing.derivedDbVersion,
      };

      await persistence.put(updated);

      return updated;
    },
    rename: async (id, friendlyName) => {
      const normalizedId = normalizeRecentBackupId(id);
      const existing = await persistence.get(normalizedId);

      if (existing === undefined) {
        throw new RecentBackupStoreError(
          `Cannot rename missing recent backup "${normalizedId}".`,
        );
      }

      const renamed: RecentBackupRecord = {
        ...existing,
        friendlyName: normalizeFriendlyName(friendlyName),
      };

      await persistence.put(renamed);

      return renamed;
    },
    remove: async (id) => {
      const normalizedId = normalizeRecentBackupId(id);
      const existing = await persistence.get(normalizedId);

      if (existing === undefined) {
        return;
      }

      await derivedDataStorage.wipeDirectories(getDerivedDataDirectoryNames(existing));
      await persistence.delete(normalizedId);
    },
  };
}

export function createRecentBackupRecord(
  input: RecentBackupInput,
  openedAt: Date = new Date(),
): RecentBackupRecord {
  const id = normalizeRecentBackupId(input.id);
  const deviceInfo = { ...input.deviceInfo };
  const directoryName = input.directoryHandle.name.trim();
  const fallbackName = directoryName.length > 0 ? directoryName : id;
  const friendlyName = normalizeFriendlyName(
    input.friendlyName ?? deviceInfo.name ?? fallbackName,
  );

  return {
    id,
    friendlyName,
    directoryHandle: input.directoryHandle,
    deviceInfo,
    isEncrypted: input.isEncrypted,
    lastOpened: formatOpenedAt(input.lastOpened ?? openedAt),
    ingestStatus: input.ingestStatus ?? "not-ingested",
    derivedDbVersion: input.derivedDbVersion ?? derivedDbVersion,
  };
}

export function createIndexedDbRecentBackupPersistence(): RecentBackupPersistence {
  return {
    list: async () => {
      const records = await withRecentsObjectStore("readonly", async (store) =>
        readRequest(store.getAll() as IDBRequest<unknown>),
      );

      return parseRecentBackupRecords(records);
    },
    get: async (id) => {
      const record = await withRecentsObjectStore("readonly", async (store) =>
        readRequest(store.get(normalizeRecentBackupId(id)) as IDBRequest<unknown>),
      );

      if (record === undefined) {
        return undefined;
      }

      return parseRecentBackupRecord(record);
    },
    put: async (record) => {
      await withRecentsObjectStore("readwrite", async (store) => {
        await readRequest(store.put(record) as IDBRequest<unknown>);
      });
    },
    delete: async (id) => {
      const normalizedId = normalizeRecentBackupId(id);

      return withRecentsObjectStore("readwrite", async (store) => {
        const existingKey = await readRequest(
          store.getKey(normalizedId) as IDBRequest<unknown>,
        );

        if (existingKey === undefined) {
          return false;
        }

        await readRequest(store.delete(normalizedId) as IDBRequest<unknown>);

        return true;
      });
    },
  };
}

export function createOpfsDerivedDataStorage(
  options: OpfsDerivedDataStorageOptions = {},
): DerivedDataStorage {
  const rootProvider: OpfsRootProvider =
    options.rootProvider ?? {
      getDirectory: () => navigator.storage.getDirectory(),
    };

  return {
    wipeDirectories: async (directoryNames) => {
      const root = await rootProvider.getDirectory();
      const appDirectory = await getExistingDirectory(
        root,
        derivedDataOpfsAppDirectoryName,
      );

      if (appDirectory === undefined) {
        return;
      }

      const backupsDirectory = await getExistingDirectory(
        appDirectory,
        derivedDataOpfsBackupsDirectoryName,
      );

      if (backupsDirectory === undefined) {
        return;
      }

      await removeDerivedDataDirectories(backupsDirectory, directoryNames);
    },
  };
}

export async function queryRecentBackupDirectoryPermission(
  recordOrHandle: RecentBackupRecord | FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const handle = getDirectoryHandleFromRecent(recordOrHandle);

  return handle.queryPermission({ mode: "read" });
}

export async function requestRecentBackupDirectoryPermission(
  recordOrHandle: RecentBackupRecord | FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const handle = getDirectoryHandleFromRecent(recordOrHandle);

  return handle.requestPermission({ mode: "read" });
}

export async function ensureRecentBackupDirectoryPermission(
  recordOrHandle: RecentBackupRecord | FileSystemDirectoryHandle,
  options: {
    request?: boolean;
  } = {},
): Promise<PermissionState> {
  const current = await queryRecentBackupDirectoryPermission(recordOrHandle);

  if (current === "granted" || options.request === false) {
    return current;
  }

  return requestRecentBackupDirectoryPermission(recordOrHandle);
}

export function getDerivedDataDirectoryNames(
  record: Pick<RecentBackupRecord, "id" | "deviceInfo">,
): readonly string[] {
  return uniqueNonEmptyStrings([record.deviceInfo.udid, record.id]);
}

export class RecentBackupStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecentBackupStoreError";
  }
}

async function findRecordForDetection(
  persistence: RecentBackupPersistence,
  detection: BackupDetectionResult,
): Promise<RecentBackupRecord | undefined> {
  const id = normalizeRecentBackupId(detection.id);
  const byId = await persistence.get(id);

  if (byId !== undefined) {
    return byId;
  }

  const udid = detection.deviceInfo.udid.trim();

  if (udid.length === 0) {
    return undefined;
  }

  const records = await persistence.list();

  return records.find(
    (record) => record.id === udid || record.deviceInfo.udid === udid,
  );
}

async function isSameDirectoryEntry(
  left: FileSystemDirectoryHandle,
  right: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    return await left.isSameEntry(right);
  } catch {
    // If Chrome cannot compare a persisted handle, prompting is safer than
    // silently reusing derived data for a possibly different source folder.
    return false;
  }
}

function reconcileIngestStatus(
  existing: RecentBackupRecord | undefined,
): RecentBackupIngestStatus {
  if (existing === undefined) {
    return "not-ingested";
  }

  if (existing.derivedDbVersion !== derivedDbVersion) {
    return "needs-reingest";
  }

  if (existing.ingestStatus === "ingesting") {
    return "needs-reingest";
  }

  return existing.ingestStatus;
}

function recoverInterruptedIngest(record: RecentBackupRecord): RecentBackupRecord {
  return record.ingestStatus === "ingesting"
    ? { ...record, ingestStatus: "needs-reingest" }
    : record;
}

let recentsDatabasePromise: Promise<IDBDatabase> | undefined;

function getRecentsDatabase(): Promise<IDBDatabase> {
  if (recentsDatabasePromise === undefined) {
    const promise = openRecentsDatabase().then((db) => {
      db.onversionchange = () => {
        db.close();

        if (recentsDatabasePromise === promise) {
          recentsDatabasePromise = undefined;
        }
      };
      db.onclose = () => {
        if (recentsDatabasePromise === promise) {
          recentsDatabasePromise = undefined;
        }
      };

      return db;
    });

    promise.catch(() => {
      if (recentsDatabasePromise === promise) {
        recentsDatabasePromise = undefined;
      }
    });

    recentsDatabasePromise = promise;
  }

  return recentsDatabasePromise;
}

async function withRecentsObjectStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await getRecentsDatabase();
  const transaction = db.transaction(recentBackupsStoreName, mode);
  const store = transaction.objectStore(recentBackupsStoreName);
  const transactionPromise = waitForTransaction(transaction);

  // A failing request rejects both the operation and the transaction promise;
  // observe the latter up front so it can never surface as an unhandled
  // rejection when the operation throws first.
  transactionPromise.catch(() => undefined);

  const result = await operation(store);

  await transactionPromise;

  return result;
}

function openRecentsDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(recentBackupsDatabaseName, recentsDatabaseVersion);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(recentBackupsStoreName)) {
        const store = db.createObjectStore(recentBackupsStoreName, { keyPath: "id" });

        store.createIndex("lastOpened", "lastOpened", { unique: false });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new RecentBackupStoreError("Could not open the recents IndexedDB database.", {
          cause: request.error ?? undefined,
        }),
      );
    };
    request.onblocked = () => {
      reject(
        new RecentBackupStoreError(
          "The recents IndexedDB database is blocked by another open tab.",
        ),
      );
    };
  });
}

function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new RecentBackupStoreError("The recents IndexedDB request failed.", {
          cause: request.error ?? undefined,
        }),
      );
    };
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(
        new RecentBackupStoreError("The recents IndexedDB transaction failed.", {
          cause: transaction.error ?? undefined,
        }),
      );
    };
    transaction.onabort = () => {
      reject(
        new RecentBackupStoreError("The recents IndexedDB transaction was aborted.", {
          cause: transaction.error ?? undefined,
        }),
      );
    };
  });
}

async function getExistingDirectory(
  parent: OpfsDirectoryHandle,
  name: string,
): Promise<OpfsDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name, { create: false });
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return undefined;
    }

    throw cause;
  }
}

async function removeDerivedDataDirectories(
  parent: OpfsDirectoryHandle,
  directoryNames: readonly string[],
): Promise<void> {
  for (const directoryName of directoryNames) {
    await removeEntryIfFound(parent, directoryName);
  }
}

/**
 * Removes a directory entry recursively, tolerating entries that do not
 * exist. Shared by recents wipe-on-remove and db-worker derived-data resets.
 */
export async function removeEntryIfFound(
  directory: Pick<OpfsDirectoryHandle, "removeEntry">,
  name: string,
): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive: true });
  } catch (cause) {
    if (!isNotFoundError(cause)) {
      throw cause;
    }
  }
}

function parseRecentBackupRecords(value: unknown): RecentBackupRecord[] {
  if (!Array.isArray(value)) {
    throw new RecentBackupStoreError("The recents IndexedDB list was malformed.");
  }

  const records: RecentBackupRecord[] = [];

  for (const entry of value) {
    try {
      records.push(parseRecentBackupRecord(entry));
    } catch (cause) {
      // Skip-and-report: one malformed row must not hide the healthy recents
      // (or the remove control that could clear the bad row).
      console.warn("Skipping a malformed recent backup record.", cause);
    }
  }

  return sortRecentBackups(records);
}

function parseRecentBackupRecord(value: unknown): RecentBackupRecord {
  if (!isObjectRecord(value)) {
    throw new RecentBackupStoreError("A recent backup record was malformed.");
  }

  const id = readString(value, "id");
  const friendlyName = readString(value, "friendlyName");
  const directoryHandle = readDirectoryHandle(value, "directoryHandle");
  const deviceInfo = readDeviceInfo(value, "deviceInfo");
  const isEncrypted = readBoolean(value, "isEncrypted");
  const lastOpened = readDateString(value, "lastOpened");
  const ingestStatus = readIngestStatus(value, "ingestStatus");
  const recordDerivedDbVersion = readNumber(value, "derivedDbVersion");

  return {
    id,
    friendlyName,
    directoryHandle,
    deviceInfo,
    isEncrypted,
    lastOpened,
    ingestStatus: ingestStatus === "ingesting" ? "needs-reingest" : ingestStatus,
    derivedDbVersion: recordDerivedDbVersion,
  };
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string") {
    throw new RecentBackupStoreError(`Recent backup field "${key}" must be a string.`);
  }

  return value;
}

function readDateString(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key);

  // sortRecentBackups compares Date.parse results; an unparseable date would
  // make the sort comparator inconsistent, so reject the record here and let
  // the skip-and-report list parsing drop it.
  if (Number.isNaN(Date.parse(value))) {
    throw new RecentBackupStoreError(
      `Recent backup field "${key}" must be a parseable date string.`,
    );
  }

  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];

  if (typeof value !== "boolean") {
    throw new RecentBackupStoreError(`Recent backup field "${key}" must be a boolean.`);
  }

  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RecentBackupStoreError(`Recent backup field "${key}" must be a number.`);
  }

  return value;
}

function readDirectoryHandle(
  record: Record<string, unknown>,
  key: string,
): FileSystemDirectoryHandle {
  const value = record[key];

  if (!isObjectRecord(value)) {
    throw new RecentBackupStoreError(
      `Recent backup field "${key}" must be a directory handle.`,
    );
  }

  if (value.kind !== "directory" || typeof value.name !== "string") {
    throw new RecentBackupStoreError(
      `Recent backup field "${key}" must be a directory handle.`,
    );
  }

  return value as unknown as FileSystemDirectoryHandle;
}

function readDeviceInfo(
  record: Record<string, unknown>,
  key: string,
): RecentBackupDeviceInfo {
  const value = record[key];

  if (!isObjectRecord(value)) {
    throw new RecentBackupStoreError(
      `Recent backup field "${key}" must be a device-info snapshot.`,
    );
  }

  return {
    udid: readOptionalString(value, "udid"),
    name: readOptionalString(value, "name"),
    model: readOptionalString(value, "model"),
    osVersion: readOptionalString(value, "osVersion"),
    serialNumber: readOptionalString(value, "serialNumber"),
    phoneNumber: readOptionalString(value, "phoneNumber"),
    lastBackupDate: readOptionalString(value, "lastBackupDate"),
  };
}

function readOptionalString(
  record: Record<string, unknown>,
  key: keyof RecentBackupDeviceInfo,
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RecentBackupStoreError(
      `Recent backup device-info field "${key}" must be a string.`,
    );
  }

  return value;
}

function readIngestStatus(
  record: Record<string, unknown>,
  key: string,
): RecentBackupIngestStatus {
  const value = record[key];

  if (
    value === "not-ingested" ||
    value === "ingesting" ||
    value === "ingested" ||
    value === "needs-reingest" ||
    value === "failed"
  ) {
    return value;
  }

  if (typeof value === "string") {
    // An unknown status written by a newer app version: whatever derived data
    // exists cannot be trusted by this build, so force a rebuild instead of
    // rejecting the whole record.
    return "needs-reingest";
  }

  throw new RecentBackupStoreError(
    `Recent backup field "${key}" must be an ingest status string.`,
  );
}

function sortRecentBackups(records: readonly RecentBackupRecord[]): RecentBackupRecord[] {
  return [...records].sort((left, right) => {
    const openedComparison =
      Date.parse(right.lastOpened) - Date.parse(left.lastOpened);

    if (openedComparison !== 0) {
      return openedComparison;
    }

    return left.friendlyName.localeCompare(right.friendlyName);
  });
}

function getDirectoryHandleFromRecent(
  recordOrHandle: RecentBackupRecord | FileSystemDirectoryHandle,
): FileSystemDirectoryHandle {
  if ("directoryHandle" in recordOrHandle) {
    return recordOrHandle.directoryHandle;
  }

  return recordOrHandle;
}

function normalizeRecentBackupId(id: string): string {
  const trimmed = id.trim();

  if (trimmed.length === 0) {
    throw new RecentBackupStoreError("Recent backup id cannot be empty.");
  }

  return trimmed;
}

function normalizeFriendlyName(friendlyName: string): string {
  const trimmed = friendlyName.trim();

  if (trimmed.length === 0) {
    throw new RecentBackupStoreError("Recent backup friendly name cannot be empty.");
  }

  return trimmed;
}

function formatOpenedAt(value: string | Date): string {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);

    if (Number.isNaN(timestamp)) {
      throw new RecentBackupStoreError("Recent backup lastOpened must be a valid date.");
    }

    return new Date(timestamp).toISOString();
  }

  return value.toISOString();
}

function uniqueNonEmptyStrings(values: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();

    if (trimmed === undefined || trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

export function isNotFoundError(cause: unknown): boolean {
  if (!isObjectRecord(cause)) {
    return false;
  }

  return cause.name === "NotFoundError";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
