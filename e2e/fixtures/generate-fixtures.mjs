/// <reference lib="webworker" />

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import {
  iosMiniBackupDevice,
  iosMiniBackupExpectedAvatarWarnings,
  iosMiniBackupExpectedContacts,
  iosMiniBackupExpectedConversations,
  iosMiniBackupExpectedMessages,
  iosMiniBackupExpectedMetadata,
  iosMiniBackupExpectedReactions,
  iosMiniBackupInfoPlist,
  iosMiniBackupManifestPlist,
  iosMiniBackupStatusPlist,
  iosMiniBackupUdid,
} from "./ios-mini-backup.mjs";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const metadataPath = path.join(fixturesDir, "fixtures.json");
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const generatedDir = path.join(fixturesDir, "generated");

if (!metadata.policy?.syntheticOnly || !metadata.policy?.noRealPersonalData) {
  throw new Error("Fixture metadata must explicitly require synthetic-only, no-real-personal-data fixtures.");
}

const iosMiniBackupId = "ios-mini-backup";
const textEncoder = new TextEncoder();
const manifestFileFlag = 1;
const fileModeRegular0644 = 0o100644;
const sqlite3 = await sqlite3InitModule({
  print: () => undefined,
  printErr: () => undefined,
});

const generatedFixtures = [
  {
    id: iosMiniBackupId,
    root: path.join(generatedDir, iosMiniBackupId, iosMiniBackupUdid),
    // The descriptive device block fixtures.json must carry, sourced from the
    // shared module so the metadata cannot drift from the generated backup.
    device: {
      displayName: iosMiniBackupDevice.displayName,
      deviceName: iosMiniBackupDevice.deviceName,
      productType: iosMiniBackupDevice.productType,
      productVersion: iosMiniBackupDevice.productVersion,
      serialNumber: iosMiniBackupDevice.serialNumber,
      udid: iosMiniBackupDevice.udid,
      phoneNumber: iosMiniBackupDevice.phoneNumber,
    },
    files: buildIosMiniBackupFiles(),
  },
];

const metadataFixtureIds = new Set(metadata.fixtures?.map((fixture) => fixture.id));
const generatedFixtureIds = new Set(generatedFixtures.map((fixture) => fixture.id));

for (const id of metadataFixtureIds) {
  if (!generatedFixtureIds.has(id)) {
    throw new Error(
      `fixtures.json declares "${id}" but generate-fixtures.mjs has no generator for it.`,
    );
  }
}

for (const fixture of generatedFixtures) {
  if (!metadataFixtureIds.has(fixture.id)) {
    throw new Error(`Fixture metadata is missing an entry for ${fixture.id}.`);
  }

  const metadataEntry = metadata.fixtures.find((entry) => entry.id === fixture.id);

  for (const [key, expected] of Object.entries(fixture.device)) {
    const declared = metadataEntry.device?.[key];

    if (declared !== expected) {
      throw new Error(
        `fixtures.json device.${key} for "${fixture.id}" is ${JSON.stringify(declared)} but the shared module generates ${JSON.stringify(expected)}. Update fixtures.json to match ios-mini-backup.mjs.`,
      );
    }
  }

  const fixtureBase = path.join(generatedDir, fixture.id);

  await rm(fixtureBase, { force: true, recursive: true });

  for (const file of fixture.files) {
    const targetPath = path.join(fixture.root, file.relativePath);

    await mkdir(path.dirname(targetPath), { recursive: true });

    if (typeof file.content === "string") {
      await writeFile(targetPath, file.content, "utf8");
    } else {
      await writeFile(targetPath, file.content);
    }
  }

  console.log(`Generated ${fixture.id} at ${path.relative(fixturesDir, fixture.root)}.`);
}

