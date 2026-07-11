import { bytesStartWith } from "../shared/binary";
import { getSqlite, type Sqlite3Api } from "../shared/sqlite-init";
import type { WorkerStructuredValue } from "../../lib/worker-types";
import { assertPositiveSafeInteger } from "../shared/guards";
import { stableHash } from "../shared/hash";
import { hasOpfsStorage, removeOpfsEntryIfFound } from "../shared/opfs";
// Type-only import: manifest-db imports this module at runtime, so a value
// import here would create a module cycle. The type is erased at build time.
import type { DecryptedPlaintextDestination } from "./manifest-db";
import {
  createTransientWorkspaceDirectory,
  type TransientStagingDirectoryHandle,
  type TransientStagingFileHandle,
} from "./transient-staging";

export type SqliteDatabase = InstanceType<Sqlite3Api["oo1"]["DB"]>;
type SqliteBindValue = string | number | bigint | boolean | null | Uint8Array;

const sqliteFormat3Magic = new TextEncoder().encode("SQLite format 3\0");
const sourceSqliteImportChunkBytes = 4 * 1024 * 1024;
const sourceSqliteSahPoolMinimumCapacity = 16;
const sourceSqliteSahPoolDirectoryName = "sahpool";
const sourceSqliteSahPoolVfsPrefix = "golemine-source";
const sourceSqliteStagedMainFileName = "staged.sqlite";
const walHeaderByteLength = 32;
const walFrameHeaderByteLength = 24;
/**
 * Budget for one transaction's buffered (not yet committed) page bytes during
 * the fast single-pass WAL replay. Real transactions stay far below this; a
 * hostile or degenerate WAL whose single transaction would exceed it abandons
 * buffering and falls back to the bounded-memory two-phase replay instead of
 * growing worker memory with the WAL size.
 */
const walPendingTransactionBudgetBytes = 64 * 1024 * 1024;
/**
 * Pure-hostility cap on a WAL commit record's declared database size. Mirrors
 * manifest-db's `maxStagedSourceFileBytes` (4 TiB absolute staged sanity
 * bound); kept as a local constant because manifest-db imports this module at
 * runtime and a value import back would create a module cycle (see the
 * type-only import note above).
 */
const maxCommittedWalDatabaseBytes = 4 * 1024 * 1024 * 1024 * 1024;

let databaseCounter = 0;

type SahPool = Awaited<ReturnType<Sqlite3Api["installOpfsSAHPoolVfs"]>>;
type InstallOpfsSahPoolVfsOptions = Parameters<
  Sqlite3Api["installOpfsSAHPoolVfs"]
>[0] & {
  forceReinitIfPreviouslyFailed?: boolean;
};

/**
 * Narrow random-access seam over the staged main database. Its shape matches
 * a FileSystemSyncAccessHandle without coupling the WAL parser to OPFS
 * globals, so the one staged pipeline also runs over in-memory bytes.
 */
export interface SourceSqliteRandomAccessFile {
  getSize(): number;
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  flush(): void;
}

/**
 * Owned in-memory implementation of {@link SourceSqliteRandomAccessFile}.
 * Backs the `Uint8Array` open path so byte inputs run through the exact
 * staged WAL pipeline used for OPFS staging (one D-021/D-022 implementation).
 * The constructor copies `bytes`; `bytes()` exposes the live backing store so
 * owners can zeroize plaintext after use, and resizes zeroize the buffer they
 * replace.
 */
export class MemoryRandomAccessFile implements SourceSqliteRandomAccessFile {
  #data: Uint8Array;

  constructor(bytes: Uint8Array = new Uint8Array()) {
    this.#data = new Uint8Array(bytes);
  }

  getSize(): number {
    return this.#data.byteLength;
  }

  read(buffer: ArrayBufferView, options?: { at?: number }): number {
    const target = viewAsBytes(buffer);
    const offset = assertMemoryFileOffset(options?.at ?? 0);
    const readable = Math.max(
      0,
      Math.min(target.byteLength, this.#data.byteLength - offset),
    );

    target.set(this.#data.subarray(offset, offset + readable));

    return readable;
  }

  write(buffer: ArrayBufferView, options?: { at?: number }): number {
    const source = viewAsBytes(buffer);
    const offset = assertMemoryFileOffset(options?.at ?? 0);
    const requiredSize = offset + source.byteLength;

    if (!Number.isSafeInteger(requiredSize)) {
      throw new RangeError("In-memory source SQLite write range is invalid.");
    }

    if (requiredSize > this.#data.byteLength) {
      this.#resize(requiredSize);
    }

    this.#data.set(source, offset);

    return source.byteLength;
  }

  truncate(newSize: number): void {
    assertMemoryFileOffset(newSize);

    if (newSize !== this.#data.byteLength) {
      this.#resize(newSize);
    }
  }

  flush(): void {
    // In-memory storage has nothing to flush.
  }

  /** Live backing store (not a copy); owners zeroize it after use. */
  bytes(): Uint8Array {
    return this.#data;
  }

  #resize(byteLength: number): void {
    const previous = this.#data;
    const resized = new Uint8Array(byteLength);

    resized.set(previous.subarray(0, Math.min(previous.byteLength, byteLength)));
    previous.fill(0);
    this.#data = resized;
  }
}

export interface SourceSqliteBlobInput {
  label: string;
  backupId: string;
  main: Blob;
  wal?: Blob;
  shm?: Blob;
}

/**
 * Streaming main source: the caller writes the main database plaintext
 * directly into the workspace's staged OPFS file, eliminating the
 * intermediate transient copy that the read-only Blob input path needs
 * (encrypted sources decrypt-stream straight into the staged file).
 */
export interface SourceSqliteStagedMainSource {
  /** Exact logical byte length `stage` must produce (writes + zero fill). */
  declaredByteLength: number;
  /** Sequentially writes the main database plaintext into `destination`. */
  stage(destination: DecryptedPlaintextDestination): Promise<void>;
}

export interface SourceSqliteStagingInput {
  label: string;
  backupId: string;
  main: SourceSqliteStagedMainSource;
  wal?: Blob;
  shm?: Blob;
}

export interface SourceSqliteMemoryInput {
  label: string;
  main: Uint8Array;
  wal?: Uint8Array;
  shm?: Uint8Array;
  backupId?: never;
}

export type SourceSqliteOpenInput =
  | SourceSqliteBlobInput
  | SourceSqliteStagingInput
  | SourceSqliteMemoryInput;

type SourceSqliteStreamingInput =
  | SourceSqliteBlobInput
  | SourceSqliteStagingInput;

function isMemorySourceSqliteInput(
  input: SourceSqliteOpenInput,
): input is SourceSqliteMemoryInput {
  return input.main instanceof Uint8Array;
}

export interface SourceSqliteDatabase {
  db: SqliteDatabase;
  /** Transient in-worker VFS filename backing this database (test seam). */
  databaseName: string;
  close(): void;
  /** Waits until transient plaintext storage has been removed. */
  cleanup(): Promise<void>;
}

export class SourceSqliteOpenError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, WorkerStructuredValue>,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SourceSqliteOpenError";
  }
}

