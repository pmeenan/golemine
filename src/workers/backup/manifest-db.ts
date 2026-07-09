import {
  getPlistData,
  isPlistDictionary,
  parsePlist,
  type PlistDictionary,
  type PlistValue,
} from "./plist";
import type { ReadonlySourceDirectoryHandle } from "./read-only-source";
import {
  openSourceSqliteDatabase,
  sqliteRows,
  type SourceSqliteDatabase,
} from "./source-sqlite";

const textEncoder = new TextEncoder();

export interface ManifestFileMetadata {
  size?: number;
  mode?: number;
  protectionClass?: number;
  lastModified?: number;
  encryptionKey?: Uint8Array;
}

export interface ManifestFileRecord {
  fileId: string;
  domain: string;
  relativePath: string;
  flags: number;
  metadata: ManifestFileMetadata;
}

export interface SourceFileBytes {
  record: ManifestFileRecord;
  bytes: Uint8Array;
  sha256: string;
  sourceByteLength: number;
}

export interface RootSourceFileBytes {
  relativePath: string;
  bytes: Uint8Array;
  sha256: string;
}

/**
 * Provenance metadata for a root source file that fed the transient
 * Manifest.db copy. Deliberately byte-free: once the sqlite copy exists the
 * reader must not pin the raw Manifest.db/-wal/-shm arrays in memory (the
 * attachment-read path caches the reader per backup, and real manifests can
 * be hundreds of megabytes).
 */
export interface RootSourceFileInfo {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface ReadSourceFileBytesOptions {
  maxReadBytes?: number;
}

interface ManifestRow {
  fileID: unknown;
  domain: unknown;
  relativePath: unknown;
  flags: unknown;
  file: unknown;
}

export class ManifestDbError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ManifestDbError";
  }
}

export class SourceFileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFileTooLargeError";
  }
}

export class ManifestDbReader {
  private constructor(
    private readonly source: SourceSqliteDatabase,
    readonly sourceFiles: readonly RootSourceFileInfo[],
  ) {}

  static async open(root: ReadonlySourceDirectoryHandle): Promise<ManifestDbReader> {
    const manifestFile = await readRootSourceFileBytes(root, "Manifest.db");
    const manifestWalFile = await readOptionalRootSourceFileBytes(root, "Manifest.db-wal");
    const manifestShmFile = await readOptionalRootSourceFileBytes(root, "Manifest.db-shm");
    const source = await openSourceSqliteDatabase({
      label: "manifest",
      main: manifestFile.bytes,
      ...(manifestWalFile === undefined ? {} : { wal: manifestWalFile.bytes }),
      ...(manifestShmFile === undefined ? {} : { shm: manifestShmFile.bytes }),
    });

    // Retain provenance metadata only. openSourceSqliteDatabase copied the
    // reconstructed database into the transient sqlite VFS above, so keeping
    // the raw byte arrays here would only pin them for the reader's lifetime
    // (ingest and attachment reads never touch them again).
    return new ManifestDbReader(
      source,
      [manifestFile, manifestWalFile, manifestShmFile]
        .filter((file): file is RootSourceFileBytes => file !== undefined)
        .map((file) => ({
          relativePath: file.relativePath,
          sha256: file.sha256,
          byteLength: file.bytes.byteLength,
        })),
    );
  }

  close(): void {
    this.source.close();
  }

  findFile(domain: string, relativePath: string): ManifestFileRecord | undefined {
    const rows = sqliteRows<ManifestRow>(
      this.source.db,
      `
        SELECT fileID, domain, relativePath, flags, file
        FROM Files
        WHERE domain = ? AND relativePath = ?
        LIMIT 1;
      `,
      [domain, relativePath],
    );

    return rows.length === 0 ? undefined : parseManifestRow(rows[0]);
  }

  requireFile(domain: string, relativePath: string): ManifestFileRecord {
    const record = this.findFile(domain, relativePath);

    if (record === undefined) {
      throw new ManifestDbError(
        `Manifest.db does not contain ${domain}/${relativePath}.`,
      );
    }

    return record;
  }
}

