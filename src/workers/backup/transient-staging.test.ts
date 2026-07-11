import { describe, expect, it } from "vitest";

import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
} from "../../lib/recents";
import {
  createTransientWorkspaceDirectory,
  ensureTransientSweep,
  openTransientStagingArea,
  transientStagingDirectoryName,
  type TransientStagingDirectoryHandle,
  type TransientStagingFileHandle,
} from "./transient-staging";

describe("transient plaintext staging", () => {
  it("sweeps crash leftovers once per backup without deleting active files", async () => {
    const backup = new MemoryDirectory();
    const oldTransient = backup.seedDirectory(transientStagingDirectoryName);
    oldTransient.seedFile("crash-leftover.bin", new Uint8Array([9]));
    let backupDirectoryReads = 0;

    const firstArea = await openTransientStagingArea("sweep-once-backup", {
      getBackupDirectory: () => {
        backupDirectoryReads += 1;
        return Promise.resolve(backup);
      },
      createFileName: () => "active.bin",
    });

    expect(
      backup
        .requireDirectory(transientStagingDirectoryName)
        .hasFile("crash-leftover.bin"),
    ).toBe(false);
    expect(backup.removedNames).toEqual([transientStagingDirectoryName]);

    const active = await firstArea.createFile();
    active.write(new Uint8Array([1, 2, 3]));

    const secondArea = await openTransientStagingArea("sweep-once-backup", {
      getBackupDirectory: () => {
        backupDirectoryReads += 1;
        return Promise.resolve(backup);
      },
      createFileName: () => "second.bin",
    });

    expect(backupDirectoryReads).toBe(1);
    expect(active.read(0, 3)).toEqual(new Uint8Array([1, 2, 3]));
    await secondArea.close();
    await firstArea.close();
  });

  it("supports append, random access, resize, and file snapshots", async () => {
    const backup = new MemoryDirectory();
    const area = await openTransientStagingArea("staging-io-backup", {
      getBackupDirectory: () => Promise.resolve(backup),
      createFileName: () => "database.bin",
    });
    const staged = await area.createFile();

    expect(staged.write(new Uint8Array([1, 2, 3]))).toBe(3);
    expect(staged.write(new Uint8Array([4, 5]))).toBe(2);
    expect(staged.write(new Uint8Array([9, 8]), 1)).toBe(2);
    staged.resize(7);

    expect(staged.byteLength).toBe(7);
    expect(staged.read(0, 20)).toEqual(new Uint8Array([1, 9, 8, 4, 5, 0, 0]));
    expect(new Uint8Array(await (await staged.getFile()).arrayBuffer())).toEqual(
      new Uint8Array([1, 9, 8, 4, 5, 0, 0]),
    );

    await area.close();
  });

  it("closes and deletes a staged file exactly once", async () => {
    const backup = new MemoryDirectory();
    const area = await openTransientStagingArea("delete-on-close-backup", {
      getBackupDirectory: () => Promise.resolve(backup),
      createFileName: () => "plaintext.bin",
    });
    const staged = await area.createFile();
    const transient = backup.requireDirectory(transientStagingDirectoryName);
    const accessHandle = transient.requireFile("plaintext.bin").accessHandle;

    await Promise.all([staged.close(), staged.close()]);

    expect(accessHandle.closeCalls).toBe(1);
    expect(transient.hasFile("plaintext.bin")).toBe(false);
    await expect(staged.getFile()).rejects.toThrow("closed");
    await area.close();
  });

  it("closing the area closes and deletes every tracked file", async () => {
    const backup = new MemoryDirectory();
    const names = ["one.bin", "two.bin"];
    const area = await openTransientStagingArea("manager-cleanup-backup", {
      getBackupDirectory: () => Promise.resolve(backup),
      createFileName: () => {
        const name = names.shift();
        if (name === undefined) {
          throw new Error("Test file names exhausted.");
        }
        return name;
      },
    });
    const first = await area.createFile();
    const second = await area.createFile();
    const transient = backup.requireDirectory(transientStagingDirectoryName);
    const firstAccess = transient.requireFile("one.bin").accessHandle;
    const secondAccess = transient.requireFile("two.bin").accessHandle;

    await area.close();

    expect(firstAccess.closeCalls).toBe(1);
    expect(secondAccess.closeCalls).toBe(1);
    expect(transient.fileNames()).toEqual([]);
    await expect(area.createFile()).rejects.toThrow("closed");
    await Promise.all([first.close(), second.close(), area.close()]);
  });

  it("ensureTransientSweep sweeps crash leftovers once without creating files", async () => {
    const backup = new MemoryDirectory();
    const oldTransient = backup.seedDirectory(transientStagingDirectoryName);
    oldTransient.seedFile("crash-leftover.bin", new Uint8Array([9]));
    oldTransient.seedDirectory("source-sqlite-crashed-1");
    let backupDirectoryReads = 0;
    const getBackupDirectory = () => {
      backupDirectoryReads += 1;
      return Promise.resolve(backup);
    };

    await ensureTransientSweep("ensure-sweep-backup", { getBackupDirectory });

    const transient = backup.requireDirectory(transientStagingDirectoryName);
    expect(backup.removedNames).toEqual([transientStagingDirectoryName]);
    expect(transient.fileNames()).toEqual([]);
    expect(transient.directoryNames()).toEqual([]);

    const area = await openTransientStagingArea("ensure-sweep-backup", {
      getBackupDirectory,
      createFileName: () => "active.bin",
    });
    const active = await area.createFile();
    active.write(new Uint8Array([1]));

    await ensureTransientSweep("ensure-sweep-backup", { getBackupDirectory });

    expect(backupDirectoryReads).toBe(1);
    expect(active.read(0, 1)).toEqual(new Uint8Array([1]));
    await area.close();
  });

  it("ensureTransientSweep rejects unsafe backup ids", async () => {
    await expect(ensureTransientSweep("unsafe/backup")).rejects.toThrow(
      "safe OPFS path segment",
    );
  });

  it("creates uniquely named workspace directories that share the sweep", async () => {
    const backup = new MemoryDirectory();
    const oldTransient = backup.seedDirectory(transientStagingDirectoryName);
    oldTransient.seedDirectory("source-sqlite-crashed-7");
    let backupDirectoryReads = 0;
    const getBackupDirectory = () => {
      backupDirectoryReads += 1;
      return Promise.resolve(backup);
    };

    const workspace = await createTransientWorkspaceDirectory(
      "workspace-backup",
      "source sqlite!",
      {
        getBackupDirectory,
        createDirectoryName: (safeNamePrefix) => `${safeNamePrefix}-1`,
      },
    );

    expect(workspace.directoryName).toBe("source_sqlite_-1");
    expect(workspace.pathSegments).toEqual([
      derivedDataOpfsAppDirectoryName,
      derivedDataOpfsBackupsDirectoryName,
      "workspace-backup",
      transientStagingDirectoryName,
      "source_sqlite_-1",
    ]);
    const transient = backup.requireDirectory(transientStagingDirectoryName);
    expect(transient.hasDirectory("source-sqlite-crashed-7")).toBe(false);
    expect(transient.hasDirectory("source_sqlite_-1")).toBe(true);

    const nested = await workspace.directory.getDirectoryHandle("sahpool", {
      create: true,
    });
    await nested.getFileHandle("pool.bin", { create: true });

    const second = await createTransientWorkspaceDirectory(
      "workspace-backup",
      "manifest",
      {
        getBackupDirectory,
        createDirectoryName: (safeNamePrefix) => `${safeNamePrefix}-2`,
      },
    );

    expect(backupDirectoryReads).toBe(1);
    expect(transient.hasDirectory("source_sqlite_-1")).toBe(true);
    expect(transient.hasDirectory("manifest-2")).toBe(true);

    await workspace.remove();
    expect(transient.hasDirectory("source_sqlite_-1")).toBe(false);
    expect(transient.hasDirectory("manifest-2")).toBe(true);
    await workspace.remove();
    await second.remove();
    expect(transient.hasDirectory("manifest-2")).toBe(false);
  });

  it("generates unique safe workspace names from the sanitized prefix", async () => {
    const backup = new MemoryDirectory();
    const options = { getBackupDirectory: () => Promise.resolve(backup) };

    const workspace = await createTransientWorkspaceDirectory(
      "workspace-name-backup",
      "sms db",
      options,
    );
    const other = await createTransientWorkspaceDirectory(
      "workspace-name-backup",
      "sms db",
      options,
    );

    expect(workspace.directoryName).toMatch(/^sms_db-[0-9a-f-]{36}$/);
    expect(other.directoryName).toMatch(/^sms_db-[0-9a-f-]{36}$/);
    expect(other.directoryName).not.toBe(workspace.directoryName);
    await workspace.remove();
    await other.remove();

    await expect(
      createTransientWorkspaceDirectory("workspace-name-backup", "", options),
    ).rejects.toThrow("must not be empty");
  });

  it("rejects a workspace directory name that is already in use", async () => {
    const backup = new MemoryDirectory();
    const options = {
      getBackupDirectory: () => Promise.resolve(backup),
      createDirectoryName: () => "db-1",
    };

    const first = await createTransientWorkspaceDirectory(
      "workspace-collision-backup",
      "db",
      options,
    );

    await expect(
      createTransientWorkspaceDirectory("workspace-collision-backup", "db", options),
    ).rejects.toThrow("already in use");
    await first.remove();
  });

  it("deletes a created stub when opening its sync access handle fails", async () => {
    const backup = new MemoryDirectory();
    const area = await openTransientStagingArea("failed-open-backup", {
      getBackupDirectory: () => Promise.resolve(backup),
      createFileName: () => "failed.bin",
    });
    const transient = backup.requireDirectory(transientStagingDirectoryName);
    transient.failNextAccessHandle = true;

    await expect(area.createFile()).rejects.toThrow("sync handle failed");
    expect(transient.hasFile("failed.bin")).toBe(false);
    await area.close();
  });
});