/**
 * Internal marker for a failure raised by the caller-provided
 * {@link SourceSqliteStagedMainSource.stage} callback (typically an
 * encrypted-session decrypt error carrying a structured worker error code).
 * The streaming opener rethrows the original cause unwrapped after workspace
 * cleanup so those codes survive; only genuine source-sqlite failures are
 * wrapped in {@link SourceSqliteOpenError}.
 */
class StagedMainSourceCallbackError extends Error {
  constructor(readonly stageCause: unknown) {
    super("The staged main source callback failed.", { cause: stageCause });
    this.name = "StagedMainSourceCallbackError";
  }
}

export async function openSourceSqliteDatabase(
  input: SourceSqliteOpenInput,
  loadSqlite: () => Promise<Sqlite3Api> = getSqlite,
): Promise<SourceSqliteDatabase> {
  if (!isMemorySourceSqliteInput(input)) {
    return openStreamingSourceSqliteDatabase(input, loadSqlite);
  }

  const sqlite3 = await loadSqlite();
  const databaseName = makeTransientDatabaseName(input.label);
  const details = sourceOpenDetails(input, databaseName);
  // Owned copy: byte inputs run through the same staged WAL pipeline as OPFS
  // staging (the single D-021/D-022 implementation), then sqlite-wasm copies
  // the reconstructed bytes into its transient in-worker VFS.
  const memoryFile = new MemoryRandomAccessFile(input.main);

  try {
    try {
      await prepareStagedSourceSqliteForReadOnlyOpen(
        memoryFile,
        input.wal === undefined ? undefined : blobFromOwnedBytesCopy(input.wal),
      );
    } catch (cause) {
      throw new SourceSqliteOpenError(
        sourceSqliteOpenErrorMessage(
          `Could not reconstruct source SQLite database "${input.label}" before opening it.`,
          cause,
        ),
        details,
        cause,
      );
    }

    try {
      sqlite3.capi.sqlite3_js_posix_create_file(databaseName, memoryFile.bytes());
    } catch (cause) {
      deleteTransientDatabaseFile(sqlite3, databaseName);
      throw new SourceSqliteOpenError(
        sourceSqliteOpenErrorMessage(
          `Could not copy source SQLite database "${input.label}" into the transient sqlite VFS.`,
          cause,
        ),
        details,
        cause,
      );
    }

    // Source bytes are copied into sqlite-wasm's transient in-worker VFS first.
    // WAL frames are applied to that copy above; the user's backup folder
    // remains read-only and SQLite opens a normal reconstructed database.
    let db: SqliteDatabase;

    try {
      db = new sqlite3.oo1.DB(databaseName, "r");
    } catch (cause) {
      deleteTransientDatabaseFile(sqlite3, databaseName);
      throw new SourceSqliteOpenError(
        sourceSqliteOpenErrorMessage(
          `Could not open source SQLite database "${input.label}" from the transient sqlite VFS.`,
          cause,
        ),
        details,
        cause,
      );
    }

    let closed = false;
    let closeError: unknown;
    const close = () => {
      if (closed) {
        if (closeError !== undefined) {
          throw asError(closeError);
        }

        return;
      }

      closed = true;

      try {
        db.close();
      } catch (cause) {
        closeError = cause;
        throw asError(cause);
      } finally {
        // sqlite3_js_posix_create_file writes a full copy of the source bytes
        // into the wasm VFS; closing the handle does not remove it. Unlink
        // even when close throws so decrypted transient files never linger.
        deleteTransientDatabaseFile(sqlite3, databaseName);
      }
    };

    return {
      db,
      databaseName,
      close,
      cleanup: () => {
        try {
          close();
          return Promise.resolve();
        } catch (cause) {
          return Promise.reject(asError(cause));
        }
      },
    };
  } finally {
    // The memory file owns a copy of the reconstructed plaintext; sqlite-wasm
    // has copied it into the transient VFS by the success path.
    memoryFile.bytes().fill(0);
  }
}