function buildIosMiniBackupFiles() {
  const attachmentBytes = smallPngBytes();
  const contactThumbnailBytes = concatBytes([
    textEncoder.encode("GMIIMG!"),
    smallPngBytes(),
  ]);
  const smsDb = createSqliteDatabaseWithWal({
    buildBase: (db) => buildSmsDatabase(db, attachmentBytes, { includeWalOnlyRows: false }),
    buildWal: (db) => insertSmsWalOnlyRows(db),
  });
  const addressBookDb = createSqliteDatabaseWithWal({
    buildBase: (db) => buildAddressBookDatabase(db, { includeWalOnlyRows: false }),
    buildWal: (db) => insertAddressBookWalOnlyRows(db),
  });
  const addressBookImagesDb = createSqliteDatabase((db) =>
    buildAddressBookImagesDatabase(db, contactThumbnailBytes),
  );
  const sourceFiles = [
    {
      ...iosMiniBackupExpectedMetadata.sourceFiles.smsDb,
      content: smsDb.main,
    },
    {
      ...iosMiniBackupExpectedMetadata.sourceFiles.smsDbWal,
      content: smsDb.wal,
    },
    {
      ...iosMiniBackupExpectedMetadata.sourceFiles.addressBookDb,
      content: addressBookDb.main,
    },
    {
      ...iosMiniBackupExpectedMetadata.sourceFiles.addressBookDbWal,
      content: addressBookDb.wal,
    },
    {
      ...iosMiniBackupExpectedMetadata.sourceFiles.addressBookImagesDb,
      content: addressBookImagesDb,
    },
    {
      ...iosMiniBackupExpectedMetadata.sourceFiles.attachment,
      content: attachmentBytes,
    },
  ];

  for (const sourceFile of sourceFiles) {
    const actualFileId = backupFileId(sourceFile.domain, sourceFile.relativePath);

    if (actualFileId !== sourceFile.fileID) {
      throw new Error(
        `Expected ${sourceFile.domain}-${sourceFile.relativePath} to hash to ${sourceFile.fileID}, got ${actualFileId}.`,
      );
    }
  }

  const manifestDb = createSqliteDatabase((db) => buildManifestDatabase(db, sourceFiles));

  return [
    {
      relativePath: "Info.plist",
      content: iosMiniBackupInfoPlist(),
    },
    {
      relativePath: "Manifest.plist",
      content: iosMiniBackupManifestPlist(),
    },
    {
      relativePath: "Manifest.db",
      content: manifestDb,
    },
    {
      relativePath: "Status.plist",
      content: iosMiniBackupStatusPlist(),
    },
    ...sourceFiles.map((sourceFile) => ({
      relativePath: backupStoragePath(sourceFile.fileID),
      content: sourceFile.content,
    })),
  ];
}

function buildManifestDatabase(db, sourceFiles) {
  db.exec(`
    CREATE TABLE Files (
      fileID TEXT PRIMARY KEY,
      domain TEXT,
      relativePath TEXT,
      flags INTEGER,
      file BLOB
    );
  `);

  for (const sourceFile of sourceFiles) {
    db.exec({
      sql: `
        INSERT INTO Files (fileID, domain, relativePath, flags, file)
        VALUES (?, ?, ?, ?, ?);
      `,
      bind: [
        sourceFile.fileID,
        sourceFile.domain,
        sourceFile.relativePath,
        manifestFileFlag,
        buildManifestFileBlob(sourceFile.content.byteLength),
      ],
    });
  }
}

