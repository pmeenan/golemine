import { describe, expect, it, vi } from "vitest";

import { createDbWorkerStorageApi, measureDerivedDataDirectory } from "./storage";

describe("derived-data storage accounting", () => {
  it("recursively totals files without counting the backup root", async () => {
    const directory = fakeDirectory([
      fakeFile(12),
      fakeDirectory([fakeFile(30), fakeDirectory([fakeFile(8)])]),
    ]);

    await expect(measureDerivedDataDirectory(directory)).resolves.toEqual({
      byteLength: 50,
      directoryCount: 2,
      fileCount: 3,
    });
  });

  it("reports an absent backup as an empty derived-data directory", async () => {
    const api = createDbWorkerStorageApi({
      getBackupDirectory: () => Promise.resolve(undefined),
      removeBackupDirectory: () => Promise.resolve(),
    });

    await expect(api.getDerivedDataStorageSummary("backup-id")).resolves.toEqual({
      ok: true,
      value: {
        backupId: "backup-id",
        byteLength: 0,
        directoryCount: 0,
        fileCount: 0,
      },
    });
  });

  it("measures before clearing and returns an exact receipt", async () => {
    const removeBackupDirectory = vi.fn(() => Promise.resolve());
    const api = createDbWorkerStorageApi({
      getBackupDirectory: () =>
        Promise.resolve(fakeDirectory([fakeFile(1024), fakeFile(512)])),
      removeBackupDirectory,
    });

    await expect(api.clearDerivedDataStorage("backup-id")).resolves.toEqual({
      ok: true,
      value: {
        backupId: "backup-id",
        clearedByteLength: 1536,
        clearedDirectoryCount: 0,
        clearedFileCount: 2,
      },
    });
    expect(removeBackupDirectory).toHaveBeenCalledWith("backup-id");
  });

  it("rejects unsafe ids without touching storage", async () => {
    const getBackupDirectory = vi.fn(() => Promise.resolve(undefined));
    const api = createDbWorkerStorageApi({ getBackupDirectory });
    const result = await api.getDerivedDataStorageSummary("../backup");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Unsafe storage ids must be rejected.");
    }
    expect(result.error.code).toBe("derived_data_storage_failed");
    expect(getBackupDirectory).not.toHaveBeenCalled();
  });
});

interface FakeFileHandle {
  kind: "file";
  getFile(): Promise<Pick<File, "size">>;
}

interface FakeDirectoryHandle {
  kind: "directory";
  values(): AsyncIterableIterator<FakeDirectoryHandle | FakeFileHandle>;
}

function fakeFile(size: number): FakeFileHandle {
  return {
    kind: "file",
    getFile: () => Promise.resolve({ size }),
  };
}

function fakeDirectory(
  entries: (FakeDirectoryHandle | FakeFileHandle)[],
): FakeDirectoryHandle {
  return {
    kind: "directory",
    values: async function* () {
      for (const entry of entries) {
        yield await Promise.resolve(entry);
      }
    },
  };
}
