import {
  getPlistData,
  isPlistDictionary,
  parsePlist,
  type PlistDictionary,
  type PlistValue,
} from "./plist";
import { bytesStartWith } from "../shared/binary";
import { getAvailableOpfsQuotaBytes, hasOpfsStorage } from "../shared/opfs";
import { defaultMaxReadBytes } from "../shared/media-limits";
import {
  IncrementalSha256,
  sha256BlobHex,
  updateSha256WithZeros,
} from "../shared/incremental-sha256";
import type { ReadonlySourceDirectoryHandle } from "./read-only-source";
import {
  ensureTransientSweep,
  openTransientStagingArea,
  type TransientStagedFile,
} from "./transient-staging";
import {
  openSourceSqliteDatabase,
  sqliteRows,
  type SourceSqliteBlobInput,
  type SourceSqliteDatabase,
  type SourceSqliteStagingInput,
} from "./source-sqlite";

const textEncoder = new TextEncoder();
const sqliteHeader = new TextEncoder().encode("SQLite format 3\0");

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
   * encrypted path it folds into the decrypt read pass (plus a bounded read
   * of any stored tail the decrypt pass never touches), but still costs extra
   * work, so it is computed only when the caller opts in via
   * `includeSourceSha256` (unencrypted reads always carry it because it is
   * derived from bytes already in memory).
   */
  sourceSha256?: string;
  sourceByteLength: number;
  isEncrypted: boolean;
}

export interface SourceFileInfo {
  record: ManifestFileRecord;
  /** SHA-256 of plaintext content. */
  sha256: string;
  sourceSha256?: string;
  byteLength: number;
  sourceByteLength: number;
  isEncrypted: boolean;
}

export interface SourceFileBlob extends SourceFileInfo {
  /** Plaintext content backed by the source file or an OPFS file snapshot. */
  blob: Blob;
  /** Releases any transient plaintext backing this Blob. Idempotent. */
  cleanup(): Promise<void>;
}

export interface SourceFileChunkSink {
  write(bytes: Uint8Array): Promise<void>;
}

export interface RootSourceFileBytes {
  relativePath: string;
  bytes: Uint8Array;
  sha256: string;
}

interface RootSourceFileBlob {
  relativePath: string;
  blob: File;
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
   * hash. Free on unencrypted reads; on encrypted reads it adds hashing work
   * folded into the decrypt pass, so only provenance/report consumers should
   * set it. Encryption-internal chunk controls live on the encrypted
   * session's own read options, not here.
   */
  includeSourceSha256?: boolean;
}

export interface ManifestDbOpenOptions {
  /** Safe per-backup OPFS directory key for transient staging. */
  backupId?: string;
  /** Streams decrypted root Manifest.db chunks into transient OPFS. */
  decryptMainChunks?: (encryptedFile: File) => AsyncIterable<Uint8Array>;
}

/**
 * Module-level unit-test overrides for the OPFS-backed source machinery,
 * mirroring source-sqlite's `loadSqlite` parameter and transient-staging's
 * `getBackupDirectory` seam: Node/Vitest runs (no OPFS) register in-memory
 * replacements here instead of threading seam options through production
 * signatures. Production never registers overrides. Tests must restore via
 * `resetBackupSourceOverridesForTests` in afterEach/finally.
 */
export interface BackupSourceTestOverrides {
  /** Replaces the OPFS streaming source SQLite factory for every database open. */
  openSourceSqlite?: (
    input: SourceSqliteBlobInput | SourceSqliteStagingInput,
  ) => Promise<SourceSqliteDatabase>;
  /** Replaces transient OPFS staging for the decrypted root Manifest.db. */
  stageDecryptedMain?: (chunks: AsyncIterable<Uint8Array>) => Promise<Blob>;
  /** Replaces transient OPFS staging for decrypted source-file plaintext. */
  stagePlaintext?: (
    chunks: AsyncIterable<Uint8Array>,
    plaintextSize: number,
  ) => Promise<Blob>;
  /** Replaces (and observes) the required pre-quota crash sweep. */
  sweepTransient?: () => Promise<void>;
}

let backupSourceOverridesForTests: BackupSourceTestOverrides = {};

/** Registers the unit-test overrides above, replacing any previous set. */
export function setBackupSourceOverridesForTests(
  overrides: BackupSourceTestOverrides,
): void {
  backupSourceOverridesForTests = overrides;
}

