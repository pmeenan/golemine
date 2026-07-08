import { describe, expect, it } from "vitest";
import { derivedDbVersion } from "./constants";
import {
  createBackupRecentsStore,
  createOpfsDerivedDataStorage,
  createRecentBackupRecord,
  ensureRecentBackupDirectoryPermission,
  getDerivedDataDirectoryNames,
  type DerivedDataStorage,
  type OpfsDirectoryHandle,
  type RecentBackupPersistence,
  type RecentBackupRecord,
} from "./recents";
import type { BackupDetectionResult } from "./worker-types";

describe("recent backup records", () => {
  it("normalizes metadata and defaults to the shared derived DB version", () => {
    const handle = fakeDirectoryHandle("source-backup");
    const record = createRecentBackupRecord(
      {
        id: "  backup-1  ",
        directoryHandle: handle,
        deviceInfo: {
          name: "Case phone",
          udid: "udid-1",
        },
        isEncrypted: true,
      },
      new Date("2026-07-07T14:30:00.000Z"),
    );

    expect(record).toEqual({
      id: "backup-1",
      friendlyName: "Case phone",
      directoryHandle: handle,
      deviceInfo: {
        name: "Case phone",
        udid: "udid-1",
      },
      isEncrypted: true,
      lastOpened: "2026-07-07T14:30:00.000Z",
      ingestStatus: "not-ingested",
      derivedDbVersion,
    });
  });

  it("uses both UDID and id as derived-data directory candidates", () => {
    expect(
      getDerivedDataDirectoryNames({
        id: "backup-id",
        deviceInfo: { udid: "device-udid" },
      }),
    ).toEqual(["device-udid", "backup-id"]);

    expect(
      getDerivedDataDirectoryNames({
        id: "same-id",
        deviceInfo: { udid: "same-id" },
      }),
    ).toEqual(["same-id"]);
  });
});

describe("backup recents store", () => {
  it("sorts by last opened and renames records", async () => {
    const persistence = new MemoryRecentBackupPersistence();
    const store = createBackupRecentsStore({
      persistence,
      derivedDataStorage: new RecordingDerivedDataStorage(),
    });

    await persistence.put(createRecentBackupRecord({
      id: "older",
      friendlyName: "Older phone",
      directoryHandle: fakeDirectoryHandle("older-source"),
      deviceInfo: {},
      isEncrypted: false,
      lastOpened: "2026-07-06T10:00:00.000Z",
    }));
    await persistence.put(createRecentBackupRecord({
      id: "newer",
      friendlyName: "Newer phone",
      directoryHandle: fakeDirectoryHandle("newer-source"),
      deviceInfo: {},
      isEncrypted: false,
      lastOpened: "2026-07-07T10:00:00.000Z",
    }));

    expect((await store.list()).map((record) => record.id)).toEqual([
      "newer",
      "older",
    ]);

    const renamed = await store.rename(" newer ", "  Renamed phone  ");

    expect(renamed.friendlyName).toBe("Renamed phone");
    expect((await store.get("newer"))?.friendlyName).toBe("Renamed phone");
  });

  it("wipes OPFS derived data before deleting a recent", async () => {
    const events: string[] = [];
    const persistence = new MemoryRecentBackupPersistence(events);
    const derivedDataStorage = new RecordingDerivedDataStorage(events);
    const store = createBackupRecentsStore({ persistence, derivedDataStorage });

    await persistence.put(createRecentBackupRecord({
      id: "backup-id",
      friendlyName: "Backup",
      directoryHandle: fakeDirectoryHandle("source"),
      deviceInfo: { udid: "device-udid" },
      isEncrypted: false,
      lastOpened: "2026-07-07T10:00:00.000Z",
    }));

    await store.remove("backup-id");

    expect(events).toEqual([
      "put:backup-id",
      "wipe:device-udid,backup-id",
      "delete:backup-id",
    ]);
    expect(await store.get("backup-id")).toBeUndefined();
  });

  it("leaves missing recents as no-ops", async () => {
    const derivedDataStorage = new RecordingDerivedDataStorage();
    const store = createBackupRecentsStore({
      persistence: new MemoryRecentBackupPersistence(),
      derivedDataStorage,
    });

    await expect(store.remove("missing")).resolves.toBeUndefined();
    expect(derivedDataStorage.wipedDirectoryNames).toEqual([]);
  });

  it("recovers interrupted ingesting records as needing re-ingest", async () => {
    const persistence = new MemoryRecentBackupPersistence();
    const store = createBackupRecentsStore({
      persistence,
      derivedDataStorage: new RecordingDerivedDataStorage(),
    });

    await persistence.put(createRecentBackupRecord({
      id: "backup-id",
      friendlyName: "Backup",
      directoryHandle: fakeDirectoryHandle("source"),
      deviceInfo: {},
      isEncrypted: false,
      ingestStatus: "ingesting",
    }));

    expect((await store.get("backup-id"))?.ingestStatus).toBe("needs-reingest");
    expect((await store.list())[0]?.ingestStatus).toBe("needs-reingest");
  });

  it("stamps the current derived DB version only after successful ingest", async () => {
    const persistence = new MemoryRecentBackupPersistence();
    const store = createBackupRecentsStore({
      persistence,
      derivedDataStorage: new RecordingDerivedDataStorage(),
    });

    await persistence.put(createRecentBackupRecord({
      id: "backup-id",
      friendlyName: "Backup",
      directoryHandle: fakeDirectoryHandle("source"),
      deviceInfo: {},
      isEncrypted: false,
      ingestStatus: "ingested",
      derivedDbVersion: derivedDbVersion - 1,
    }));

    const running = await store.updateIngestStatus("backup-id", "ingesting");
    const failed = await store.updateIngestStatus("backup-id", "failed");
    const ingested = await store.updateIngestStatus("backup-id", "ingested");

    expect(running.derivedDbVersion).toBe(derivedDbVersion - 1);
    expect(failed.derivedDbVersion).toBe(derivedDbVersion - 1);
    expect(ingested.derivedDbVersion).toBe(derivedDbVersion);
  });
});

