import { afterEach, describe, expect, it, vi } from "vitest";

import { getSqlite } from "../shared/sqlite-init";
import {
  appleTimestampToIso,
  normalizeIosMessages,
} from "./ios-normalize";
import type { ManifestDbReader, ManifestFileRecord } from "./manifest-db";
import type { ReadonlySourceDirectoryHandle } from "./read-only-source";
import type { SqliteDatabase } from "./source-sqlite";

const openDatabases: SqliteDatabase[] = [];

afterEach(() => {
  vi.restoreAllMocks();

  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe("iOS message normalization hardening", () => {
  it("synthesizes an unassigned conversation for messages without chat joins", async () => {
    const smsDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        handle_id INTEGER,
        date INTEGER,
        is_from_me INTEGER
      );
    `);
    smsDb.exec({
      sql: "INSERT INTO handle (ROWID, id) VALUES (?, ?);",
      bind: [1, "+15550102000"],
    });
    smsDb.exec({
      sql: `
        INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me)
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      bind: [7, "ORPHAN-MESSAGE", "Loose message", 1, 804430800000000000n, 0],
    });

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: noopManifest,
      root: noopRoot,
    });

    expect(normalized.messages[0]).toEqual(
      expect.objectContaining({
        conversationId: "chat:0",
        body: "Loose message",
      }),
    );
    expect(normalized.conversations).toEqual([
      expect.objectContaining({
        id: "chat:0",
        displayName: "Unassigned messages",
        messageCount: 1,
        participantIds: ["self", "handle:1"],
      }),
    ]);
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "message-chat-missing",
          source: "7",
        }),
      ]),
    );
  });

  it("merges chat rows with duplicate GUIDs into the first conversation", async () => {
    const smsDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        chat_identifier TEXT,
        service_name TEXT,
        display_name TEXT,
        style INTEGER
      );
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        handle_id INTEGER,
        date INTEGER,
        is_from_me INTEGER
      );
    `);
    smsDb.exec("INSERT INTO handle (ROWID, id) VALUES (1, '+15550102000');");
    smsDb.exec(`
      INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, style)
      VALUES
        (1, 'DUPLICATE-CHAT-GUID', '+15550102000', 'iMessage', NULL, 45),
        (2, 'DUPLICATE-CHAT-GUID', '+15550102000', 'iMessage', NULL, 45);
    `);
    smsDb.exec(`
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 1);
      INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me)
      VALUES
        (10, 'MESSAGE-A', 'First message', 1, 804430800000000000, 0),
        (11, 'MESSAGE-B', 'Second message', 1, 804430801000000000, 0);
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 10), (2, 11);
    `);

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: noopManifest,
      root: noopRoot,
    });

    expect(normalized.conversations).toEqual([
      expect.objectContaining({
        id: "chat:1",
        providerKey: "DUPLICATE-CHAT-GUID",
        messageCount: 2,
      }),
    ]);
    expect(normalized.messages).toEqual([
      expect.objectContaining({ id: "message:10", conversationId: "chat:1" }),
      expect.objectContaining({ id: "message:11", conversationId: "chat:1" }),
    ]);
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "conversation-duplicate-guid",
          source: "2",
        }),
      ]),
    );
  });

  it("keeps only explicit group names and preserves contact first names", async () => {
    const smsDb = await createMemoryDatabase();
    const contactsDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        chat_identifier TEXT,
        service_name TEXT,
        display_name TEXT,
        style INTEGER
      );
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    `);
    smsDb.exec(`
      INSERT INTO handle (ROWID, id) VALUES
        (1, '+15550101001'),
        (2, '+15550101002'),
        (3, '+15550101003');
      INSERT INTO chat (
        ROWID,
        guid,
        chat_identifier,
        service_name,
        display_name,
        style
      ) VALUES
        (1, 'UNNAMED-GROUP', 'chat-opaque-id', 'iMessage', NULL, 43),
        (2, 'NAMED-GROUP', 'chat-named-id', 'iMessage', 'Project Crew', 43),
        (3, 'DIRECT-CHAT', '+15550101001', 'iMessage', NULL, 45);
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES
        (1, 1), (1, 2), (1, 3),
        (2, 1), (2, 2), (2, 3),
        (3, 1);
    `);
    contactsDb.exec(`
      CREATE TABLE ABPerson (
        ROWID INTEGER PRIMARY KEY,
        First TEXT,
        Last TEXT,
        Organization TEXT
      );
      CREATE TABLE ABMultiValue (
        UID INTEGER PRIMARY KEY,
        record_id INTEGER,
        property INTEGER,
        value TEXT
      );
      INSERT INTO ABPerson (ROWID, First, Last) VALUES
        (1, 'Brian', 'Meenan'),
        (2, 'Karin', 'Stone'),
        (3, 'Sean', 'Parker');
      INSERT INTO ABMultiValue (UID, record_id, property, value) VALUES
        (1, 1, 3, '+15550101001'),
        (2, 2, 3, '+15550101002'),
        (3, 3, 3, '+15550101003');
    `);

    const normalized = await normalizeIosMessages({
      smsDb,
      contactsDb,
      manifest: noopManifest,
      root: noopRoot,
    });
    const unnamedGroup = normalized.conversations.find(
      (conversation) => conversation.providerKey === "UNNAMED-GROUP",
    );
    const namedGroup = normalized.conversations.find(
      (conversation) => conversation.providerKey === "NAMED-GROUP",
    );
    const direct = normalized.conversations.find(
      (conversation) => conversation.providerKey === "DIRECT-CHAT",
    );

    expect(unnamedGroup).toEqual(
      expect.objectContaining({
        kind: "group",
        participantIds: ["self", "handle:1", "handle:2", "handle:3"],
      }),
    );
    expect(unnamedGroup).not.toHaveProperty("displayName");
    expect(namedGroup).toEqual(
      expect.objectContaining({ displayName: "Project Crew", kind: "group" }),
    );
    expect(direct).toEqual(
      expect.objectContaining({ displayName: "Brian Meenan", kind: "direct" }),
    );
    expect(normalized.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contactFirstName: "Brian",
          contactName: "Brian Meenan",
          id: "handle:1",
        }),
        expect.objectContaining({
          contactFirstName: "Karin",
          contactName: "Karin Stone",
          id: "handle:2",
        }),
        expect.objectContaining({
          contactFirstName: "Sean",
          contactName: "Sean Parker",
          id: "handle:3",
        }),
      ]),
    );
  });

  it("omits out-of-range Apple timestamps instead of throwing", () => {
    expect(appleTimestampToIso(10n ** 30n)).toBeUndefined();
  });

  it("folds newer unknown tapbacks into reactions instead of message rows", async () => {
    const smsDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        handle_id INTEGER,
        date INTEGER,
        is_from_me INTEGER,
        associated_message_guid TEXT,
        associated_message_type INTEGER
      );
    `);
    smsDb.exec("INSERT INTO handle (ROWID, id) VALUES (1, '+15550102000');");
    smsDb.exec({
      sql: `
        INSERT INTO message (
          ROWID,
          guid,
          text,
          handle_id,
          date,
          is_from_me,
          associated_message_guid,
          associated_message_type
        )
        VALUES
          (1, 'TARGET-GUID', 'Target message', 1, 804430800000000000, 0, NULL, 0),
          (2, 'REACTION-GUID', NULL, 1, 804430801000000000, 0, 'bp:TARGET-GUID', 2006),
          (3, 'REACTION-REMOVE-GUID', NULL, 1, 804430802000000000, 0, 'bp:TARGET-GUID', 3006);
      `,
    });

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: noopManifest,
      root: noopRoot,
    });

    expect(normalized.messages).toHaveLength(1);
    expect(normalized.reactions).toEqual([
      expect.objectContaining({
        id: "reaction:2",
        kind: "unknown",
        rawTimestamp: "804430801000000000",
        sourceGuid: "REACTION-GUID",
        targetMessageId: "message:1",
      }),
    ]);
  });

  it("classifies unmapped tapback-add types as unknown reactions and diverts removals", async () => {
    const smsDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        handle_id INTEGER,
        date INTEGER,
        is_from_me INTEGER,
        associated_message_guid TEXT,
        associated_message_type INTEGER
      );
    `);
    smsDb.exec("INSERT INTO handle (ROWID, id) VALUES (1, '+15550102000');");
    smsDb.exec({
      sql: `
        INSERT INTO message (
          ROWID,
          guid,
          text,
          handle_id,
          date,
          is_from_me,
          associated_message_guid,
          associated_message_type
        )
        VALUES
          (1, 'TARGET-GUID', 'Target message', 1, 804430800000000000, 0, NULL, 0),
          (2, 'FUTURE-ADD-GUID', NULL, 1, 804430801000000000, 0, 'bp:TARGET-GUID', 2042),
          (3, 'FUTURE-REMOVE-GUID', NULL, 1, 804430802000000000, 0, 'bp:TARGET-GUID', 3042);
      `,
    });

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: noopManifest,
      root: noopRoot,
    });

    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0]).toEqual(
      expect.objectContaining({ sourceGuid: "TARGET-GUID" }),
    );
    expect(normalized.reactions).toEqual([
      expect.objectContaining({
        id: "reaction:2",
        kind: "unknown",
        sourceGuid: "FUTURE-ADD-GUID",
        targetMessageId: "message:1",
      }),
    ]);
  });

  it("warns when attributedBody bytes cannot be decoded and no plain text is present", async () => {
    const smsDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        attributedBody BLOB,
        date INTEGER,
        is_from_me INTEGER
      );
    `);
    smsDb.exec({
      sql: `
        INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me)
        VALUES (?, ?, NULL, ?, ?, ?);
      `,
      bind: [11, "UNDECODABLE-GUID", new Uint8Array([0x01, 0x02, 0x03, 0x04]), 804430800000000000, 0],
    });

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: noopManifest,
      root: noopRoot,
    });

    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0]).toEqual(expect.objectContaining({ body: "" }));
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "message-body-undecodable",
          source: "11",
        }),
      ]),
    );
  });

  it("does not warn about the body of messages without any body source", async () => {
    const smsDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        attributedBody BLOB,
        date INTEGER,
        is_from_me INTEGER
      );
    `);
    smsDb.exec(`
      INSERT INTO message (ROWID, guid, text, attributedBody, date, is_from_me)
      VALUES (12, 'ATTACHMENT-ONLY-GUID', NULL, NULL, 804430800000000000, 0);
    `);

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: noopManifest,
      root: noopRoot,
    });

    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0]).toEqual(expect.objectContaining({ body: "" }));
    expect(normalized.warnings.map((warning) => warning.code)).not.toContain(
      "message-body-undecodable",
    );
  });

  it("keeps attachment metadata and warns when the source file is missing from Manifest.db", async () => {
    const smsDb = await createAttachmentDatabase(
      "~/Library/SMS/Attachments/aa/bb/missing.heic",
    );

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: manifestWithoutRecords,
      root: rootThatMustNotRead,
    });

    expect(normalized.attachments).toEqual([
      expect.objectContaining({
        filename: "missing.heic",
        sourcePath: "Library/SMS/Attachments/aa/bb/missing.heic",
        sourceDomain: "MediaDomain",
        sourceGuid: "ATTACHMENT-GUID",
      }),
    ]);
    expect(normalized.attachments[0]?.sha256).toBeUndefined();
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "attachment-source-missing",
          source: "Library/SMS/Attachments/aa/bb/missing.heic",
        }),
      ]),
    );
  });

  it("keeps attachment metadata when Manifest.db lookup throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const smsDb = await createAttachmentDatabase(
      "/var/mobile/Library/SMS/Attachments/aa/bb/file.heic",
    );

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: manifestThatThrows,
      root: noopRoot,
    });

    expect(normalized.attachments).toEqual([
      expect.objectContaining({
        filename: "file.heic",
        sourcePath: "Library/SMS/Attachments/aa/bb/file.heic",
        sourceDomain: "MediaDomain",
        sourceGuid: "ATTACHMENT-GUID",
      }),
    ]);
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "attachment-source-unreadable",
          source: "Library/SMS/Attachments/aa/bb/file.heic",
        }),
      ]),
    );
  });

  it("defers large attachment source hashing without reading source bytes", async () => {
    const smsDb = await createAttachmentDatabase(
      "~/Library/SMS/Attachments/aa/bb/large.mov",
    );

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: manifestWithRecord({
        fileId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        domain: "MediaDomain",
        relativePath: "Library/SMS/Attachments/aa/bb/large.mov",
        flags: 1,
        metadata: { size: 64 * 1024 * 1024 + 1 },
      }),
      root: rootThatMustNotRead,
    });

    expect(normalized.attachments[0]).toEqual(
      expect.objectContaining({
        filename: "large.mov",
        sourcePath: "Library/SMS/Attachments/aa/bb/large.mov",
      }),
    );
    expect(normalized.attachments[0]?.sha256).toBeUndefined();
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "attachment-source-hash-deferred",
          source: "Library/SMS/Attachments/aa/bb/large.mov",
        }),
      ]),
    );
  });

  it("checks actual attachment file size before hashing deceptive MBFile sizes", async () => {
    const smsDb = await createAttachmentDatabase(
      "~/Library/SMS/Attachments/aa/bb/deceptive.mov",
    );

    const normalized = await normalizeIosMessages({
      smsDb,
      manifest: manifestWithRecord({
        fileId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        domain: "MediaDomain",
        relativePath: "Library/SMS/Attachments/aa/bb/deceptive.mov",
        flags: 1,
        metadata: { size: 1 },
      }),
      root: rootWithOversizedSourceFile,
    });

    expect(normalized.attachments[0]).toEqual(
      expect.objectContaining({
        sourcePath: "Library/SMS/Attachments/aa/bb/deceptive.mov",
      }),
    );
    expect(normalized.attachments[0]?.sha256).toBeUndefined();
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "attachment-source-hash-deferred",
          source: "Library/SMS/Attachments/aa/bb/deceptive.mov",
        }),
      ]),
    );
  });

  it("treats malformed contact-image schemas as a no-op", async () => {
    const smsDb = await createMemoryDatabase();
    const contactsDb = await createMemoryDatabase();
    const contactImagesDb = await createMemoryDatabase();

    smsDb.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY,
        guid TEXT,
        text TEXT,
        handle_id INTEGER,
        date INTEGER,
        is_from_me INTEGER
      );
    `);
    smsDb.exec("INSERT INTO handle (ROWID, id) VALUES (1, '+1 (555) 010-2000');");

    contactsDb.exec(`
      CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY, First TEXT, Last TEXT);
      CREATE TABLE ABMultiValue (
        UID INTEGER PRIMARY KEY,
        record_id INTEGER,
        property INTEGER,
        value TEXT
      );
    `);
    contactsDb.exec("INSERT INTO ABPerson (ROWID, First, Last) VALUES (1, 'Rowan', 'Vale');");
    contactsDb.exec(`
      INSERT INTO ABMultiValue (UID, record_id, property, value)
      VALUES (1, 1, 3, '+15550102000');
    `);

    contactImagesDb.exec("CREATE TABLE ABThumbnailImage (data BLOB);");
    contactImagesDb.exec({
      sql: "INSERT INTO ABThumbnailImage (data) VALUES (?);",
      bind: [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    });

    const normalized = await normalizeIosMessages({
      smsDb,
      contactsDb,
      contactImagesDb,
      manifest: noopManifest,
      root: noopRoot,
    });

    expect(normalized.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "handle:1",
          contactName: "Rowan Vale",
        }),
      ]),
    );
    expect(normalized.contactAvatars).toEqual([]);
  });
});

async function createMemoryDatabase(): Promise<SqliteDatabase> {
  const sqlite3 = await getSqlite();
  const db = new sqlite3.oo1.DB(":memory:", "c");

  openDatabases.push(db);

  return db;
}

async function createAttachmentDatabase(filename: string): Promise<SqliteDatabase> {
  const smsDb = await createMemoryDatabase();

  smsDb.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      date INTEGER,
      is_from_me INTEGER
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER
    );
    CREATE TABLE message_attachment_join (
      message_id INTEGER,
      attachment_id INTEGER
    );
  `);
  smsDb.exec({
    sql: `
      INSERT INTO message (ROWID, guid, text, date, is_from_me)
      VALUES (1, 'MESSAGE-GUID', 'With attachment', 804430800000000000, 1);
    `,
  });
  smsDb.exec({
    sql: `
      INSERT INTO attachment (
        ROWID,
        guid,
        filename,
        mime_type,
        transfer_name,
        total_bytes
      )
      VALUES (1, 'ATTACHMENT-GUID', ?, 'image/heic', NULL, 5);
    `,
    bind: [filename],
  });
  smsDb.exec(
    "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 1);",
  );

  return smsDb;
}

function manifestWithRecord(record: ManifestFileRecord): ManifestDbReader {
  return {
    findFile: (domain: string, relativePath: string) =>
      domain === record.domain && relativePath === record.relativePath
        ? record
        : undefined,
  } as ManifestDbReader;
}

const noopManifest = {} as ManifestDbReader;
const manifestWithoutRecords = {
  findFile: () => undefined,
} as unknown as ManifestDbReader;
const noopRoot = {} as ReadonlySourceDirectoryHandle;
const manifestThatThrows = {
  findFile: () => {
    throw new Error("synthetic unreadable MBFile");
  },
} as unknown as ManifestDbReader;
const rootThatMustNotRead = {
  getDirectory: () => {
    throw new Error("Source bytes should not be read for deferred attachment hashes.");
  },
} as unknown as ReadonlySourceDirectoryHandle;
const rootWithOversizedSourceFile = {
  getDirectory: () =>
    Promise.resolve({
      getFile: () =>
        Promise.resolve({
          size: 64 * 1024 * 1024 + 1,
          arrayBuffer: () => {
            throw new Error("Oversized source bytes should not be read.");
          },
        } as unknown as File),
    }),
} as unknown as ReadonlySourceDirectoryHandle;