/** Restores production behavior; call from afterEach/finally in tests. */
export function resetBackupSourceOverridesForTests(): void {
  backupSourceOverridesForTests = {};
}

/**
 * Read seam for sibling modules (ios-ingest) that open source SQLite
 * databases themselves. Production callers fall back to the OPFS streaming
 * factory when no test override is registered.
 */
export function getBackupSourceOverridesForTests(): Readonly<BackupSourceTestOverrides> {
  return backupSourceOverridesForTests;
}

export interface ReadEncryptedSourceFileBytesOptions {
  plaintextSize: number;
  maxReadBytes?: number;
  /** Compute the ciphertext SHA-256, folded into the decrypt read pass. */
  includeSourceSha256?: boolean;
  signal?: AbortSignal;
  /**
   * Streams decrypted plaintext chunks for the stored file. When the caller
   * forwards `onCiphertextChunk` to the session decryptor
   * (`CbcChunkDecryptOptions.onCiphertextChunk`), stored-source hashing folds
   * into the decrypt read pass; decryptors that ignore it stay correct — the
   * stored file is then hashed in its own pass.
   */
  decryptChunks(
    source: Blob,
    onCiphertextChunk?: (chunk: Uint8Array) => void,
  ): AsyncIterable<Uint8Array>;
}

export interface ReadEncryptedSourceFileBlobOptions
  extends ReadEncryptedSourceFileBytesOptions {
  backupId: string;
}