describe("recordDetection", () => {
  it("creates a record from a fresh detection", async () => {
    const persistence = new MemoryRecentBackupPersistence();
    const store = createBackupRecentsStore({
      persistence,
      derivedDataStorage: new RecordingDerivedDataStorage(),
    });
    const handle = fakeDirectoryHandle("source");

    const record = await store.recordDetection(detection(), handle);

    expect(record).toMatchObject({
      id: "udid-1",
      friendlyName: "Mina's iPhone backup",
      directoryHandle: handle,
      deviceInfo: {
        udid: "udid-1",
        name: "Mina's iPhone",
        lastBackupDate: "2026-07-01T12:34:56.000Z",
      },
      isEncrypted: false,
      ingestStatus: "not-ingested",
      derivedDbVersion,
    });
    expect(await store.get("udid-1")).toEqual(record);
  });

  it("preserves the user's rename and ingest state when the same backup is re-opened from any entry point", async () => {
    const persistence = new MemoryRecentBackupPersistence();
    const store = createBackupRecentsStore({
      persistence,
      derivedDataStorage: new RecordingDerivedDataStorage(),
    });

    await persistence.put(createRecentBackupRecord({
      id: "udid-1",
      friendlyName: "Evidence iPhone",
      directoryHandle: fakeDirectoryHandle("source"),
      deviceInfo: { udid: "udid-1" },
      isEncrypted: false,
      ingestStatus: "ingested",
    }));

    // Re-open via the picker: no previousRecordId is available.
    const record = await store.recordDetection(
      detection(),
      fakeDirectoryHandle("source"),
    );

    expect(record.friendlyName).toBe("Evidence iPhone");
    expect(record.ingestStatus).toBe("ingested");
  });

  it("forces re-ingest when the stored derived DB version is stale", async () => {
    const persistence = new MemoryRecentBackupPersistence();
    const store = createBackupRecentsStore({
      persistence,
      derivedDataStorage: new RecordingDerivedDataStorage(),
    });

    await persistence.put(createRecentBackupRecord({
      id: "udid-1",
      friendlyName: "Evidence iPhone",
      directoryHandle: fakeDirectoryHandle("source"),
      deviceInfo: { udid: "udid-1" },
      isEncrypted: false,
      ingestStatus: "ingested",
      derivedDbVersion: derivedDbVersion - 1,
    }));

    const record = await store.recordDetection(
      detection(),
      fakeDirectoryHandle("source"),
    );

    expect(record.ingestStatus).toBe("needs-reingest");
  });

  it("does not preserve an interrupted ingesting state when the backup is re-opened", async () => {
    const persistence = new MemoryRecentBackupPersistence();
    const store = createBackupRecentsStore({
      persistence,
      derivedDataStorage: new RecordingDerivedDataStorage(),
    });

    await persistence.put(createRecentBackupRecord({
      id: "udid-1",
      friendlyName: "Evidence iPhone",
      directoryHandle: fakeDirectoryHandle("source"),
      deviceInfo: { udid: "udid-1" },
      isEncrypted: false,
      ingestStatus: "ingesting",
    }));

    const record = await store.recordDetection(
      detection(),
      fakeDirectoryHandle("source"),
    );

    expect(record.ingestStatus).toBe("needs-reingest");
  });

  it("retires the stale record when a reopened recent detects as a different device", async () => {
    const events: string[] = [];
    const persistence = new MemoryRecentBackupPersistence(events);
    const derivedDataStorage = new RecordingDerivedDataStorage(events);
    const store = createBackupRecentsStore({ persistence, derivedDataStorage });

    await persistence.put(createRecentBackupRecord({
      id: "old-udid",
      friendlyName: "Old device",
      directoryHandle: fakeDirectoryHandle("source"),
      deviceInfo: { udid: "old-udid" },
      isEncrypted: false,
    }));

    const record = await store.recordDetection(
      detection({
        id: "new-udid",
        deviceInfo: { udid: "new-udid", name: "New device" },
      }),
      fakeDirectoryHandle("source"),
      { previousRecordId: "old-udid" },
    );

    expect(record.id).toBe("new-udid");
    expect(await store.get("old-udid")).toBeUndefined();
    expect(derivedDataStorage.wipedDirectoryNames).toEqual(["old-udid"]);
  });

  it("migrates a folder-name fallback id to the detected UDID without wiping shared derived data", async () => {
    const events: string[] = [];
    const persistence = new MemoryRecentBackupPersistence(events);
    const derivedDataStorage = new RecordingDerivedDataStorage(events);
    const store = createBackupRecentsStore({ persistence, derivedDataStorage });

    // Stored before Info.plist carried a UDID: the folder name became the id,
    // but the device UDID was already known.
    await persistence.put(createRecentBackupRecord({
      id: "backup-folder",
      friendlyName: "Evidence iPhone",
      directoryHandle: fakeDirectoryHandle("backup-folder"),
      deviceInfo: { udid: "udid-1" },
      isEncrypted: false,
    }));

    const record = await store.recordDetection(
      detection(),
      fakeDirectoryHandle("backup-folder"),
    );

    expect(record.id).toBe("udid-1");
    expect(record.friendlyName).toBe("Evidence iPhone");
    expect(await store.get("backup-folder")).toBeUndefined();
    // The stale folder-name directory is wiped, the shared udid directory is not.
    expect(derivedDataStorage.wipedDirectoryNames).toEqual(["backup-folder"]);
  });
});

