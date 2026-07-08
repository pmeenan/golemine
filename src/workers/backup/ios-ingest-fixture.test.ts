import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { derivedDbVersion } from "../../lib/constants";
import {
  type IngestSinkApi,
  workerOk,
} from "../../lib/worker-types";
import {
  iosMiniBackupExpectedAvatarWarnings,
  iosMiniBackupExpectedMessages,
  iosMiniBackupExpectedMetadata,
  iosMiniBackupUdid,
} from "../../../e2e/fixtures/ios-mini-backup.mjs";
import {
  ManifestDbReader,
  readSourceFileBytes,
} from "./manifest-db";
import { ingestUnencryptedBackupDirectory } from "./ios-ingest";
import { normalizeIosMessages } from "./ios-normalize";
import type {
  ReadonlySourceDirectoryHandle,
  ReadonlySourceHandle,
} from "./read-only-source";
import { openSourceSqliteDatabase, type SourceSqliteDatabase } from "./source-sqlite";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../e2e/fixtures/generated/ios-mini-backup",
  iosMiniBackupUdid,
);

describe("iOS M2 ingest fixture", () => {
  it("reads Manifest.db file records and MBFile metadata", async () => {
    const root = new DiskReadonlyDirectory(fixtureRoot, iosMiniBackupUdid);
    const manifest = await ManifestDbReader.open(root);

    try {
      const sms = manifest.requireFile(
        iosMiniBackupExpectedMetadata.sourceFiles.smsDb.domain,
        iosMiniBackupExpectedMetadata.sourceFiles.smsDb.relativePath,
      );
      const smsWal = manifest.requireFile(
        iosMiniBackupExpectedMetadata.sourceFiles.smsDbWal.domain,
        iosMiniBackupExpectedMetadata.sourceFiles.smsDbWal.relativePath,
      );

      expect(sms.fileId).toBe(iosMiniBackupExpectedMetadata.sourceFiles.smsDb.fileID);
      expect(sms.metadata.size).toBeGreaterThan(0);
      expect(sms.metadata.encryptionKey).toBeUndefined();
      expect(smsWal.fileId).toBe(
        iosMiniBackupExpectedMetadata.sourceFiles.smsDbWal.fileID,
      );

      const smsBytes = await readSourceFileBytes(root, sms);
      expect(smsBytes.sha256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      manifest.close();
    }
  });

  it("normalizes messages, contacts, avatars, reactions, attachments, and WAL rows", async () => {
    const root = new DiskReadonlyDirectory(fixtureRoot, iosMiniBackupUdid);
    const manifest = await ManifestDbReader.open(root);
    const opened: SourceSqliteDatabase[] = [];

    try {
      const smsDb = await openFixtureDatabase(root, manifest, "smsDb", "smsDbWal");
      const contactsDb = await openFixtureDatabase(
        root,
        manifest,
        "addressBookDb",
        "addressBookDbWal",
      );
      const contactImagesDb = await openFixtureDatabase(
        root,
        manifest,
        "addressBookImagesDb",
      );
      opened.push(smsDb, contactsDb, contactImagesDb);

      const normalized = await normalizeIosMessages({
        smsDb: smsDb.db,
        contactsDb: contactsDb.db,
        contactImagesDb: contactImagesDb.db,
        manifest,
        root,
      });

      expect(normalized.messages).toHaveLength(
        iosMiniBackupExpectedMetadata.counts.normalizedMessages,
      );
      expect(normalized.conversations).toHaveLength(
        iosMiniBackupExpectedMetadata.counts.conversations,
      );
      expect(normalized.reactions).toHaveLength(
        iosMiniBackupExpectedMetadata.counts.reactions,
      );
      expect(normalized.attachments).toHaveLength(
        iosMiniBackupExpectedMetadata.counts.attachments,
      );
      expect(normalized.contactAvatars).toHaveLength(
        iosMiniBackupExpectedMetadata.counts.avatarThumbnails,
      );
      expect(normalized.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "contact-avatar-unreadable",
            source: String(iosMiniBackupExpectedAvatarWarnings[0].recordId),
          }),
        ]),
      );

      for (const expected of iosMiniBackupExpectedMessages) {
        const message = normalized.messages.find(
          (item) => item.sourceRowId === expected.sourceRowId,
        );

        expect(message, expected.guid).toBeDefined();
        expect(message?.body).toBe(expected.body);
        expect(message?.sentAtUtc).toBe(expected.sentAtUtc);
      }

      expect(
        normalized.messages.some((message) =>
          message.sourceGuid === "GOLEMINE-MSG-TAPBACK-0005"
        ),
      ).toBe(false);
      expect(
        normalized.messages.some((message) =>
          message.sourceGuid === "GOLEMINE-MSG-GROUP-WAL-0006"
        ),
      ).toBe(true);
      expect(normalized.attachments[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(normalized.participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            handle: "+15550104000",
            contactName: "Avery Cipher",
          }),
        ]),
      );
    } finally {
      for (const database of opened) {
        database.close();
      }
      manifest.close();
    }
  });

  it("rejects a stale recent request before preparing the db sink", async () => {
    const root = new DiskFileSystemDirectory(fixtureRoot, iosMiniBackupUdid);
    const prepareIngest = vi.fn<IngestSinkApi["prepareIngest"]>(() =>
      Promise.resolve(
        workerOk({ backupId: "stale-backup", kind: "prepare", accepted: 0 }),
      ),
    );
    const writeIngestBatch = vi.fn<IngestSinkApi["writeIngestBatch"]>((batch) =>
      Promise.resolve(
        workerOk({ backupId: batch.backupId, kind: batch.kind, accepted: 0 }),
      ),
    );
    const finalizeIngest = vi.fn<IngestSinkApi["finalizeIngest"]>((report) =>
      Promise.resolve(
        workerOk({
          ...report,
          databaseName: "golemine.sqlite",
          derivedDbVersion,
        }),
      ),
    );
    const sink: IngestSinkApi = {
      prepareIngest,
      writeIngestBatch,
      finalizeIngest,
    };

    const result = await ingestUnencryptedBackupDirectory(
      root as unknown as FileSystemDirectoryHandle,
      {
        backupId: "stale-backup",
        provider: "ios-itunes",
        sourceKind: "itunes-finder",
        sourceFolderName: "stale-backup",
        friendlyName: "Stale backup",
        deviceInfo: { udid: "stale-backup" },
        isEncrypted: false,
        derivedDbVersion,
      },
      sink,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected stale ingest to fail.");
    }
    expect(result.error.code).toBe("backup_invalid");
    expect(prepareIngest).not.toHaveBeenCalled();
  });
});

