import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  iosMiniBackupExpectedMetadata,
  iosMiniBackupUdid,
  iosMiniEncryptedBackupExpectedMetadata,
  iosMiniEncryptedBackupPassword,
  iosMiniEncryptedBackupUdid,
} from "../../../e2e/fixtures/ios-mini-backup.mjs";
import {
  readSourceFile,
  readUnencryptedSourceFile,
  resetUnencryptedSourceFileCache,
} from "./attachment-read";
import {
  findEncryptedBackupSession,
  resetEncryptedBackupSession,
  unlockBackupSession,
} from "./encrypted-session";
import { UnlockedBackupKeybag } from "./crypto";
import { ManifestDbReader } from "./manifest-db";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e/fixtures/generated/ios-mini-backup",
  iosMiniBackupUdid,
);
const encryptedFixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e/fixtures/generated/ios-mini-encrypted-backup",
  iosMiniEncryptedBackupUdid,
);

beforeEach(async () => {
  resetUnencryptedSourceFileCache();
  await resetEncryptedBackupSession();
});

describe("readUnencryptedSourceFile", () => {
  it("reads and hashes an unencrypted attachment through Manifest.db", async () => {
    const root = new DiskFileSystemDirectory(fixtureRoot, iosMiniBackupUdid);
    const attachment = iosMiniBackupExpectedMetadata.sourceFiles.attachment;
    const result = await readUnencryptedSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniBackupUdid,
        sourceDomain: attachment.domain,
        sourcePath: attachment.relativePath,
        sourceGuid: attachment.guid,
        filename: attachment.transferName,
        mime: attachment.mimeType,
        maxReadBytes: 1024 * 1024,
      },
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.value).toMatchObject({
      backupId: iosMiniBackupUdid,
      sourceDomain: attachment.domain,
      sourcePath: attachment.relativePath,
      sourceGuid: attachment.guid,
      filename: attachment.transferName,
      mime: attachment.mimeType,
      fileId: attachment.fileID,
      domain: attachment.domain,
      relativePath: attachment.relativePath,
    });
    expect(result.value.byteLength).toBeGreaterThan(0);
    expect(result.value.bytes.byteLength).toBe(result.value.byteLength);
    expect(result.value.sourceByteLength).toBe(result.value.byteLength);
    expect(result.value.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("returns a recoverable error when the source file is over the read cap", async () => {
    const root = new DiskFileSystemDirectory(fixtureRoot, iosMiniBackupUdid);
    const attachment = iosMiniBackupExpectedMetadata.sourceFiles.attachment;
    const result = await readUnencryptedSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniBackupUdid,
        sourceDomain: attachment.domain,
        sourcePath: attachment.relativePath,
        maxReadBytes: 1,
      },
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("Expected oversized source read to fail.");
    }

    expect(result.error).toMatchObject({
      worker: "backup",
      code: "backup_access_failed",
      recoverable: true,
    });
  });

  it("reuses the cached detection and Manifest.db reader across sequential reads", async () => {
    const opens = new Map<string, number>();
    const root = new CountingDiskFileSystemDirectory(
      fixtureRoot,
      iosMiniBackupUdid,
      opens,
    );
    const attachment = iosMiniBackupExpectedMetadata.sourceFiles.attachment;
    const request = {
      backupId: iosMiniBackupUdid,
      sourceDomain: attachment.domain,
      sourcePath: attachment.relativePath,
      maxReadBytes: 1024 * 1024,
    };
    const first = await readUnencryptedSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      request,
    );
    const manifestOpensAfterFirstRead = opens.get("Manifest.db") ?? 0;
    const detectionOpensAfterFirstRead = opens.get("Info.plist") ?? 0;
    const second = await readUnencryptedSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      request,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (!first.ok || !second.ok) {
      throw new Error("Expected both cached reads to succeed.");
    }

    expect(second.value.sha256).toBe(first.value.sha256);
    // The second read must reuse the cached ManifestDbReader and detection
    // result instead of re-opening Manifest.db or re-reading the root plists
    // (detection itself touches Manifest.db once, so we assert no additional
    // opens rather than an absolute count).
    expect(manifestOpensAfterFirstRead).toBeGreaterThanOrEqual(1);
    expect(opens.get("Manifest.db")).toBe(manifestOpensAfterFirstRead);
    expect(opens.get("Info.plist") ?? 0).toBe(detectionOpensAfterFirstRead);
  });

  it("evicts the cached reader when the same backupId arrives with a different root", async () => {
    const opens = new Map<string, number>();
    const firstRoot = new CountingDiskFileSystemDirectory(
      fixtureRoot,
      iosMiniBackupUdid,
      opens,
    );
    const secondRoot = new CountingDiskFileSystemDirectory(
      fixtureRoot,
      iosMiniBackupUdid,
      opens,
    );
    const attachment = iosMiniBackupExpectedMetadata.sourceFiles.attachment;
    const request = {
      backupId: iosMiniBackupUdid,
      sourceDomain: attachment.domain,
      sourcePath: attachment.relativePath,
      maxReadBytes: 1024 * 1024,
    };
    const first = await readUnencryptedSourceFile(
      firstRoot as unknown as FileSystemDirectoryHandle,
      request,
    );
    const manifestOpensAfterFirstRead = opens.get("Manifest.db") ?? 0;
    // Same backupId, different root handle: the stale manifest index must not
    // be reused to resolve reads against the new root.
    const second = await readUnencryptedSourceFile(
      secondRoot as unknown as FileSystemDirectoryHandle,
      request,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (!first.ok || !second.ok) {
      throw new Error("Expected both reads to succeed.");
    }

    expect(second.value.sha256).toBe(first.value.sha256);
    expect(manifestOpensAfterFirstRead).toBeGreaterThanOrEqual(1);
    // Eviction forces re-detection and a fresh Manifest.db open from the new
    // root instead of a cache hit.
    expect(opens.get("Manifest.db") ?? 0).toBeGreaterThan(
      manifestOpensAfterFirstRead,
    );
  });

  it("rejects a source file when the expected hash no longer matches", async () => {
    const root = new DiskFileSystemDirectory(fixtureRoot, iosMiniBackupUdid);
    const attachment = iosMiniBackupExpectedMetadata.sourceFiles.attachment;
    const result = await readUnencryptedSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniBackupUdid,
        sourceDomain: attachment.domain,
        sourcePath: attachment.relativePath,
        expectedSha256: "0".repeat(64),
        maxReadBytes: 1024 * 1024,
      },
    );

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("Expected hash mismatch to fail.");
    }

    expect(result.error).toMatchObject({
      worker: "backup",
      code: "backup_access_failed",
      recoverable: true,
    });
    expect(result.error.message).toContain("hash");
  });

  it("requires an in-memory session before reading an encrypted attachment", async () => {
    const root = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const attachment =
      iosMiniEncryptedBackupExpectedMetadata.sourceFiles.attachment;
    const result = await readSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        sourceDomain: attachment.domain,
        sourcePath: attachment.relativePath,
        maxReadBytes: 1024 * 1024,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected an encrypted attachment read to require unlock.");
    }
    expect(result.error).toMatchObject({
      code: "backup_password_required",
      recoverable: true,
    });
  });

  it("decrypts and hashes an attachment after one session unlock", async () => {
    const root = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const unlockRequest = {
      backupId: iosMiniEncryptedBackupUdid,
      password: iosMiniEncryptedBackupPassword,
    };
    let passwordDuringKdf: string | undefined;
    const unlock = await unlockBackupSession(
      root as unknown as FileSystemDirectoryHandle,
      unlockRequest,
      (event) => {
        if (event.phase === "unlocking") {
          passwordDuringKdf = unlockRequest.password;
        }
      },
    );
    expect(unlock.ok).toBe(true);
    expect(unlockRequest.password).toBe("");
    expect(passwordDuringKdf).toBe("");

    const attachment =
      iosMiniEncryptedBackupExpectedMetadata.sourceFiles.attachment;
    const result = await readSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        sourceDomain: attachment.domain,
        sourcePath: attachment.relativePath,
        maxReadBytes: 1024 * 1024,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    expect(result.value.isEncrypted).toBe(true);
    expect(result.value.sourceByteLength).toBeGreaterThan(0);
    expect(result.value.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.value.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.value.sha256).not.toBe(result.value.sourceSha256);
    expect(result.value.byteLength).toBe(result.value.bytes.byteLength);
  });

  it("evicts encrypted keys when the same backup id is supplied from a different root handle", async () => {
    const firstRoot = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const secondRoot = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const unlock = await unlockBackupSession(
      firstRoot as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        password: iosMiniEncryptedBackupPassword,
      },
    );
    expect(unlock.ok).toBe(true);

    const attachment =
      iosMiniEncryptedBackupExpectedMetadata.sourceFiles.attachment;
    const result = await readSourceFile(
      secondRoot as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        sourceDomain: attachment.domain,
        sourcePath: attachment.relativePath,
        maxReadBytes: 1024 * 1024,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected root identity mismatch to clear the session.");
    }
    expect(result.error.code).toBe("backup_password_required");
  });

  it("serializes concurrent different-root opens and final lock destroys every published context", async () => {
    const firstRoot = new DeferredIdentityDiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const secondRoot = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const manifestClose = vi.spyOn(ManifestDbReader.prototype, "close");
    const keybagDestroy = vi.spyOn(UnlockedBackupKeybag.prototype, "destroy");
    const firstStarted = deferredSignal();

    try {
      const firstOpen = unlockBackupSession(
        firstRoot as unknown as FileSystemDirectoryHandle,
        {
          backupId: iosMiniEncryptedBackupUdid,
          password: iosMiniEncryptedBackupPassword,
        },
        (event) => {
          if (event.phase === "unlocking") {
            firstStarted.resolve();
          }
        },
      );
      await firstStarted.promise;
      const secondOpen = unlockBackupSession(
        secondRoot as unknown as FileSystemDirectoryHandle,
        {
          backupId: iosMiniEncryptedBackupUdid,
          password: iosMiniEncryptedBackupPassword,
        },
      );

      expect((await firstOpen).ok).toBe(true);
      await firstRoot.identityCompared.promise;
      firstRoot.resolveIdentity(false);
      expect((await secondOpen).ok).toBe(true);

      await resetEncryptedBackupSession();

      expect(manifestClose).toHaveBeenCalledTimes(2);
      expect(keybagDestroy).toHaveBeenCalledTimes(2);
      expect(
        await findEncryptedBackupSession(
          secondRoot as unknown as FileSystemDirectoryHandle,
          iosMiniEncryptedBackupUdid,
        ),
      ).toBeUndefined();
    } finally {
      await resetEncryptedBackupSession();
      manifestClose.mockRestore();
      keybagDestroy.mockRestore();
    }
  });

  it("a lock during deferred root comparison cancels the in-flight replacement open", async () => {
    const firstRoot = new DeferredIdentityDiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const secondRoot = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const manifestClose = vi.spyOn(ManifestDbReader.prototype, "close");
    const keybagDestroy = vi.spyOn(UnlockedBackupKeybag.prototype, "destroy");

    try {
      const firstOpen = await unlockBackupSession(
        firstRoot as unknown as FileSystemDirectoryHandle,
        {
          backupId: iosMiniEncryptedBackupUdid,
          password: iosMiniEncryptedBackupPassword,
        },
      );
      expect(firstOpen.ok).toBe(true);

      const secondOpen = unlockBackupSession(
        secondRoot as unknown as FileSystemDirectoryHandle,
        {
          backupId: iosMiniEncryptedBackupUdid,
          password: iosMiniEncryptedBackupPassword,
        },
      );
      await firstRoot.identityCompared.promise;

      const lock = resetEncryptedBackupSession();
      firstRoot.resolveIdentity(false);
      await lock;

      const result = await secondOpen;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected session lock to cancel replacement unlock.");
      }
      expect(result.error.code).toBe("backup_password_required");
      expect(manifestClose).toHaveBeenCalledTimes(1);
      expect(keybagDestroy).toHaveBeenCalledTimes(1);
      expect(
        await findEncryptedBackupSession(
          secondRoot as unknown as FileSystemDirectoryHandle,
          iosMiniEncryptedBackupUdid,
        ),
      ).toBeUndefined();
    } finally {
      await resetEncryptedBackupSession();
      manifestClose.mockRestore();
      keybagDestroy.mockRestore();
    }
  });

  it("different-root replacement aborts a read after its first decrypted chunk", async () => {
    const firstRoot = new DeferredIdentityDiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const secondRoot = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const unlocked = await unlockBackupSession(
      firstRoot as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        password: iosMiniEncryptedBackupPassword,
      },
    );
    expect(unlocked.ok).toBe(true);
    const session = await findEncryptedBackupSession(
      firstRoot as unknown as FileSystemDirectoryHandle,
      iosMiniEncryptedBackupUdid,
    );
    if (session === undefined) {
      throw new Error("Expected the encrypted session to be active.");
    }
    const attachment =
      iosMiniEncryptedBackupExpectedMetadata.sourceFiles.attachment;
    const record = session.manifest.requireFile(
      attachment.domain,
      attachment.relativePath,
    );
    const firstChunkDecrypted = deferredSignal();
    const releaseChunk = deferredSignal();
    let chunkCount = 0;
    const sourceRead = session.readSourceFile(record, {
      maxReadBytes: 1024 * 1024,
      decryptChunkBytes: 16,
      decryptProgress: async () => {
        chunkCount += 1;
        if (chunkCount === 1) {
          firstChunkDecrypted.resolve();
          await releaseChunk.promise;
        }
      },
    });

    await firstChunkDecrypted.promise;
    const replacement = unlockBackupSession(
      secondRoot as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        password: iosMiniEncryptedBackupPassword,
      },
    );
    let replacementSettled = false;
    void replacement.finally(() => {
      replacementSettled = true;
    });
    await firstRoot.identityCompared.promise;
    firstRoot.resolveIdentity(false);
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    releaseChunk.resolve();
    await expect(sourceRead).rejects.toMatchObject({
      code: "backup_password_required",
    });
    expect((await replacement).ok).toBe(true);
    await resetEncryptedBackupSession();
  });

  it("re-verifies a supplied password even when a matching session is active", async () => {
    const root = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const unlocked = await unlockBackupSession(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        password: iosMiniEncryptedBackupPassword,
      },
    );
    expect(unlocked.ok).toBe(true);

    try {
      // A wrong password must never report success just because an unlocked
      // session for the same backup/root is already active in this worker.
      const wrongPassword = await unlockBackupSession(
        root as unknown as FileSystemDirectoryHandle,
        {
          backupId: iosMiniEncryptedBackupUdid,
          password: "definitely-wrong",
        },
      );
      expect(wrongPassword.ok).toBe(false);
      if (wrongPassword.ok) {
        throw new Error("Expected the wrong password to be rejected.");
      }
      expect(wrongPassword.error.code).toBe("backup_password_incorrect");

      // Supplying the correct password again replaces the session and works.
      const reUnlocked = await unlockBackupSession(
        root as unknown as FileSystemDirectoryHandle,
        {
          backupId: iosMiniEncryptedBackupUdid,
          password: iosMiniEncryptedBackupPassword,
        },
      );
      expect(reUnlocked.ok).toBe(true);
    } finally {
      await resetEncryptedBackupSession();
    }
  });

  it("a lock during final progress prevents old-session plaintext from returning", async () => {
    const root = new DiskFileSystemDirectory(
      encryptedFixtureRoot,
      iosMiniEncryptedBackupUdid,
    );
    const unlocked = await unlockBackupSession(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        password: iosMiniEncryptedBackupPassword,
      },
    );
    expect(unlocked.ok).toBe(true);
    const session = await findEncryptedBackupSession(
      root as unknown as FileSystemDirectoryHandle,
      iosMiniEncryptedBackupUdid,
    );
    if (session === undefined) {
      throw new Error("Expected the encrypted session to be active.");
    }
    const originalRead = session.readSourceFile.bind(session);
    let plaintext: Uint8Array | undefined;
    session.readSourceFile = async (record, options) => {
      const source = await originalRead(record, options);
      plaintext = source.bytes;
      return source;
    };
    const finalProgressStarted = deferredSignal();
    const releaseFinalProgress = deferredSignal();
    const attachment =
      iosMiniEncryptedBackupExpectedMetadata.sourceFiles.attachment;
    const read = readSourceFile(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: iosMiniEncryptedBackupUdid,
        sourceDomain: attachment.domain,
        sourcePath: attachment.relativePath,
        maxReadBytes: 1024 * 1024,
      },
      async (event) => {
        if (event.phase === "complete") {
          finalProgressStarted.resolve();
          await releaseFinalProgress.promise;
        }
      },
    );

    await finalProgressStarted.promise;
    await resetEncryptedBackupSession();
    releaseFinalProgress.resolve();

    const result = await read;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected the locked read to reject old-session plaintext.");
    }
    expect(result.error.code).toBe("backup_password_required");
    expect(plaintext).toBeDefined();
    expect(Array.from(plaintext ?? []).every((byte) => byte === 0)).toBe(true);
  });
});