describe("recent backup directory permissions", () => {
  it("requests permission only after a prompt result", async () => {
    const calls: string[] = [];
    let queryState: PermissionState = "prompt";
    const handle = fakeDirectoryHandle("source", {
      queryPermission: (mode) => {
        calls.push(`query:${mode}`);
        return Promise.resolve(queryState);
      },
      requestPermission: (mode) => {
        calls.push(`request:${mode}`);
        queryState = "granted";
        return Promise.resolve("granted");
      },
    });

    await expect(ensureRecentBackupDirectoryPermission(handle)).resolves.toBe("granted");
    await expect(ensureRecentBackupDirectoryPermission(handle)).resolves.toBe("granted");
    expect(calls).toEqual(["query:read", "request:read", "query:read"]);
  });
});

describe("OPFS derived-data storage", () => {
  it("removes per-backup directories under the Golemine backup namespace", async () => {
    const root = new MemoryOpfsDirectory("root");
    const appDirectory = root.createChild("golemine");
    const backupsDirectory = appDirectory.createChild("backups");

    backupsDirectory.createChild("device-udid");
    backupsDirectory.createChild("backup-id");
    backupsDirectory.createChild("other-backup");

    const storage = createOpfsDerivedDataStorage({
      rootProvider: {
        getDirectory: () => Promise.resolve(root),
      },
    });

    await storage.wipeDirectories(["device-udid", "backup-id"]);

    expect(backupsDirectory.hasChild("device-udid")).toBe(false);
    expect(backupsDirectory.hasChild("backup-id")).toBe(false);
    expect(backupsDirectory.hasChild("other-backup")).toBe(true);
  });

  it("tolerates missing OPFS namespace directories", async () => {
    const storage = createOpfsDerivedDataStorage({
      rootProvider: {
        getDirectory: () => Promise.resolve(new MemoryOpfsDirectory("root")),
      },
    });

    await expect(
      storage.wipeDirectories(["device-udid", "backup-id"]),
    ).resolves.toBeUndefined();
  });
});