async function openStreamingSourceSqliteDatabase(
  input: SourceSqliteStreamingInput,
  loadSqlite: () => Promise<Sqlite3Api>,
): Promise<SourceSqliteDatabase> {
  if (!hasOpfsStorage()) {
    throw new SourceSqliteOpenError(
      `Could not stage source SQLite database "${input.label}" because OPFS is unavailable.`,
      sourceOpenDetails(input, null),
    );
  }

  const sqlite3 = await loadSqlite();
  const databaseName = "/source.sqlite";
  const details = sourceOpenDetails(input, databaseName);
  let workspace: SourceSqliteWorkspace;

  try {
    workspace = await createSourceSqliteWorkspace(input.backupId, input.label);
  } catch (cause) {
    throw new SourceSqliteOpenError(
      sourceSqliteOpenErrorMessage(
        `Could not create transient OPFS storage for source SQLite database "${input.label}".`,
        cause,
      ),
      details,
      cause,
    );
  }

  let mainAccess: FileSystemSyncAccessHandle | undefined;
  let pool: SahPool | undefined;
  let operation = "opening the staged main database";

  try {
    mainAccess = await workspace.mainFile.createSyncAccessHandle();

    if (input.main instanceof Blob) {
      operation = "copying the main database into staging";
      await copyBlobToRandomAccessFile(input.main, mainAccess);
    } else {
      operation = "staging the decrypted main database";
      await stageMainSourceToRandomAccessFile(input.main, mainAccess);
    }

    operation = "applying the staged WAL and journal header";
    await prepareStagedSourceSqliteForReadOnlyOpen(mainAccess, input.wal);
    mainAccess.flush();

    operation = "installing the transient SQLite pool";
    pool = await installSourceSqliteSahPool(sqlite3, workspace);
    operation = "importing the staged database into the SQLite pool";
    await importRandomAccessDatabase(pool, databaseName, mainAccess);

    // Once opfs-sahpool owns its chunked import, the first staged plaintext
    // copy is no longer needed. Close and remove it before SQLite is opened so
    // only one on-disk plaintext copy remains during queries.
    mainAccess.close();
    mainAccess = undefined;
    operation = "deleting the first staged database copy";
    await removeOpfsEntryIfFound(
      workspace.directory,
      sourceSqliteStagedMainFileName,
    );

    let db: SqliteDatabase;

    try {
      db = new sqlite3.oo1.DB({
        filename: databaseName,
        flags: "r",
        vfs: pool.vfsName,
      });
    } catch (cause) {
      pool.unlink(databaseName);
      await cleanupStreamingWorkspace(pool, workspace);
      pool = undefined;
      throw new SourceSqliteOpenError(
        sourceSqliteOpenErrorMessage(
          `Could not open source SQLite database "${input.label}" from its transient OPFS pool.`,
          cause,
        ),
        details,
        cause,
      );
    }

    const openedPool = pool;
    let closed = false;
    let closeError: unknown;
    let cleanupPromise: Promise<void> | undefined;
    const beginCleanup = (): Promise<void> => {
      if (cleanupPromise !== undefined) {
        return cleanupPromise;
      }

      closed = true;

      try {
        db.close();
      } catch (cause) {
        closeError = cause;
      }

      // unlink() synchronously truncates and disassociates the SAH slot, so
      // plaintext is gone before close() returns. removeVfs() releases the
      // pool handles synchronously before its first await; directory removal
      // then completes asynchronously and is observable through cleanup().
      try {
        openedPool.unlink(databaseName);
      } catch (cause) {
        closeError =
          closeError === undefined
            ? cause
            : new AggregateError(
                [closeError, cause],
                "Source SQLite close and unlink both failed.",
              );
      }
      cleanupPromise = cleanupStreamingWorkspace(openedPool, workspace).then(
        () => {
          if (closeError !== undefined) {
            throw asError(closeError);
          }
        },
        (cleanupCause: unknown) => {
          if (closeError !== undefined) {
            throw new AggregateError(
              [closeError, cleanupCause],
              "Source SQLite close and transient cleanup both failed.",
            );
          }

          throw asError(cleanupCause);
        },
      );

      return cleanupPromise;
    };

    return {
      db,
      databaseName,
      close: () => {
        if (closed) {
          if (closeError !== undefined) {
            throw asError(closeError);
          }

          return;
        }

        const pendingCleanup = beginCleanup();

        // Most existing callers only need synchronous SQLite close semantics.
        // Attach a handler so best-effort cleanup does not become an unhandled
        // rejection; lock/reset paths call cleanup() and observe the failure.
        void pendingCleanup.catch(() => undefined);

        if (closeError !== undefined) {
          throw asError(closeError);
        }
      },
      cleanup: beginCleanup,
    };
  } catch (cause) {
    try {
      mainAccess?.close();
    } catch {
      // Preserve the staging/import failure.
    }

    let cleanupCause: unknown;

    try {
      if (pool !== undefined) {
        pool.unlink(databaseName);
        await cleanupStreamingWorkspace(pool, workspace);
      } else {
        await workspace.remove();
      }
    } catch (failure) {
      cleanupCause = failure;
    }

    if (cause instanceof StagedMainSourceCallbackError) {
      // The failure originated inside the caller-provided stage() callback
      // (for example an encrypted-session decrypt error whose structured
      // code the ingest layer maps). Rethrow it unwrapped after best-effort
      // workspace cleanup; a cleanup failure must not mask the stage cause.
      throw asError(
        cause.stageCause,
        "The staged main source callback failed.",
      );
    }

    if (cause instanceof SourceSqliteOpenError && cleanupCause === undefined) {
      throw cause;
    }

    const reportedCause =
      cleanupCause === undefined
        ? cause
        : new AggregateError(
            [cause, cleanupCause],
            "Source SQLite streaming and cleanup both failed.",
          );

    throw new SourceSqliteOpenError(
      sourceSqliteOpenErrorMessage(
        `Could not stream source SQLite database "${input.label}" through transient OPFS while ${operation}.`,
        reportedCause,
      ),
      details,
      reportedCause,
    );
  }
}