class DiskFileSystemDirectory {
  readonly kind = "directory";

  constructor(
    private readonly absolutePath: string,
    readonly name: string,
  ) {}

  // Reference identity stands in for Chrome's underlying-entry comparison:
  // reusing the same instance models re-reads from the same picked directory,
  // while a fresh instance models a different root handle for the same id.
  isSameEntry(other: unknown): Promise<boolean> {
    return Promise.resolve(other === this);
  }

  async *entries(): AsyncIterableIterator<
    [string, DiskFileSystemDirectory | DiskFileSystemFile]
  > {
    for (const entry of await readdir(this.absolutePath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        yield [
          entry.name,
          new DiskFileSystemDirectory(path.join(this.absolutePath, entry.name), entry.name),
        ];
      } else if (entry.isFile()) {
        yield [
          entry.name,
          new DiskFileSystemFile(path.join(this.absolutePath, entry.name), entry.name),
        ];
      }
    }
  }

  getDirectoryHandle(name: string): Promise<DiskFileSystemDirectory> {
    return Promise.resolve(
      new DiskFileSystemDirectory(path.join(this.absolutePath, name), name),
    );
  }

  getFileHandle(name: string): Promise<DiskFileSystemFile> {
    return Promise.resolve(
      new DiskFileSystemFile(path.join(this.absolutePath, name), name),
    );
  }
}