function buildSmsDatabase(db, attachmentBytes, options) {
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      service TEXT,
      uncanonicalized_id TEXT
    );

    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT NOT NULL,
      chat_identifier TEXT,
      service_name TEXT,
      display_name TEXT,
      style INTEGER
    );

    CREATE TABLE chat_handle_join (
      chat_id INTEGER NOT NULL,
      handle_id INTEGER NOT NULL
    );

    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT NOT NULL,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER,
      service TEXT,
      date INTEGER,
      date_read INTEGER,
      date_delivered INTEGER,
      is_from_me INTEGER,
      is_read INTEGER,
      is_sent INTEGER,
      is_delivered INTEGER,
      cache_has_attachments INTEGER,
      item_type INTEGER,
      group_action_type INTEGER,
      associated_message_guid TEXT,
      associated_message_type INTEGER,
      balloon_bundle_id TEXT,
      expressive_send_style_id TEXT,
      date_edited INTEGER,
      date_retracted INTEGER,
      subject TEXT,
      error INTEGER,
      is_audio_message INTEGER
    );

    CREATE TABLE chat_message_join (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      message_date INTEGER
    );

    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT NOT NULL,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER,
      is_sticker INTEGER,
      uti TEXT
    );

    CREATE TABLE message_attachment_join (
      message_id INTEGER NOT NULL,
      attachment_id INTEGER NOT NULL
    );
  `);

  const rowan = iosMiniBackupExpectedContacts[0];
  const niko = iosMiniBackupExpectedContacts[1];
  const rowanPhone = rowan.handles[0];
  const nikoEmail = niko.handles[0];
  const directChat = iosMiniBackupExpectedConversations[0];
  const groupChat = iosMiniBackupExpectedConversations[1];
  const directIncoming = expectedMessage(1);
  const directOutgoing = expectedMessage(2);
  const groupTyped = expectedMessage(3);
  const groupAttachment = expectedMessage(4);
  const tapback = iosMiniBackupExpectedReactions[0];
  const attachment = iosMiniBackupExpectedMetadata.sourceFiles.attachment;

  db.exec({
    sql: "INSERT INTO handle (ROWID, id, service, uncanonicalized_id) VALUES (?, ?, ?, ?);",
    bind: [1, rowanPhone.value, "iMessage", rowanPhone.uncanonicalizedValue],
  });
  db.exec({
    sql: "INSERT INTO handle (ROWID, id, service, uncanonicalized_id) VALUES (?, ?, ?, ?);",
    bind: [2, nikoEmail.value, "iMessage", nikoEmail.uncanonicalizedValue],
  });

  db.exec({
    sql: `
      INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, style)
      VALUES (?, ?, ?, ?, ?, ?);
    `,
    bind: [
      directChat.rowId,
      directChat.guid,
      directChat.chatIdentifier,
      directChat.service,
      directChat.displayName,
      45,
    ],
  });
  db.exec({
    sql: `
      INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, style)
      VALUES (?, ?, ?, ?, ?, ?);
    `,
    bind: [
      groupChat.rowId,
      groupChat.guid,
      groupChat.chatIdentifier,
      groupChat.service,
      groupChat.displayName,
      43,
    ],
  });

  db.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);");
  db.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 1);");
  db.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 2);");

  insertMessage(db, directIncoming, {
    text: directIncoming.body,
    attributedBody: null,
    handleId: 1,
    isFromMe: 0,
    isRead: 1,
    isSent: 0,
    isDelivered: 0,
    hasAttachments: 0,
  });
  insertMessage(db, directOutgoing, {
    text: directOutgoing.body,
    attributedBody: null,
    handleId: 0,
    isFromMe: 1,
    isRead: 1,
    isSent: 1,
    isDelivered: 1,
    hasAttachments: 0,
  });
  insertMessage(db, groupTyped, {
    text: null,
    attributedBody: typedstreamString(groupTyped.body),
    handleId: 2,
    isFromMe: 0,
    isRead: 1,
    isSent: 0,
    isDelivered: 0,
    hasAttachments: 0,
  });
  insertMessage(db, groupAttachment, {
    text: groupAttachment.body,
    attributedBody: null,
    handleId: 0,
    isFromMe: 1,
    isRead: 1,
    isSent: 1,
    isDelivered: 0,
    hasAttachments: 1,
  });
  insertMessage(db, tapback, {
    text: null,
    attributedBody: null,
    handleId: 1,
    isFromMe: 0,
    isRead: 1,
    isSent: 0,
    isDelivered: 0,
    hasAttachments: 0,
    associatedMessageGuid: tapback.associatedMessageGuid,
    associatedMessageType: tapback.associatedMessageType,
  });

  const messages = [
    directIncoming,
    directOutgoing,
    groupTyped,
    groupAttachment,
    tapback,
  ];

  for (const message of messages) {
    const chatId =
      message.conversationGuid === directChat.guid ? directChat.rowId : groupChat.rowId;

    db.exec({
      sql: "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?);",
      bind: [chatId, message.sourceRowId, appleNs(message.rawAppleNanoseconds)],
    });
  }

  db.exec({
    sql: `
      INSERT INTO attachment
        (ROWID, guid, filename, mime_type, transfer_name, total_bytes, is_sticker, uti)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `,
    bind: [
      1,
      attachment.guid,
      attachment.backupFilename,
      attachment.mimeType,
      attachment.transferName,
      attachmentBytes.byteLength,
      0,
      "public.png",
    ],
  });
  db.exec({
    sql: "INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?);",
    bind: [groupAttachment.sourceRowId, 1],
  });

  if (options.includeWalOnlyRows) {
    insertSmsWalOnlyRows(db);
  }
}

function insertSmsWalOnlyRows(db) {
  const avery = iosMiniBackupExpectedContacts[2];
  const averyPhone = avery.handles[0];
  const groupChat = iosMiniBackupExpectedConversations[1];
  const walOnlyMessage = expectedMessage(6);

  db.exec({
    sql: "INSERT INTO handle (ROWID, id, service, uncanonicalized_id) VALUES (?, ?, ?, ?);",
    bind: [3, averyPhone.value, "iMessage", averyPhone.uncanonicalizedValue],
  });
  db.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (2, 3);");
  insertMessage(db, walOnlyMessage, {
    text: walOnlyMessage.body,
    attributedBody: null,
    handleId: 3,
    isFromMe: 0,
    isRead: 1,
    isSent: 0,
    isDelivered: 0,
    hasAttachments: 0,
  });
  db.exec({
    sql: "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?);",
    bind: [groupChat.rowId, walOnlyMessage.sourceRowId, appleNs(walOnlyMessage.rawAppleNanoseconds)],
  });
}

function buildAddressBookDatabase(db, options) {
  db.exec(`
    CREATE TABLE ABPerson (
      ROWID INTEGER PRIMARY KEY,
      First TEXT,
      Last TEXT,
      Organization TEXT
    );

    CREATE TABLE ABMultiValue (
      UID INTEGER PRIMARY KEY,
      record_id INTEGER NOT NULL,
      property INTEGER NOT NULL,
      value TEXT NOT NULL,
      label INTEGER
    );

    CREATE TABLE ABMultiValueLabel (
      ROWID INTEGER PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec("INSERT INTO ABMultiValueLabel (ROWID, value) VALUES (1, '_$!<Mobile>!$_');");
  db.exec("INSERT INTO ABMultiValueLabel (ROWID, value) VALUES (2, '_$!<Work>!$_');");

  let multiValueUid = 1;

  const contacts = options.includeWalOnlyRows
    ? iosMiniBackupExpectedContacts
    : iosMiniBackupExpectedContacts.filter((contact) => !contact.storedInWal);

  for (const contact of contacts) {
    multiValueUid = insertAddressBookContact(db, contact, multiValueUid);
  }
}

