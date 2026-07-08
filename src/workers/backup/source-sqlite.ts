import { bytesStartWith } from "../shared/binary";
import { getSqlite, type Sqlite3Api } from "../shared/sqlite-init";

export type SqliteDatabase = InstanceType<Sqlite3Api["oo1"]["DB"]>;
type SqliteBindValue = string | number | bigint | boolean | null | Uint8Array;

const sqliteFormat3Magic = new TextEncoder().encode("SQLite format 3\0");

let databaseCounter = 0;

export interface SourceSqliteDatabase {
  db: SqliteDatabase;
  close(): void;
}

interface WalFrameScan {
  lastCommitFrameEnd: number;
  lastCommittedPageCount: number;
  validCommittedFrameCount: number;
}

export async function openSourceSqliteDatabase(input: {
  label: string;
  main: Uint8Array;
  wal?: Uint8Array;
  shm?: Uint8Array;
}): Promise<SourceSqliteDatabase> {
  const sqlite3 = await getSqlite();
  const databaseName = makeTransientDatabaseName(input.label);
  const mainBytes =
    input.wal === undefined ? input.main : applySqliteWal(input.main, input.wal);

  sqlite3.capi.sqlite3_js_posix_create_file(databaseName, mainBytes);

  // Source bytes are copied into sqlite-wasm's transient in-worker VFS first.
  // WAL frames are applied to that copy above; the user's backup folder
  // remains read-only and SQLite opens a normal reconstructed database.
  const db = new sqlite3.oo1.DB(databaseName, "r");

  return {
    db,
    close: () => {
      db.close();
    },
  };
}

export function applySqliteWal(main: Uint8Array, wal: Uint8Array): Uint8Array {
  if (wal.byteLength === 0) {
    return main;
  }

  if (wal.byteLength < 32) {
    throw new Error("SQLite WAL sidecar is too short.");
  }

  const magic = readUInt32(wal, 0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    throw new Error("SQLite WAL sidecar has an invalid magic number.");
  }

  if (readUInt32(wal, 4) !== 3_007_000) {
    throw new Error("SQLite WAL sidecar has an unsupported format version.");
  }

  const checksumEndian = magic === 0x377f0683 ? "big" : "little";
  const pageSize = readWalPageSize(wal);
  if (pageSize === undefined) {
    throw new Error("SQLite WAL sidecar has an invalid page size.");
  }

  const mainPageSize = readMainDatabasePageSize(main);
  if (mainPageSize !== undefined && mainPageSize !== pageSize) {
    throw new Error("SQLite WAL page size does not match the main database.");
  }

  const frameSize = 24 + pageSize;
  const scan = scanCommittedWalFrames(wal, pageSize, checksumEndian);
  const { lastCommitFrameEnd, lastCommittedPageCount, validCommittedFrameCount } = scan;

  if (lastCommittedPageCount === 0) {
    return main;
  }

  const committedByteLength = lastCommittedPageCount * pageSize;
  const maxReconstructedByteLength =
    main.byteLength + validCommittedFrameCount * pageSize;

  if (
    !Number.isSafeInteger(committedByteLength) ||
    committedByteLength > maxReconstructedByteLength
  ) {
    throw new Error("SQLite WAL committed database size exceeds source bounds.");
  }

  let output = new Uint8Array(main);

  for (let frameOffset = 32; frameOffset < lastCommitFrameEnd; frameOffset += frameSize) {
    const pageNumber = readUInt32(wal, frameOffset);
    const pageOffset = (pageNumber - 1) * pageSize;

    if (pageOffset + pageSize > committedByteLength) {
      continue;
    }

    if (pageOffset + pageSize > output.byteLength) {
      const resized = new Uint8Array(pageOffset + pageSize);
      resized.set(output);
      output = resized;
    }

    output.set(wal.subarray(frameOffset + 24, frameOffset + 24 + pageSize), pageOffset);
  }

  if (output.byteLength !== committedByteLength) {
    output = output.slice(0, committedByteLength);
  }

  if (output.byteLength >= 20) {
    output[18] = 1;
    output[19] = 1;
  }

  return output;
}

function scanCommittedWalFrames(
  wal: Uint8Array,
  pageSize: number,
  endian: "big" | "little",
): WalFrameScan {
  let checksum = walChecksumBytes(wal, 0, 24, [0, 0], endian);

  if (readUInt32(wal, 24) !== checksum[0] || readUInt32(wal, 28) !== checksum[1]) {
    throw new Error("SQLite WAL header checksum is invalid.");
  }

  const frameSize = 24 + pageSize;
  const completeFrameCount = Math.floor((wal.byteLength - 32) / frameSize);
  const salt1 = readUInt32(wal, 16);
  const salt2 = readUInt32(wal, 20);
  let lastCommitFrameEnd = 32;
  let lastCommittedPageCount = 0;
  let validCommittedFrameCount = 0;

  for (let index = 0; index < completeFrameCount; index += 1) {
    const frameOffset = 32 + index * frameSize;
    const frame = readValidWalFrame(
      wal,
      frameOffset,
      pageSize,
      checksum,
      endian,
      salt1,
      salt2,
    );

    if (frame === undefined) {
      break;
    }

    checksum = frame.checksum;

    if (frame.commitPageCount > 0) {
      lastCommitFrameEnd = frameOffset + frameSize;
      lastCommittedPageCount = frame.commitPageCount;
      validCommittedFrameCount = index + 1;
    }
  }

  return {
    lastCommitFrameEnd,
    lastCommittedPageCount,
    validCommittedFrameCount,
  };
}