async function openFixtureDatabase(
  root: ReadonlySourceDirectoryHandle,
  manifest: ManifestDbReader,
  mainKey: keyof typeof iosMiniBackupExpectedMetadata.sourceFiles,
  walKey?: keyof typeof iosMiniBackupExpectedMetadata.sourceFiles,
): Promise<SourceSqliteDatabase> {
  const mainInfo = iosMiniBackupExpectedMetadata.sourceFiles[mainKey];
  const main = await readSourceFileBytes(
    root,
    manifest.requireFile(mainInfo.domain, mainInfo.relativePath),
  );
  const walInfo =
    walKey === undefined ? undefined : iosMiniBackupExpectedMetadata.sourceFiles[walKey];
  const wal =
    walInfo === undefined
      ? undefined
      : await readSourceFileBytes(
          root,
          manifest.requireFile(walInfo.domain, walInfo.relativePath),
        );

  return openSourceSqliteDatabase({
    label: mainKey,
    main: main.bytes,
    ...(wal === undefined ? {} : { wal: wal.bytes }),
  });
}

class DiskReadonlyDirectory implements ReadonlySourceDirectoryHandle {
  readonly kind = "directory";

  constructor(
    private readonly absolutePath: string,
    readonly name: string,
  ) {}

  async *entries(): AsyncIterableIterator<[string, ReadonlySourceHandle]> {
    for (const entry of await readdir(this.absolutePath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        yield [
          entry.name,
          new DiskReadonlyDirectory(path.join(this.absolutePath, entry.name), entry.name),
        ];
      } else if (entry.isFile()) {
        yield [
          entry.name,
          new DiskReadonlyFile(path.join(this.absolutePath, entry.name), entry.name),
        ];
      }
    }
  }

  getDirectory(name: string): Promise<ReadonlySourceDirectoryHandle> {
    return Promise.resolve(
      new DiskReadonlyDirectory(path.join(this.absolutePath, name), name),
    );
  }

  async getFile(name: string): Promise<File> {
    return new DiskReadonlyFile(path.join(this.absolutePath, name), name).getFile();
  }
}

class DiskReadonlyFile {
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

class DiskFileSystemDirectory {
  readonly kind = "directory";

  constructor(
    private readonly absolutePath: string,
    readonly name: string,
  ) {}

  async *entries(): AsyncIterableIterator<[string, DiskFileSystemDirectory | DiskFileSystemFile]> {
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
