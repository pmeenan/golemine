import { afterEach, describe, expect, it, vi } from "vitest";

import type { IngestWarning } from "../../lib/worker-types";
import {
  assertRequiredSourceDatabaseSetWithinBudget,
  consumeSourceDatabaseBudget,
  maxStagedSourceDatabaseSetBytes,
  openOptionalBackupDatabase,
} from "./ios-ingest";
import {
  maxStagedSourceFileBytes,
  resetBackupSourceOverridesForTests,
  setBackupSourceOverridesForTests,
  SourceFileTooLargeError,
  type ManifestFileRecord,
  type ManifestDbReader,
} from "./manifest-db";
import type {
  ReadonlySourceDirectoryHandle,
  ReadonlySourceHandle,
} from "./read-only-source";

afterEach(() => {
  resetBackupSourceOverridesForTests();
  vi.unstubAllGlobals();
});

describe("source database staged sanity budget", () => {
  it("charges main and sidecars against one combined limit", () => {
    const afterMain = consumeSourceDatabaseBudget(
      maxStagedSourceDatabaseSetBytes,
      maxStagedSourceDatabaseSetBytes - 32,
    );
    const afterWal = consumeSourceDatabaseBudget(afterMain, 16);

    expect(consumeSourceDatabaseBudget(afterWal, 16)).toBe(0);
  });

  it("rejects the first source file that crosses the combined boundary", () => {
    expect(() => consumeSourceDatabaseBudget(16, 17)).toThrow(
      SourceFileTooLargeError,
    );
  });

  it("pre-verifies every encrypted set key and charges a conservative 3x OPFS peak", async () => {
    const mebibyte = 1024 * 1024;
    const records = requiredEncryptedRecords(40 * mebibyte);
    const verifiedPaths: string[] = [];
    const verifyEncryptedFileKey = vi.fn((record: ManifestFileRecord) => {
      verifiedPaths.push(record.relativePath);
      return Promise.resolve();
    });

    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn(),
        estimate: () =>
          Promise.resolve({ quota: 350 * mebibyte, usage: 0 }),
      },
    });

    await expect(
      assertRequiredSourceDatabaseSetWithinBudget({
        manifest: manifestWithRecords(records),
        root: storedFilesRoot(records, 16),
        domain: "HomeDomain",
        relativePath: "Library/SMS/sms.db",
        isEncrypted: true,
        budgetBytes: 120 * mebibyte,
        verifyEncryptedFileKey,
      }),
    ).rejects.toBeInstanceOf(SourceFileTooLargeError);

    expect(verifyEncryptedFileKey).toHaveBeenCalledTimes(3);
    expect(verifiedPaths).toEqual([
      "Library/SMS/sms.db",
      "Library/SMS/sms.db-wal",
      "Library/SMS/sms.db-shm",
    ]);
  });

  it("accepts a long aligned stored tail when logical plaintext fits its cap", async () => {
    const [main] = requiredEncryptedRecords(16);
    const verifyEncryptedFileKey = vi.fn((_record: ManifestFileRecord) =>
      Promise.resolve(),
    );

    await expect(
      assertRequiredSourceDatabaseSetWithinBudget({
        manifest: manifestWithRecords([main]),
        root: storedFilesRoot([main], 64),
        domain: main.domain,
        relativePath: main.relativePath,
        isEncrypted: true,
        budgetBytes: 16,
        verifyEncryptedFileKey,
      }),
    ).resolves.toBeUndefined();

    expect(verifyEncryptedFileKey).toHaveBeenCalledWith(main);
  });

  it("rejects an invalid encrypted logical size before key verification", async () => {
    const [main] = requiredEncryptedRecords(maxStagedSourceFileBytes + 1);
    const verifyEncryptedFileKey = vi.fn((_record: ManifestFileRecord) =>
      Promise.resolve(),
    );

    await expect(
      assertRequiredSourceDatabaseSetWithinBudget({
        manifest: manifestWithRecords([main]),
        root: storedFilesRoot([main], 16),
        domain: main.domain,
        relativePath: main.relativePath,
        isEncrypted: true,
        verifyEncryptedFileKey,
      }),
    ).rejects.toMatchObject({ code: "backup_crypto_malformed" });

    expect(verifyEncryptedFileKey).not.toHaveBeenCalled();
  });

  it("rejects an encrypted stored file above the absolute cap before key verification", async () => {
    const [main] = requiredEncryptedRecords(16);
    const verifyEncryptedFileKey = vi.fn((_record: ManifestFileRecord) =>
      Promise.resolve(),
    );

    await expect(
      assertRequiredSourceDatabaseSetWithinBudget({
        manifest: manifestWithRecords([main]),
        root: storedFilesRoot([main], maxStagedSourceFileBytes + 16),
        domain: main.domain,
        relativePath: main.relativePath,
        isEncrypted: true,
        verifyEncryptedFileKey,
      }),
    ).rejects.toMatchObject({ code: "backup_crypto_malformed" });

    expect(verifyEncryptedFileKey).not.toHaveBeenCalled();
  });
});