interface SourceSqliteWorkspace {
  directory: TransientStagingDirectoryHandle;
  mainFile: TransientStagingFileHandle;
  opfsPoolDirectory: string;
  vfsName: string;
  remove(): Promise<void>;
}

async function createSourceSqliteWorkspace(
  backupId: string,
  label: string,
): Promise<SourceSqliteWorkspace> {
  databaseCounter += 1;
  const databaseId = databaseCounter;
  // The workspace-directory factory owns the transient/ layout: it validates
  // the backup id, participates in the once-per-worker crash-leftover sweep,
  // and provides the recursive NotFound-tolerant remove().
  const workspace = await createTransientWorkspaceDirectory(
    backupId,
    `source-sqlite-${label}`,
  );

  try {
    const mainFile = await workspace.directory.getFileHandle(
      sourceSqliteStagedMainFileName,
      { create: true },
    );
    const opfsPoolDirectory = [
      "",
      ...workspace.pathSegments,
      sourceSqliteSahPoolDirectoryName,
    ].join("/");

    return {
      directory: workspace.directory,
      mainFile,
      opfsPoolDirectory,
      vfsName: `${sourceSqliteSahPoolVfsPrefix}-${String(databaseId)}-${stableHash(opfsPoolDirectory)}`,
      remove: () => workspace.remove(),
    };
  } catch (cause) {
    try {
      await workspace.remove();
    } catch {
      // Preserve the staged-main creation failure.
    }

    throw cause;
  }
}

async function installSourceSqliteSahPool(
  sqlite3: Sqlite3Api,
  workspace: SourceSqliteWorkspace,
): Promise<SahPool> {
  const installOptions: InstallOpfsSahPoolVfsOptions = {
    clearOnInit: true,
    initialCapacity: sourceSqliteSahPoolMinimumCapacity,
    name: workspace.vfsName,
    directory: workspace.opfsPoolDirectory,
    forceReinitIfPreviouslyFailed: true,
  };
  const pool = await sqlite3.installOpfsSAHPoolVfs(installOptions);

  await pool.reserveMinimumCapacity(sourceSqliteSahPoolMinimumCapacity);

  return pool;
}

async function importRandomAccessDatabase(
  pool: SahPool,
  databaseName: string,
  source: SourceSqliteRandomAccessFile,
): Promise<void> {
  const sourceByteLength = source.getSize();
  const chunkBuffer = new Uint8Array(
    Math.min(sourceSqliteImportChunkBytes, sourceByteLength),
  );
  let offset = 0;

  try {
    await pool.importDb(databaseName, () => {
      if (offset >= sourceByteLength) {
        return undefined;
      }

      const byteLength = Math.min(chunkBuffer.byteLength, sourceByteLength - offset);
      const chunk = chunkBuffer.subarray(0, byteLength);
      const bytesRead = source.read(chunk, { at: offset });

      if (bytesRead !== byteLength) {
        throw new Error("A staged SQLite import returned a short read.");
      }

      offset += bytesRead;

      return chunk;
    });
  } finally {
    chunkBuffer.fill(0);
  }
}

async function copyBlobToRandomAccessFile(
  source: Blob,
  destination: SourceSqliteRandomAccessFile,
): Promise<void> {
  destination.truncate(0);

  for (let offset = 0; offset < source.size; offset += sourceSqliteImportChunkBytes) {
    const chunk = new Uint8Array(
      await source
        .slice(offset, Math.min(source.size, offset + sourceSqliteImportChunkBytes))
        .arrayBuffer(),
    );

    try {
      writeRandomAccessBytes(destination, chunk, offset);
    } finally {
      chunk.fill(0);
    }
  }

  destination.truncate(source.size);
}

/**
 * Lets a caller-provided stage callback (typically an encrypted-source
 * decrypt stream) write the main database plaintext directly into the
 * workspace's staged random-access file. Sequential writes only; sparse
 * tails zero-extend through truncate. The callback must produce exactly
 * `declaredByteLength` bytes — hostile over- and under-runs are rejected.
 */
