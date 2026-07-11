import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
} from "../../lib/recents";
import {
  getOpfsBackupDirectoryHandle,
  isSafeOpfsPathSegment,
  removeOpfsEntryIfFound,
} from "../shared/opfs";

export const transientStagingDirectoryName = "transient";

export interface TransientStagingDirectoryHandle {
  getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<TransientStagingDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: FileSystemGetFileOptions,
  ): Promise<TransientStagingFileHandle>;
  removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void>;
}

export interface TransientStagingFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
  getFile(): Promise<File>;
}

export interface TransientStagingOptions {
  /** Test seam; production callers use the per-backup OPFS helper. */
  getBackupDirectory?: () => Promise<TransientStagingDirectoryHandle>;
  /** Test seam; production names contain only a random UUID. */
  createFileName?: () => string;
}

export type TransientSweepOptions = Pick<
  TransientStagingOptions,
  "getBackupDirectory"
>;

export interface TransientWorkspaceDirectoryOptions {
  /** Test seam; production callers use the per-backup OPFS helper. */
  getBackupDirectory?: () => Promise<TransientStagingDirectoryHandle>;
  /** Test seam; production names append a random UUID to the safe prefix. */
  createDirectoryName?: (safeNamePrefix: string) => string;
}

/**
 * A worker-owned plaintext file in OPFS. Callers must close it in `finally`;
 * close is idempotent and removes the backing file.
 */
export interface TransientStagedFile {
  readonly name: string;
  readonly byteLength: number;
  read(offset: number, length: number): Uint8Array;
  write(bytes: Uint8Array, offset?: number): number;
  resize(byteLength: number): void;
  flush(): void;
  getFile(): Promise<File>;
  close(): Promise<void>;
}

export interface TransientStagingArea {
  readonly backupDirectoryName: string;
  createFile(): Promise<TransientStagedFile>;
  close(): Promise<void>;
}

/**
 * A worker-owned directory directly under the per-backup `transient/` root,
 * for consumers that manage their own files and nested directories (e.g. a
 * staged source database plus its sahpool directory). Callers must remove it
 * in `finally`; remove is recursive, idempotent, and NotFound-tolerant.
 */
export interface TransientWorkspaceDirectory {
  readonly directory: TransientStagingDirectoryHandle;
  readonly directoryName: string;
  /** OPFS path segments from the storage root to `directory`. */
  readonly pathSegments: readonly string[];
  remove(): Promise<void>;
}

interface SweepContext {
  transientDirectory: TransientStagingDirectoryHandle;
}

// A worker may have a session-owned Manifest reader and several source DBs
// alive at once. Sweep once per backup per worker so a later staging-area or
// workspace-directory open cannot remove files still owned by an earlier one.
// A fresh worker has a fresh map and therefore sweeps crash leftovers on its
// first open. The sweep removes the whole `transient/` directory, so leftover
// staged files and workspace directories from crashed workers are both swept.
// This whole-directory sweep assumes at most one worker uses a backup's
// transient directory at a time (single-tab flows; same-backup multi-tab is
// out of scope per D-029) — a second concurrent worker's first sweep would
// collide with live staging.
const sweepByBackupDirectory = new Map<string, Promise<SweepContext>>();

export async function openTransientStagingArea(
  backupDirectoryName: string,
  options: TransientStagingOptions = {},
): Promise<TransientStagingArea> {
  const { safeBackupDirectoryName, transientDirectory } = await requireSweptTransientDirectory(
    backupDirectoryName,
    options.getBackupDirectory,
  );

  return new OpfsTransientStagingArea(
    safeBackupDirectoryName,
    transientDirectory,
    options.createFileName ?? createRandomStagingFileName,
  );
}

/**
 * Performs the once-per-backup-per-worker crash-leftover sweep of
 * `golemine/backups/<id>/transient/` without creating a staging file or
 * workspace. Callers that only need the sweep guarantee (e.g. before quota
 * estimates) use this instead of opening and closing a throwaway staging
 * area. Later staging/workspace opens in the same worker reuse the same
 * sweep, so this never removes still-active transient files.
 */
export async function ensureTransientSweep(
  backupDirectoryName: string,
  options: TransientSweepOptions = {},
): Promise<void> {
  await requireSweptTransientDirectory(
    backupDirectoryName,
    options.getBackupDirectory,
  );
}

