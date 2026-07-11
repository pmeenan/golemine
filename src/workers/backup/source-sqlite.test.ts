import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getSqlite, type Sqlite3Api } from "../shared/sqlite-init";
import {
  applySqliteWalToStagedFile,
  MemoryRandomAccessFile,
  openSourceSqliteDatabase,
  prepareStagedSourceSqliteForReadOnlyOpen,
  SourceSqliteOpenError,
  sqliteValue,
} from "./source-sqlite";

const pageSize = 512;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openSourceSqliteDatabase", () => {
  it("unlinks the transient wasm VFS copy when the database is closed", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "golemine-source-"));
    const dbPath = path.join(tempDirectory, "source.db");
    const nodeDb = new DatabaseSync(dbPath);

    try {
      nodeDb.exec(`
        CREATE TABLE ore (id INTEGER PRIMARY KEY, label TEXT);
        INSERT INTO ore (id, label) VALUES (1, 'bronze');
      `);
      nodeDb.close();

      const main = Uint8Array.from(await readFile(dbPath));
      const source = await openSourceSqliteDatabase({ label: "unlink-test", main });

      expect(sqliteValue(source.db, "SELECT label FROM ore WHERE id = 1;")).toBe(
        "bronze",
      );

      source.close();
      await source.cleanup();

      // The transient copy must be removed from the wasm VFS on close;
      // re-opening the same name read-only must fail because the file is gone.
      const sqlite3 = await getSqlite();

      expect(() => new sqlite3.oo1.DB(source.databaseName, "r")).toThrow();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("unlinks a transient VFS copy when the read-only DB open fails", async () => {
    const harness = createSqliteCleanupHarness({ throwOnOpen: true });

    await expect(
      openSourceSqliteDatabase(
        { label: "open-failure", main: sqliteHeaderPage(pageSize) },
        () => Promise.resolve(harness.sqlite3),
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(harness.createFile).toHaveBeenCalledTimes(1);
    expect(harness.unlink).toHaveBeenCalledTimes(1);
    expect(harness.dealloc).toHaveBeenCalledTimes(1);
  });

  it("unlinks a transient VFS copy even when db.close throws", async () => {
    const harness = createSqliteCleanupHarness({ throwOnClose: true });
    const source = await openSourceSqliteDatabase(
      { label: "close-failure", main: sqliteHeaderPage(pageSize) },
      () => Promise.resolve(harness.sqlite3),
    );

    expect(() => {
      source.close();
    }).toThrow("synthetic close failure");
    expect(harness.unlink).toHaveBeenCalledTimes(1);
    expect(harness.dealloc).toHaveBeenCalledTimes(1);
  });

  it("chunk-imports byte-equivalent WAL output and awaits OPFS cleanup", async () => {
    const root = new MemoryDirectoryHandle("root");
    const main = sqliteHeaderPage(pageSize);

    main[18] = 2;
    main[19] = 2;

    const wal = walFile([
      { pageNumber: 1, commitPageCount: 1, data: sqliteHeaderPage(pageSize) },
    ]);
    const expected = await applyWalForTest(main, wal);
    const fake = createFakeStreamingSqlite();

    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(root) },
    });

    const source = await openSourceSqliteDatabase(
      {
        label: "stream-equivalence",
        backupId: "synthetic-backup",
        main: blobFromBytes(main),
        wal: blobFromBytes(wal),
      },
      () => Promise.resolve(fake.sqlite3),
    );

    expect(concatBytes(fake.importedChunks)).toEqual(expected);
    expect(fake.install).toHaveBeenCalledWith(
      expect.objectContaining({
        clearOnInit: true,
        initialCapacity: 16,
      }),
    );
    expect(fake.reserveMinimumCapacity).toHaveBeenCalledWith(16);
    expect(root.removedNames).toContain("transient");

    source.close();
    await source.cleanup();

    expect(fake.unlink).toHaveBeenCalledWith("/source.sqlite");
    expect(fake.removeVfs).toHaveBeenCalledTimes(1);
    expect(root.removedNames).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-sqlite-stream-equivalence-"),
      ]),
    );
  });
});

