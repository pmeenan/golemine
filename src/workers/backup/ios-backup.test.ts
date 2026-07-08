import { describe, expect, it } from "vitest";
import {
  iosMiniBackupDevice,
  iosMiniBackupInfoPlist,
  plistDict,
} from "../../../e2e/fixtures/ios-mini-backup.mjs";
import type {
  ReadonlySourceDirectoryHandle,
  ReadonlySourceHandle,
} from "./read-only-source";
import {
  BackupDetectionError,
  detectBackupDirectory,
  detectIosBackup,
} from "./ios-backup";

describe("iOS backup detection", () => {
  it("detects a valid iTunes/Finder backup from read-only source handles", async () => {
    const root = new SyntheticReadonlyDirectory(
      iosMiniBackupDevice.udid,
      backupFiles(),
    );

    const result = await detectIosBackup(root);

    expect(result).toEqual({
      provider: "ios-itunes",
      sourceKind: "itunes-finder",
      id: iosMiniBackupDevice.udid,
      friendlyName: iosMiniBackupDevice.displayName,
      sourceFolderName: iosMiniBackupDevice.udid,
      isEncrypted: true,
      deviceInfo: {
        udid: iosMiniBackupDevice.udid,
        name: iosMiniBackupDevice.deviceName,
        model: iosMiniBackupDevice.productType,
        osVersion: iosMiniBackupDevice.productVersion,
        serialNumber: iosMiniBackupDevice.serialNumber,
        phoneNumber: iosMiniBackupDevice.phoneNumber,
      },
      lastBackupDate: "2026-07-01T12:34:56.000Z",
      backupFormatVersion: "10.0",
      backupDate: "2026-07-01T12:35:10.000Z",
    });
  });

  it("reports missing required root files as a non-backup folder", async () => {
    const root = new SyntheticReadonlyDirectory(
      "not-a-backup",
      new Map([["Info.plist", file("Info.plist", minimalInfoPlist())]]),
    );

    await expect(detectIosBackup(root)).rejects.toMatchObject({
      code: "backup_not_found",
      message:
        "This folder does not look like an iTunes/Finder backup. Missing Manifest.plist, Manifest.db and Status.plist.",
    });
  });

  it("converts malformed plist input into a WorkerResult error", async () => {
    const rawRoot = new SyntheticRawDirectory("malformed-backup", backupFiles({
      "Info.plist": file("Info.plist", "<plist><dict>"),
    }));

    const result = await detectBackupDirectory(rawRoot.asDirectoryHandle());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        worker: "backup",
        code: "backup_parse_failed",
        message: "Info.plist could not be parsed as a plist.",
        recoverable: true,
      });
    }
    expect(rawRoot.fileRequests.every((request) => request.create === false)).toBe(
      true,
    );
  });

  it("requires Manifest.plist to carry the IsEncrypted flag", async () => {
    const root = new SyntheticReadonlyDirectory("missing-encryption-flag", backupFiles({
      "Manifest.plist": file(
        "Manifest.plist",
        plistDict(`
          <key>Version</key>
          <string>10.0</string>
        `),
      ),
    }));

    await expect(detectIosBackup(root)).rejects.toBeInstanceOf(
      BackupDetectionError,
    );
    await expect(detectIosBackup(root)).rejects.toMatchObject({
      code: "backup_invalid",
      message: "Manifest.plist is missing the IsEncrypted flag.",
    });
  });

  it("requires encrypted backups to carry ManifestKey metadata", async () => {
    const root = new SyntheticReadonlyDirectory("missing-manifest-key", backupFiles({
      "Manifest.plist": file(
        "Manifest.plist",
        plistDict(`
          <key>IsEncrypted</key>
          <true/>
          <key>BackupKeyBag</key>
          <data>AQID</data>
        `),
      ),
    }));

    await expect(detectIosBackup(root)).rejects.toMatchObject({
      code: "backup_invalid",
      message: "Encrypted Manifest.plist is missing ManifestKey.",
    });
  });

  it("requires encrypted backup key metadata to be non-empty", async () => {
    const root = new SyntheticReadonlyDirectory("empty-manifest-key", backupFiles({
      "Manifest.plist": file(
        "Manifest.plist",
        plistDict(`
          <key>IsEncrypted</key>
          <true/>
          <key>BackupKeyBag</key>
          <data>AQID</data>
          <key>ManifestKey</key>
          <data></data>
        `),
      ),
    }));

    await expect(detectIosBackup(root)).rejects.toMatchObject({
      code: "backup_invalid",
      message: "Encrypted Manifest.plist is missing ManifestKey.",
    });
  });

  it("requires unencrypted Manifest.db to have a SQLite header", async () => {
    const root = new SyntheticReadonlyDirectory("bad-manifest-db", backupFiles({
      "Manifest.plist": file(
        "Manifest.plist",
        plistDict(`
          <key>IsEncrypted</key>
          <false/>
        `),
      ),
      "Manifest.db": file("Manifest.db", "not sqlite"),
    }));

    await expect(detectIosBackup(root)).rejects.toMatchObject({
      code: "backup_invalid",
      message: "Manifest.db is not a SQLite database.",
    });
  });

  it("rejects oversized root plist metadata before reading it into memory", async () => {
    const root = new SyntheticReadonlyDirectory("oversized-info", backupFiles({
      "Info.plist": file("Info.plist", new Uint8Array(9 * 1024 * 1024)),
    }));

    await expect(detectIosBackup(root)).rejects.toMatchObject({
      code: "backup_invalid",
      message: "Info.plist is too large to be a normal backup metadata plist.",
    });
  });
});