function detection(
  overrides: Partial<BackupDetectionResult> = {},
): BackupDetectionResult {
  return {
    provider: "ios-itunes",
    sourceKind: "itunes-finder",
    id: "udid-1",
    friendlyName: "Mina's iPhone backup",
    sourceFolderName: "backup-folder",
    isEncrypted: false,
    deviceInfo: { udid: "udid-1", name: "Mina's iPhone" },
    lastBackupDate: "2026-07-01T12:34:56.000Z",
    ...overrides,
  };
}

class MemoryRecentBackupPersistence implements RecentBackupPersistence {
  private readonly records = new Map<string, RecentBackupRecord>();

  constructor(private readonly events?: string[]) {}

  list(): Promise<RecentBackupRecord[]> {
    return Promise.resolve(Array.from(this.records.values()));
  }

  get(id: string): Promise<RecentBackupRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  put(record: RecentBackupRecord): Promise<void> {
    this.events?.push(`put:${record.id}`);
    this.records.set(record.id, record);

    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    this.events?.push(`delete:${id}`);

    return Promise.resolve(this.records.delete(id));
  }
}

class RecordingDerivedDataStorage implements DerivedDataStorage {
  readonly wipedDirectoryNames: string[] = [];

  constructor(private readonly events?: string[]) {}

  wipeDirectories(directoryNames: readonly string[]): Promise<void> {
    this.events?.push(`wipe:${directoryNames.join(",")}`);
    this.wipedDirectoryNames.push(...directoryNames);

    return Promise.resolve();
  }
}

class MemoryOpfsDirectory implements OpfsDirectoryHandle {
  private readonly children = new Map<string, MemoryOpfsDirectory>();

  constructor(readonly name: string) {}

  createChild(name: string): MemoryOpfsDirectory {
    const child = new MemoryOpfsDirectory(name);

    this.children.set(name, child);

    return child;
  }

  hasChild(name: string): boolean {
    return this.children.has(name);
  }

  getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<OpfsDirectoryHandle> {
    const child = this.children.get(name);

    if (child !== undefined) {
      return Promise.resolve(child);
    }

    if (options?.create === true) {
      return Promise.resolve(this.createChild(name));
    }

    return Promise.reject(createNotFoundError());
  }

  removeEntry(
    name: string,
    _options?: FileSystemRemoveOptions,
  ): Promise<void> {
    if (!this.children.delete(name)) {
      return Promise.reject(createNotFoundError());
    }

    return Promise.resolve();
  }
}

function fakeDirectoryHandle(
  name: string,
  permissions?: {
    queryPermission?: (mode: string) => Promise<PermissionState>;
    requestPermission?: (mode: string) => Promise<PermissionState>;
  },
): FileSystemDirectoryHandle {
  const queryPermission = permissions?.queryPermission;
  const requestPermission = permissions?.requestPermission;
  const handle = {
    kind: "directory" as const,
    name,
    queryPermission: queryPermission
      ? (descriptor?: { mode?: string }) =>
          queryPermission(descriptor?.mode ?? "read")
      : undefined,
    requestPermission: requestPermission
      ? (descriptor?: { mode?: string }) =>
          requestPermission(descriptor?.mode ?? "read")
      : undefined,
  };

  return handle as unknown as FileSystemDirectoryHandle;
}

function createNotFoundError(): Error {
  const error = new Error("Not found");

  error.name = "NotFoundError";

  return error;
}