describe("openSourceSqliteDatabase staged main input", () => {
  it("stages a streamed main source and applies the WAL on top", async () => {
    const root = new MemoryDirectoryHandle("root");
    const main = new Uint8Array(pageSize * 2);

    main.set(sqliteHeaderPage(pageSize));
    main[18] = 2;
    main[19] = 2;

    const wal = walFile([
      { pageNumber: 2, commitPageCount: 2, data: page(0x5a) },
    ]);
    const expected = await applyWalForTest(main, wal);
    const fake = createFakeStreamingSqlite();

    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(root) },
    });

    const source = await openSourceSqliteDatabase(
      {
        label: "staged-main",
        backupId: "synthetic-backup-staged",
        main: {
          declaredByteLength: main.byteLength,
          stage: async (destination) => {
            await destination.write(main.subarray(0, pageSize));
            // The sparse second page zero-extends instead of being written.
            await destination.extendZeros?.(pageSize);
          },
        },
        wal: blobFromBytes(wal),
      },
      () => Promise.resolve(fake.sqlite3),
    );

    expect(concatBytes(fake.importedChunks)).toEqual(expected);

    source.close();
    await source.cleanup();

    expect(fake.removeVfs).toHaveBeenCalledTimes(1);
    expect(root.removedNames).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-sqlite-staged-main-"),
      ]),
    );
  });

  it("rethrows a stage-callback failure unwrapped after cleaning the workspace", async () => {
    const root = new MemoryDirectoryHandle("root");
    const fake = createFakeStreamingSqlite();
    // Stage-callback failures (e.g. encrypted-session decrypt errors) carry
    // structured codes the ingest layer maps; the opener must rethrow the
    // exact error instead of wrapping it in SourceSqliteOpenError.
    const stageFailure = new Error("synthetic stage failure");

    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(root) },
    });

    await expect(
      openSourceSqliteDatabase(
        {
          label: "staged-failure",
          backupId: "synthetic-backup-staged-failure",
          main: {
            declaredByteLength: pageSize,
            stage: async (destination) => {
              await destination.write(page(0x11).subarray(0, 64));
              throw stageFailure;
            },
          },
        },
        () => Promise.resolve(fake.sqlite3),
      ),
    ).rejects.toBe(stageFailure);

    expect(fake.install).not.toHaveBeenCalled();
    expect(root.removedNames).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-sqlite-staged-failure-"),
      ]),
    );
  });

  it("rejects a staged main source that produces fewer bytes than declared", async () => {
    const root = new MemoryDirectoryHandle("root");
    const fake = createFakeStreamingSqlite();

    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(root) },
    });

    await expect(
      openSourceSqliteDatabase(
        {
          label: "staged-short",
          backupId: "synthetic-backup-staged-short",
          main: {
            declaredByteLength: pageSize,
            stage: async (destination) => {
              await destination.write(page(0x11).subarray(0, 16));
            },
          },
        },
        () => Promise.resolve(fake.sqlite3),
      ),
    ).rejects.toThrow("did not match the declared main size");

    expect(fake.install).not.toHaveBeenCalled();
    expect(root.removedNames).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source-sqlite-staged-short-"),
      ]),
    );
  });

  it("rejects a staged main source that writes beyond its declared size", async () => {
    const root = new MemoryDirectoryHandle("root");
    const fake = createFakeStreamingSqlite();

    vi.stubGlobal("navigator", {
      storage: { getDirectory: () => Promise.resolve(root) },
    });

    const rejection = expect(
      openSourceSqliteDatabase(
        {
          label: "staged-overflow",
          backupId: "synthetic-backup-staged-overflow",
          main: {
            declaredByteLength: 64,
            stage: async (destination) => {
              await destination.write(page(0x11));
            },
          },
        },
        () => Promise.resolve(fake.sqlite3),
      ),
    ).rejects;

    await rejection.toThrow(SourceSqliteOpenError);
    expect(fake.install).not.toHaveBeenCalled();
  });
});