function backupFiles(
  overrides: Record<string, File> = {},
): ReadonlyMap<string, File> {
  return new Map(
    Object.entries({
      "Info.plist": file("Info.plist", minimalInfoPlist()),
      "Manifest.plist": file(
        "Manifest.plist",
        plistDict(`
          <key>IsEncrypted</key>
          <true/>
          <key>BackupKeyBag</key>
          <data>AQID</data>
          <key>ManifestKey</key>
          <data>BAUG</data>
          <key>Version</key>
          <string>10.0</string>
          <key>Date</key>
          <date>2026-07-01T12:35:10Z</date>
        `),
      ),
      "Manifest.db": file("Manifest.db", "SQLite format 3\u0000synthetic"),
      "Status.plist": file(
        "Status.plist",
        plistDict(`
          <key>SnapshotState</key>
          <string>finished</string>
        `),
      ),
      ...overrides,
    }),
  );
}

function minimalInfoPlist(): string {
  return iosMiniBackupInfoPlist();
}

function file(name: string, content: string | Uint8Array): File {
  if (typeof content === "string") {
    return new File([content], name);
  }

  return new File([copyToArrayBuffer(content)], name);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

class SyntheticReadonlyDirectory implements ReadonlySourceDirectoryHandle {
  readonly kind = "directory";

  constructor(
    readonly name: string,
    private readonly files: ReadonlyMap<string, File>,
  ) {}

  entries(): AsyncIterableIterator<[string, ReadonlySourceHandle]> {
    return syntheticReadonlyEntries(this.files);
  }

  getDirectory(_name: string): Promise<ReadonlySourceDirectoryHandle> {
    return Promise.reject(notFoundError());
  }

  getFile(name: string): Promise<File> {
    const fileValue = this.files.get(name);

    if (fileValue === undefined) {
      return Promise.reject(notFoundError());
    }

    return Promise.resolve(fileValue);
  }
}

class SyntheticRawDirectory {
  readonly kind = "directory";
  readonly fileRequests: { name: string; create: boolean | undefined }[] = [];

  constructor(
    readonly name: string,
    private readonly files: ReadonlyMap<string, File>,
  ) {}

  asDirectoryHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<SyntheticRawFileHandle> {
    this.fileRequests.push({ name, create: options?.create });
    const fileValue = this.files.get(name);

    if (fileValue === undefined) {
      return Promise.reject(notFoundError());
    }

    return Promise.resolve(new SyntheticRawFileHandle(name, fileValue));
  }

  getDirectoryHandle(_name: string): Promise<SyntheticRawDirectory> {
    return Promise.reject(notFoundError());
  }
}

class SyntheticRawFileHandle {
  readonly kind = "file";

  constructor(
    readonly name: string,
    private readonly fileValue: File,
  ) {}

  getFile(): Promise<File> {
    return Promise.resolve(this.fileValue);
  }
}

async function* syntheticReadonlyEntries(
  files: ReadonlyMap<string, File>,
): AsyncIterableIterator<[string, ReadonlySourceHandle]> {
  await Promise.resolve();

  for (const [name, fileValue] of files) {
    yield [
      name,
      {
        kind: "file",
        name,
        getFile: () => Promise.resolve(fileValue),
      },
    ];
  }
}

function notFoundError(): Error {
  const error = new Error("Synthetic handle is missing.");
  error.name = "NotFoundError";
  return error;
}