class CountingDiskFileSystemDirectory extends DiskFileSystemDirectory {
  constructor(
    absolutePath: string,
    name: string,
    private readonly opens: Map<string, number>,
  ) {
    super(absolutePath, name);
  }

  override getFileHandle(name: string): Promise<DiskFileSystemFile> {
    this.opens.set(name, (this.opens.get(name) ?? 0) + 1);

    return super.getFileHandle(name);
  }
}

class DeferredIdentityDiskFileSystemDirectory extends DiskFileSystemDirectory {
  readonly identityCompared = deferredSignal();
  private readonly identityResult = deferred<boolean>();

  override isSameEntry(other: unknown): Promise<boolean> {
    if (other === this) {
      return Promise.resolve(true);
    }

    this.identityCompared.resolve();
    return this.identityResult.promise;
  }

  resolveIdentity(value: boolean): void {
    this.identityResult.resolve(value);
  }
}

class DiskFileSystemFile {
  readonly kind = "file";

  constructor(
    private readonly absolutePath: string,
    readonly name: string,
  ) {}

  async getFile(): Promise<File> {
    const bytes = Uint8Array.from(await readFile(this.absolutePath));

    return new File([bytes], this.name);
  }
}

interface Deferred<TValue> {
  promise: Promise<TValue>;
  resolve(value: TValue): void;
}

interface DeferredSignal {
  promise: Promise<void>;
  resolve(): void;
}

function deferred<TValue>(): Deferred<TValue> {
  let resolvePromise = (_value: TValue): void => undefined;
  const promise = new Promise<TValue>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}

function deferredSignal(): DeferredSignal {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}