function createSqliteCleanupHarness(options: {
  throwOnOpen?: boolean;
  throwOnClose?: boolean;
}) {
  const createFile = vi.fn();
  const unlink = vi.fn(() => 0);
  const dealloc = vi.fn();

  class FakeDb {
    constructor(_databaseName: string, _mode: string) {
      if (options.throwOnOpen === true) {
        throw new Error("synthetic open failure");
      }
    }

    close(): void {
      if (options.throwOnClose === true) {
        throw new Error("synthetic close failure");
      }
    }
  }

  const sqlite3 = {
    capi: { sqlite3_js_posix_create_file: createFile },
    oo1: { DB: FakeDb },
    wasm: {
      exports: { sqlite3__wasm_vfs_unlink: unlink },
      allocCString: () => 42,
      dealloc,
    },
  } as unknown as Sqlite3Api;

  return { sqlite3, createFile, unlink, dealloc };
}

function createFakeStreamingSqlite() {
  const importedChunks: Uint8Array[] = [];
  const unlink = vi.fn(() => true);
  const removeVfs = vi.fn(() => Promise.resolve(true));
  const reserveMinimumCapacity = vi.fn(() => Promise.resolve(16));
  const install = vi.fn(() =>
    Promise.resolve({
      vfsName: "golemine-source-test",
      reserveMinimumCapacity,
      importDb: async (
        _name: string,
        next: () =>
          | Uint8Array
          | ArrayBuffer
          | undefined
          | Promise<Uint8Array | ArrayBuffer | undefined>,
      ) => {
        let chunk: Uint8Array | ArrayBuffer | undefined;

        while ((chunk = await next()) !== undefined) {
          importedChunks.push(
            chunk instanceof Uint8Array
              ? new Uint8Array(chunk)
              : new Uint8Array(chunk.slice(0)),
          );
        }

        return importedChunks.reduce((total, item) => total + item.byteLength, 0);
      },
      unlink,
      removeVfs,
    }),
  );

  class FakeDb {
    close = vi.fn();
  }

  const sqlite3 = {
    installOpfsSAHPoolVfs: install,
    oo1: { DB: FakeDb },
  } as unknown as Sqlite3Api;

  return {
    sqlite3,
    importedChunks,
    install,
    unlink,
    removeVfs,
    reserveMinimumCapacity,
  };
}