function insertAddressBookWalOnlyRows(db) {
  const maxBaseUid = iosMiniBackupExpectedContacts
    .filter((contact) => !contact.storedInWal)
    .reduce((sum, contact) => sum + contact.handles.length, 0);
  const walContact = iosMiniBackupExpectedContacts.find((contact) => contact.storedInWal);

  if (walContact === undefined) {
    throw new Error("Missing WAL-only AddressBook contact fixture.");
  }

  insertAddressBookContact(db, walContact, maxBaseUid + 1);
}

function insertAddressBookContact(db, contact, firstMultiValueUid) {
  db.exec({
    sql: "INSERT INTO ABPerson (ROWID, First, Last, Organization) VALUES (?, ?, ?, ?);",
    bind: [contact.rowId, contact.firstName, contact.lastName, null],
  });

  let multiValueUid = firstMultiValueUid;

  for (const handle of contact.handles) {
    db.exec({
      sql: `
        INSERT INTO ABMultiValue (UID, record_id, property, value, label)
        VALUES (?, ?, ?, ?, ?);
      `,
      bind: [
        multiValueUid,
        contact.rowId,
        handle.property,
        handle.value,
        handle.kind === "phone" ? 1 : 2,
      ],
    });
    multiValueUid += 1;
  }

  return multiValueUid;
}