export async function readSourceFileBytes(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  options: ReadSourceFileBytesOptions = {},
): Promise<SourceFileBytes> {
  const directory = await root.getDirectory(record.fileId.slice(0, 2));
  const file = await directory.getFile(record.fileId);
  const maxReadBytes = options.maxReadBytes;

  if (maxReadBytes !== undefined && file.size > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const expectedSize = record.metadata.size;
  const contents =
    expectedSize === undefined || expectedSize >= bytes.byteLength
      ? bytes
      : bytes.subarray(0, expectedSize);

  if (maxReadBytes !== undefined && contents.byteLength > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  return {
    record,
    bytes: contents,
    sha256: await sha256Hex(contents),
    sourceByteLength: file.size,
  };
}

export async function readRootSourceFileBytes(
  root: ReadonlySourceDirectoryHandle,
  relativePath: string,
): Promise<RootSourceFileBytes> {
  const file = await root.getFile(relativePath);
  const bytes = new Uint8Array(await file.arrayBuffer());

  return {
    relativePath,
    bytes,
    sha256: await sha256Hex(bytes),
  };
}

async function readOptionalRootSourceFileBytes(
  root: ReadonlySourceDirectoryHandle,
  relativePath: string,
): Promise<RootSourceFileBytes | undefined> {
  try {
    return await readRootSourceFileBytes(root, relativePath);
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return undefined;
    }

    throw cause;
  }
}

export async function sourceFileId(
  domain: string,
  relativePath: string,
): Promise<string> {
  return digestHex("SHA-1", textEncoder.encode(`${domain}-${relativePath}`));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return digestHex("SHA-256", bytes);
}

function parseManifestRow(row: ManifestRow): ManifestFileRecord {
  if (
    typeof row.fileID !== "string" ||
    typeof row.domain !== "string" ||
    typeof row.relativePath !== "string" ||
    typeof row.flags !== "number"
  ) {
    throw new ManifestDbError("Manifest.db returned a malformed Files row.");
  }

  return {
    fileId: row.fileID,
    domain: row.domain,
    relativePath: row.relativePath,
    flags: row.flags,
    metadata: parseMbFileMetadata(row.file),
  };
}

export function parseMbFileMetadata(value: unknown): ManifestFileMetadata {
  if (!(value instanceof Uint8Array)) {
    return {};
  }

  try {
    const parsed = parsePlist(value);
    const root = plistRootDictionary(parsed.value);

    if (root === undefined) {
      return {};
    }

    return {
      ...optionalNumberField("size", root, "Size"),
      ...optionalNumberField("mode", root, "Mode"),
      ...optionalNumberField("protectionClass", root, "ProtectionClass"),
      ...optionalNumberField("lastModified", root, "LastModified"),
      ...optionalDataField("encryptionKey", root, "EncryptionKey"),
    };
  } catch (cause) {
    throw new ManifestDbError("Manifest.db contains an unreadable MBFile record.", cause);
  }
}

function plistRootDictionary(value: PlistValue): PlistDictionary | undefined {
  if (!isPlistDictionary(value)) {
    return undefined;
  }

  const objects = value.$objects;
  const top = value.$top;

  if (Array.isArray(objects) && isPlistDictionary(top)) {
    const rootRef = top.root;
    const root = typeof rootRef === "number" ? objects[rootRef] : undefined;

    return root !== undefined && isPlistDictionary(root) ? root : value;
  }

  return value;
}

function optionalNumberField<TKey extends string>(
  outputKey: TKey,
  dict: PlistDictionary,
  sourceKey: string,
): Partial<Record<TKey, number>> {
  const value = dict[sourceKey];

  return typeof value === "number" && Number.isFinite(value)
    ? ({ [outputKey]: value } as Record<TKey, number>)
    : {};
}

function optionalDataField<TKey extends string>(
  outputKey: TKey,
  dict: PlistDictionary,
  sourceKey: string,
): Partial<Record<TKey, Uint8Array>> {
  const value = getPlistData(dict, sourceKey);

  return value === undefined ? {} : ({ [outputKey]: value } as Record<TKey, Uint8Array>);
}

async function digestHex(algorithm: AlgorithmIdentifier, bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest accepts a BufferSource view directly; hashing the
  // view avoids copying potentially large source files. The narrowing cast is
  // safe because this project never allocates SharedArrayBuffer-backed views
  // (D-008 avoids SharedArrayBuffer entirely).
  const digest = await crypto.subtle.digest(
    algorithm,
    bytes as Uint8Array<ArrayBuffer>,
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isNotFoundError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }

  return (
    ("name" in cause && cause.name === "NotFoundError") ||
    ("code" in cause && cause.code === "ENOENT")
  );
}
