import { afterEach, describe, expect, it } from "vitest";
import { derivedDbVersion } from "../../lib/constants";
import {
  formatWorkerErrorPayload,
  type BackupIngestReport,
  type BackupIngestRequest,
  type DbWorkerApi,
  type NormalizedContactAvatar,
  type WorkerResult,
} from "../../lib/worker-types";
import {
  contactAvatarRelativeDirectory,
  createDerivedDatabaseSchema,
  derivedDatabaseFilename,
  type DerivedSqliteDatabase,
} from "./schema";
import {
  createDbWorkerIngestApi,
  type ContactAvatarStore,
  type DerivedDatabaseFactory,
} from "./ingest-sink";
import { getSqlite } from "../shared/sqlite-init";

const testNow = new Date("2026-07-08T12:00:00.000Z");
const avatarSha256 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const attachmentSha256 =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const openDatabases: DerivedSqliteDatabase[] = [];

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe("derived db schema", () => {
  it("creates the M2 tables, FTS table, triggers, and schema version", async () => {
    const db = await createMemoryDatabase();

    createDerivedDatabaseSchema(db);

    const tables = db.selectValues(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    const triggers = db.selectValues(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;",
    );

    expect(tables.map(String)).toEqual(
      expect.arrayContaining([
        "attachments",
        "contact_avatars",
        "conversation_participants",
        "conversations",
        "ingest_meta",
        "messages",
        "messages_fts",
        "participants",
        "reactions",
        "report_items",
        "reports",
      ]),
    );
    expect(triggers.map(String)).toEqual(
      expect.arrayContaining(["messages_ai", "messages_ad", "messages_au"]),
    );
    expect(db.selectValue("PRAGMA user_version;")).toBe(derivedDbVersion);
  });
});

describe("db ingest sink", () => {
  it("inserts batches with bound values and keeps FTS populated", async () => {
    const harness = await createHarness();

    await prepareHarness(harness.api);

    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "participants",
        items: [
          {
            id: "p-self",
            handle: "me",
            kind: "self",
            contactName: "Device Owner",
            isSelf: true,
          },
          {
            id: "p-alex",
            handle: "+15550101111",
            kind: "phone",
            contactName: "Alex Example",
            isSelf: false,
          },
        ],
      }),
    );
    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "conversations",
        items: [
          {
            id: "c-1",
            providerKey: "chat-guid-1",
            kind: "direct",
            displayName: "Alex Example",
            service: "iMessage",
            lastMessageAt: "2026-07-08T10:30:00.000Z",
            messageCount: 1,
            participantIds: ["p-self", "p-alex"],
          },
        ],
      }),
    );
    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-1",
            conversationId: "c-1",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T10:30:00.000Z",
            rawTimestamp: "804421800000000000",
            body: "Bronze update'); DROP TABLE participants; -- still text",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceGuid: "message-guid-1",
            sourceRowId: 42,
            isSystemEvent: false,
          },
        ],
      }),
    );
    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "attachments",
        items: [
          {
            id: "a-1",
            messageId: "m-1",
            filename: "photo.heic",
            mime: "image/heic",
            bytes: 2048,
            sourcePath: "Library/SMS/Attachments/photo.heic",
            sourceDomain: "MediaDomain",
            sha256: attachmentSha256,
            sourceGuid: "attachment-guid-1",
          },
        ],
      }),
    );
    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "reactions",
        items: [
          {
            id: "r-1",
            targetMessageId: "m-1",
            senderId: "p-self",
            kind: "liked",
            sentAtUtc: "2026-07-08T10:31:00.000Z",
            rawTimestamp: "804421860000000000",
            sourceGuid: "reaction-guid-1",
            sourceRowId: 43,
          },
        ],
      }),
    );
    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "contact-avatars",
        items: [
          {
            participantId: "p-alex",
            sha256: avatarSha256,
            mime: "image/png",
            byteLength: 3,
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );

    expect(
      harness.db.selectValue(
        "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?;",
        ["bronze"],
      ),
    ).toBe(1);
    expect(
      harness.db.selectValue(
        `
          SELECT messages.id
          FROM messages_fts
          JOIN messages ON messages.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?;
        `,
        ["bronze"],
      ),
    ).toBe("m-1");
    expect(harness.db.selectValue("SELECT COUNT(*) FROM participants;")).toBe(2);
    expect(
      harness.db.selectValue(
        "SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = ?;",
        ["c-1"],
      ),
    ).toBe(2);
    expect(
      harness.db.selectObject(
        "SELECT avatar_path AS avatarPath FROM participants WHERE id = ?;",
        ["p-alex"],
      ),
    ).toEqual({
      avatarPath: `${contactAvatarRelativeDirectory}/${avatarSha256}.png`,
    });
    expect(
      harness.db.selectObject(
        `
          SELECT source_guid AS sourceGuid
          FROM attachments
          WHERE id = ?;
        `,
        ["a-1"],
      ),
    ).toEqual({ sourceGuid: "attachment-guid-1" });
    expect(
      harness.db.selectObject(
        `
          SELECT raw_timestamp AS rawTimestamp
          FROM reactions
          WHERE id = ?;
        `,
        ["r-1"],
      ),
    ).toEqual({ rawTimestamp: "804421860000000000" });
    expect(harness.avatarWrites).toHaveLength(1);
  });

  it("keeps avatar back-references when a participant is re-upserted after avatars", async () => {
    const harness = await createHarness();
    const alex = {
      id: "p-alex",
      handle: "+15550101111",
      kind: "phone" as const,
      contactName: "Alex Example",
      isSelf: false,
    };

    await prepareHarness(harness.api);

    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "participants",
        items: [alex],
      }),
    );
    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "contact-avatars",
        items: [
          {
            participantId: "p-alex",
            sha256: avatarSha256,
            mime: "image/png",
            byteLength: 3,
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );
    unwrap(
      await harness.api.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "participants",
        items: [alex],
      }),
    );

    expect(
      harness.db.selectObject(
        `
          SELECT
            avatar_path AS avatarPath,
            avatar_sha256 AS avatarSha256,
            avatar_mime AS avatarMime
          FROM participants
          WHERE id = ?;
        `,
        ["p-alex"],
      ),
    ).toEqual({
      avatarPath: `${contactAvatarRelativeDirectory}/${avatarSha256}.png`,
      avatarSha256,
      avatarMime: "image/png",
    });
  });

  it("finalizes and reads summary metadata from ingest_meta", async () => {
    const harness = await createHarness();

    await prepareHarness(harness.api);
    await insertMinimalMessageDataset(harness.api);

    const summary = unwrap(await harness.api.finalizeIngest(testReport));
    const storedSummary = unwrap(
      await harness.api.getIngestSummary(testRequest.backupId),
    );

    expect(summary).toEqual({
      ...testReport,
      counts: {
        conversations: 1,
        participants: 2,
        messages: 1,
        attachments: 0,
        reactions: 0,
        contactAvatars: 0,
        warnings: 1,
      },
      databaseName: derivedDatabaseFilename,
      derivedDbVersion,
    });
    expect(storedSummary).toEqual(summary);
    expect(
      harness.db.selectObject(
        "SELECT value FROM ingest_meta WHERE key = ?;",
        ["summary_json"],
      ),
    ).toEqual({ value: JSON.stringify(summary) });
    expect(
      harness.db.selectObject(
        "SELECT value FROM ingest_meta WHERE key = ?;",
        ["database_name"],
      ),
    ).toEqual({ value: derivedDatabaseFilename });
    expect(
      harness.db.selectValue(
        `
          SELECT COUNT(*)
          FROM ingest_meta
          WHERE key IN ('counts_json', 'source_files_json', 'warnings_json')
             OR key LIKE 'count.%';
        `,
      ),
    ).toBe(0);
  });

  it("treats a structurally-valid summary from another derivedDbVersion as absent", async () => {
    const harness = await createHarness();

    await prepareHarness(harness.api);
    await insertMinimalMessageDataset(harness.api);

    const summary = unwrap(await harness.api.finalizeIngest(testReport));
    const staleSummary = { ...summary, derivedDbVersion: derivedDbVersion - 1 };

    harness.db.exec({
      sql: `
        INSERT INTO ingest_meta (key, value)
        VALUES ('summary_json', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `,
      bind: [JSON.stringify(staleSummary)],
    });

    const result = await harness.api.getIngestSummary(testRequest.backupId);

    expect(result.ok).toBe(true);
    expect(unwrap(result)).toBeUndefined();
  });

  it("still reports structural garbage in the stored summary as malformed", async () => {
    const harness = await createHarness();

    await prepareHarness(harness.api);

    harness.db.exec({
      sql: `
        INSERT INTO ingest_meta (key, value)
        VALUES ('summary_json', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `,
      bind: [JSON.stringify({ provider: "" })],
    });

    const result = await harness.api.getIngestSummary(testRequest.backupId);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("db_ingest_failed");
      expect(result.error.message).toContain("malformed");
    }
  });
});