async function stageMainSourceToRandomAccessFile(
  source: SourceSqliteStagedMainSource,
  destination: SourceSqliteRandomAccessFile,
): Promise<void> {
  assertPositiveSafeInteger(
    source.declaredByteLength,
    "Staged source SQLite main byte length",
  );
  destination.truncate(0);

  let offset = 0;
  let completed = false;
  // Tags failures raised by this module's own destination writers (size-claim
  // violations, staged-file write errors) so the catch below can tell them
  // apart from failures the caller-provided stage callback throws itself.
  // Object property rather than a local: closure assignments are invisible to
  // TypeScript's control-flow narrowing of locals.
  const stageState: { ownFailure?: { cause: unknown } } = {};
  const guarded = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (cause) {
      stageState.ownFailure = { cause };
      throw cause;
    }
  };
  const claimBytes = (byteLength: number): void => {
    if (completed) {
      throw new Error("Staged source SQLite destination is closed.");
    }

    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      offset + byteLength > source.declaredByteLength
    ) {
      throw new Error(
        "Staged source SQLite bytes exceeded the declared main size.",
      );
    }
  };

  try {
    await source.stage({
      write: (chunk) => {
        guarded(() => {
          claimBytes(chunk.byteLength);
          writeRandomAccessBytes(destination, chunk, offset);
          offset += chunk.byteLength;
        });
      },
      extendZeros: (byteLength) => {
        guarded(() => {
          claimBytes(byteLength);
          offset += byteLength;
          // truncate() zero-fills when it grows the file.
          destination.truncate(offset);
        });
      },
    });
  } catch (cause) {
    if (stageState.ownFailure !== undefined && stageState.ownFailure.cause === cause) {
      throw cause;
    }

    // Anything else originated inside the caller-provided stage callback;
    // mark it so the opener rethrows it unwrapped (structured error codes
    // such as encrypted-session decrypt failures must survive).
    throw new StagedMainSourceCallbackError(cause);
  }
  completed = true;

  if (offset !== source.declaredByteLength) {
    throw new Error(
      "Staged source SQLite bytes did not match the declared main size.",
    );
  }
}

async function cleanupStreamingWorkspace(
  pool: SahPool,
  workspace: SourceSqliteWorkspace,
): Promise<void> {
  try {
    await pool.removeVfs();
  } finally {
    await workspace.remove();
  }
}

function deleteTransientDatabaseFile(
  sqlite3: Sqlite3Api,
  databaseName: string,
): void {
  // The installed @sqlite.org/sqlite-wasm build exposes no public JS helper
  // for deleting a file created with sqlite3_js_posix_create_file
  // (sqlite3.util, which wraps sqlite3__wasm_vfs_unlink, is deleted after
  // bootstrap), so call the exported C helper directly. Passing a null VFS
  // pointer makes it unlink through the default (unix) VFS — the one
  // sqlite3_js_posix_create_file writes into. Best-effort: a failed unlink
  // must never mask the read result, so errors are swallowed.
  try {
    const wasm = sqlite3.wasm;
    // wasm.exports is typed `any` by the package; narrow it explicitly.
    const exports = wasm.exports as Record<string, unknown>;
    const unlink = exports.sqlite3__wasm_vfs_unlink;

    if (typeof unlink !== "function") {
      return;
    }

    const namePointer = wasm.allocCString(databaseName, false);

    try {
      (unlink as (vfsPointer: number, namePointer: number) => number)(
        0,
        namePointer,
      );
    } finally {
      wasm.dealloc(namePointer);
    }
  } catch {
    // Cleanup only; the database is already closed.
  }
}

/**
 * Prepares a staged main database in place. WAL parsing retains the
 * D-021/D-022 validation and committed-prefix behavior; frame payloads are
 * written directly to the random-access file instead of growing a full JS
 * plaintext buffer. This is the single WAL reconstruction pipeline — byte
 * inputs run through it via {@link MemoryRandomAccessFile}.
 */
export async function prepareStagedSourceSqliteForReadOnlyOpen(
  main: SourceSqliteRandomAccessFile,
  wal?: Blob,
): Promise<void> {
  if (wal !== undefined && wal.size > 0) {
    await applySqliteWalToStagedFile(main, wal);
  } else {
    forceStagedRollbackJournalMode(main);
  }

  main.flush();
}

export async function applySqliteWalToStagedFile(
  main: SourceSqliteRandomAccessFile,
  wal: Blob,
  // Test seam only; production callers always use the default budget.
  pendingTransactionBudgetBytes = walPendingTransactionBudgetBytes,
): Promise<void> {
  if (wal.size === 0) {
    forceStagedRollbackJournalMode(main);
    return;
  }

  if (wal.size < walHeaderByteLength) {
    throw new Error("SQLite WAL sidecar is too short.");
  }

  const walHeader = await readBlobRange(wal, 0, walHeaderByteLength);
  const magic = readUInt32(walHeader, 0);

  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    throw new Error("SQLite WAL sidecar has an invalid magic number.");
  }

  if (readUInt32(walHeader, 4) !== 3_007_000) {
    throw new Error("SQLite WAL sidecar has an unsupported format version.");
  }

  const checksumEndian = magic === 0x377f0683 ? "big" : "little";
  const pageSize = readWalPageSize(walHeader);

  if (pageSize === undefined) {
    throw new Error("SQLite WAL sidecar has an invalid page size.");
  }

  const mainHeader = readRandomAccessBytes(main, 0, Math.min(100, main.getSize()));
  const mainPageSize = readMainDatabasePageSize(mainHeader);

  if (mainPageSize !== undefined && mainPageSize !== pageSize) {
    throw new Error("SQLite WAL page size does not match the main database.");
  }

  const committedByteLength = await replayCommittedWalFrames(
    main,
    wal,
    walHeader,
    pageSize,
    checksumEndian,
    pendingTransactionBudgetBytes,
  );

  if (committedByteLength !== undefined) {
    main.truncate(committedByteLength);
  }

  forceStagedRollbackJournalMode(main);
}

