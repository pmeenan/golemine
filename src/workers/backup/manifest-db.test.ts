import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  ManifestDbReader,
  maxEncryptedManifestDatabaseBytes,
  SourceFileDecryptionError,
  SourceFileTooLargeError,
  readEncryptedSourceFileBytes,
  readSourceFileBytes,
} from "./manifest-db";
import type {
  ReadonlySourceDirectoryHandle,
  ReadonlySourceHandle,
} from "./read-only-source";

describe("ManifestDbReader", () => {
  it("applies the root Manifest.db WAL sidecar before querying Files", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "golemine-manifest-"));
    const dbPath = path.join(tempDirectory, "Manifest.db");
    const db = new DatabaseSync(dbPath);

    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE Files (
          fileID TEXT PRIMARY KEY,
          domain TEXT,
          relativePath TEXT,
          flags INTEGER,
          file BLOB
        );
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      db.prepare(`
        INSERT INTO Files (fileID, domain, relativePath, flags, file)
        VALUES (?, ?, ?, ?, NULL);
      `).run(
        "3d0d7e5fb2ce288813306e4d4636395e047a3d28",
        "HomeDomain",
        "Library/SMS/sms.db",
        1,
      );

      const root = new MemoryReadonlyDirectory(
        new Map([
          ["Manifest.db", Uint8Array.from(await readFile(dbPath))],
          ["Manifest.db-wal", Uint8Array.from(await readFile(`${dbPath}-wal`))],
        ]),
      );
      const manifest = await ManifestDbReader.open(root);

      try {
        expect(
          manifest.requireFile("HomeDomain", "Library/SMS/sms.db"),
        ).toMatchObject({
          fileId: "3d0d7e5fb2ce288813306e4d4636395e047a3d28",
          flags: 1,
        });
        expect(manifest.sourceFiles.map((file) => file.relativePath)).toEqual([
          "Manifest.db",
          "Manifest.db-wal",
        ]);
      } finally {
        manifest.close();
      }

      let ciphertext: Uint8Array | undefined;
      let plaintext: Uint8Array | undefined;
      const encryptedRoot = new MemoryReadonlyDirectory(
        new Map([["Manifest.db", Uint8Array.from(await readFile(dbPath))]]),
      );
      const decryptedManifest = await ManifestDbReader.open(encryptedRoot, {
        decryptMain: (bytes) => {
          ciphertext = bytes;
          plaintext = bytes.slice();
          return Promise.resolve(plaintext);
        },
      });

      try {
        expect(ciphertext).toBeDefined();
        expect(plaintext).toBeDefined();
        expect(Array.from(ciphertext ?? []).every((byte) => byte === 0)).toBe(
          true,
        );
        expect(Array.from(plaintext ?? []).every((byte) => byte === 0)).toBe(
          true,
        );
      } finally {
        decryptedManifest.close();
      }
    } finally {
      db.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rejects malformed encrypted source shape before invoking the decryptor", async () => {
    const decryptChunks = vi.fn(() => emptyChunks());
    const malformedFile = new File([new ArrayBuffer(15)], "ciphertext");
    const shard = {
      kind: "directory" as const,
      name: "aa",
      entries: emptyEntries,
      getDirectory: () => Promise.reject(createNotFoundError()),
      getFile: () => Promise.resolve(malformedFile),
    } satisfies ReadonlySourceDirectoryHandle;
    const root = {
      kind: "directory" as const,
      name: "root",
      entries: emptyEntries,
      getDirectory: () => Promise.resolve(shard),
      getFile: () => Promise.reject(createNotFoundError()),
    } satisfies ReadonlySourceDirectoryHandle;

    await expect(
      readEncryptedSourceFileBytes(
        root,
        {
          fileId: "aa00000000000000000000000000000000000000",
          domain: "MediaDomain",
          relativePath: "Library/SMS/Attachments/malformed.bin",
          flags: 1,
          metadata: { size: 14 },
        },
        {
          plaintextSize: 14,
          maxReadBytes: 1024,
          decryptChunks,
        },
      ),
    ).rejects.toBeInstanceOf(SourceFileDecryptionError);
    expect(decryptChunks).not.toHaveBeenCalled();
  });

  it("rejects an oversized encrypted Manifest.db before reading or decrypting it", async () => {
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    const decryptMain = vi.fn((bytes: Uint8Array) => Promise.resolve(bytes));
    const oversizedManifest = {
      size: maxEncryptedManifestDatabaseBytes + 1,
      arrayBuffer,
    } as unknown as File;
    const root = {
      kind: "directory" as const,
      name: "root",
      entries: emptyEntries,
      getDirectory: () => Promise.reject(createNotFoundError()),
      getFile: (name: string) =>
        name === "Manifest.db"
          ? Promise.resolve(oversizedManifest)
          : Promise.reject(createNotFoundError()),
    } satisfies ReadonlySourceDirectoryHandle;

    await expect(
      ManifestDbReader.open(root, { decryptMain }),
    ).rejects.toBeInstanceOf(SourceFileTooLargeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(decryptMain).not.toHaveBeenCalled();
  });

  it("accepts a block-aligned encrypted source tail beyond its declared size", async () => {
    const ciphertext = new Uint8Array(64);
    const plaintext = new Uint8Array(16).fill(0x4a);
    const shard = {
      kind: "directory" as const,
      name: "aa",
      entries: emptyEntries,
      getDirectory: () => Promise.reject(createNotFoundError()),
      getFile: () => Promise.resolve(fileFromBytes(ciphertext, "ciphertext")),
    } satisfies ReadonlySourceDirectoryHandle;
    const root = {
      kind: "directory" as const,
      name: "root",
      entries: emptyEntries,
      getDirectory: () => Promise.resolve(shard),
      getFile: () => Promise.reject(createNotFoundError()),
    } satisfies ReadonlySourceDirectoryHandle;

    const source = await readEncryptedSourceFileBytes(
      root,
      {
        fileId: "aa00000000000000000000000000000000000000",
        domain: "HomeDomain",
        relativePath: "Library/SMS/sms.db",
        flags: 1,
        metadata: { size: plaintext.byteLength },
      },
      {
        plaintextSize: plaintext.byteLength,
        maxReadBytes: 1024,
        decryptChunks: () => oneChunk(plaintext),
      },
    );

    expect(source.bytes).toEqual(plaintext);
    expect(source.sourceByteLength).toBe(ciphertext.byteLength);
  });

  it("zero-extends an encrypted sparse prefix to its declared logical size", async () => {
    const ciphertext = new Uint8Array(16);
    const materialized = new Uint8Array(16).fill(0x4a);
    const plaintextSize = 48;
    const shard = {
      kind: "directory" as const,
      name: "aa",
      entries: emptyEntries,
      getDirectory: () => Promise.reject(createNotFoundError()),
      getFile: () => Promise.resolve(fileFromBytes(ciphertext, "ciphertext")),
    } satisfies ReadonlySourceDirectoryHandle;
    const root = {
      kind: "directory" as const,
      name: "root",
      entries: emptyEntries,
      getDirectory: () => Promise.resolve(shard),
      getFile: () => Promise.reject(createNotFoundError()),
    } satisfies ReadonlySourceDirectoryHandle;

    const source = await readEncryptedSourceFileBytes(
      root,
      {
        fileId: "aa00000000000000000000000000000000000000",
        domain: "HomeDomain",
        relativePath: "Library/SMS/sms.db",
        flags: 1,
        metadata: { size: plaintextSize },
      },
      {
        plaintextSize,
        maxReadBytes: 1024,
        decryptChunks: () => oneChunk(materialized),
      },
    );

    expect(source.bytes.subarray(0, materialized.byteLength)).toEqual(
      materialized,
    );
    expect(source.bytes.subarray(materialized.byteLength)).toEqual(
      new Uint8Array(plaintextSize - materialized.byteLength),
    );
    expect(source.sourceByteLength).toBe(ciphertext.byteLength);
  });

  it("rejects encrypted MBFile ciphertext over its caller cap before reading", async () => {
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    const decryptChunks = vi.fn(() => emptyChunks());
    const oversizedFile = {
      size: 1024 + 17,
      arrayBuffer,
      slice: vi.fn(),
    } as unknown as File;
    const shard = {
      kind: "directory" as const,
      name: "aa",
      entries: emptyEntries,
      getDirectory: () => Promise.reject(createNotFoundError()),
      getFile: () => Promise.resolve(oversizedFile),
    } satisfies ReadonlySourceDirectoryHandle;
    const root = {
      kind: "directory" as const,
      name: "root",
      entries: emptyEntries,
      getDirectory: () => Promise.resolve(shard),
      getFile: () => Promise.reject(createNotFoundError()),
    } satisfies ReadonlySourceDirectoryHandle;

    await expect(
      readEncryptedSourceFileBytes(
        root,
        {
          fileId: "aa00000000000000000000000000000000000000",
          domain: "HomeDomain",
          relativePath: "Library/SMS/sms.db",
          flags: 1,
          metadata: { size: 1024 },
        },
        {
          plaintextSize: 1024,
          maxReadBytes: 1024,
          decryptChunks,
        },
      ),
    ).rejects.toBeInstanceOf(SourceFileTooLargeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(decryptChunks).not.toHaveBeenCalled();
  });

  it.each([
    ["oversized", Number.MAX_SAFE_INTEGER],
    ["negative", -1],
    ["fractional", 1.5],
  ])(
    "uses actual unencrypted File.size and ignores %s metadata Size",
    async (_label, metadataSize) => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const shard = {
        kind: "directory" as const,
        name: "aa",
        entries: emptyEntries,
        getDirectory: () => Promise.reject(createNotFoundError()),
        getFile: () => Promise.resolve(fileFromBytes(bytes, "small.bin")),
      } satisfies ReadonlySourceDirectoryHandle;
      const root = {
        kind: "directory" as const,
        name: "root",
        entries: emptyEntries,
        getDirectory: () => Promise.resolve(shard),
        getFile: () => Promise.reject(createNotFoundError()),
      } satisfies ReadonlySourceDirectoryHandle;

      const source = await readSourceFileBytes(
        root,
        {
          fileId: "aa00000000000000000000000000000000000000",
          domain: "HomeDomain",
          relativePath: "Library/small.bin",
          flags: 1,
          metadata: { size: metadataSize },
        },
        { maxReadBytes: 8 },
      );

      expect(source.bytes).toEqual(bytes);
      expect(source.sourceByteLength).toBe(4);
    },
  );
});