async function createHarness(): Promise<{
  api: Pick<
    DbWorkerApi,
    "prepareIngest" | "writeIngestBatch" | "finalizeIngest" | "getIngestSummary"
  >;
  db: DerivedSqliteDatabase;
  avatarWrites: NormalizedContactAvatar[];
}> {
  const db = await createMemoryDatabase();
  const avatarWrites: NormalizedContactAvatar[] = [];
  const databaseFactory: DerivedDatabaseFactory = (request) =>
    Promise.resolve({
      db,
      databaseName: derivedDatabaseFilename,
      backupDirectoryName: request.deviceInfo?.udid ?? request.backupId,
      close: () => undefined,
    });
  const avatarStore: ContactAvatarStore = {
    reset: () => {
      avatarWrites.length = 0;

      return Promise.resolve();
    },
    write: (_backupDirectoryName, avatar) => {
      avatarWrites.push(avatar);

      return Promise.resolve(
        `${contactAvatarRelativeDirectory}/${avatar.sha256}.png`,
      );
    },
  };

  return {
    api: createDbWorkerIngestApi({
      databaseFactory,
      avatarStore,
      now: () => testNow,
    }),
    db,
    avatarWrites,
  };
}

async function prepareHarness(
  api: Pick<DbWorkerApi, "prepareIngest">,
): Promise<void> {
  unwrap(await api.prepareIngest(testRequest));
}