/**
 * Creates a uniquely named, caller-owned workspace directory under the swept
 * per-backup `transient/` root. Participates in the same once-per-worker
 * crash-leftover sweep as staging areas: leftover workspaces from crashed
 * workers are removed by a fresh worker's first transient open, while later
 * opens in the same worker never sweep again.
 */
export async function createTransientWorkspaceDirectory(
  backupDirectoryName: string,
  namePrefix: string,
  options: TransientWorkspaceDirectoryOptions = {},
): Promise<TransientWorkspaceDirectory> {
  const { safeBackupDirectoryName, transientDirectory } = await requireSweptTransientDirectory(
    backupDirectoryName,
    options.getBackupDirectory,
  );

  const safeNamePrefix = namePrefix.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 32);
  if (safeNamePrefix.length === 0) {
    throw new Error("Transient workspace name prefix must not be empty.");
  }

  const directoryName = (
    options.createDirectoryName ?? createRandomWorkspaceDirectoryName
  )(safeNamePrefix);
  if (!isSafeOpfsPathSegment(directoryName)) {
    throw new Error(
      "Transient workspace directory name is not a safe OPFS path segment.",
    );
  }

  // remove() deletes the directory recursively, so two owners must never
  // share one name. Fail loudly instead of silently reusing the directory;
  // a name taken by a non-directory entry surfaces from the create below.
  let nameInUse = true;
  try {
    await transientDirectory.getDirectoryHandle(directoryName);
  } catch {
    nameInUse = false;
  }
  if (nameInUse) {
    throw new Error("Transient workspace directory name is already in use.");
  }

  const directory = await transientDirectory.getDirectoryHandle(directoryName, {
    create: true,
  });

  return {
    directory,
    directoryName,
    pathSegments: Object.freeze([
      derivedDataOpfsAppDirectoryName,
      derivedDataOpfsBackupsDirectoryName,
      safeBackupDirectoryName,
      transientStagingDirectoryName,
      directoryName,
    ]),
    remove: () =>
      removeOpfsEntryIfFound(transientDirectory, directoryName, {
        recursive: true,
      }),
  };
}

class OpfsTransientStagingArea implements TransientStagingArea {
  readonly #files = new Set<OpfsTransientStagedFile>();
  #closed = false;

  constructor(
    public readonly backupDirectoryName: string,
    private readonly directory: TransientStagingDirectoryHandle,
    private readonly createFileName: () => string,
  ) {}

  async createFile(): Promise<TransientStagedFile> {
    if (this.#closed) {
      throw new Error("Transient staging area is closed.");
    }

    const name = this.createFileName();
    if (!isSafeOpfsPathSegment(name)) {
      throw new Error("Transient staging file name is not a safe OPFS path segment.");
    }

    const fileHandle = await this.directory.getFileHandle(name, { create: true });
    let accessHandle: FileSystemSyncAccessHandle;
    try {
      accessHandle = await fileHandle.createSyncAccessHandle();
    } catch (cause) {
      await removeOpfsEntryIfFound(this.directory, name);
      throw cause;
    }

    const stagedFile = new OpfsTransientStagedFile(
      name,
      fileHandle,
      accessHandle,
      this.directory,
      (closedFile) => this.#files.delete(closedFile),
    );
    this.#files.add(stagedFile);
    return stagedFile;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    const results = await Promise.allSettled(
      [...this.#files].map((file) => file.close()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);

    if (failures.length === 1) {
      throw asError(failures[0], "Could not clean up a transient staging file.");
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Could not clean up transient staging files.");
    }
  }
}

class OpfsTransientStagedFile implements TransientStagedFile {
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    public readonly name: string,
    private readonly fileHandle: TransientStagingFileHandle,
    private readonly accessHandle: FileSystemSyncAccessHandle,
    private readonly directory: TransientStagingDirectoryHandle,
    private readonly onClose: (file: OpfsTransientStagedFile) => void,
  ) {}

  get byteLength(): number {
    this.assertOpen();
    return this.accessHandle.getSize();
  }

  read(offset: number, length: number): Uint8Array {
    this.assertOpen();
    assertSafeByteRange(offset, length);

    const bytes = new Uint8Array(length);
    const bytesRead = this.accessHandle.read(bytes, { at: offset });
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
      throw new Error("Transient staging read returned an invalid byte count.");
    }
    return bytesRead === length ? bytes : bytes.subarray(0, bytesRead);
  }

