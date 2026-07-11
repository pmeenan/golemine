import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ManifestDbError,
  ManifestDbReader,
  maxStagedSourceFileBytes,
  SourceFileDecryptionError,
  SourceFileTooLargeError,
  readEncryptedSourceFileBytes,
  readSourceFileBytes,
  resetBackupSourceOverridesForTests,
  setBackupSourceOverridesForTests,
  stageDecryptedManifestDatabase,
} from "./manifest-db";
import { sha256BlobHex } from "../shared/incremental-sha256";
import { inMemoryBackupSourceOverridesForTest } from "./source-sqlite.test-support";
import type {
  ReadonlySourceDirectoryHandle,
  ReadonlySourceHandle,
} from "./read-only-source";

beforeEach(() => {
  setBackupSourceOverridesForTests(inMemoryBackupSourceOverridesForTest);
});

afterEach(() => {
  resetBackupSourceOverridesForTests();
  vi.unstubAllGlobals();
});

describe("ManifestDbReader", () => {
  it("charges a conservative 3x OPFS peak before staging Manifest.db", async () => {
    const root = new MemoryReadonlyDirectory(
      new Map([["Manifest.db", new Uint8Array(512)]]),
    );

    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn(),
        estimate: () => Promise.resolve({ quota: 1_200, usage: 0 }),
      },
    });

    setBackupSourceOverridesForTests({
      ...inMemoryBackupSourceOverridesForTest,
      sweepTransient: () => Promise.resolve(),
    });

    await expect(ManifestDbReader.open(root)).rejects.toBeInstanceOf(
      SourceFileTooLargeError,
    );
  });

  it("sweeps crash residue before the Manifest quota preflight", async () => {
    const root = new MemoryReadonlyDirectory(
      new Map([["Manifest.db", new Uint8Array(512)]]),
    );
    let usage = 1_000;
    const sweepTransient = vi.fn(() => {
      usage = 0;
      return Promise.resolve();
    });

    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn(),
        estimate: () => Promise.resolve({ quota: 2_000, usage }),
      },
    });

    setBackupSourceOverridesForTests({
      ...inMemoryBackupSourceOverridesForTest,
      sweepTransient,
    });
    const manifest = await ManifestDbReader.open(root);

    expect(sweepTransient).toHaveBeenCalledTimes(1);
    manifest.close();
    await manifest.cleanup();
  });

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
        decryptMainChunks: async function* (file) {
          ciphertext = new Uint8Array(await file.arrayBuffer());
          plaintext = ciphertext.slice();
          yield plaintext;
        },
      });

      try {
        expect(ciphertext).toBeDefined();
        expect(plaintext).toBeDefined();
        expect(decryptedManifest.sourceFiles[0]?.contentSha256).toMatch(
          /^[a-f0-9]{64}$/u,
        );
      } finally {
        decryptedManifest.close();
      }
    } finally {
      db.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("opens a backup whose root Manifest sidecars are present but zero bytes", async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "golemine-manifest-"));
    const dbPath = path.join(tempDirectory, "Manifest.db");
    const db = new DatabaseSync(dbPath);

    try {
      db.exec(`
        CREATE TABLE Files (
          fileID TEXT PRIMARY KEY,
          domain TEXT,
          relativePath TEXT,
          flags INTEGER,
          file BLOB
        );
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

      // A zero-byte -wal/-shm pair is normal after wal_checkpoint(TRUNCATE)
      // and must behave exactly like an absent sidecar.
      const root = new MemoryReadonlyDirectory(
        new Map([
          ["Manifest.db", Uint8Array.from(await readFile(dbPath))],
          ["Manifest.db-wal", new Uint8Array(0)],
          ["Manifest.db-shm", new Uint8Array(0)],
        ]),
      );
      const manifest = await ManifestDbReader.open(root);

      try {
        expect(
          manifest.requireFile("HomeDomain", "Library/SMS/sms.db"),
        ).toMatchObject({
          fileId: "3d0d7e5fb2ce288813306e4d4636395e047a3d28",
        });
        expect(
          manifest.sourceFiles.map((file) => [file.relativePath, file.byteLength]),
        ).toEqual([
          ["Manifest.db", expect.any(Number)],
          ["Manifest.db-wal", 0],
          ["Manifest.db-shm", 0],
        ]);
      } finally {
        manifest.close();
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
    const decryptMainChunks = vi.fn(() => emptyChunks());
    const oversizedManifest = {
      size: maxStagedSourceFileBytes + 1,
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
      ManifestDbReader.open(root, { decryptMainChunks }),
    ).rejects.toBeInstanceOf(SourceFileTooLargeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(decryptMainChunks).not.toHaveBeenCalled();
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

    const record = {
      fileId: "aa00000000000000000000000000000000000000",
      domain: "HomeDomain",
      relativePath: "Library/SMS/sms.db",
      flags: 1,
      metadata: { size: plaintext.byteLength },
    };

    await expect(
      readEncryptedSourceFileBytes(
        root,
        record,
        {
          plaintextSize: plaintext.byteLength,
          maxReadBytes: plaintext.byteLength,
          decryptChunks: () => oneChunk(plaintext),
        },
      ),
    ).rejects.toBeInstanceOf(SourceFileTooLargeError);

    const source = await readEncryptedSourceFileBytes(
      root,
      record,
      {
        plaintextSize: plaintext.byteLength,
        // The caller cap binds the logical plaintext size and tolerates one
        // extra stored AES block; a stored tail beyond that (64 > 16 + 16
        // above) is rejected. Database ingest uses its absolute per-file cap
        // after the required set's logical preflight.
        maxReadBytes: ciphertext.byteLength,
        decryptChunks: () => oneChunk(plaintext),
      },
    );

    expect(source.bytes).toEqual(plaintext);
    expect(source.sourceByteLength).toBe(ciphertext.byteLength);
  });

  it("accepts a cap-sized plaintext whose stored PKCS#7 tail is cap + 16", async () => {
    const cap = 32;
    const plaintext = Uint8Array.from({ length: cap }, (_, index) => index + 1);
    const ciphertext = new Uint8Array(cap + 16).fill(0xe7);
    const root = singleStoredFileRoot(ciphertext);
    const record = {
      fileId: "aa00000000000000000000000000000000000000",
      domain: "MediaDomain",
      relativePath: "Library/SMS/Attachments/near-cap.bin",
      flags: 1,
      metadata: { size: cap },
    };

    const source = await readEncryptedSourceFileBytes(root, record, {
      plaintextSize: cap,
      maxReadBytes: cap,
      decryptChunks: () => oneChunk(plaintext),
    });

    expect(source.bytes).toEqual(plaintext);
    expect(source.sourceByteLength).toBe(cap + 16);
  });

  it("rejects a plaintext one byte over the caller cap before decrypting", async () => {
    const cap = 32;
    const decryptChunks = vi.fn(() => emptyChunks());
    const root = singleStoredFileRoot(new Uint8Array(cap + 16));

    await expect(
      readEncryptedSourceFileBytes(
        root,
        {
          fileId: "aa00000000000000000000000000000000000000",
          domain: "MediaDomain",
          relativePath: "Library/SMS/Attachments/over-cap.bin",
          flags: 1,
          metadata: { size: cap + 1 },
        },
        {
          plaintextSize: cap + 1,
          maxReadBytes: cap,
          decryptChunks,
        },
      ),
    ).rejects.toBeInstanceOf(SourceFileTooLargeError);
    expect(decryptChunks).not.toHaveBeenCalled();
  });

  it("computes the opt-in stored-source hash over the complete stored file", async () => {
    const ciphertext = Uint8Array.from(
      { length: 64 },
      (_, index) => (index * 37 + 11) & 0xff,
    );
    const plaintext = new Uint8Array(16).fill(0x4a);
    const expectedSourceSha256 = await sha256BlobHex(
      new Blob([ciphertext.slice()]),
    );
    const expectedSha256 = await sha256BlobHex(new Blob([plaintext.slice()]));
    const root = singleStoredFileRoot(ciphertext);
    const record = {
      fileId: "aa00000000000000000000000000000000000000",
      domain: "MediaDomain",
      relativePath: "Library/SMS/Attachments/tail.bin",
      flags: 1,
      metadata: { size: plaintext.byteLength },
    };
    const request = {
      plaintextSize: plaintext.byteLength,
      maxReadBytes: ciphertext.byteLength,
      includeSourceSha256: true,
    };

    // A decryptor that forwards the ciphertext tee reads only the
    // block-aligned prefix needed for the plaintext; the core must fold the
    // unread stored tail into the same hash.
    const teed = await readEncryptedSourceFileBytes(root, record, {
      ...request,
      decryptChunks: async function* (file, onCiphertextChunk) {
        await Promise.resolve();
        onCiphertextChunk?.(
          new Uint8Array(await file.slice(0, 16).arrayBuffer()),
        );
        yield plaintext.slice();
      },
    });
    expect(teed.sourceSha256).toBe(expectedSourceSha256);
    expect(teed.sha256).toBe(expectedSha256);

    // A decryptor that ignores the tee stays correct: the core hashes the
    // whole stored file in its own pass.
    const unteed = await readEncryptedSourceFileBytes(root, record, {
      ...request,
      decryptChunks: () => oneChunk(plaintext),
    });
    expect(unteed.sourceSha256).toBe(expectedSourceSha256);
    expect(unteed.sha256).toBe(expectedSha256);
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

  it("rejects a non-block-aligned encrypted MBFile tail before reading", async () => {
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
    ).rejects.toBeInstanceOf(SourceFileDecryptionError);
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

describe("stageDecryptedManifestDatabase", () => {
  it.each([[0], [5], [16]])(
    "hashes exactly the normalized content when %i pad bytes are truncated",
    async (padBytes) => {
      const content = sqlitePayload(512);
      const padded = new Uint8Array(content.byteLength + padBytes);
      padded.set(content);
      padded.fill(padBytes, content.byteLength);
      const staged = new MemoryStagedFile();

      const result = await stageDecryptedManifestDatabase(
        staged,
        // Awkward chunk boundaries around the 16-byte hold-back window.
        chunksOf(padded, [7, 100, padded.byteLength - 7 - 100 - 3, 3]),
      );

      expect(result.normalizedByteLength).toBe(content.byteLength);
      expect(result.contentSha256).toBe(
        await sha256BlobHex(new Blob([content.slice()])),
      );
      expect(staged.byteLength).toBe(padded.byteLength);
    },
  );

  it("rejects invalid trailing pad bytes", async () => {
    const content = sqlitePayload(512);
    const padded = new Uint8Array(content.byteLength + 4);
    padded.set(content);
    padded.fill(9, content.byteLength);

    await expect(
      stageDecryptedManifestDatabase(
        new MemoryStagedFile(),
        chunksOf(padded, [padded.byteLength]),
      ),
    ).rejects.toBeInstanceOf(ManifestDbError);
  });
});

function sqlitePayload(byteLength: number): Uint8Array {
  const bytes = Uint8Array.from(
    { length: byteLength },
    (_, index) => (index * 31 + 17) & 0xff,
  );
  bytes.set(new TextEncoder().encode("SQLite format 3\u0000"));
  bytes[16] = 0x02;
  bytes[17] = 0x00;
  return bytes;
}

async function* chunksOf(
  bytes: Uint8Array,
  chunkLengths: readonly number[],
): AsyncGenerator<Uint8Array, void, void> {
  let offset = 0;
  for (const chunkLength of chunkLengths) {
    await Promise.resolve();
    yield bytes.slice(offset, offset + chunkLength);
    offset += chunkLength;
  }
  if (offset !== bytes.byteLength) {
    throw new Error("Test chunk lengths did not cover the payload.");
  }
}

class MemoryStagedFile {
  #bytes = new Uint8Array(0);

  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  write(bytes: Uint8Array, offset = this.#bytes.byteLength): number {
    const end = offset + bytes.byteLength;
    if (end > this.#bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.#bytes);
      this.#bytes = grown;
    }
    this.#bytes.set(bytes, offset);
    return bytes.byteLength;
  }

  read(offset: number, length: number): Uint8Array {
    return this.#bytes.slice(offset, offset + length);
  }
}

function singleStoredFileRoot(
  storedBytes: Uint8Array,
): ReadonlySourceDirectoryHandle {
  const shard = {
    kind: "directory" as const,
    name: "aa",
    entries: emptyEntries,
    getDirectory: () => Promise.reject(createNotFoundError()),
    getFile: () => Promise.resolve(fileFromBytes(storedBytes, "ciphertext")),
  } satisfies ReadonlySourceDirectoryHandle;

  return {
    kind: "directory" as const,
    name: "root",
    entries: emptyEntries,
    getDirectory: () => Promise.resolve(shard),
    getFile: () => Promise.reject(createNotFoundError()),
  } satisfies ReadonlySourceDirectoryHandle;
}

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