class MemoryDirectory implements TransientStagingDirectoryHandle {
  readonly removedNames: string[] = [];
  failNextAccessHandle = false;
  readonly #directories = new Map<string, MemoryDirectory>();
  readonly #files = new Map<string, MemoryFileHandle>();

  getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<MemoryDirectory> {
    const existing = this.#directories.get(name);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    if (options?.create !== true) {
      return Promise.reject(notFoundError());
    }
    const directory = new MemoryDirectory();
    this.#directories.set(name, directory);
    return Promise.resolve(directory);
  }

  getFileHandle(
    name: string,
    options?: FileSystemGetFileOptions,
  ): Promise<TransientStagingFileHandle> {
    const existing = this.#files.get(name);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    if (options?.create !== true) {
      return Promise.reject(notFoundError());
    }
    const file = new MemoryFileHandle(this.failNextAccessHandle);
    this.failNextAccessHandle = false;
    this.#files.set(name, file);
    return Promise.resolve(file);
  }

  removeEntry(name: string): Promise<void> {
    const removed = this.#files.delete(name) || this.#directories.delete(name);
    if (!removed) {
      return Promise.reject(notFoundError());
    }
    this.removedNames.push(name);
    return Promise.resolve();
  }

  seedDirectory(name: string): MemoryDirectory {
    const directory = new MemoryDirectory();
    this.#directories.set(name, directory);
    return directory;
  }

  seedFile(name: string, bytes: Uint8Array): MemoryFileHandle {
    const file = new MemoryFileHandle(false, bytes);
    this.#files.set(name, file);
    return file;
  }

  requireDirectory(name: string): MemoryDirectory {
    const directory = this.#directories.get(name);
    if (directory === undefined) {
      throw new Error(`Missing test directory: ${name}`);
    }
    return directory;
  }

  requireFile(name: string): MemoryFileHandle {
    const file = this.#files.get(name);
    if (file === undefined) {
      throw new Error(`Missing test file: ${name}`);
    }
    return file;
  }

  hasFile(name: string): boolean {
    return this.#files.has(name);
  }

  hasDirectory(name: string): boolean {
    return this.#directories.has(name);
  }

  fileNames(): string[] {
    return [...this.#files.keys()];
  }

  directoryNames(): string[] {
    return [...this.#directories.keys()];
  }
}

class MemoryFileHandle implements TransientStagingFileHandle {
  readonly accessHandle: MemorySyncAccessHandle;

  constructor(
    private readonly failAccessHandle: boolean,
    initialBytes: Uint8Array = new Uint8Array(),
  ) {
    this.accessHandle = new MemorySyncAccessHandle(initialBytes);
  }

  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
    if (this.failAccessHandle) {
      return Promise.reject(new Error("sync handle failed"));
    }
    return Promise.resolve(this.accessHandle);
  }

  getFile(): Promise<File> {
    return Promise.resolve(
      new File([this.accessHandle.snapshot()], "staged.bin", {
        type: "application/octet-stream",
      }),
    );
  }
}

