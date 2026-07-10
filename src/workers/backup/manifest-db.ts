import {
  getPlistData,
  isPlistDictionary,
  parsePlist,
  type PlistDictionary,
  type PlistValue,
} from "./plist";
import { zeroizeBuffers } from "../shared/zeroize";
import type { ReadonlySourceDirectoryHandle } from "./read-only-source";
import {
  openSourceSqliteDatabase,
  sqliteRows,
  type SourceSqliteDatabase,
} from "./source-sqlite";

const textEncoder = new TextEncoder();
const maxUnencryptedManifestDatabaseBytes = 1024 * 1024 * 1024;
// Encrypted Manifest.db exists simultaneously as bounded ciphertext,
// chunk-decrypted plaintext, and a transient SQLite copy in sqlite-wasm's
// heap, whose imported wasm memory maxes out at 2 GiB and is shared with the
// per-ingest source database copies (D-039). 512 MiB keeps the manifest's
// share of that heap plus its JS-side plaintext comfortably inside those
// ceilings until a streaming Manifest import exists.
export const maxEncryptedManifestDatabaseBytes = 512 * 1024 * 1024;

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
  /** Plaintext bytes consumed by ingest/preview. */
  bytes: Uint8Array;
  /** SHA-256 of plaintext `bytes`. */
  sha256: string;
  /**
   * SHA-256 of the complete file as stored in the source backup. On the
   * encrypted path this costs a second full read of the ciphertext, so it is
   * computed only when the caller opts in via `includeSourceSha256`
   * (unencrypted reads always carry it because it is derived from bytes
   * already in memory).
   */
  sourceSha256?: string;
  sourceByteLength: number;
  isEncrypted: boolean;
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
  /** SHA-256 of bytes exactly as stored in the backup. */
  sha256: string;
  /** SHA-256 after provider/session decryption, when different. */
  contentSha256?: string;
  byteLength: number;
  contentByteLength?: number;
  isEncrypted?: boolean;
}

export interface ReadSourceFileBytesOptions {
  maxReadBytes?: number;
  /**
   * Requests the stored-source (ciphertext) SHA-256 alongside the plaintext
   * hash. Free on unencrypted reads; on encrypted reads it triggers a second
   * full read of the stored file, so only provenance/report consumers should
   * set it. Encryption-internal chunk controls live on the encrypted
   * session's own read options, not here.
   */
  includeSourceSha256?: boolean;
}

export interface ManifestDbOpenOptions {
  /** Decrypts root Manifest.db before its transient read-only SQLite open. */
  decryptMain?: (encryptedBytes: Uint8Array) => Promise<Uint8Array>;
}

export interface ReadEncryptedSourceFileBytesOptions {
  plaintextSize: number;
  maxReadBytes?: number;
  /** Compute the ciphertext SHA-256 (a second full read of the stored file). */
  includeSourceSha256?: boolean;
  signal?: AbortSignal;
  decryptChunks(source: Blob): AsyncIterable<Uint8Array>;
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

export class SourceFileDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceFileDecryptionError";
  }
}

export class ManifestDbReader {
  private constructor(
    private readonly source: SourceSqliteDatabase,
    readonly sourceFiles: readonly RootSourceFileInfo[],
  ) {}