function buildAddressBookImagesDatabase(db, contactThumbnailBytes) {
  db.exec(`
    CREATE TABLE ABThumbnailImage (
      record_id INTEGER PRIMARY KEY,
      format INTEGER,
      data BLOB
    );
  `);

  db.exec({
    sql: "INSERT INTO ABThumbnailImage (record_id, format, data) VALUES (?, ?, ?);",
    bind: [iosMiniBackupExpectedContacts[0].rowId, 0, contactThumbnailBytes],
  });
  db.exec({
    sql: "INSERT INTO ABThumbnailImage (record_id, format, data) VALUES (?, ?, ?);",
    bind: [
      iosMiniBackupExpectedAvatarWarnings[0].recordId,
      0,
      textEncoder.encode("not-a-png-or-jpeg-thumbnail"),
    ],
  });
}

function insertMessage(db, message, options) {
  db.exec({
    sql: `
      INSERT INTO message (
        ROWID,
        guid,
        text,
        attributedBody,
        handle_id,
        service,
        date,
        date_read,
        date_delivered,
        is_from_me,
        is_read,
        is_sent,
        is_delivered,
        cache_has_attachments,
        item_type,
        group_action_type,
        associated_message_guid,
        associated_message_type,
        balloon_bundle_id,
        expressive_send_style_id,
        date_edited,
        date_retracted,
        subject,
        error,
        is_audio_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    bind: [
      message.sourceRowId,
      message.guid,
      options.text,
      options.attributedBody,
      options.handleId,
      message.service ?? "iMessage",
      appleNs(message.rawAppleNanoseconds),
      appleNs(message.readRawAppleNanoseconds ?? null),
      appleNs(message.deliveredRawAppleNanoseconds ?? null),
      options.isFromMe,
      options.isRead,
      options.isSent,
      options.isDelivered,
      options.hasAttachments,
      0,
      0,
      options.associatedMessageGuid ?? null,
      options.associatedMessageType ?? 0,
      null,
      null,
      null,
      null,
      null,
      0,
      0,
    ],
  });
}

function createSqliteDatabase(build) {
  const db = new sqlite3.oo1.DB(":memory:");

  try {
    db.exec(`
      PRAGMA encoding = 'UTF-8';
      PRAGMA page_size = 4096;
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = OFF;
    `);
    build(db);
    db.exec("VACUUM;");

    const integrityRows = db.exec({
      sql: "PRAGMA integrity_check;",
      rowMode: "array",
      returnValue: "resultRows",
    });

    if (integrityRows.length !== 1 || integrityRows[0][0] !== "ok") {
      throw new Error(`Generated SQLite database failed integrity_check: ${JSON.stringify(integrityRows)}`);
    }

    return sqlite3.capi.sqlite3_js_db_export(db);
  } finally {
    db.close();
  }
}

function createSqliteDatabaseWithWal({ buildBase, buildWal }) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "golemine-fixture-"));
  const databasePath = path.join(tempDir, "source.sqlite");
  const walPath = `${databasePath}-wal`;

  try {
    writeFileSync(databasePath, createSqliteDatabase(buildBase));

    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA wal_autocheckpoint = 0;");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      buildWal(createNodeSqliteExecAdapter(db));

      const walBytes = readFileSync(walPath);
      if (walBytes.byteLength === 0) {
        throw new Error("Generated SQLite WAL sidecar is empty.");
      }

      return {
        main: Uint8Array.from(readFileSync(databasePath)),
        wal: normalizeGeneratedWal(Uint8Array.from(walBytes)),
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function createNodeSqliteExecAdapter(db) {
  return {
    exec: (input) => {
      if (typeof input === "string") {
        db.exec(input);
        return;
      }

      const statement = db.prepare(input.sql);
      statement.run(...(input.bind ?? []));
    },
  };
}

function normalizeGeneratedWal(wal) {
  const magic = readUInt32(wal, 0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    throw new Error("Generated SQLite WAL has an unexpected magic number.");
  }

  const endian = magic === 0x377f0683 ? "big" : "little";
  const pageSize = readUInt32(wal, 8);
  const frameSize = 24 + pageSize;

  if ((wal.byteLength - 32) % frameSize !== 0) {
    throw new Error("Generated SQLite WAL has a truncated frame.");
  }

  writeUInt32(wal, 12, 0);
  writeUInt32(wal, 16, 0x12345678);
  writeUInt32(wal, 20, 0x90abcdef);

  let checksum = walChecksum(wal, 0, 24, [0, 0], endian);
  writeUInt32(wal, 24, checksum[0]);
  writeUInt32(wal, 28, checksum[1]);

  for (let offset = 32; offset < wal.byteLength; offset += frameSize) {
    writeUInt32(wal, offset + 8, 0x12345678);
    writeUInt32(wal, offset + 12, 0x90abcdef);
    checksum = walChecksum(wal, offset, 8, checksum, endian);
    checksum = walChecksum(wal, offset + 24, pageSize, checksum, endian);
    writeUInt32(wal, offset + 16, checksum[0]);
    writeUInt32(wal, offset + 20, checksum[1]);
  }

  return wal;
}

function walChecksum(bytes, offset, byteLength, seed, endian) {
  let s0 = seed[0] >>> 0;
  let s1 = seed[1] >>> 0;

  for (let cursor = offset; cursor < offset + byteLength; cursor += 8) {
    s0 = (s0 + readUInt32Endian(bytes, cursor, endian) + s1) >>> 0;
    s1 = (s1 + readUInt32Endian(bytes, cursor + 4, endian) + s0) >>> 0;
  }

  return [s0, s1];
}

function expectedMessage(sourceRowId) {
  const message = iosMiniBackupExpectedMessages.find((item) => item.sourceRowId === sourceRowId);

  if (message === undefined) {
    throw new Error(`Missing expected message row ${sourceRowId}.`);
  }

  return message;
}

function appleNs(rawAppleNanoseconds) {
  return rawAppleNanoseconds === null ? null : BigInt(rawAppleNanoseconds);
}

function backupFileId(domain, relativePath) {
  return createHash("sha1").update(`${domain}-${relativePath}`).digest("hex");
}

function backupStoragePath(fileID) {
  return path.join(fileID.slice(0, 2), fileID);
}

function buildManifestFileBlob(size) {
  const lastModified = Math.floor(Date.parse(iosMiniBackupExpectedMetadata.backupDate) / 1000);

  return buildBinaryPlistDictionary([
    ["Size", size],
    ["Mode", fileModeRegular0644],
    ["ProtectionClass", 0],
    ["LastModified", lastModified],
  ]);
}

function buildBinaryPlistDictionary(entries) {
  const objects = [new Uint8Array()];
  const keyRefs = [];
  const valueRefs = [];

  for (const [key, value] of entries) {
    keyRefs.push(objects.length);
    objects.push(binaryPlistStringObject(key));
    valueRefs.push(objects.length);
    objects.push(binaryPlistValueObject(value));
  }

  objects[0] = binaryPlistDictionaryObject(keyRefs, valueRefs);

  return buildBinaryPlist(objects);
}

function buildBinaryPlist(objects) {
  const objectRefSize = 1;

  if (objects.length > 0xff) {
    throw new Error("Fixture binary plist has too many objects for one-byte refs.");
  }

  const offsets = [];
  let cursor = 8;

  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.byteLength;
  }

  if (cursor > 0xffff) {
    throw new Error("Fixture binary plist is too large for two-byte offsets.");
  }

  const offsetTableOffset = cursor;
  const offsetTable = new Uint8Array(offsets.length * 2);

  offsets.forEach((offset, index) => {
    writeUInt(offsetTable, index * 2, BigInt(offset), 2);
  });

  const trailer = new Uint8Array(32);
  trailer[6] = 2;
  trailer[7] = objectRefSize;
  writeUInt(trailer, 8, BigInt(objects.length), 8);
  writeUInt(trailer, 16, 0n, 8);
  writeUInt(trailer, 24, BigInt(offsetTableOffset), 8);

  return concatBytes([
    textEncoder.encode("bplist00"),
    ...objects,
    offsetTable,
    trailer,
  ]);
}

function binaryPlistDictionaryObject(keyRefs, valueRefs) {
  if (keyRefs.length !== valueRefs.length) {
    throw new Error("Fixture binary plist dictionary key/value refs are mismatched.");
  }

  return concatBytes([
    binaryPlistLengthHeader(0xd0, keyRefs.length),
    new Uint8Array(keyRefs),
    new Uint8Array(valueRefs),
  ]);
}

function binaryPlistValueObject(value) {
  if (typeof value === "number") {
    return binaryPlistIntegerObject(BigInt(value));
  }

  if (typeof value === "bigint") {
    return binaryPlistIntegerObject(value);
  }

  if (typeof value === "string") {
    return binaryPlistStringObject(value);
  }

  throw new Error(`Unsupported binary plist fixture value: ${String(value)}`);
}

function binaryPlistStringObject(value) {
  const bytes = textEncoder.encode(value);

  if (bytes.some((byte) => byte > 0x7f)) {
    throw new Error("Fixture binary plist writer only supports ASCII strings.");
  }

  return concatBytes([binaryPlistLengthHeader(0x50, bytes.byteLength), bytes]);
}

function binaryPlistIntegerObject(value) {
  if (value < 0n) {
    throw new Error("Fixture binary plist writer only supports unsigned integers.");
  }

  const byteLength =
    value <= 0xffn ? 1 : value <= 0xffffn ? 2 : value <= 0xffffffffn ? 4 : 8;
  const infoByByteLength = new Map([
    [1, 0],
    [2, 1],
    [4, 2],
    [8, 3],
  ]);
  const info = infoByByteLength.get(byteLength);

  return concatBytes([
    new Uint8Array([0x10 | info]),
    uintBytes(value, byteLength),
  ]);
}

function binaryPlistLengthHeader(kind, count) {
  if (count < 0x0f) {
    return new Uint8Array([kind | count]);
  }

  return concatBytes([new Uint8Array([kind | 0x0f]), binaryPlistIntegerObject(BigInt(count))]);
}

function typedstreamString(value) {
  const text = textEncoder.encode(value);

  if (text.byteLength > 0x7f) {
    throw new Error("Fixture typedstream writer only supports short UTF-8 strings.");
  }

  return concatBytes([
    new Uint8Array([0x04, 0x0b]),
    textEncoder.encode("streamtyped"),
    new Uint8Array([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x08]),
    textEncoder.encode("NSString"),
    new Uint8Array([0x01, 0x84, 0x84, 0x08]),
    textEncoder.encode("NSObject"),
    new Uint8Array([0x00, 0x85, 0x84, 0x01, 0x2b, text.byteLength]),
    text,
    new Uint8Array([0x86]),
  ]);
}

function smallPngBytes() {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
}

function uintBytes(value, byteLength) {
  const bytes = new Uint8Array(byteLength);
  writeUInt(bytes, 0, value, byteLength);
  return bytes;
}

function readUInt32(bytes, offset) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  ) >>> 0;
}

function readUInt32Endian(bytes, offset, endian) {
  if (endian === "big") {
    return readUInt32(bytes, offset);
  }

  return (
    bytes[offset] +
    (bytes[offset + 1] << 8) +
    (bytes[offset + 2] << 16) +
    ((bytes[offset + 3] << 24) >>> 0)
  ) >>> 0;
}

function writeUInt32(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function writeUInt(target, offset, value, byteLength) {
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    target[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function concatBytes(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}