function readValidWalFrame(
  wal: Uint8Array,
  frameOffset: number,
  pageSize: number,
  previousChecksum: readonly [number, number],
  endian: "big" | "little",
  salt1: number,
  salt2: number,
): { commitPageCount: number; checksum: [number, number] } | undefined {
  const pageNumber = readUInt32(wal, frameOffset);

  if (pageNumber <= 0) {
    return undefined;
  }

  if (
    readUInt32(wal, frameOffset + 8) !== salt1 ||
    readUInt32(wal, frameOffset + 12) !== salt2
  ) {
    return undefined;
  }

  let checksum = walChecksumBytes(wal, frameOffset, 8, previousChecksum, endian);
  checksum = walChecksumBytes(wal, frameOffset + 24, pageSize, checksum, endian);

  if (
    readUInt32(wal, frameOffset + 16) !== checksum[0] ||
    readUInt32(wal, frameOffset + 20) !== checksum[1]
  ) {
    return undefined;
  }

  return {
    commitPageCount: readUInt32(wal, frameOffset + 4),
    checksum,
  };
}

function walChecksumBytes(
  bytes: Uint8Array,
  offset: number,
  byteLength: number,
  seed: readonly [number, number],
  endian: "big" | "little",
): [number, number] {
  let s0 = seed[0] >>> 0;
  let s1 = seed[1] >>> 0;

  for (let cursor = offset; cursor < offset + byteLength; cursor += 8) {
    s0 = (s0 + readUInt32Endian(bytes, cursor, endian) + s1) >>> 0;
    s1 = (s1 + readUInt32Endian(bytes, cursor + 4, endian) + s0) >>> 0;
  }

  return [s0, s1];
}

export function sqliteRows<T>(
  db: SqliteDatabase,
  sql: string,
  bind?: readonly SqliteBindValue[],
): T[] {
  return db.exec({
    sql,
    ...(bind === undefined ? {} : { bind }),
    rowMode: "object",
    returnValue: "resultRows",
  }) as T[];
}

export function sqliteValue(
  db: SqliteDatabase,
  sql: string,
  bind?: readonly SqliteBindValue[],
): string | number | bigint | null | undefined {
  const rows = sqliteRows<Record<string, unknown>>(db, sql, bind);

  if (rows.length === 0) {
    return undefined;
  }

  const value = Object.values(rows[0])[0];

  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value === null
    ? value
    : undefined;
}

export function sqliteTableColumns(
  db: SqliteDatabase,
  tableName: string,
): Set<string> {
  const rows = sqliteRows<{ name: unknown }>(db, `PRAGMA table_info(${quoteIdentifier(tableName)});`);
  const columns = new Set<string>();

  for (const row of rows) {
    if (typeof row.name === "string") {
      columns.add(row.name);
    }
  }

  return columns;
}

export function sqliteTableExists(db: SqliteDatabase, tableName: string): boolean {
  const count = sqliteValue(
    db,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?;",
    [tableName],
  );

  return (
    (typeof count === "number" && count > 0) ||
    (typeof count === "bigint" && count > 0n)
  );
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function makeTransientDatabaseName(label: string): string {
  databaseCounter += 1;
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48);

  return `/golemine-source-${safeLabel}-${String(databaseCounter)}.sqlite`;
}

function readWalPageSize(wal: Uint8Array): number | undefined {
  const pageSize = readUInt32(wal, 8);

  return isValidSqlitePageSize(pageSize) ? pageSize : undefined;
}

function readMainDatabasePageSize(main: Uint8Array): number | undefined {
  if (main.byteLength < 100 || !bytesStartWith(main, sqliteFormat3Magic)) {
    return undefined;
  }

  const value = (main[16] << 8) | main[17];
  const pageSize = value === 1 ? 65_536 : value;

  return isValidSqlitePageSize(pageSize) ? pageSize : undefined;
}

function isValidSqlitePageSize(value: number): boolean {
  return value >= 512 && value <= 65_536 && (value & (value - 1)) === 0;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  ) >>> 0;
}

function readUInt32Endian(
  bytes: Uint8Array,
  offset: number,
  endian: "big" | "little",
): number {
  if (endian === "big") {
    return readUInt32(bytes, offset);
  }

  return (
    bytes[offset] +
    (bytes[offset + 1] << 8) +
    (bytes[offset + 2] << 16) +
    ((bytes[offset + 3] << 24) >>> 0)
  ) >>> 0;
}