describe("staged WAL replay", () => {
  it("replays committed frames and ignores frames after the last commit", async () => {
    const main = new Uint8Array(pageSize * 2);
    main[0] = 0x53;
    main[pageSize] = 0x6d;

    const committedPage = page(0x43);
    const uncommittedPage = page(0x55);
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 2, data: committedPage },
      { pageNumber: 2, commitPageCount: 0, data: uncommittedPage },
    ]);

    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x43);
    expect(reconstructed[pageSize]).toBe(0x6d);
  });

  it("keeps main database content when no WAL frame is committed", async () => {
    const main = sqliteHeaderPage(pageSize);
    main[18] = 2;
    main[19] = 2;
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 0, data: page(0x57) },
    ]);
    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).not.toBe(main);
    expect(reconstructed[18]).toBe(1);
    expect(reconstructed[19]).toBe(1);
    expect(reconstructed.slice(20)).toEqual(main.slice(20));
    expect(main[18]).toBe(2);
    expect(main[19]).toBe(2);
  });

  it("forces WAL-mode main databases into rollback mode for read-only transient opens", async () => {
    const main = sqliteHeaderPage(pageSize);

    main[18] = 2;
    main[19] = 2;

    const staged = new TestRandomAccessFile(main);

    await prepareStagedSourceSqliteForReadOnlyOpen(staged);

    const prepared = staged.bytes();

    expect(prepared).not.toBe(main);
    expect(prepared[18]).toBe(1);
    expect(prepared[19]).toBe(1);
    expect(main[18]).toBe(2);
    expect(main[19]).toBe(2);
  });

  it("rejects WAL sidecars whose page size does not match the main database", async () => {
    const main = sqliteHeaderPage(1024);
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 1, data: page(0x57) },
    ]);

    await expect(applyWalForTest(main, wal)).rejects.toThrow(
      "SQLite WAL page size does not match the main database.",
    );
  });

  it("stops replay at the first invalid frame checksum", async () => {
    const main = new Uint8Array(pageSize * 2);
    main[0] = 0x4d;
    main[pageSize] = 0x6d;
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 2, data: page(0x43) },
      { pageNumber: 2, commitPageCount: 2, data: page(0x57) },
    ]);

    wal[32 + 24 + pageSize] ^= 0xff;

    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x43);
    expect(reconstructed[pageSize]).toBe(0x6d);
  });

  it("stops replay before a stale frame whose salt no longer matches", async () => {
    const main = new Uint8Array(pageSize * 2);
    main[0] = 0x4d;
    main[pageSize] = 0x6d;
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 2, data: page(0x43) },
      { pageNumber: 2, commitPageCount: 2, data: page(0x57) },
    ]);

    writeUInt32(wal, 32 + (24 + pageSize) + 8, 0x11111111);

    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x43);
    expect(reconstructed[pageSize]).toBe(0x6d);
  });

  it("ignores a torn tail after a committed WAL frame", async () => {
    const main = sqliteHeaderPage(pageSize);
    const wal = appendBytes(
      walFile([{ pageNumber: 1, commitPageCount: 1, data: page(0x57) }]),
      new Uint8Array([0x84, 0x01, 0x2b, 0xff]),
    );

    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize);
    expect(reconstructed[0]).toBe(0x57);
  });

  it("truncates the database when the final commit shrinks it below earlier frames", async () => {
    const main = page(0x4d);
    // Commit 1 grows the database to 3 pages; commit 2 rewrites page 1 and
    // shrinks the database back to 2 pages. Page 3 from commit 1 must not
    // survive the replay.
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 0, data: page(0x11) },
      { pageNumber: 2, commitPageCount: 0, data: page(0x22) },
      { pageNumber: 3, commitPageCount: 3, data: page(0x33) },
      { pageNumber: 1, commitPageCount: 2, data: page(0x44) },
    ]);

    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x44);
    expect(reconstructed[pageSize - 1]).toBe(0x44);
    expect(reconstructed[pageSize]).toBe(0x22);
    expect(reconstructed[pageSize * 2 - 1]).toBe(0x22);
    expect(reconstructed.includes(0x33)).toBe(false);
  });

  it("replays a checkpoint-truncated main whose earlier commit declares a larger database", async () => {
    // Real scenario: the WAL was born (salted) while the database had 1,000
    // pages, an early transaction committed at that size, a later same-WAL
    // transaction shrank the database, and a checkpoint backfilled and
    // truncated the MAIN FILE without resetting the WAL (salts unchanged).
    // SQLite recovery accepts this — only the FINAL commit's declared size
    // matters — so replay must not reject the early commit's larger size.
    const main = concatBytes([page(0x4d), page(0x6d)]);
    const wal = walFile([
      { pageNumber: 999, commitPageCount: 0, data: page(0xc9) },
      { pageNumber: 1, commitPageCount: 1000, data: page(0x43) },
      { pageNumber: 1, commitPageCount: 2, data: page(0x44) },
    ]);

    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed.subarray(0, pageSize)).toEqual(page(0x44));
    expect(reconstructed.subarray(pageSize)).toEqual(page(0x6d));
  });

  it("rejects WAL sidecars whose commit size exceeds available source pages", async () => {
    const main = sqliteHeaderPage(pageSize);
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 99, data: page(0x57) },
    ]);

    await expect(applyWalForTest(main, wal)).rejects.toThrow(
      "SQLite WAL committed database size exceeds source bounds.",
    );
  });

  it("replays a WAL larger than one buffered read chunk", async () => {
    // 8000 frames of 512-byte pages (536 bytes each) exceed the 4 MiB chunk
    // budget, so the replay must cross at least one chunk boundary.
    const frameCount = 8000;
    const lastCommitIndex = 7900;
    const frames: { pageNumber: number; commitPageCount: number; data: Uint8Array }[] = [];
    const expectedPages = new Map<number, Uint8Array>();

    for (let index = 0; index < frameCount; index += 1) {
      const pageNumber = (index % 3) + 1;
      const data = page(index & 0xff);

      frames.push({
        pageNumber,
        commitPageCount: index === lastCommitIndex ? 3 : 0,
        data,
      });

      if (index <= lastCommitIndex) {
        expectedPages.set(pageNumber, data);
      }
    }

    const main = page(0x4d);
    const wal = walFile(frames);
    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 3);

    for (const [pageNumber, data] of expectedPages) {
      expect(
        reconstructed.subarray((pageNumber - 1) * pageSize, pageNumber * pageSize),
      ).toEqual(data);
    }
  });

  it("skips a committed page whose number exceeds its own transaction's size", async () => {
    const main = page(0x4d);
    // A hostile page number this large would otherwise force a ~1 TiB sparse
    // write (the in-memory file would throw on allocation); the page is
    // beyond its own commit's declared size, so it must be skipped.
    const wal = walFile([
      { pageNumber: 0x7fffffff, commitPageCount: 0, data: page(0x66) },
      { pageNumber: 1, commitPageCount: 1, data: page(0x11) },
    ]);

    const reconstructed = await applyWalForTest(main, wal);

    expect(reconstructed).toHaveLength(pageSize);
    expect(reconstructed[0]).toBe(0x11);
  });

  it("falls back to bounded two-phase replay when one transaction exceeds the pending budget", async () => {
    const main = page(0x4d);
    const wal = walFile([
      { pageNumber: 2, commitPageCount: 0, data: page(0x22) },
      { pageNumber: 3, commitPageCount: 0, data: page(0x33) },
      { pageNumber: 1, commitPageCount: 3, data: page(0x11) },
      { pageNumber: 2, commitPageCount: 0, data: page(0x99) },
    ]);
    const unbudgeted = await applyWalForTest(main, wal);
    const staged = new TestRandomAccessFile(main);

    // One page of budget: the three-frame transaction abandons buffering and
    // the two-phase fallback must reproduce the exact buffered-path output,
    // still ignoring the trailing uncommitted frame.
    await applySqliteWalToStagedFile(staged, blobFromBytes(wal), pageSize);

    expect(staged.bytes()).toEqual(unbudgeted);
    expect(staged.bytes()).toHaveLength(pageSize * 3);
    expect(staged.bytes()[0]).toBe(0x11);
    expect(staged.bytes()[pageSize]).toBe(0x22);
    expect(staged.bytes()[pageSize * 2]).toBe(0x33);
  });

  it("keeps main content when a budget-exceeding WAL has no commit frame", async () => {
    const main = sqliteHeaderPage(pageSize);

    main[18] = 2;
    main[19] = 2;

    // A commit-less WAL of many valid frames must complete with bounded
    // buffering and no writes: no commit means the journal-force branch runs
    // over the untouched main content.
    const frames = Array.from({ length: 64 }, (_, index) => ({
      pageNumber: index + 2,
      commitPageCount: 0,
      data: page(index & 0xff),
    }));
    const staged = new TestRandomAccessFile(main);

    await applySqliteWalToStagedFile(
      staged,
      blobFromBytes(walFile(frames)),
      pageSize,
    );

    const reconstructed = staged.bytes();

    expect(reconstructed).toHaveLength(pageSize);
    expect(reconstructed[18]).toBe(1);
    expect(reconstructed[19]).toBe(1);
    expect(reconstructed.slice(20)).toEqual(main.slice(20));
  });
});

