import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { ManifestDbReader } from "./manifest-db";
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
    } finally {
      db.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

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