/** Shared per-WAL state for the frame scans (one D-021/D-022 validation core). */
interface WalFrameScanContext {
  wal: Blob;
  pageSize: number;
  frameSize: number;
  completeFrameCount: number;
  salt1: number;
  salt2: number;
  headerChecksum: readonly [number, number];
  endian: "big" | "little";
  /**
   * Structural bound over the WHOLE WAL's complete frames: every page the
   * final commit retains must already exist in the main database or arrive
   * as a frame, so the FINAL applied commit's size can never exceed it.
   * Intermediate commits may legitimately exceed it — a checkpoint can
   * backfill and truncate the main file without resetting the WAL, leaving
   * earlier commit records that declare the old, larger database size.
   */
  maxReconstructedByteLength: number;
}

interface ValidWalFrame {
  frameIndex: number;
  pageNumber: number;
  commitPageCount: number;
  /** Borrowed view into the chunk buffer; copy before returning if retained. */
  pageBytes: Uint8Array;
}

/**
 * D-021/D-022 WAL replay: frames are read in large frame-aligned chunks (no
 * per-frame blob micro-reads), validated against the salt/checksum chain, and
 * stopped at the first invalid, stale, or torn frame. Only frames up to the
 * last valid commit frame may reach the staged file. The fast path buffers a
 * transaction's page bytes in memory until its commit frame validates,
 * bounded by {@link walPendingTransactionBudgetBytes}; a transaction that
 * would exceed that budget abandons buffering and the replay restarts as the
 * bounded-memory strategy in {@link replayCommittedWalFramesInTwoPhases}.
 * Returns the committed database byte length, or undefined when no valid
 * commit frame exists.
 */
async function replayCommittedWalFrames(
  main: SourceSqliteRandomAccessFile,
  wal: Blob,
  header: Uint8Array,
  pageSize: number,
  endian: "big" | "little",
  pendingTransactionBudgetBytes: number,
): Promise<number | undefined> {
  const headerChecksum = walChecksumBytes(header, 0, 24, [0, 0], endian);

  if (
    readUInt32(header, 24) !== headerChecksum[0] ||
    readUInt32(header, 28) !== headerChecksum[1]
  ) {
    throw new Error("SQLite WAL header checksum is invalid.");
  }

  const frameSize = walFrameHeaderByteLength + pageSize;
  const completeFrameCount = Math.floor(
    (wal.size - walHeaderByteLength) / frameSize,
  );
  const context: WalFrameScanContext = {
    wal,
    pageSize,
    frameSize,
    completeFrameCount,
    salt1: readUInt32(header, 16),
    salt2: readUInt32(header, 20),
    headerChecksum,
    endian,
    // Captured before any page write can grow the staged file.
    maxReconstructedByteLength: main.getSize() + completeFrameCount * pageSize,
  };
  const buffered = await replayBufferedWalFrames(
    main,
    context,
    pendingTransactionBudgetBytes,
  );

  if (buffered.kind === "replayed") {
    assertFinalWalCommitWithinSourceBounds(
      buffered.committedByteLength,
      context,
    );

    return buffered.committedByteLength;
  }

  return replayCommittedWalFramesInTwoPhases(main, context);
}

type BufferedWalReplayResult =
  | { kind: "replayed"; committedByteLength: number | undefined }
  | { kind: "budget-exceeded" };

/**
 * Fast single-pass replay: non-commit frames buffer their page bytes (last
 * write per page wins) until their transaction's commit frame validates; a
 * transaction still pending when the valid prefix ends is discarded. Reports
 * "budget-exceeded" instead of buffering further when one transaction's
 * pending page bytes would cross `pendingTransactionBudgetBytes`; committed
 * transactions already written to the staged file before the abandonment are
 * rewritten identically by the two-phase restart, which replays the same
 * frames in the same order.
 */
async function replayBufferedWalFrames(
  main: SourceSqliteRandomAccessFile,
  context: WalFrameScanContext,
  pendingTransactionBudgetBytes: number,
): Promise<BufferedWalReplayResult> {
  const pendingPages = new Map<number, Uint8Array>();
  // Object properties rather than locals: closure assignments are invisible
  // to TypeScript's control-flow narrowing of locals.
  const scan: {
    pendingByteCount: number;
    committedByteLength: number | undefined;
    budgetExceeded: boolean;
  } = { pendingByteCount: 0, committedByteLength: undefined, budgetExceeded: false };

  try {
    await scanValidWalFrames(context, (frame) => {
      if (frame.commitPageCount === 0) {
        const existing = pendingPages.get(frame.pageNumber);

        if (existing !== undefined) {
          existing.set(frame.pageBytes);

          return "continue";
        }

        if (
          scan.pendingByteCount + context.pageSize >
          pendingTransactionBudgetBytes
        ) {
          scan.budgetExceeded = true;

          return "stop";
        }

        // Copy: the chunk buffer is released after this frame's iteration.
        pendingPages.set(frame.pageNumber, frame.pageBytes.slice());
        scan.pendingByteCount += context.pageSize;

        return "continue";
      }

      const candidateByteLength = commitByteLengthWithinSanityBound(
        frame.commitPageCount,
        context.pageSize,
      );

      for (const [pendingPageNumber, pendingBytes] of pendingPages) {
        writeCommittedWalPage(
          main,
          pendingPageNumber,
          pendingBytes,
          context.pageSize,
          candidateByteLength,
        );
        pendingBytes.fill(0);
      }

      pendingPages.clear();
      scan.pendingByteCount = 0;
      writeCommittedWalPage(
        main,
        frame.pageNumber,
        frame.pageBytes,
        context.pageSize,
        candidateByteLength,
      );
      scan.committedByteLength = candidateByteLength;

      return "continue";
    });
  } finally {
    for (const pendingBytes of pendingPages.values()) {
      pendingBytes.fill(0);
    }

    pendingPages.clear();
  }

  return scan.budgetExceeded
    ? { kind: "budget-exceeded" }
    : { kind: "replayed", committedByteLength: scan.committedByteLength };
}

