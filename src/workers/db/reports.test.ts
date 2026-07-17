import { afterEach, describe, expect, it } from "vitest";

import { derivedDbVersion } from "../../lib/constants";
import type {
  BackupIngestRequest,
  DbWorkerApi,
} from "../../lib/worker-types";
import {
  closeMemoryDatabases,
  createMemoryDatabase,
  unwrap,
} from "./derived-db.test-support";
import {
  createDbWorkerIngestApi,
  type DerivedDatabaseFactory,
} from "./ingest-sink";
import { createDbWorkerReportApi } from "./reports";

afterEach(closeMemoryDatabases);

describe("db-worker reports", () => {
  it("creates multiple reports, persists ordered items and notes, and updates membership", async () => {
    const db = await createMemoryDatabase();
    const databaseFactory: DerivedDatabaseFactory = () => Promise.resolve({
      db,
      databaseName: "test.sqlite",
      backupDirectoryName: "backup-report-test",
      close: () => undefined,
    });
    const ingest = createDbWorkerIngestApi({
      databaseFactory,
      avatarStore: {
        reset: () => Promise.resolve(),
        write: () => Promise.resolve("unused"),
      },
    });
    const ids = ["report-a", "report-b"];
    let tick = 0;
    const reports = createDbWorkerReportApi({
      databaseFactory,
      now: () => new Date(Date.UTC(2026, 6, 16, 12, 0, tick++)),
      randomId: () => ids.shift() ?? "unexpected-report",
    });

    await seedMessages(ingest);

    const reportA = unwrap(
      await reports.createReport({
        backupId: request.backupId,
        title: "Exhibit A",
        timezone: "America/New_York",
      }),
    );
    const reportB = unwrap(
      await reports.createReport({
        backupId: request.backupId,
        title: "Interview extract",
        timezone: "UTC",
      }),
    );

    expect(reportA).toMatchObject({ id: "report-a", itemCount: 0 });
    expect(reportB).toMatchObject({ id: "report-b", itemCount: 0 });

    unwrap(
      await reports.setMessageReportMembership({
        backupId: request.backupId,
        messageId: "message-1",
        reportId: reportA.id,
        selected: true,
      }),
    );
    unwrap(
      await reports.setMessageReportMembership({
        backupId: request.backupId,
        messageId: "message-2",
        reportId: reportA.id,
        selected: true,
      }),
    );
    const membership = unwrap(
      await reports.setMessageReportMembership({
        backupId: request.backupId,
        messageId: "message-1",
        reportId: reportB.id,
        selected: true,
      }),
    );

    expect(membership.reportIds).toEqual(["report-a", "report-b"]);
    expect(
      unwrap(await reports.listReports({ backupId: request.backupId })).reports,
    ).toEqual([
      expect.objectContaining({ id: "report-b", itemCount: 1 }),
      expect.objectContaining({ id: "report-a", itemCount: 2 }),
    ]);

    const initial = unwrap(
      await reports.getReport({
        backupId: request.backupId,
        reportId: reportA.id,
      }),
    );

    expect(initial?.items.map((item) => item.message.id)).toEqual([
      "message-1",
      "message-2",
    ]);

    const saved = unwrap(
      await reports.saveReport({
        backupId: request.backupId,
        reportId: reportA.id,
        title: "Exhibit A — selected messages",
        caseMetadata: {
          matter: "Example v. Sample",
          preparer: "Pat Example",
          timezone: "America/Chicago",
        },
        items: [
          { messageId: "message-2", note: "Second message first." },
          { messageId: "message-1", note: "Follow-up context." },
        ],
      }),
    );

    expect(saved.caseMetadata).toEqual({
      matter: "Example v. Sample",
      preparer: "Pat Example",
      timezone: "America/Chicago",
    });
    expect(saved.items.map((item) => [item.message.id, item.note, item.position])).toEqual([
      ["message-2", "Second message first.", 0],
      ["message-1", "Follow-up context.", 1],
    ]);

    unwrap(
      await reports.setMessageReportMembership({
        backupId: request.backupId,
        messageId: "message-2",
        reportId: reportA.id,
        selected: false,
      }),
    );
    const afterRemoval = unwrap(
      await reports.getReport({
        backupId: request.backupId,
        reportId: reportA.id,
      }),
    );

    // Removal leaves positions sparse; ordering is what matters (saveReport
    // rewrote message-1 to position 1, and removal does not renumber).
    expect(
      afterRemoval?.items.map((item) => ({
        messageId: item.message.id,
        position: item.position,
      })),
    ).toEqual([{ messageId: "message-1", position: 1 }]);

    // A same-version rebuild recreates normalized tables but retains
    // user-authored report metadata, notes, and surviving selections.
    await seedMessages(ingest);
    const afterRebuild = unwrap(
      await reports.getReport({
        backupId: request.backupId,
        reportId: reportA.id,
      }),
    );
    expect(afterRebuild).toMatchObject({
      id: reportA.id,
      title: "Exhibit A — selected messages",
      items: [
        {
          message: { id: "message-1" },
          note: "Follow-up context.",
          position: 1,
        },
      ],
    });
    expect(
      unwrap(
        await reports.deleteReport({
          backupId: request.backupId,
          reportId: reportB.id,
        }),
      ),
    ).toBe(true);
  });

  it("deletes report items explicitly even when foreign keys are disabled", async () => {
    const db = await createMemoryDatabase();
    const databaseFactory: DerivedDatabaseFactory = () => Promise.resolve({
      db,
      databaseName: "test.sqlite",
      backupDirectoryName: "backup-report-test",
      close: () => undefined,
    });
    const ingest = createDbWorkerIngestApi({
      databaseFactory,
      avatarStore: {
        reset: () => Promise.resolve(),
        write: () => Promise.resolve("unused"),
      },
    });
    const reports = createDbWorkerReportApi({ databaseFactory });

    await seedMessages(ingest);
    const report = unwrap(
      await reports.createReport({
        backupId: request.backupId,
        title: "Cascade check",
        timezone: "UTC",
      }),
    );
    unwrap(
      await reports.setMessageReportMembership({
        backupId: request.backupId,
        messageId: "message-1",
        reportId: report.id,
        selected: true,
      }),
    );

    // Production report RPC connections never ran PRAGMA foreign_keys = ON
    // historically, so the delete must not depend on ON DELETE CASCADE.
    db.exec("PRAGMA foreign_keys = OFF;");
    expect(
      unwrap(
        await reports.deleteReport({
          backupId: request.backupId,
          reportId: report.id,
        }),
      ),
    ).toBe(true);

    expect(
      unwrap(
        await reports.getMessageReportMembership({
          backupId: request.backupId,
          messageId: "message-1",
        }),
      ).reportIds,
    ).toEqual([]);
    expect(Number(db.selectValue("SELECT COUNT(*) FROM report_items;"))).toBe(0);
  });

  it("keeps other reports listable when one stored row is corrupt", async () => {
    const db = await createMemoryDatabase();
    const databaseFactory: DerivedDatabaseFactory = () => Promise.resolve({
      db,
      databaseName: "test.sqlite",
      backupDirectoryName: "backup-report-test",
      close: () => undefined,
    });
    const ingest = createDbWorkerIngestApi({
      databaseFactory,
      avatarStore: {
        reset: () => Promise.resolve(),
        write: () => Promise.resolve("unused"),
      },
    });
    const reports = createDbWorkerReportApi({ databaseFactory });

    await seedMessages(ingest);
    unwrap(
      await reports.createReport({
        backupId: request.backupId,
        title: "Healthy report",
        timezone: "UTC",
      }),
    );
    // A stored timezone the runtime no longer supports (or malformed
    // metadata JSON) degrades that report to defaults instead of poisoning
    // the whole list.
    db.exec({
      sql: `
        INSERT INTO reports (id, title, created_at, updated_at, case_meta_json)
        VALUES (?, ?, ?, ?, ?);
      `,
      bind: [
        "report-drifted",
        "Drifted timezone",
        "2026-07-16T12:00:00.000Z",
        "2026-07-16T12:00:00.000Z",
        JSON.stringify({ matter: "", preparer: "", timezone: "Mars/Olympus_Mons" }),
      ],
    });
    db.exec({
      sql: `
        INSERT INTO reports (id, title, created_at, updated_at, case_meta_json)
        VALUES (?, ?, ?, ?, ?);
      `,
      bind: [
        "report-malformed",
        "Malformed metadata",
        "2026-07-16T12:00:00.000Z",
        "2026-07-16T12:00:00.000Z",
        "{not json",
      ],
    });

    const listed = unwrap(
      await reports.listReports({ backupId: request.backupId }),
    ).reports;

    expect(listed.map((report) => report.id)).toContain("report-drifted");
    expect(listed.map((report) => report.id)).toContain("report-malformed");
    expect(listed).toHaveLength(3);
    expect(
      listed.find((report) => report.id === "report-drifted")?.caseMetadata
        .timezone,
    ).toBe("UTC");
  });

  it("rejects unsupported report timezones", async () => {
    const db = await createMemoryDatabase();
    const databaseFactory: DerivedDatabaseFactory = () => Promise.resolve({
      db,
      databaseName: "test.sqlite",
      backupDirectoryName: "backup-report-test",
      close: () => undefined,
    });
    const ingest = createDbWorkerIngestApi({
      databaseFactory,
      avatarStore: {
        reset: () => Promise.resolve(),
        write: () => Promise.resolve("unused"),
      },
    });
    const reports = createDbWorkerReportApi({ databaseFactory });

    await seedMessages(ingest);
    const result = await reports.createReport({
      backupId: request.backupId,
      title: "Invalid zone",
      timezone: "Mars/Olympus_Mons",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Creating the report failed.");
      expect(result.error.causeMessage).toContain("not supported");
    }
  });
});

const request: BackupIngestRequest = {
  backupId: "backup-report-test",
  provider: "ios-itunes",
  sourceKind: "itunes-finder",
  sourceFolderName: "synthetic",
  friendlyName: "Synthetic report backup",
  deviceInfo: { udid: "backup-report-test", name: "Synthetic phone" },
  isEncrypted: false,
  derivedDbVersion,
};

async function seedMessages(
  ingest: Pick<DbWorkerApi, "prepareIngest" | "writeIngestBatch">,
): Promise<void> {
  unwrap(await ingest.prepareIngest(request));
  unwrap(
    await ingest.writeIngestBatch({
      backupId: request.backupId,
      kind: "participants",
      items: [
        {
          id: "person-self",
          handle: "self",
          kind: "self",
          contactName: "Mina",
          isSelf: true,
        },
        {
          id: "person-other",
          handle: "+15550102000",
          kind: "phone",
          contactName: "Rowan Vale",
          contactFirstName: "Rowan",
          isSelf: false,
        },
      ],
    }),
  );
  unwrap(
    await ingest.writeIngestBatch({
      backupId: request.backupId,
      kind: "conversations",
      items: [
        {
          id: "conversation-1",
          providerKey: "chat-1",
          kind: "direct",
          lastMessageAt: "2026-07-01T13:01:00.000Z",
          messageCount: 2,
          participantIds: ["person-self", "person-other"],
        },
      ],
    }),
  );
  unwrap(
    await ingest.writeIngestBatch({
      backupId: request.backupId,
      kind: "messages",
      items: [
        {
          id: "message-1",
          conversationId: "conversation-1",
          senderId: "person-other",
          sentAtUtc: "2026-07-01T13:00:00.000Z",
          rawTimestamp: "804600000000000000",
          body: "Did you find the brass gear?",
          service: "iMessage",
          isFromMe: false,
          edited: false,
          unsent: false,
          sourceGuid: "SOURCE-MESSAGE-1",
          sourceRowId: 1,
          isSystemEvent: false,
        },
        {
          id: "message-2",
          conversationId: "conversation-1",
          senderId: "person-self",
          sentAtUtc: "2026-07-01T13:01:00.000Z",
          rawTimestamp: "804600060000000000",
          body: "Packed it with the backup notes.",
          service: "iMessage",
          isFromMe: true,
          edited: false,
          unsent: false,
          sourceGuid: "SOURCE-MESSAGE-2",
          sourceRowId: 2,
          isSystemEvent: false,
        },
      ],
    }),
  );
}