export const maxStagedSourceFileBytes = 4 * 1024 * 1024 * 1024 * 1024;

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
    const backupId = options.backupId ?? "manifest-transient";
    const manifestFile = await readRootSourceFileBlob(root, "Manifest.db");
    // Encrypted backups do not expose usable root Manifest.db sidecars unless
    // each sidecar has independently supported key metadata. Apple backups do
    // not provide that at the root, so never mix encrypted/unknown sidecar
    // bytes into the decrypted database.
    let manifestWalFile: RootSourceFileBlob | undefined;
    let manifestShmFile: RootSourceFileBlob | undefined;
    let decryptedArea: Awaited<ReturnType<typeof openTransientStagingArea>> | undefined;

    try {
      // A previous worker crash may have left a large transient tree. Sweep it
      // before measuring quota so stale plaintext cannot make the next open
      // reject while also preventing the sweep that would recover it.
      if (hasOpfsStorage()) {
        const { sweepTransient } = backupSourceOverridesForTests;
        if (sweepTransient !== undefined) {
          await sweepTransient();
        } else {
          await ensureTransientSweep(backupId);
        }
      }

      if (options.decryptMainChunks === undefined) {
        manifestWalFile = await readOptionalRootSourceFileBlob(
          root,
          "Manifest.db-wal",
        );
        manifestShmFile = await readOptionalRootSourceFileBlob(
          root,
          "Manifest.db-shm",
        );
      }

      await assertManifestStagingQuota(
        (manifestFile.blob.size +
          (manifestWalFile?.blob.size ?? 0) +
          (manifestShmFile?.blob.size ?? 0)) * 3,
      );

      let openedMainBlob: Blob = manifestFile.blob;
      let mainContentSha256: string | undefined;

      // The decrypted Manifest deliberately keeps this stage -> copy -> import
      // path instead of the SourceSqliteStagingInput direct-stream used for
      // source databases: normalizeStagedManifestDatabase must read and resize
      // the staged file (PKCS#7 pad truncation) before the sqlite open, which
      // the write-only stage-destination interface cannot express.
      if (options.decryptMainChunks !== undefined) {
        const decryptedChunks = options.decryptMainChunks(manifestFile.blob);
        const { stageDecryptedMain } = backupSourceOverridesForTests;

        if (stageDecryptedMain !== undefined) {
          openedMainBlob = await stageDecryptedMain(decryptedChunks);
          mainContentSha256 = await sha256BlobHex(openedMainBlob);
        } else {
          decryptedArea = await openTransientStagingArea(backupId);
          const staged = await decryptedArea.createFile();
          const stagedManifest = await stageDecryptedManifestDatabase(
            staged,
            decryptedChunks,
          );
          if (stagedManifest.normalizedByteLength !== staged.byteLength) {
            staged.resize(stagedManifest.normalizedByteLength);
          }
          openedMainBlob = await staged.getFile();
          mainContentSha256 = stagedManifest.contentSha256;
        }
      }

      const sourceFiles = [manifestFile, manifestWalFile, manifestShmFile]
        .filter((file): file is RootSourceFileBlob => file !== undefined)
        .map((file) => ({
          relativePath: file.relativePath,
          sha256: file.sha256,
          byteLength: file.blob.size,
          ...(file.relativePath === "Manifest.db" && mainContentSha256 !== undefined
            ? {
                contentSha256: mainContentSha256,
                contentByteLength: openedMainBlob.size,
                isEncrypted: true,
              }
            : {}),
        }));
      const source = await (backupSourceOverridesForTests.openSourceSqlite ??
        openSourceSqliteDatabase)({
        backupId,
        label: "manifest",
        main: openedMainBlob,
        ...(manifestWalFile === undefined ? {} : { wal: manifestWalFile.blob }),
        ...(manifestShmFile === undefined ? {} : { shm: manifestShmFile.blob }),
      });

      // The reader retains byte-free provenance only; sqlite-wasm owns the
      // one transient reconstructed copy until close().
      return new ManifestDbReader(source, sourceFiles);
    } finally {
      await decryptedArea?.close();
    }
  }

  close(): void {
    this.source.close();
  }

  cleanup(): Promise<void> {
    return this.source.cleanup();
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
  const maxReadBytes = Math.min(
    options.maxReadBytes ?? defaultMaxReadBytes,
    defaultMaxReadBytes,
  );
  const expectedSize = record.metadata.size;
  const validExpectedSize =
    expectedSize !== undefined &&
    Number.isSafeInteger(expectedSize) &&
    expectedSize >= 0
      ? expectedSize
      : undefined;

  if (file.size > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const contents =
    validExpectedSize === undefined || validExpectedSize >= sourceBytes.byteLength
      ? sourceBytes
      : sourceBytes.subarray(0, validExpectedSize);

  if (contents.byteLength > maxReadBytes) {
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

export async function readSourceFileBlob(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  options: ReadSourceFileBytesOptions = {},
): Promise<SourceFileBlob> {
  const file = await getStoredSourceFile(root, record);
  const blob = sourcePlaintextBlob(file, record, options.maxReadBytes);
  const sha256 = await sha256BlobHex(blob);
  const sourceSha256 =
    blob.size === file.size ? sha256 : await sha256BlobHex(file);

  return {
    record,
    blob,
    sha256,
    sourceSha256,
    byteLength: blob.size,
    sourceByteLength: file.size,
    isEncrypted: false,
    cleanup: () => Promise.resolve(),
  };
}

/**
 * Receives the streamed plaintext of one encrypted source file. `write` gets
 * borrowed chunks that are zeroized after the call settles, so destinations
 * must copy or persist the bytes before returning. Destinations with a cheap
 * zero representation (staged OPFS files, preallocated zero-initialized
 * buffers) implement `extendZeros`; destinations without one omit it and
 * receive any sparse zero extension as ordinary `write` chunks.
 */
export interface DecryptedPlaintextDestination {
  write(chunk: Uint8Array): void | Promise<void>;
  extendZeros?(byteLength: number): void | Promise<void>;
}

export interface EncryptedSourceFileDigests {
  /** SHA-256 of the logical plaintext (materialized prefix + zero fill). */
  sha256: string;
  /** SHA-256 of the complete stored ciphertext, when requested. */
  sourceSha256?: string;
  /** Logical plaintext length (`MBFile.Size`). */
  byteLength: number;
  /** Stored ciphertext length. */
  sourceByteLength: number;
}

/**
 * Core encrypted-source decrypt streamer shared by the Blob/staging, direct
 * sink, and bounded in-memory read paths (and by report/database staging
 * consumers). Owns hostile-shape validation, the single decrypt loop with its
 * overflow/short-stream checks, sparse zero extension to the declared logical
 * size, plaintext hashing, and the opt-in stored-source hash folded into the
 * decrypt read pass.
 */
export async function decryptSourceFileToDestination(
  record: ManifestFileRecord,
  file: Blob,
  destination: DecryptedPlaintextDestination,
  options: ReadEncryptedSourceFileBytesOptions,
): Promise<EncryptedSourceFileDigests> {
  options.signal?.throwIfAborted();
  const { plaintextSize } = options;
  assertEncryptedSourceFileShape(record, file, plaintextSize, options.maxReadBytes);

  const hasher = new IncrementalSha256();
  const sourceHasher =
    options.includeSourceSha256 === true ? new IncrementalSha256() : undefined;
  let hashedSourceBytes = 0;
  // The decryptor slices stored ciphertext sequentially from byte 0, so the
  // tee always covers a contiguous stored prefix; whatever it did not read is
  // hashed after the loop without re-reading bytes the decrypt pass saw.
  const onCiphertextChunk =
    sourceHasher === undefined
      ? undefined
      : (chunk: Uint8Array): void => {
          sourceHasher.update(chunk);
          hashedSourceBytes += chunk.byteLength;
        };
  const materializedPlaintextBytes = Math.min(plaintextSize, file.size);
  let offset = 0;

  for await (const chunk of options.decryptChunks(file, onCiphertextChunk)) {
    try {
      options.signal?.throwIfAborted();
      if (offset + chunk.byteLength > materializedPlaintextBytes) {
        throw new SourceFileDecryptionError(
          `Decrypted file ${record.domain}/${record.relativePath} exceeded its materialized plaintext size.`,
        );
      }
      await destination.write(chunk);
      hasher.update(chunk);
      offset += chunk.byteLength;
      options.signal?.throwIfAborted();
    } finally {
      // Defense in depth for the borrowed plaintext chunk: the production
      // decryptor zeroizes its own buffers, and the destination has already
      // copied/persisted the bytes, so clearing here is always safe.
      chunk.fill(0);
    }
  }

  if (offset !== materializedPlaintextBytes) {
    throw new SourceFileDecryptionError(
      `Decrypted file ${record.domain}/${record.relativePath} did not match its materialized source size.`,
    );
  }

  const zeroExtensionBytes = plaintextSize - offset;
  if (zeroExtensionBytes > 0) {
    if (destination.extendZeros === undefined) {
      await updateSha256WithZeros(
        hasher,
        zeroExtensionBytes,
        undefined,
        async (chunk) => {
          options.signal?.throwIfAborted();
          await destination.write(chunk);
        },
      );
    } else {
      await destination.extendZeros(zeroExtensionBytes);
      updateSha256WithZeros(hasher, zeroExtensionBytes);
    }
  }
  options.signal?.throwIfAborted();

  let sourceSha256: string | undefined;
  if (sourceHasher !== undefined) {
    if (hashedSourceBytes === 0) {
      // The decryptor did not forward the ciphertext tee (or read nothing);
      // hash the stored file in its own single pass.
      sourceSha256 = await sha256BlobHex(file, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } else {
      if (hashedSourceBytes < file.size) {
        // Decrypt work is bounded by the materialized plaintext, so a stored
        // block-aligned tail beyond MBFile.Size is never decrypted. Fold the
        // unread stored tail into the same hasher (the helper's own digest of
        // the tail slice is discarded) so sourceSha256 always covers the
        // complete stored file.
        await sha256BlobHex(file.slice(hashedSourceBytes), {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onChunk: (chunk) => {
            sourceHasher.update(chunk);
          },
        });
      }
      sourceSha256 = sourceHasher.digestHex();
    }
  }

  return {
    sha256: hasher.digestHex(),
    ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
    byteLength: plaintextSize,
    sourceByteLength: file.size,
  };
}

export async function readEncryptedSourceFileBlob(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  options: ReadEncryptedSourceFileBlobOptions,
): Promise<SourceFileBlob> {
  options.signal?.throwIfAborted();
  const file = await getStoredSourceFile(root, record);
  const { plaintextSize } = options;
  assertEncryptedSourceFileShape(record, file, plaintextSize, options.maxReadBytes);

  const { stagePlaintext } = backupSourceOverridesForTests;
  if (stagePlaintext !== undefined) {
    // Unit-test override for runtimes without OPFS. It consumes the chunk
    // iterable itself, so the stored-source hash cannot fold into the decrypt
    // pass here and keeps its own read.
    const sourceSha256 =
      options.includeSourceSha256 === true
        ? await sha256BlobHex(file, {
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          })
        : undefined;
    const blob = await stagePlaintext(
      options.decryptChunks(file),
      plaintextSize,
    );
    if (blob.size !== plaintextSize) {
      throw new SourceFileDecryptionError(
        `Decrypted file ${record.domain}/${record.relativePath} did not match its declared plaintext size.`,
      );
    }
    return {
      record,
      blob,
      sha256: await sha256BlobHex(blob, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
      ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
      byteLength: plaintextSize,
      sourceByteLength: file.size,
      isEncrypted: true,
      cleanup: () => Promise.resolve(),
    };
  }

  const area = await openTransientStagingArea(options.backupId);
  let retained = false;
  try {
    const staged = await area.createFile();
    let position = 0;
    const digests = await decryptSourceFileToDestination(
      record,
      file,
      {
        write(chunk) {
          staged.write(chunk, position);
          position += chunk.byteLength;
        },
        extendZeros(byteLength) {
          // OPFS truncate extends the staged file with (possibly sparse)
          // zeros without writing them.
          staged.resize(position + byteLength);
          position += byteLength;
        },
      },
      options,
    );
    staged.flush();
    options.signal?.throwIfAborted();
    const blob = await staged.getFile();
    options.signal?.throwIfAborted();

    const result: SourceFileBlob = {
      record,
      blob,
      sha256: digests.sha256,
      ...(digests.sourceSha256 === undefined
        ? {}
        : { sourceSha256: digests.sourceSha256 }),
      byteLength: plaintextSize,
      sourceByteLength: file.size,
      isEncrypted: true,
      cleanup: () => area.close(),
    };
    retained = true;
    return result;
  } finally {
    if (!retained) {
      await area.close();
    }
  }
}

export async function writeSourceFileToSink(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  sink: SourceFileChunkSink,
  options: ReadSourceFileBytesOptions = {},
): Promise<SourceFileInfo> {
  const file = await getStoredSourceFile(root, record);
  const blob = sourcePlaintextBlob(file, record, options.maxReadBytes);
  // One streaming pass hashes while it tees each chunk to the sink; when the
  // written slice covers the whole stored file the same digest doubles as the
  // stored-source hash.
  const sha256 = await sha256BlobHex(blob, {
    onChunk: (chunk) => sink.write(chunk),
  });
  const sourceSha256 =
    blob.size === file.size ? sha256 : await sha256BlobHex(file);

  return {
    record,
    sha256,
    sourceSha256,
    byteLength: blob.size,
    sourceByteLength: file.size,
    isEncrypted: false,
  };
}

export async function writeEncryptedSourceFileToSink(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  sink: SourceFileChunkSink,
  options: ReadEncryptedSourceFileBytesOptions,
): Promise<SourceFileInfo> {
  options.signal?.throwIfAborted();
  const file = await getStoredSourceFile(root, record);
  // No extendZeros: a streaming sink has no cheap zero representation, so the
  // core streams any sparse zero extension through write().
  const digests = await decryptSourceFileToDestination(
    record,
    file,
    { write: (chunk) => sink.write(chunk) },
    options,
  );

  return {
    record,
    sha256: digests.sha256,
    ...(digests.sourceSha256 === undefined
      ? {}
      : { sourceSha256: digests.sourceSha256 }),
    byteLength: options.plaintextSize,
    sourceByteLength: file.size,
    isEncrypted: true,
  };
}

/**
 * Reads a small encrypted MBFile through the session's chunk decryptor into
 * the bounded compatibility buffer used by eager attachment hashing. Database,
 * preview, and extraction paths use the Blob/staging or direct-sink siblings.
 */
export async function readEncryptedSourceFileBytes(
  root: ReadonlySourceDirectoryHandle,
  record: ManifestFileRecord,
  options: ReadEncryptedSourceFileBytesOptions,
): Promise<SourceFileBytes> {
  options.signal?.throwIfAborted();
  const file = await getStoredSourceFile(root, record);
  options.signal?.throwIfAborted();
  const maxReadBytes = Math.min(
    options.maxReadBytes ?? defaultMaxReadBytes,
    defaultMaxReadBytes,
  );
  const { plaintextSize } = options;
  // Validate hostile metadata before the plaintext allocation below; the
  // core repeats this check but must never see an unvalidated allocation.
  assertEncryptedSourceFileShape(record, file, plaintextSize, maxReadBytes);

  // MBFile.Size is the authoritative logical plaintext length. Real backup
  // producers can leave a longer block-aligned stored tail or a shorter
  // materialized prefix for a sparse file. The destination is zero-initialized
  // below, so a short prefix is safely extended without reading invented bytes.
  const contents = new Uint8Array(new ArrayBuffer(plaintextSize));
  let position = 0;

  try {
    const digests = await decryptSourceFileToDestination(
      record,
      file,
      {
        write(chunk) {
          contents.set(chunk, position);
          position += chunk.byteLength;
        },
        extendZeros(byteLength) {
          // The destination buffer is zero-initialized; advancing suffices.
          position += byteLength;
        },
      },
      { ...options, maxReadBytes },
    );

    return {
      record,
      bytes: contents,
      sha256: digests.sha256,
      ...(digests.sourceSha256 === undefined
        ? {}
        : { sourceSha256: digests.sourceSha256 }),
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

async function readRootSourceFileBlob(
  root: ReadonlySourceDirectoryHandle,
  relativePath: string,
  options: { allowEmpty?: boolean } = {},
): Promise<RootSourceFileBlob> {
  const file = await root.getFile(relativePath);

  if (
    file.size > maxStagedSourceFileBytes ||
    (file.size <= 0 && options.allowEmpty !== true)
  ) {
    throw new SourceFileTooLargeError(
      `${relativePath} is outside the staged source-file sanity limit.`,
    );
  }

  return {
    relativePath,
    blob: file,
    sha256: await sha256BlobHex(file),
  };
}

async function readOptionalRootSourceFileBlob(
  root: ReadonlySourceDirectoryHandle,
  relativePath: string,
): Promise<RootSourceFileBlob | undefined> {
  try {
    // A present zero-byte sidecar is normal after `wal_checkpoint(TRUNCATE)`
    // and must behave exactly like an absent/empty one downstream.
    return await readRootSourceFileBlob(root, relativePath, { allowEmpty: true });
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return undefined;
    }
    throw cause;
  }
}

/**
 * Byte-level random-access view of a staged Manifest payload. `read` must
 * return caller-owned bytes: the normalizer zeroizes inspected copies after
 * use. `TransientStagedFile` satisfies this shape.
 */
export interface StagedManifestByteSource {
  readonly byteLength: number;
  read(offset: number, length: number): Uint8Array;
}

/**
 * Pure byte-level Manifest normalization core: SQLite header validation,
 * page-size decode (including the 1 => 65536 rule and bounds/power-of-two
 * checks), the trailing-pad truncation decision, and pad-byte verification.
 * Returns the normalized (pad-truncated) byte length. Shared with test
 * support so in-memory staging never validates less than production.
 */
export function normalizeStagedManifestDatabase(
  staged: StagedManifestByteSource,
): number {
  if (staged.byteLength < 100) {
    throw new ManifestDbError(
      "Decrypted Manifest database does not have a valid SQLite header.",
    );
  }

  const header = staged.read(0, 100);
  if (!bytesStartWith(header, sqliteHeader)) {
    header.fill(0);
    throw new ManifestDbError(
      "Decrypted Manifest database does not have a valid SQLite header.",
    );
  }

  const encodedPageSize = (header[16] << 8) | header[17];
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  header.fill(0);
  if (
    pageSize < 512 ||
    pageSize > 65_536 ||
    (pageSize & (pageSize - 1)) !== 0
  ) {
    throw new ManifestDbError(
      "Decrypted Manifest database has an invalid SQLite page size.",
    );
  }

  const trailingBytes = staged.byteLength % pageSize;
  if (trailingBytes === 0) {
    return staged.byteLength;
  }
  if (trailingBytes > 16) {
    throw new ManifestDbError(
      "Decrypted Manifest database has invalid trailing bytes.",
    );
  }

  const trailing = staged.read(staged.byteLength - trailingBytes, trailingBytes);
  const validPadding = trailing.every((byte) => byte === trailingBytes);
  trailing.fill(0);
  if (!validPadding) {
    throw new ManifestDbError(
      "Decrypted Manifest database has invalid trailing bytes.",
    );
  }

  return staged.byteLength - trailingBytes;
}

export interface StagedManifestDatabase {
  /** Byte length after the trailing-pad truncation decision. */
  normalizedByteLength: number;
  /** SHA-256 of exactly the normalized (pad-truncated) staged content. */
  contentSha256: string;
}

const manifestPadHoldBackBytes = 16;

/**
 * Streams decrypted Manifest.db chunks into `staged` while hashing them,
 * then applies the SQLite page-size normalization. The final 16 bytes are
 * held back from the running hasher until the trailing-pad truncation
 * decision, so `contentSha256` covers exactly the normalized content without
 * re-reading the staged file. The caller still owns the `resize` to the
 * returned normalized length.
 */
export async function stageDecryptedManifestDatabase(
  staged: Pick<TransientStagedFile, "byteLength" | "read" | "write">,
  chunks: AsyncIterable<Uint8Array>,
): Promise<StagedManifestDatabase> {
  const hasher = new IncrementalSha256();
  const heldBack = new Uint8Array(manifestPadHoldBackBytes);
  let heldBackLength = 0;
  let offset = 0;

  try {
    for await (const chunk of chunks) {
      staged.write(chunk, offset);
      offset += chunk.byteLength;

      // Release everything but the newest 16 bytes into the running hasher,
      // oldest bytes first (held-back remainder, then this chunk's prefix).
      const releaseLength = Math.max(
        0,
        heldBackLength + chunk.byteLength - manifestPadHoldBackBytes,
      );
      const releaseFromHeldBack = Math.min(heldBackLength, releaseLength);
      if (releaseFromHeldBack > 0) {
        hasher.update(heldBack.subarray(0, releaseFromHeldBack));
        heldBack.copyWithin(0, releaseFromHeldBack, heldBackLength);
        heldBackLength -= releaseFromHeldBack;
      }
      const releaseFromChunk = releaseLength - releaseFromHeldBack;
      if (releaseFromChunk > 0) {
        hasher.update(chunk.subarray(0, releaseFromChunk));
      }
      heldBack.set(chunk.subarray(releaseFromChunk), heldBackLength);
      heldBackLength += chunk.byteLength - releaseFromChunk;
    }

    // normalizeStagedManifestDatabase guarantees byteLength >= 100, so the
    // hold-back is full and the truncation (0..16 bytes) lands inside it.
    const normalizedByteLength = normalizeStagedManifestDatabase(staged);
    const truncatedBytes = staged.byteLength - normalizedByteLength;
    hasher.update(heldBack.subarray(0, heldBackLength - truncatedBytes));

    return { normalizedByteLength, contentSha256: hasher.digestHex() };
  } finally {
    heldBack.fill(0);
  }
}

async function assertManifestStagingQuota(requiredBytes: number): Promise<void> {
  const available = await getAvailableOpfsQuotaBytes();
  if (available === undefined) {
    return;
  }

  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > available) {
    throw new SourceFileTooLargeError(
      "There is not enough local OPFS quota to stage Manifest.db.",
    );
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

function sourcePlaintextBlob(
  file: File,
  record: ManifestFileRecord,
  maxReadBytes?: number,
): Blob {
  const expectedSize = record.metadata.size;
  const validExpectedSize =
    expectedSize !== undefined &&
    Number.isSafeInteger(expectedSize) &&
    expectedSize >= 0
      ? expectedSize
      : undefined;

  if (
    file.size > maxStagedSourceFileBytes ||
    (maxReadBytes !== undefined && file.size > maxReadBytes)
  ) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  const byteLength =
    validExpectedSize === undefined
      ? file.size
      : Math.min(file.size, validExpectedSize);

  if (maxReadBytes !== undefined && byteLength > maxReadBytes) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
  }

  return byteLength === file.size ? file : file.slice(0, byteLength);
}

function assertEncryptedSourceFileShape(
  record: ManifestFileRecord,
  file: Blob,
  plaintextSize: number,
  maxReadBytes?: number,
): void {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new SourceFileDecryptionError(
      `Source file ${record.domain}/${record.relativePath} has an invalid declared plaintext size.`,
    );
  }
  if (file.size % 16 !== 0) {
    throw new SourceFileDecryptionError(
      `Encrypted file ${record.domain}/${record.relativePath} is inconsistent with its declared plaintext size.`,
    );
  }
  // The caller cap binds the authoritative logical plaintext size. Stored
  // ciphertext may legitimately carry one block-aligned PKCS#7 tail beyond a
  // cap-sized plaintext, so tolerate up to one extra AES block of stored
  // bytes; the absolute staged sanity bound still applies to both sizes, and
  // decrypt/hash work stays bounded by the materialized plaintext.
  if (
    plaintextSize > maxStagedSourceFileBytes ||
    file.size > maxStagedSourceFileBytes ||
    (maxReadBytes !== undefined &&
      (plaintextSize > maxReadBytes || file.size > maxReadBytes + 16))
  ) {
    throw new SourceFileTooLargeError(
      `Source file ${record.domain}/${record.relativePath} is larger than the read limit.`,
    );
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