describe("staged source SQLite preparation", () => {
  it("reconstructs a staged file to the exact committed WAL state", async () => {
    const main = new Uint8Array(pageSize * 2);
    main.set(sqliteHeaderPage(pageSize));
    main[18] = 2;
    main[19] = 2;
    main[pageSize] = 0x6d;
    const wal = walFile([
      { pageNumber: 2, commitPageCount: 2, data: page(0x22) },
      { pageNumber: 1, commitPageCount: 3, data: sqliteHeaderPage(pageSize) },
      { pageNumber: 3, commitPageCount: 3, data: page(0x33) },
      { pageNumber: 2, commitPageCount: 0, data: page(0x99) },
    ]);
    const expectedHeaderPage = sqliteHeaderPage(pageSize);
    expectedHeaderPage[18] = 1;
    expectedHeaderPage[19] = 1;
    const expected = concatBytes([expectedHeaderPage, page(0x22), page(0x33)]);
    const staged = new TestRandomAccessFile(main);

    await applySqliteWalToStagedFile(staged, blobFromBytes(wal));

    expect(staged.bytes()).toEqual(expected);
    expect(staged.flushCount).toBe(0);
  });

  it("preserves the committed-prefix stop for a corrupt staged WAL tail", async () => {
    const main = new Uint8Array(pageSize * 2);
    main[0] = 0x4d;
    main[pageSize] = 0x6d;
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 2, data: page(0x43) },
      { pageNumber: 2, commitPageCount: 2, data: page(0x57) },
    ]);

    wal[32 + 24 + pageSize] ^= 0xff;

    const staged = new TestRandomAccessFile(main);

    await applySqliteWalToStagedFile(staged, blobFromBytes(wal));

    expect(staged.getSize()).toBe(pageSize * 2);
    expect(staged.bytes()[0]).toBe(0x43);
    expect(staged.bytes()[pageSize]).toBe(0x6d);
  });

  it("forces D-025 rollback mode and flushes a staged DB without a WAL", async () => {
    const main = sqliteHeaderPage(pageSize);

    main[18] = 2;
    main[19] = 2;

    const staged = new TestRandomAccessFile(main);

    await prepareStagedSourceSqliteForReadOnlyOpen(staged);

    expect(staged.bytes()[18]).toBe(1);
    expect(staged.bytes()[19]).toBe(1);
    expect(staged.flushCount).toBe(1);
  });
});