describe("optional source database pre-staging bound", () => {
  it("rejects a hostile multi-TiB declared Size before any decrypt or staging work", async () => {
    const record = encryptedRecord(
      "Library/AddressBook/AddressBook.sqlitedb",
      maxStagedSourceFileBytes + 16,
    );
    const warnings: IngestWarning[] = [];
    const readSourceFile = vi.fn(() =>
      Promise.reject(new Error("must not read")),
    );
    const stageSourceFile = vi.fn(() =>
      Promise.reject(new Error("must not stage")),
    );
    const openSourceSqlite = vi.fn(() =>
      Promise.reject(new Error("must not open")),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    setBackupSourceOverridesForTests({ openSourceSqlite });
    try {
      const opened = await openOptionalBackupDatabase({
        backupId: "test-backup",
        manifest: manifestWithRecords([record]),
        role: "contacts",
        domain: record.domain,
        relativePath: record.relativePath,
        warnings,
        readSourceFile,
        stageSourceFile,
        budgetBytes: maxStagedSourceDatabaseSetBytes,
      });

      expect(opened).toBeUndefined();
      expect(warnings).toEqual([
        expect.objectContaining({
          code: "contacts-database-unreadable",
          source: record.relativePath,
        }),
      ]);
      expect(readSourceFile).not.toHaveBeenCalled();
      expect(stageSourceFile).not.toHaveBeenCalled();
      expect(openSourceSqlite).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects an over-budget optional declared Size before any staging work", async () => {
    const record = encryptedRecord(
      "Library/AddressBook/AddressBook.sqlitedb",
      4096,
    );
    const warnings: IngestWarning[] = [];
    const stageSourceFile = vi.fn(() =>
      Promise.reject(new Error("must not stage")),
    );
    const openSourceSqlite = vi.fn(() =>
      Promise.reject(new Error("must not open")),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    setBackupSourceOverridesForTests({ openSourceSqlite });
    try {
      const opened = await openOptionalBackupDatabase({
        backupId: "test-backup",
        manifest: manifestWithRecords([record]),
        role: "contacts",
        domain: record.domain,
        relativePath: record.relativePath,
        warnings,
        readSourceFile: () => Promise.reject(new Error("must not read")),
        stageSourceFile,
        budgetBytes: 1024,
      });

      expect(opened).toBeUndefined();
      expect(warnings).toEqual([
        expect.objectContaining({ code: "contacts-database-unreadable" }),
      ]);
      expect(stageSourceFile).not.toHaveBeenCalled();
      expect(openSourceSqlite).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

function encryptedRecord(
  relativePath: string,
  logicalSize: number,
): ManifestFileRecord {
  return {
    fileId: `bb${"0".repeat(38)}`,
    domain: "HomeDomain",
    relativePath,
    flags: 1,
    metadata: {
      size: logicalSize,
      encryptionKey: new Uint8Array(44).fill(7),
    },
  };
}

function requiredEncryptedRecords(logicalSize: number): ManifestFileRecord[] {
  return ["", "-wal", "-shm"].map((suffix, index) => ({
    fileId: `aa${String(index).padStart(38, "0")}`,
    domain: "HomeDomain",
    relativePath: `Library/SMS/sms.db${suffix}`,
    flags: 1,
    metadata: {
      size: logicalSize,
      encryptionKey: new Uint8Array(44).fill(index + 1),
    },
  }));
}

function manifestWithRecords(
  records: readonly ManifestFileRecord[],
): ManifestDbReader {
  const byPath = new Map(
    records.map((record) => [
      `${record.domain}\u0000${record.relativePath}`,
      record,
    ]),
  );

  return {
    findFile: (domain: string, relativePath: string) =>
      byPath.get(`${domain}\u0000${relativePath}`),
  } as unknown as ManifestDbReader;
}

function storedFilesRoot(
  records: readonly ManifestFileRecord[],
  storedSize: number,
): ReadonlySourceDirectoryHandle {
  const fileIds = new Set(records.map((record) => record.fileId));
  const shard = {
    kind: "directory" as const,
    name: "aa",
    entries: emptyEntries,
    getDirectory: () => Promise.reject(new Error("not found")),
    getFile: (name: string) =>
      fileIds.has(name)
        ? Promise.resolve({ size: storedSize } as File)
        : Promise.reject(new Error("not found")),
  } satisfies ReadonlySourceDirectoryHandle;

  return {
    kind: "directory" as const,
    name: "root",
    entries: emptyEntries,
    getDirectory: (name: string) =>
      name === "aa"
        ? Promise.resolve(shard)
        : Promise.reject(new Error("not found")),
    getFile: () => Promise.reject(new Error("not found")),
  } satisfies ReadonlySourceDirectoryHandle;
}

async function* emptyEntries(): AsyncIterableIterator<
  [string, ReadonlySourceHandle]
> {
  await Promise.resolve();
  yield* [];
}