class MemorySyncAccessHandle implements FileSystemSyncAccessHandle {
  closeCalls = 0;
  #bytes: Uint8Array<ArrayBuffer>;
  #closed = false;

  constructor(initialBytes: Uint8Array) {
    this.#bytes = Uint8Array.from(initialBytes);
  }

  close(): void {
    this.#closed = true;
    this.closeCalls += 1;
  }

  flush(): void {
    this.assertOpen();
  }

  getSize(): number {
    this.assertOpen();
    return this.#bytes.byteLength;
  }

  read(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number {
    this.assertOpen();
    const target = toBytes(buffer);
    const at = options?.at ?? 0;
    const available = Math.max(0, this.#bytes.byteLength - at);
    const length = Math.min(target.byteLength, available);
    target.set(this.#bytes.subarray(at, at + length));
    return length;
  }

  truncate(newSize: number): void {
    this.assertOpen();
    const resized = new Uint8Array(newSize);
    resized.set(this.#bytes.subarray(0, newSize));
    this.#bytes = resized;
  }

  write(buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions): number {
    this.assertOpen();
    const source = toBytes(buffer);
    const at = options?.at ?? 0;
    const requiredSize = at + source.byteLength;
    if (requiredSize > this.#bytes.byteLength) {
      this.truncate(requiredSize);
    }
    this.#bytes.set(source, at);
    return source.byteLength;
  }

  snapshot(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.#bytes);
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new Error("Memory sync handle is closed.");
    }
  }
}

function toBytes(buffer: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new Uint8Array(buffer);
}

function notFoundError(): DOMException {
  return new DOMException("Entry not found.", "NotFoundError");
}
