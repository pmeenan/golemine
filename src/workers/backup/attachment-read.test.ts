import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import {
  iosMiniBackupExpectedMetadata,
  iosMiniBackupUdid,
} from "../../../e2e/fixtures/ios-mini-backup.mjs";
import {
  readUnencryptedSourceFile,
  resetUnencryptedSourceFileCache,
} from "./attachment-read";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e/fixtures/generated/ios-mini-backup",
  iosMiniBackupUdid,
);

beforeEach(() => {
  resetUnencryptedSourceFileCache();
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