  write(bytes: Uint8Array, offset = this.byteLength): number {
    this.assertOpen();
    assertSafeByteRange(offset, bytes.byteLength);

    let written = 0;
    while (written < bytes.byteLength) {
      const count = this.accessHandle.write(bytes.subarray(written), {
        at: offset + written,
      });
      if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - written) {
        throw new Error("Transient staging write made no valid forward progress.");
      }
      written += count;
    }
    return written;
  }

  resize(byteLength: number): void {
    this.assertOpen();
    assertSafeByteRange(byteLength, 0);
    this.accessHandle.truncate(byteLength);
  }

  flush(): void {
    this.assertOpen();
    this.accessHandle.flush();
  }

  async getFile(): Promise<File> {
    this.flush();
    return this.fileHandle.getFile();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    let closeFailure: unknown;
    try {
      this.accessHandle.close();
    } catch (cause) {
      closeFailure = cause;
    }

    let removeFailure: unknown;
    try {
      await removeOpfsEntryIfFound(this.directory, this.name);
    } catch (cause) {
      removeFailure = cause;
    } finally {
      this.onClose(this);
    }

    if (closeFailure !== undefined && removeFailure !== undefined) {
      throw new AggregateError(
        [closeFailure, removeFailure],
        "Could not close and delete a transient staging file.",
      );
    }
    if (closeFailure !== undefined) {
      throw asError(closeFailure, "Could not close a transient staging file.");
    }
    if (removeFailure !== undefined) {
      throw asError(removeFailure, "Could not delete a transient staging file.");
    }
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new Error("Transient staging file is closed.");
    }
  }
}

async function requireSweptTransientDirectory(
  backupDirectoryName: string,
  getBackupDirectory: TransientStagingOptions["getBackupDirectory"],
): Promise<{
  safeBackupDirectoryName: string;
  transientDirectory: TransientStagingDirectoryHandle;
}> {
  if (!isSafeOpfsPathSegment(backupDirectoryName)) {
    throw new Error("Transient staging backup id is not a safe OPFS path segment.");
  }

  const safeBackupDirectoryName = backupDirectoryName.trim();
  const context = await getOrCreateSweep(safeBackupDirectoryName, getBackupDirectory);

  return {
    safeBackupDirectoryName,
    transientDirectory: context.transientDirectory,
  };
}

function getOrCreateSweep(
  backupDirectoryName: string,
  getBackupDirectory: TransientStagingOptions["getBackupDirectory"],
): Promise<SweepContext> {
  const existing = sweepByBackupDirectory.get(backupDirectoryName);
  if (existing !== undefined) {
    return existing;
  }

  const sweep = sweepTransientDirectory(backupDirectoryName, getBackupDirectory);
  sweepByBackupDirectory.set(backupDirectoryName, sweep);
  void sweep.catch(() => {
    if (sweepByBackupDirectory.get(backupDirectoryName) === sweep) {
      sweepByBackupDirectory.delete(backupDirectoryName);
    }
  });
  return sweep;
}

async function sweepTransientDirectory(
  backupDirectoryName: string,
  getBackupDirectory: TransientStagingOptions["getBackupDirectory"],
): Promise<SweepContext> {
  const backupDirectory =
    getBackupDirectory === undefined
      ? await getOpfsBackupDirectoryHandle(backupDirectoryName, true)
      : await getBackupDirectory();

  await removeOpfsEntryIfFound(backupDirectory, transientStagingDirectoryName, {
    recursive: true,
  });
  const transientDirectory = await backupDirectory.getDirectoryHandle(
    transientStagingDirectoryName,
    { create: true },
  );
  return { transientDirectory };
}

function createRandomStagingFileName(): string {
  return `stage-${crypto.randomUUID()}.bin`;
}

function createRandomWorkspaceDirectoryName(safeNamePrefix: string): string {
  return `${safeNamePrefix}-${crypto.randomUUID()}`;
}

function assertSafeByteRange(offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw new RangeError("Transient staging byte range is invalid.");
  }
}

function asError(cause: unknown, fallbackMessage: string): Error {
  return cause instanceof Error ? cause : new Error(fallbackMessage, { cause });
}