/**
 * Bounded-memory fallback for a WAL whose single transaction exceeds the
 * pending-page budget. Phase 1 scans the whole WAL through the same
 * validation core (frame header and checksum-chain validation only, constant
 * memory) to locate the last valid commit frame and its committed size;
 * phase 2 re-reads the same chunked frames and writes pages straight to the
 * staged file with no buffering, because the commit boundary is already
 * known. Pages beyond the final committed size are skipped — the bufferless
 * equivalent of the per-transaction rule in {@link writeCommittedWalPage}:
 * any such page is either rewritten by the fresh frames a later regrowth
 * must emit or removed by the caller's ending truncate.
 */
async function replayCommittedWalFramesInTwoPhases(
  main: SourceSqliteRandomAccessFile,
  context: WalFrameScanContext,
): Promise<number | undefined> {
  let lastCommitFrameIndex = -1;
  let committedByteLength: number | undefined;

  await scanValidWalFrames(context, (frame) => {
    if (frame.commitPageCount !== 0) {
      committedByteLength = commitByteLengthWithinSanityBound(
        frame.commitPageCount,
        context.pageSize,
      );
      lastCommitFrameIndex = frame.frameIndex;
    }

    return "continue";
  });

  if (committedByteLength === undefined) {
    return undefined;
  }

  const finalByteLength = committedByteLength;

  assertFinalWalCommitWithinSourceBounds(finalByteLength, context);

  await scanValidWalFrames(context, (frame) => {
    writeCommittedWalPage(
      main,
      frame.pageNumber,
      frame.pageBytes,
      context.pageSize,
      finalByteLength,
    );

    return frame.frameIndex >= lastCommitFrameIndex ? "stop" : "continue";
  });

  return finalByteLength;
}

/**
 * Chunked scan over the WAL's complete frames through the single frame
 * validation core, invoking `visit` for each valid frame in order. Stops at
 * the first invalid, stale, or torn frame (SQLite end-of-log behavior) or
 * when `visit` returns "stop". Chunk buffers are zeroized after use.
 */
async function scanValidWalFrames(
  context: WalFrameScanContext,
  visit: (frame: ValidWalFrame) => "continue" | "stop",
): Promise<void> {
  const { frameSize, completeFrameCount } = context;
  const framesPerChunk = Math.max(
    1,
    Math.floor(sourceSqliteImportChunkBytes / frameSize),
  );
  let checksum = context.headerChecksum;
  let frameIndex = 0;

  while (frameIndex < completeFrameCount) {
    const chunkFrameCount = Math.min(
      framesPerChunk,
      completeFrameCount - frameIndex,
    );
    const chunk = await readBlobRange(
      context.wal,
      walHeaderByteLength + frameIndex * frameSize,
      chunkFrameCount * frameSize,
    );

    try {
      for (
        let chunkFrame = 0;
        chunkFrame < chunkFrameCount;
        chunkFrame += 1, frameIndex += 1
      ) {
        const frameOffset = chunkFrame * frameSize;
        const frameChecksum = validateWalFrame(
          chunk,
          frameOffset,
          context,
          checksum,
        );

        if (frameChecksum === undefined) {
          return;
        }

        checksum = frameChecksum;

        const outcome = visit({
          frameIndex,
          pageNumber: readUInt32(chunk, frameOffset),
          commitPageCount: readUInt32(chunk, frameOffset + 4),
          pageBytes: chunk.subarray(
            frameOffset + walFrameHeaderByteLength,
            frameOffset + frameSize,
          ),
        });

        if (outcome === "stop") {
          return;
        }
      }
    } finally {
      chunk.fill(0);
    }
  }
}

/**
 * The single D-021/D-022 frame validation core shared by the buffered replay
 * and both two-phase passes: salt continuity plus the cumulative checksum
 * over the frame header and page payload. Returns the advanced checksum
 * chain, or undefined for an invalid, stale, or torn frame.
 */
function validateWalFrame(
  chunk: Uint8Array,
  frameOffset: number,
  context: WalFrameScanContext,
  checksum: readonly [number, number],
): [number, number] | undefined {
  if (
    readUInt32(chunk, frameOffset) <= 0 ||
    readUInt32(chunk, frameOffset + 8) !== context.salt1 ||
    readUInt32(chunk, frameOffset + 12) !== context.salt2
  ) {
    return undefined;
  }

  let frameChecksum = walChecksumBytes(
    chunk,
    frameOffset,
    8,
    checksum,
    context.endian,
  );

  frameChecksum = walChecksumBytes(
    chunk,
    frameOffset + walFrameHeaderByteLength,
    context.pageSize,
    frameChecksum,
    context.endian,
  );

  if (
    readUInt32(chunk, frameOffset + 16) !== frameChecksum[0] ||
    readUInt32(chunk, frameOffset + 20) !== frameChecksum[1]
  ) {
    return undefined;
  }

  return frameChecksum;
}