class TestRandomAccessFile extends MemoryRandomAccessFile {
  flushCount = 0;

  override flush(): void {
    this.flushCount += 1;
  }
}

async function applyWalForTest(main: Uint8Array, wal: Uint8Array): Promise<Uint8Array> {
  const staged = new TestRandomAccessFile(main);

  await applySqliteWalToStagedFile(staged, blobFromBytes(wal));

  return staged.bytes();
}

class MemoryFileHandle {
  readonly kind = "file";
  readonly access = new TestRandomAccessFile(new Uint8Array());

  constructor(readonly name: string) {}

  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
    return Promise.resolve(
      Object.assign(this.access, { close: () => undefined }) as unknown as FileSystemSyncAccessHandle,
    );
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory";
  private readonly directories = new Map<string, MemoryDirectoryHandle>();
  private readonly files = new Map<string, MemoryFileHandle>();

  constructor(
    readonly name: string,
    readonly removedNames: string[] = [],
  ) {}

  getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FileSystemDirectoryHandle> {
    let directory = this.directories.get(name);

    if (directory === undefined) {
      if (options?.create !== true) {
        return Promise.reject(
          new DOMException(`No directory named ${name}.`, "NotFoundError"),
        );
      }

      directory = new MemoryDirectoryHandle(name, this.removedNames);
      this.directories.set(name, directory);
    }

    return Promise.resolve(directory as unknown as FileSystemDirectoryHandle);
  }