async function insertMinimalMessageDataset(
  api: Pick<DbWorkerApi, "writeIngestBatch">,
): Promise<void> {
  unwrap(
    await api.writeIngestBatch({
      backupId: testRequest.backupId,
      kind: "participants",
      items: [
        {
          id: "p-self",
          handle: "me",
          kind: "self",
          isSelf: true,
        },
        {
          id: "p-alex",
          handle: "+15550101111",
          kind: "phone",
          isSelf: false,
        },
      ],
    }),
  );
  unwrap(
    await api.writeIngestBatch({
      backupId: testRequest.backupId,
      kind: "conversations",
      items: [
        {
          id: "c-1",
          providerKey: "chat-guid-1",
          kind: "direct",
          messageCount: 1,
          participantIds: ["p-self", "p-alex"],
        },
      ],
    }),
  );
  unwrap(
    await api.writeIngestBatch({
      backupId: testRequest.backupId,
      kind: "messages",
      items: [
        {
          id: "m-1",
          conversationId: "c-1",
          senderId: "p-alex",
          rawTimestamp: "804421800000000000",
          body: "summary body",
          isFromMe: false,
          edited: false,
          unsent: false,
          sourceRowId: 42,
          isSystemEvent: false,
        },
      ],
    }),
  );
}

async function createMemoryDatabase(): Promise<DerivedSqliteDatabase> {
  const sqlite3 = await getSqlite();
  const db = new sqlite3.oo1.DB(":memory:", "c");

  openDatabases.push(db);

  return db;
}

function unwrap<TValue>(result: WorkerResult<TValue>): TValue {
  if (!result.ok) {
    throw new Error(formatWorkerErrorPayload(result.error));
  }

  return result.value;
}

const testRequest: BackupIngestRequest = {
  backupId: "test-backup",
  provider: "ios-itunes",
  sourceKind: "itunes-finder",
  sourceFolderName: "Synthetic Backup",
  friendlyName: "Test Phone",
  deviceInfo: {
    udid: "00000000-0000000000000000",
    name: "Test Phone",
    model: "iPhone99,9",
    osVersion: "18.5",
  },
  isEncrypted: false,
  derivedDbVersion,
};

const testReport: BackupIngestReport = {
  backupId: testRequest.backupId,
  provider: "ios-itunes",
  startedAt: "2026-07-08T11:59:00.000Z",
  completedAt: "2026-07-08T12:00:00.000Z",
  counts: {
    conversations: 99,
    participants: 99,
    messages: 99,
    attachments: 99,
    reactions: 99,
    contactAvatars: 99,
    warnings: 99,
  },
  sourceFiles: [
    {
      role: "messages-db",
      fileId: "3d0d7e5fb2ce288813306e4d4636395e047a3d28",
      domain: "HomeDomain",
      relativePath: "Library/SMS/sms.db",
      sha256: attachmentSha256,
      bytes: 4096,
    },
  ],
  warnings: [
    {
      code: "synthetic-warning",
      message: "Synthetic warning for summary metadata coverage.",
      source: "fixture",
    },
  ],
};