/**
 * Pure-hostility per-commit cap: a commit record may not declare a database
 * larger than the absolute staged sanity bound — no real backup can hit it.
 * There is deliberately no tighter per-commit structural bound: a checkpoint
 * can backfill and truncate the main file without resetting the WAL, so an
 * earlier commit's declared size may legitimately exceed the bytes present
 * in main plus the frames seen so far.
 */
function commitByteLengthWithinSanityBound(
  commitPageCount: number,
  pageSize: number,
): number {
  const candidateByteLength = commitPageCount * pageSize;

  if (
    !Number.isSafeInteger(candidateByteLength) ||
    candidateByteLength > maxCommittedWalDatabaseBytes
  ) {
    throw new Error(
      "SQLite WAL committed database size exceeds source bounds.",
    );
  }

  return candidateByteLength;
}

/**
 * The FINAL applied commit must fit the whole-WAL structural bound (every
 * retained page exists in main or arrived as a frame); hostile final commit
 * records that claim more are rejected.
 */
function assertFinalWalCommitWithinSourceBounds(
  committedByteLength: number | undefined,
  context: WalFrameScanContext,
): void {
  if (
    committedByteLength !== undefined &&
    committedByteLength > context.maxReconstructedByteLength
  ) {
    throw new Error(
      "SQLite WAL committed database size exceeds source bounds.",
    );
  }
}

function writeCommittedWalPage(
  main: SourceSqliteRandomAccessFile,
  pageNumber: number,
  pageBytes: Uint8Array,
  pageSize: number,
  committedByteLength: number,
): void {
  const pageEnd = pageNumber * pageSize;

  // A page beyond its own transaction's committed database size is skipped
  // instead of creating a huge sparse write. This is provably safe: such a
  // page can only matter again if the database regrows past it, and regrowth
  // emits fresh frames for every regrown page (the PENDING_BYTE page is never
  // read); pages beyond the final committed size are removed by the ending
  // truncate.
  if (!Number.isSafeInteger(pageEnd) || pageEnd > committedByteLength) {
    return;
  }

  writeRandomAccessBytes(main, pageBytes, pageEnd - pageSize);
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

function sourceOpenDetails(
  input: SourceSqliteOpenInput,
  databaseName: string | null,
): Record<string, WorkerStructuredValue> {
  const common = {
    label: input.label,
    databaseName,
  };

  if (!isMemorySourceSqliteInput(input)) {
    return {
      ...common,
      mainByteLength:
        input.main instanceof Blob
          ? input.main.size
          : input.main.declaredByteLength,
      walByteLength: input.wal?.size ?? null,
      shmByteLength: input.shm?.size ?? null,
      mainLooksSqlite: null,
      mainWriteVersion: null,
      mainReadVersion: null,
    };
  }

  return {
    ...common,
    mainByteLength: input.main.byteLength,
    walByteLength: input.wal?.byteLength ?? null,
    shmByteLength: input.shm?.byteLength ?? null,
    mainLooksSqlite: bytesStartWith(input.main, sqliteFormat3Magic),
    mainWriteVersion: input.main.byteLength > 18 ? input.main[18] : null,
    mainReadVersion: input.main.byteLength > 19 ? input.main[19] : null,
  };
}

function blobFromOwnedBytesCopy(bytes: Uint8Array): Blob {
  // Copy onto a plain ArrayBuffer first (Blob parts require one), then
  // zeroize the transient copy — Blob construction copies synchronously.
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy]);

  copy.fill(0);

  return blob;
}

function viewAsBytes(buffer: ArrayBufferView): Uint8Array {
  return buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function assertMemoryFileOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("In-memory source SQLite file offset is invalid.");
  }

  return offset;
}

async function readBlobRange(
  blob: Blob,
  offset: number,
  byteLength: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    offset + byteLength > blob.size
  ) {
    throw new Error("A staged SQLite source read exceeded its file bounds.");
  }

  const bytes = new Uint8Array(
    await blob.slice(offset, offset + byteLength).arrayBuffer(),
  );

  if (bytes.byteLength !== byteLength) {
    throw new Error("A staged SQLite source returned a short read.");
  }

  return bytes;
}

function readRandomAccessBytes(
  source: SourceSqliteRandomAccessFile,
  offset: number,
  byteLength: number,
): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  const bytesRead = source.read(bytes, { at: offset });

  if (bytesRead !== byteLength) {
    throw new Error("A staged SQLite file returned a short read.");
  }

  return bytes;
}

function writeRandomAccessBytes(
  destination: SourceSqliteRandomAccessFile,
  bytes: Uint8Array,
  offset: number,
): void {
  let bytesWritten = 0;

  while (bytesWritten < bytes.byteLength) {
    const written = destination.write(bytes.subarray(bytesWritten), {
      at: offset + bytesWritten,
    });

    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("A staged SQLite file returned a short write.");
    }

    bytesWritten += written;
  }
}

function forceStagedRollbackJournalMode(
  destination: SourceSqliteRandomAccessFile,
): void {
  if (destination.getSize() < 20) {
    return;
  }

  const header = readRandomAccessBytes(destination, 0, 20);

  if (bytesStartWith(header, sqliteFormat3Magic)) {
    writeRandomAccessBytes(destination, new Uint8Array([1, 1]), 18);
  }
}

function sourceSqliteOpenErrorMessage(message: string, cause: unknown): string {
  return cause instanceof Error ? `${message} (${cause.message})` : message;
}

function asError(
  cause: unknown,
  message = "A source SQLite cleanup operation failed.",
): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
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
