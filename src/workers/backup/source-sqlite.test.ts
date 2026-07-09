import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { getSqlite } from "../shared/sqlite-init";
import {
  applySqliteWal,
  openSourceSqliteDatabase,
  prepareSourceSqliteBytesForReadOnlyOpen,
  sqliteValue,
} from "./source-sqlite";

const pageSize = 512;

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

      // The transient copy must be removed from the wasm VFS on close;
      // re-opening the same name read-only must fail because the file is gone.
      const sqlite3 = await getSqlite();

      expect(() => new sqlite3.oo1.DB(source.databaseName, "r")).toThrow();
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("applySqliteWal", () => {
  it("replays committed frames and ignores frames after the last commit", () => {
    const main = new Uint8Array(pageSize * 2);
    main[0] = 0x53;
    main[pageSize] = 0x6d;

    const committedPage = page(0x43);
    const uncommittedPage = page(0x55);
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 2, data: committedPage },
      { pageNumber: 2, commitPageCount: 0, data: uncommittedPage },
    ]);

    const reconstructed = applySqliteWal(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x43);
    expect(reconstructed[pageSize]).toBe(0x6d);
  });

  it("keeps main database content when no WAL frame is committed", () => {
    const main = sqliteHeaderPage(pageSize);
    main[18] = 2;
    main[19] = 2;
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 0, data: page(0x57) },
    ]);
    const reconstructed = applySqliteWal(main, wal);

    expect(reconstructed).not.toBe(main);
    expect(reconstructed[18]).toBe(1);
    expect(reconstructed[19]).toBe(1);
    expect(reconstructed.slice(20)).toEqual(main.slice(20));
    expect(main[18]).toBe(2);
    expect(main[19]).toBe(2);
  });

  it("forces WAL-mode main databases into rollback mode for read-only transient opens", () => {
    const main = sqliteHeaderPage(pageSize);

    main[18] = 2;
    main[19] = 2;

    const prepared = prepareSourceSqliteBytesForReadOnlyOpen(main);

    expect(prepared).not.toBe(main);
    expect(prepared[18]).toBe(1);
    expect(prepared[19]).toBe(1);
    expect(main[18]).toBe(2);
    expect(main[19]).toBe(2);
  });

  it("rejects WAL sidecars whose page size does not match the main database", () => {
    const main = sqliteHeaderPage(1024);
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 1, data: page(0x57) },
    ]);

    expect(() => applySqliteWal(main, wal)).toThrow(
      "SQLite WAL page size does not match the main database.",
    );
  });

  it("stops replay at the first invalid frame checksum", () => {
    const main = new Uint8Array(pageSize * 2);
    main[0] = 0x4d;
    main[pageSize] = 0x6d;
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 2, data: page(0x43) },
      { pageNumber: 2, commitPageCount: 2, data: page(0x57) },
    ]);

    wal[32 + 24 + pageSize] ^= 0xff;

    const reconstructed = applySqliteWal(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x43);
    expect(reconstructed[pageSize]).toBe(0x6d);
  });

  it("stops replay before a stale frame whose salt no longer matches", () => {
    const main = new Uint8Array(pageSize * 2);
    main[0] = 0x4d;
    main[pageSize] = 0x6d;
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 2, data: page(0x43) },
      { pageNumber: 2, commitPageCount: 2, data: page(0x57) },
    ]);

    writeUInt32(wal, 32 + (24 + pageSize) + 8, 0x11111111);

    const reconstructed = applySqliteWal(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x43);
    expect(reconstructed[pageSize]).toBe(0x6d);
  });

  it("ignores a torn tail after a committed WAL frame", () => {
    const main = sqliteHeaderPage(pageSize);
    const wal = appendBytes(
      walFile([{ pageNumber: 1, commitPageCount: 1, data: page(0x57) }]),
      new Uint8Array([0x84, 0x01, 0x2b, 0xff]),
    );

    const reconstructed = applySqliteWal(main, wal);

    expect(reconstructed).toHaveLength(pageSize);
    expect(reconstructed[0]).toBe(0x57);
  });

  it("truncates the database when the final commit shrinks it below earlier frames", () => {
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

    const reconstructed = applySqliteWal(main, wal);

    expect(reconstructed).toHaveLength(pageSize * 2);
    expect(reconstructed[0]).toBe(0x44);
    expect(reconstructed[pageSize - 1]).toBe(0x44);
    expect(reconstructed[pageSize]).toBe(0x22);
    expect(reconstructed[pageSize * 2 - 1]).toBe(0x22);
    expect(reconstructed.includes(0x33)).toBe(false);
  });

  it("rejects WAL sidecars whose commit size exceeds available source pages", () => {
    const main = sqliteHeaderPage(pageSize);
    const wal = walFile([
      { pageNumber: 1, commitPageCount: 99, data: page(0x57) },
    ]);

    expect(() => applySqliteWal(main, wal)).toThrow(
      "SQLite WAL committed database size exceeds source bounds.",
    );
  });
});

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

function writeUInt32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