  getFileHandle(
    name: string,
    options?: FileSystemGetFileOptions,
  ): Promise<FileSystemFileHandle> {
    let file = this.files.get(name);

    if (file === undefined) {
      if (options?.create !== true) {
        return Promise.reject(
          new DOMException(`No file named ${name}.`, "NotFoundError"),
        );
      }

      file = new MemoryFileHandle(name);
      this.files.set(name, file);
    }

    return Promise.resolve(file as unknown as FileSystemFileHandle);
  }

  removeEntry(name: string): Promise<void> {
    this.removedNames.push(name);
    this.directories.delete(name);
    this.files.delete(name);

    return Promise.resolve();
  }
}

function page(fill: number): Uint8Array {
  const bytes = new Uint8Array(pageSize);

  bytes.fill(fill);

  return bytes;
}

function sqliteHeaderPage(headerPageSize: number): Uint8Array {
  const bytes = page(0);
  const header = "SQLite format 3\0";

  for (let index = 0; index < header.length; index += 1) {
    bytes[index] = header.charCodeAt(index);
  }

  bytes[16] = (headerPageSize >>> 8) & 0xff;
  bytes[17] = headerPageSize & 0xff;

  return bytes;
}

function walFile(
  frames: readonly {
    pageNumber: number;
    commitPageCount: number;
    data: Uint8Array;
  }[],
): Uint8Array {
  const frameSize = 24 + pageSize;
  const bytes = new Uint8Array(32 + frames.length * frameSize);

  writeUInt32(bytes, 0, 0x377f0682);
  writeUInt32(bytes, 4, 3007000);
  writeUInt32(bytes, 8, pageSize);
  writeUInt32(bytes, 16, 0x12345678);
  writeUInt32(bytes, 20, 0x90abcdef);

  let checksum = walChecksum(bytes, 0, 24, [0, 0]);
  writeUInt32(bytes, 24, checksum[0]);
  writeUInt32(bytes, 28, checksum[1]);

  frames.forEach((frame, index) => {
    const offset = 32 + index * frameSize;

    writeUInt32(bytes, offset, frame.pageNumber);
    writeUInt32(bytes, offset + 4, frame.commitPageCount);
    writeUInt32(bytes, offset + 8, 0x12345678);
    writeUInt32(bytes, offset + 12, 0x90abcdef);
    bytes.set(frame.data, offset + 24);
    checksum = walChecksum(bytes, offset, 8, checksum);
    checksum = walChecksum(bytes, offset + 24, pageSize, checksum);
    writeUInt32(bytes, offset + 16, checksum[0]);
    writeUInt32(bytes, offset + 20, checksum[1]);
  });

  return bytes;
}

function walChecksum(
  bytes: Uint8Array,
  offset: number,
  byteLength: number,
  seed: readonly [number, number],
): [number, number] {
  let s0 = seed[0] >>> 0;
  let s1 = seed[1] >>> 0;

  for (let cursor = offset; cursor < offset + byteLength; cursor += 8) {
    s0 = (s0 + readUInt32LittleEndian(bytes, cursor) + s1) >>> 0;
    s1 = (s1 + readUInt32LittleEndian(bytes, cursor + 4) + s0) >>> 0;
  }

  return [s0, s1];
}

function readUInt32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    (bytes[offset + 1] << 8) +
    (bytes[offset + 2] << 16) +
    ((bytes[offset + 3] << 24) >>> 0)
  ) >>> 0;
}

function appendBytes(bytes: Uint8Array, suffix: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.byteLength + suffix.byteLength);

  output.set(bytes);
  output.set(suffix, bytes.byteLength);

  return output;
}

function blobFromBytes(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);

  new Uint8Array(buffer).set(bytes);

  return new Blob([buffer]);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function writeUInt32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