async function* emptyChunks(): AsyncGenerator<Uint8Array, void, void> {
  await Promise.resolve();
  yield new Uint8Array();
}

async function* oneChunk(
  bytes: Uint8Array,
): AsyncGenerator<Uint8Array, void, void> {
  await Promise.resolve();
  yield bytes.slice();
}

async function* emptyEntries(): AsyncIterableIterator<
  [string, ReadonlySourceHandle]
> {
  await Promise.resolve();
  yield* [];
}

class MemoryReadonlyDirectory implements ReadonlySourceDirectoryHandle {
  readonly kind = "directory";
  readonly name = "root";

  constructor(private readonly files: ReadonlyMap<string, Uint8Array>) {}

  async *entries(): AsyncIterableIterator<[string, ReadonlySourceHandle]> {
    await Promise.resolve();

    for (const [name, bytes] of this.files) {
      yield [
        name,
        {
          kind: "file",
          name,
          getFile: () => Promise.resolve(fileFromBytes(bytes, name)),
        },
      ];
    }
  }

  getDirectory(_name: string): Promise<ReadonlySourceDirectoryHandle> {
    return Promise.reject(createNotFoundError());
  }

  getFile(name: string): Promise<File> {
    const bytes = this.files.get(name);

    if (bytes === undefined) {
      return Promise.reject(createNotFoundError());
    }

    return Promise.resolve(fileFromBytes(bytes, name));
  }
}

function fileFromBytes(bytes: Uint8Array, name: string): File {
  const copy = new Uint8Array(bytes.byteLength);

  copy.set(bytes);

  return new File([copy.buffer], name);
}

function createNotFoundError(): Error {
  const error = new Error("Not found");

  error.name = "NotFoundError";

  return error;
}