  static async open(
    root: ReadonlySourceDirectoryHandle,
    options: ManifestDbOpenOptions = {},
  ): Promise<ManifestDbReader> {
    const manifestReadLimit =
      options.decryptMain === undefined
        ? maxUnencryptedManifestDatabaseBytes
        : maxEncryptedManifestDatabaseBytes;
    const manifestFile = await readRootSourceFileBytes(
      root,
      "Manifest.db",
      manifestReadLimit,
    );
    // Encrypted backups do not expose usable root Manifest.db sidecars unless
    // each sidecar has independently supported key metadata. Apple backups do
    // not provide that at the root, so never mix encrypted/unknown sidecar
    // bytes into the decrypted database.
    let manifestWalFile: RootSourceFileBytes | undefined;
    let manifestShmFile: RootSourceFileBytes | undefined;
    let mainBytes: Uint8Array | undefined;

    try {
      if (options.decryptMain === undefined) {
        manifestWalFile = await readOptionalRootSourceFileBytes(
          root,
          "Manifest.db-wal",
          maxUnencryptedManifestDatabaseBytes,
        );
        manifestShmFile = await readOptionalRootSourceFileBytes(
          root,
          "Manifest.db-shm",
          maxUnencryptedManifestDatabaseBytes,
        );
      }

      mainBytes =
        options.decryptMain === undefined
          ? manifestFile.bytes
          : await options.decryptMain(manifestFile.bytes);
      const openedMainBytes = mainBytes;
      const mainContentSha256 =
        options.decryptMain === undefined
          ? undefined
          : await sha256Hex(mainBytes);
      const sourceFiles = [manifestFile, manifestWalFile, manifestShmFile]
        .filter((file): file is RootSourceFileBytes => file !== undefined)
        .map((file) => ({
          relativePath: file.relativePath,
          sha256: file.sha256,
          byteLength: file.bytes.byteLength,
          ...(file.relativePath === "Manifest.db" && mainContentSha256 !== undefined
            ? {
                contentSha256: mainContentSha256,
                contentByteLength: openedMainBytes.byteLength,
                isEncrypted: true,
              }
            : {}),
        }));
      const source = await openSourceSqliteDatabase({
        label: "manifest",
        main: openedMainBytes,
        ...(manifestWalFile === undefined ? {} : { wal: manifestWalFile.bytes }),
        ...(manifestShmFile === undefined ? {} : { shm: manifestShmFile.bytes }),
      });

      // The reader retains byte-free provenance only; sqlite-wasm owns the
      // one transient reconstructed copy until close().
      return new ManifestDbReader(source, sourceFiles);
    } finally {
      zeroizeBuffers(
        manifestFile.bytes,
        manifestWalFile?.bytes,
        manifestShmFile?.bytes,
        mainBytes,
      );
    }
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

/**
 * Resolves the stored backup file for a Manifest record (fileId-sharded
 * layout) without reading its bytes. Shared by both readers and by the
 * pre-prepare ingest budget check so size probes never duplicate the walk.
 */
export async function getStoredSourceFile(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
): Promise<File> {
  const directory = await root.getDirectory(record.fileId.slice(0, 2));

  return directory.getFile(record.fileId);
}

export async function readSourceFileBytes(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  options: ReadSourceFileBytesOptions = {},
): Promise<SourceFileBytes> {
  const file = await getStoredSourceFile(root, record);
  const maxReadBytes = options.maxReadBytes;
  const expectedSize = record.metadata.size;
  const validExpectedSize =
    expectedSize !== undefined &&
    Number.isSafeInteger(expectedSize) &&
    expectedSize >= 0
      ? expectedSize
      : undefined;

  if (maxReadBytes !== undefined && file.size > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const contents =
    validExpectedSize === undefined || validExpectedSize >= sourceBytes.byteLength
      ? sourceBytes
      : sourceBytes.subarray(0, validExpectedSize);

  if (maxReadBytes !== undefined && contents.byteLength > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  const sha256 = await sha256Hex(contents);
  const sourceSha256 =
    contents === sourceBytes ? sha256 : await sha256Hex(sourceBytes);

  return {
    record,
    bytes: contents,
    sha256,
    sourceSha256,
    sourceByteLength: file.size,
    isEncrypted: false,
  };
}

/**
 * Reads an encrypted MBFile through the session's chunk decryptor. The final
 * plaintext must be materialized because the worker RPC returns Uint8Array,
 * but ciphertext is never passed as one monolithic decrypt input. Exact
 * source SHA-256 still uses WebCrypto's one-shot digest (there is no native
 * streaming digest API); it is computed in a separate scope before plaintext
 * allocation so both full buffers are not intentionally retained together.
 */
export async function readEncryptedSourceFileBytes(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  options: ReadEncryptedSourceFileBytesOptions,
): Promise<SourceFileBytes> {
  options.signal?.throwIfAborted();
  const file = await getStoredSourceFile(root, record);
  options.signal?.throwIfAborted();
  const { maxReadBytes, plaintextSize } = options;

  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new SourceFileDecryptionError(
      `Source file ${record.domain}/${record.relativePath} has an invalid declared plaintext size.`,
    );
  }

  if (maxReadBytes !== undefined && plaintextSize > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  if (maxReadBytes !== undefined && file.size > maxReadBytes + 16) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  // MBFile.Size is the authoritative logical plaintext length. Real backup
  // producers can leave a longer block-aligned stored tail or a shorter
  // materialized prefix for a sparse file. The destination is zero-initialized
  // below, so a short prefix is safely extended without reading invented bytes.
  // The caller caps above still bound both stored and logical sizes first.
  if (file.size % 16 !== 0) {
    throw new SourceFileDecryptionError(
      `Encrypted file ${record.domain}/${record.relativePath} is inconsistent with its declared plaintext size.`,
    );
  }

  options.signal?.throwIfAborted();
  // Ciphertext hashing costs a second full read of the stored file (WebCrypto
  // has no incremental digest), so it runs only for callers that need stored-
  // source provenance; eager ingest attachment hashing skips it.
  const sourceSha256 =
    options.includeSourceSha256 === true
      ? await sha256File(file, options.signal)
      : undefined;
  options.signal?.throwIfAborted();
  const contents = new Uint8Array(plaintextSize);
  const materializedPlaintextBytes = Math.min(plaintextSize, file.size);
  let offset = 0;

  try {
    for await (const chunk of options.decryptChunks(file)) {
      try {
        options.signal?.throwIfAborted();
        if (offset + chunk.byteLength > contents.byteLength) {
          throw new SourceFileDecryptionError(
            `Decrypted file ${record.domain}/${record.relativePath} exceeded its declared plaintext size.`,
          );
        }

        contents.set(chunk, offset);
        offset += chunk.byteLength;
        options.signal?.throwIfAborted();
      } finally {
        chunk.fill(0);
      }
    }

    if (offset !== materializedPlaintextBytes) {
      throw new SourceFileDecryptionError(
        `Decrypted file ${record.domain}/${record.relativePath} did not match its materialized source size.`,
      );
    }

    options.signal?.throwIfAborted();
    const sha256 = await sha256Hex(contents);
    options.signal?.throwIfAborted();

    return {
      record,
      bytes: contents,
      sha256,
      ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
      sourceByteLength: file.size,
      isEncrypted: true,
    };
  } catch (cause) {
    contents.fill(0);
    throw cause;
  }
}

export async function readRootSourceFileBytes(
  root: ReadonlySourceDirectoryHandle,
  relativePath: string,
  maxReadBytes?: number,
): Promise<RootSourceFileBytes> {
  const file = await root.getFile(relativePath);

  if (maxReadBytes !== undefined && file.size > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `${relativePath} is larger than the read limit.`,
    );
  }

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
  maxReadBytes?: number,
): Promise<RootSourceFileBytes | undefined> {
  try {
    return await readRootSourceFileBytes(root, relativePath, maxReadBytes);
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

async function sha256File(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const sourceBytes = new Uint8Array(await file.arrayBuffer());

  try {
    signal?.throwIfAborted();
    const sha256 = await sha256Hex(sourceBytes);
    signal?.throwIfAborted();
    return sha256;
  } finally {
    sourceBytes.fill(0);
  }
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
      ...optionalArchivedDataField(
        "encryptionKey",
        parsed.value,
        root,
        "EncryptionKey",
      ),
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

function optionalArchivedDataField<TKey extends string>(
  outputKey: TKey,
  archive: PlistValue,
  dict: PlistDictionary,
  sourceKey: string,
): Partial<Record<TKey, Uint8Array>> {
  const direct = getPlistData(dict, sourceKey);

  if (direct !== undefined) {
    return { [outputKey]: direct } as Record<TKey, Uint8Array>;
  }

  if (!isPlistDictionary(archive) || !Array.isArray(archive.$objects)) {
    return {};
  }

  const reference = dict[sourceKey];
  const referenced =
    typeof reference === "number" && Number.isInteger(reference)
      ? archive.$objects[reference]
      : undefined;
  const resolved =
    referenced instanceof Uint8Array
      ? referenced
      : referenced !== undefined && isPlistDictionary(referenced)
        ? getPlistData(referenced, "NS.data") ??
          getPlistData(referenced, "NS.bytes")
        : undefined;

  return resolved === undefined
    ? {}
    : ({ [outputKey]: resolved } as Record<TKey, Uint8Array>);
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
