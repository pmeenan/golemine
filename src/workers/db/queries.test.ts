import { afterEach, describe, expect, it } from "vitest";
import { derivedDbVersion } from "../../lib/constants";
import {
  formatWorkerErrorPayload,
  type BackupIngestRequest,
  type DbWorkerApi,
  type WorkerResult,
} from "../../lib/worker-types";
import {
  createDbWorkerIngestApi,
  type ContactAvatarStore,
  type DerivedDatabaseFactory,
} from "./ingest-sink";
import {
  buildQuotedLiteralSnippetSegments,
  buildSnippetSegments,
  compileUserTextToFtsExpression,
  createDbWorkerQueryApi,
} from "./queries";
import { derivedDatabaseFilename, type DerivedSqliteDatabase } from "./schema";
import { getSqlite } from "../shared/sqlite-init";

const openDatabases: DerivedSqliteDatabase[] = [];

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe("db-worker queries", () => {
  it("lists conversations by recency with participants and last-message previews", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);

    const page = unwrap(
      await harness.queryApi.listConversations({
        backupId: testRequest.backupId,
        limit: 10,
      }),
    );

    expect(page.total).toBe(2);
    expect(page.conversations.map((conversation) => conversation.id)).toEqual([
      "c-group",
      "c-direct",
    ]);
    expect(page.conversations[0]?.participants.map((participant) => participant.id)).toEqual([
      "p-alex",
      "p-blair",
      "p-self",
    ]);
    expect(page.conversations[0]?.lastMessage).toMatchObject({
      id: "m-group-last",
      bodyPreview: "Latest silver note",
      sender: { id: "p-alex", contactName: "Alex Example" },
      attachmentCount: 0,
      reactionCount: 0,
    });
    expect(page.conversations[1]?.lastMessage).toMatchObject({
      id: "m-direct-same-time",
      bodyPreview: "Bronze reaction target",
      attachmentCount: 1,
      reactionCount: 0,
    });

    const nextPage = unwrap(
      await harness.queryApi.listConversations({
        backupId: testRequest.backupId,
        limit: 1,
        offset: 1,
      }),
    );

    expect(nextPage.total).toBe(2);
    expect(nextPage.conversations.map((conversation) => conversation.id)).toEqual([
      "c-direct",
    ]);
  });

  it("returns chronological timeline pages around an anchor with attachments and reactions", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);

    const page = unwrap(
      await harness.queryApi.getMessageTimelinePage({
        backupId: testRequest.backupId,
        conversationId: "c-direct",
        anchorMessageId: "m-direct-anchor",
        limit: 3,
      }),
    );

    expect(page.total).toBe(3);
    expect(page.anchorOffset).toBe(1);
    expect(page.messages.map((message) => message.id)).toEqual([
      "m-direct-older",
      "m-direct-anchor",
      "m-direct-same-time",
    ]);
    expect(page.messages[1]).toMatchObject({
      id: "m-direct-anchor",
      sender: { id: "p-self", isSelf: true },
      attachments: [
        {
          id: "a-photo",
          filename: "photo.heic",
          mediaKind: "heic",
          thumbnailCacheKey: attachmentSha256,
          sourceDomain: "MediaDomain",
          sourceGuid: "attachment-guid-photo",
        },
      ],
      reactions: [
        {
          id: "r-like",
          kind: "liked",
          sender: { id: "p-alex", contactName: "Alex Example" },
          sourceGuid: "reaction-guid-like",
          sourceRowId: 103,
        },
      ],
    });

    const offsetPage = unwrap(
      await harness.queryApi.getMessageTimelinePage({
        backupId: testRequest.backupId,
        conversationId: "c-direct",
        limit: 1,
        offset: 2,
      }),
    );

    expect(offsetPage.messages.map((message) => message.id)).toEqual([
      "m-direct-same-time",
    ]);
    expect(offsetPage.hasMoreBefore).toBe(true);
    expect(offsetPage.hasMoreAfter).toBe(false);
  });

  it("returns messages-only timeline pages without conversation hydration", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);

    const page = unwrap(
      await harness.queryApi.getMessageTimelineMessagesPage({
        backupId: testRequest.backupId,
        conversationId: "c-direct",
        limit: 2,
        offset: 1,
      }),
    );

    expect(page).not.toHaveProperty("conversation");
    expect(page.total).toBe(3);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(2);
    expect(page.messages.map((message) => message.id)).toEqual([
      "m-direct-anchor",
      "m-direct-same-time",
    ]);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(false);
    expect(page.messages[0]).toMatchObject({
      id: "m-direct-anchor",
      serviceKind: "imessage",
      sender: { id: "p-self", isSelf: true },
      attachments: [expect.objectContaining({ id: "a-photo" })],
      reactions: [expect.objectContaining({ id: "r-like" })],
    });

    const anchoredPage = unwrap(
      await harness.queryApi.getMessageTimelineMessagesPage({
        backupId: testRequest.backupId,
        conversationId: "c-direct",
        anchorMessageId: "m-direct-anchor",
        limit: 3,
      }),
    );

    expect(anchoredPage.anchorMessageId).toBe("m-direct-anchor");
    expect(anchoredPage.anchorOffset).toBe(1);
    expect(anchoredPage.messages.map((message) => message.id)).toEqual([
      "m-direct-older",
      "m-direct-anchor",
      "m-direct-same-time",
    ]);
  });

  it("picks last-message previews across null timestamps and rowid ties without window scans", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "conversations",
        items: [
          {
            id: "c-null-only",
            providerKey: "chat-null-only",
            kind: "direct",
            messageCount: 2,
            participantIds: ["p-self", "p-alex"],
          },
          {
            id: "c-mixed-null",
            providerKey: "chat-mixed-null",
            kind: "direct",
            messageCount: 2,
            participantIds: ["p-self", "p-blair"],
          },
        ],
      }),
    );
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-null-low-rowid",
            conversationId: "c-null-only",
            senderId: "p-alex",
            rawTimestamp: "0",
            body: "Undated first",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 400,
            isSystemEvent: false,
          },
          {
            id: "m-null-high-rowid",
            conversationId: "c-null-only",
            senderId: "p-alex",
            rawTimestamp: "0",
            body: "Undated second",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 401,
            isSystemEvent: false,
          },
          {
            id: "m-mixed-dated",
            conversationId: "c-mixed-null",
            senderId: "p-blair",
            sentAtUtc: "2026-07-07T08:00:00.000Z",
            rawTimestamp: "804300000000000000",
            body: "Dated message",
            service: "SMS",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 499,
            isSystemEvent: false,
          },
          {
            id: "m-mixed-null",
            conversationId: "c-mixed-null",
            senderId: "p-blair",
            rawTimestamp: "0",
            body: "Undated message",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 500,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const page = unwrap(
      await harness.queryApi.listConversations({
        backupId: testRequest.backupId,
        limit: 10,
      }),
    );
    const nullOnly = page.conversations.find(
      (conversation) => conversation.id === "c-null-only",
    );
    const mixedNull = page.conversations.find(
      (conversation) => conversation.id === "c-mixed-null",
    );

    // All-null timestamps fall back to the source rowid tie-breaker.
    expect(nullOnly?.lastMessage).toMatchObject({
      id: "m-null-high-rowid",
      serviceKind: "unknown",
    });
    // A dated message beats a null-timestamp message even with a lower rowid.
    expect(mixedNull?.lastMessage).toMatchObject({
      id: "m-mixed-dated",
      serviceKind: "sms-family",
    });
  });

  it("returns message details with conversation context and provenance fields", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);

    const details = unwrap(
      await harness.queryApi.getMessageDetails({
        backupId: testRequest.backupId,
        messageId: "m-direct-anchor",
      }),
    );

    expect(details).toMatchObject({
      conversation: {
        id: "c-direct",
        participants: [
          { id: "p-alex", handle: "+15550101111", contactFirstName: "Alex" },
          { id: "p-self", handle: "me" },
        ],
      },
      message: {
        id: "m-direct-anchor",
        rawTimestamp: "804415800000000000",
        sourceGuid: "message-guid-anchor",
        sourceRowId: 101,
        attachments: [
          {
            mediaKind: "heic",
            thumbnailCacheKey: attachmentSha256,
            sha256: attachmentSha256,
          },
        ],
        reactions: [{ rawTimestamp: "804415860000000000" }],
      },
    });

    const fallbackDetails = unwrap(
      await harness.queryApi.getMessageDetails({
        backupId: testRequest.backupId,
        messageId: "m-direct-same-time",
      }),
    );

    expect(fallbackDetails?.message.attachments).toEqual([
      expect.objectContaining({
        id: "a-note",
        mediaKind: "file",
        thumbnailCacheKey: "attachment-guid-note",
        sourceGuid: "attachment-guid-note",
      }),
    ]);
    expect(fallbackDetails?.message.attachments[0]).not.toHaveProperty("sha256");
  });

  it("omits malformed attachment byte counts without failing message queries", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    harness.db.exec({
      sql: `
        INSERT INTO attachments (
          id,
          message_id,
          filename,
          bytes,
          source_guid
        )
        VALUES ('a-fractional', 'm-direct-anchor', 'fractional.bin', 1.5, 'attachment-guid-fractional');
      `,
    });
    harness.db.exec({
      sql: "UPDATE attachments SET bytes = ? WHERE id = ?;",
      bind: ["not-a-byte-count", "a-photo"],
    });
    harness.db.exec({
      sql: "UPDATE attachments SET bytes = ? WHERE id = ?;",
      bind: [9007199254740992, "a-note"],
    });

    const timeline = unwrap(
      await harness.queryApi.getMessageTimelinePage({
        backupId: testRequest.backupId,
        conversationId: "c-direct",
        limit: 3,
      }),
    );
    const anchor = timeline.messages.find(
      (message) => message.id === "m-direct-anchor",
    );
    const sameTime = timeline.messages.find(
      (message) => message.id === "m-direct-same-time",
    );

    expect(anchor?.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a-photo" }),
        expect.objectContaining({ id: "a-fractional" }),
      ]),
    );
    expect(
      anchor?.attachments.find((attachment) => attachment.id === "a-photo"),
    ).not.toHaveProperty("bytes");
    expect(
      anchor?.attachments.find(
        (attachment) => attachment.id === "a-fractional",
      ),
    ).not.toHaveProperty("bytes");
    expect(sameTime?.attachments[0]).toMatchObject({ id: "a-note" });
    expect(sameTime?.attachments[0]).not.toHaveProperty("bytes");

    const details = unwrap(
      await harness.queryApi.getMessageDetails({
        backupId: testRequest.backupId,
        messageId: "m-direct-anchor",
      }),
    );

    expect(
      details?.message.attachments.find(
        (attachment) => attachment.id === "a-photo",
      ),
    ).not.toHaveProperty("bytes");
    expect(
      details?.message.attachments.find(
        (attachment) => attachment.id === "a-fractional",
      ),
    ).not.toHaveProperty("bytes");

    const search = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: "quartz",
      }),
    );
    const searchMessage = search.results.find(
      (result) => result.message.id === "m-direct-anchor",
    )?.message;

    expect(
      searchMessage?.attachments.find(
        (attachment) => attachment.id === "a-photo",
      ),
    ).not.toHaveProperty("bytes");
    expect(
      searchMessage?.attachments.find(
        (attachment) => attachment.id === "a-fractional",
      ),
    ).not.toHaveProperty("bytes");
  });

  it("searches messages with safe filters and structured snippets", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);

    const attachmentResults = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: "quartz",
        filters: {
          conversationId: "c-direct",
          participantQuery: "alex",
          hasAttachment: true,
        },
      }),
    );

    expect(attachmentResults.total).toBe(1);
    expect(attachmentResults.results[0]?.message.id).toBe("m-direct-anchor");
    expect(attachmentResults.results[0]?.snippets).toContainEqual({
      text: "quartz",
      highlighted: true,
    });
    expect(
      attachmentResults.results[0]?.snippets.every(
        (segment) => !segment.text.includes("<mark>"),
      ),
    ).toBe(true);

    const participantResults = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: "bronze",
        filters: {
          participantId: "p-blair",
          fromUtc: "2026-07-08T09:00:00.000Z",
          toUtcExclusive: "2026-07-08T10:00:00.000Z",
        },
      }),
    );

    expect(participantResults.results.map((result) => result.message.id)).toEqual([
      "m-group-old",
    ]);

    const firstSearchPage = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        limit: 1,
        text: "bronze",
      }),
    );
    const secondSearchPage = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        limit: 1,
        offset: 1,
        text: "bronze",
      }),
    );

    expect(firstSearchPage.total).toBeGreaterThan(1);
    expect(secondSearchPage.total).toBe(firstSearchPage.total);
    expect(secondSearchPage.results).toHaveLength(1);
    expect(secondSearchPage.results[0]?.message.id).not.toBe(
      firstSearchPage.results[0]?.message.id,
    );
  });

  it("compiles implicit-AND prefixes and only sound quoted narrowing terms", () => {
    expect(
      compileUserTextToFtsExpression(
        'alpha bron "PHOTO update" "🧪!"',
      ),
    ).toEqual({
      expression: '"alpha"* "bron"* "update"*',
      terms: ["alpha", "bron", "PHOTO", "update"],
      unquotedTerms: ["alpha", "bron"],
      quotedSubstrings: ["PHOTO update", "🧪!"],
      hasSearchCriteria: true,
      requiresVerification: true,
    });

    expect(compileUserTextToFtsExpression('"rass"')).toMatchObject({
      expression: "",
      terms: ["rass"],
      quotedSubstrings: ["rass"],
      hasSearchCriteria: true,
      requiresVerification: true,
    });
    expect(compileUserTextToFtsExpression("rass")).toMatchObject({
      expression: '"rass"*',
      requiresVerification: false,
    });
    expect(compileUserTextToFtsExpression('"x Ა"')).toMatchObject({
      expression: "",
      terms: ["x", "Ა"],
      quotedSubstrings: ["x Ა"],
    });
    expect(compileUserTextToFtsExpression('"Ა x"')).toMatchObject({
      expression: '"x"*',
      terms: ["Ა", "x"],
      quotedSubstrings: ["Ა x"],
    });
    expect(compileUserTextToFtsExpression("Ა")).toMatchObject({
      expression: '"Ა"*',
      terms: ["Ა"],
      requiresVerification: false,
    });
  });

  it("matches unquoted prefixes with implicit AND in any order", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-prefix",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "A BRONZED plate carries alphabetic marks",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: "alpha bron",
      }),
    );

    expect(result.results.map((item) => item.message.id)).toContain("m-prefix");
    expect(result.coverage).toEqual({
      strategy: "fts",
      candidateRows: 2,
      truncated: false,
    });
  });

  it("verifies mixed quoted substrings after sound FTS narrowing", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-quoted-match",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "The PHOTO UPDATE includes quartz",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
          {
            id: "m-quoted-false-candidate",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:01:00.000Z",
            rawTimestamp: "804422460000000000",
            body: "The photo has an unrelated update includes quartz",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 301,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"photo update includes" quartz',
      }),
    );

    expect(result.results.map((item) => item.message.id)).toEqual([
      "m-quoted-match",
    ]);
    expect(result.coverage).toEqual({
      strategy: "fts",
      candidateRows: 2,
      truncated: false,
    });
    expect(result.results[0]?.snippets).toContainEqual({
      text: "PHOTO UPDATE includes",
      highlighted: true,
    });
  });

  it("finds case-insensitive mid-token quoted literals without unsound FTS narrowing", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-mid-token",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "Polished BRASS casing",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"rass"',
      }),
    );

    expect(result.results.map((item) => item.message.id)).toEqual([
      "m-mid-token",
    ]);
    expect(result.coverage).toEqual({
      strategy: "bounded-scan",
      candidateRows: 6,
      truncated: false,
      rowBudget: 10_000,
    });
    expect(result.results[0]?.snippets).toContainEqual({
      text: "RASS",
      highlighted: true,
    });

    const narrowed = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"rass" casing',
      }),
    );

    expect(narrowed.results.map((item) => item.message.id)).toEqual([
      "m-mid-token",
    ]);
    expect(narrowed.coverage.strategy).toBe("fts");
  });

  it("keeps one bounded corpus when results are scoped to a conversation", async () => {
    const harness = await createHarness({ boundedSearchRowBudget: 1 });

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-global-cap-newest",
            conversationId: "c-group",
            senderId: "p-blair",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "Newest BRASS global hit",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
          {
            id: "m-outside-global-cap",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T11:30:00.000Z",
            rawTimestamp: "804420600000000000",
            body: "Older BRASS scoped hit",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 301,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const globalResults = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"rass"',
      }),
    );
    const globalConversations = unwrap(
      await harness.queryApi.listSearchConversations({
        backupId: testRequest.backupId,
        text: '"rass"',
      }),
    );
    const scopedResults = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"rass"',
        filters: { conversationId: "c-direct" },
      }),
    );

    expect(globalResults.results.map((item) => item.message.id)).toEqual([
      "m-global-cap-newest",
    ]);
    expect(globalConversations.conversations).toEqual([
      expect.objectContaining({ id: "c-group", hitCount: 1 }),
    ]);
    expect(scopedResults.results).toEqual([]);
    expect(scopedResults.total).toBe(0);
    expect(scopedResults.coverage).toEqual(globalResults.coverage);
    expect(scopedResults.coverage).toEqual({
      strategy: "bounded-scan",
      candidateRows: 7,
      truncated: true,
      rowBudget: 1,
    });
  });

  it("bounds FTS-narrowed quoted verification scans and discloses truncation", async () => {
    const harness = await createHarness({ boundedSearchRowBudget: 1 });

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-narrowed-newest",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "Newest BRASS casing",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
          {
            id: "m-narrowed-older",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T11:30:00.000Z",
            rawTimestamp: "804420600000000000",
            body: "Older BRASS casing",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 301,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"rass" casing',
      }),
    );

    expect(result.results.map((item) => item.message.id)).toEqual([
      "m-narrowed-newest",
    ]);
    expect(result.total).toBe(1);
    expect(result.coverage).toEqual({
      strategy: "bounded-scan",
      candidateRows: 2,
      truncated: true,
      rowBudget: 1,
    });
  });

  it("highlights unquoted terms inside quoted-literal snippets", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-mixed-highlight",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "A BRONZED filigree wraps the gear assembly",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: 'bronz "gear"',
      }),
    );

    expect(result.results.map((item) => item.message.id)).toEqual([
      "m-mixed-highlight",
    ]);
    // The quoted literal and the unquoted AND-term (as a whole prefixed
    // token) are both highlighted; without the term highlight the user
    // cannot tell why the mixed query matched this message.
    expect(result.results[0]?.snippets).toContainEqual({
      text: "gear",
      highlighted: true,
    });
    expect(result.results[0]?.snippets).toContainEqual({
      text: "BRONZED",
      highlighted: true,
    });
  });

  it("aligns quoted snippet windows to code-point boundaries", () => {
    const body = `${"🙂".repeat(150)} quartz mine`;
    const segments = buildQuotedLiteralSnippetSegments(body, ["quartz mine"]);

    expect(
      segments.some(
        (segment) => segment.highlighted && segment.text.includes("quartz mine"),
      ),
    ).toBe(true);

    for (const segment of segments) {
      // A window edge landing inside a surrogate pair would leave a lone
      // surrogate (rendered as U+FFFD) at a segment boundary.
      expect(/\p{Cs}/u.test(segment.text)).toBe(false);
    }
  });

  it("uses Unicode case folding for verified quoted literals", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-final-sigma",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "Greek ος ending",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
          {
            id: "m-long-s",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:01:00.000Z",
            rawTimestamp: "804422460000000000",
            body: "A ſpecial archival form",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 301,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const sigmaResults = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"οσ"',
      }),
    );
    const longSResults = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"special"',
      }),
    );

    expect(sigmaResults.results.map((item) => item.message.id)).toContain(
      "m-final-sigma",
    );
    expect(
      sigmaResults.results.find((item) => item.message.id === "m-final-sigma")
        ?.snippets,
    ).toContainEqual({ text: "ος", highlighted: true });
    expect(longSResults.results.map((item) => item.message.id)).toContain(
      "m-long-s",
    );
    expect(
      longSResults.results.find((item) => item.message.id === "m-long-s")
        ?.snippets,
    ).toContainEqual({ text: "ſpecial", highlighted: true });
  });

  it("does not let unicode61 version skew hide verified Georgian quoted matches", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-georgian-bounded",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "x ა",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
          {
            id: "m-georgian-ascii-narrowed",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:01:00.000Z",
            rawTimestamp: "804422460000000000",
            body: "ა X",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 301,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const bounded = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"x Ა"',
      }),
    );
    const asciiNarrowed = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"Ა x"',
      }),
    );

    expect(bounded.results.map((item) => item.message.id)).toEqual([
      "m-georgian-bounded",
    ]);
    expect(bounded.coverage.strategy).toBe("bounded-scan");
    expect(bounded.results[0]?.snippets).toContainEqual({
      text: "x ა",
      highlighted: true,
    });
    expect(asciiNarrowed.results.map((item) => item.message.id)).toEqual([
      "m-georgian-ascii-narrowed",
    ]);
    expect(asciiNarrowed.coverage.strategy).toBe("fts");
    expect(asciiNarrowed.results[0]?.snippets).toContainEqual({
      text: "ა X",
      highlighted: true,
    });
  });

  it("reports bounded-scan truncation for punctuation-only quoted searches", async () => {
    const harness = await createHarness({ boundedSearchRowBudget: 1 });

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-punctuation-newest",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "Newest 🧪! literal",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
          {
            id: "m-punctuation-older",
            conversationId: "c-group",
            senderId: "p-blair",
            sentAtUtc: "2026-07-08T11:30:00.000Z",
            rawTimestamp: "804420600000000000",
            body: "Older 🧪! literal",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 301,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"🧪!"',
      }),
    );

    expect(result.results.map((item) => item.message.id)).toEqual([
      "m-punctuation-newest",
    ]);
    expect(result.total).toBe(1);
    expect(result.coverage).toEqual({
      strategy: "bounded-scan",
      candidateRows: 7,
      truncated: true,
      rowBudget: 1,
    });

    const conversations = unwrap(
      await harness.queryApi.listSearchConversations({
        backupId: testRequest.backupId,
        text: '"🧪!"',
      }),
    );

    expect(conversations.conversations).toEqual([
      expect.objectContaining({ id: "c-direct", hitCount: 1 }),
    ]);
    expect(conversations.coverage).toEqual(result.coverage);
    expect(conversations.coverage.truncated).toBe(true);
  });

  it("lists active-search conversations by newest hit with hit counts", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);

    const page = unwrap(
      await harness.queryApi.listSearchConversations({
        backupId: testRequest.backupId,
        text: "bronze",
      }),
    );

    expect(page.total).toBe(2);
    expect(page.conversations).toEqual([
      expect.objectContaining({
        id: "c-direct",
        hitCount: 3,
        latestHitAtUtc: "2026-07-08T10:10:00.000Z",
      }),
      expect.objectContaining({
        id: "c-group",
        hitCount: 1,
        latestHitAtUtc: "2026-07-08T09:30:00.000Z",
      }),
    ]);
    expect(page.coverage).toEqual({
      strategy: "fts",
      candidateRows: 4,
      truncated: false,
    });

    const secondPage = unwrap(
      await harness.queryApi.listSearchConversations({
        backupId: testRequest.backupId,
        text: "bronze",
        limit: 1,
        offset: 1,
      }),
    );

    expect(secondPage.conversations.map((conversation) => conversation.id)).toEqual([
      "c-group",
    ]);
  });

  it("lists verified quoted hits per conversation and applies non-conversation filters", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-rass-direct-new",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T12:00:00.000Z",
            rawTimestamp: "804422400000000000",
            body: "New BRASS plate",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 300,
            isSystemEvent: false,
          },
          {
            id: "m-rass-direct-old",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T11:45:00.000Z",
            rawTimestamp: "804421500000000000",
            body: "Old grass note",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 301,
            isSystemEvent: false,
          },
          {
            id: "m-rass-group",
            conversationId: "c-group",
            senderId: "p-blair",
            sentAtUtc: "2026-07-08T11:30:00.000Z",
            rawTimestamp: "804420600000000000",
            body: "Group brass note",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceRowId: 302,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const page = unwrap(
      await harness.queryApi.listSearchConversations({
        backupId: testRequest.backupId,
        text: '"rass"',
      }),
    );

    expect(page.conversations).toEqual([
      expect.objectContaining({
        id: "c-direct",
        hitCount: 2,
        latestHitAtUtc: "2026-07-08T12:00:00.000Z",
      }),
      expect.objectContaining({
        id: "c-group",
        hitCount: 1,
        latestHitAtUtc: "2026-07-08T11:30:00.000Z",
      }),
    ]);
    expect(page.coverage).toMatchObject({
      strategy: "bounded-scan",
      truncated: false,
    });

    const participantFiltered = unwrap(
      await harness.queryApi.listSearchConversations({
        backupId: testRequest.backupId,
        text: '"rass"',
        filters: { participantId: "p-blair" },
      }),
    );

    expect(participantFiltered.conversations).toEqual([
      expect.objectContaining({ id: "c-group", hitCount: 1 }),
    ]);
  });

  it("uses FTS snippets for diacritic-folded search highlights", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-cafe",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T10:20:00.000Z",
            rawTimestamp: "804416400000000000",
            body: "Meet at the Caf\u00e9 before noon",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceGuid: "message-guid-cafe",
            sourceRowId: 104,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: "cafe",
      }),
    );

    expect(result.results.map((searchResult) => searchResult.message.id)).toContain(
      "m-cafe",
    );
    expect(
      result.results.find((searchResult) => searchResult.message.id === "m-cafe")
        ?.snippets,
    ).toContainEqual({ text: "Caf\u00e9", highlighted: true });
  });

  it("quotes hostile FTS text and keeps backup strings out of SQL syntax", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: 'bronze"; DROP TABLE participants; --',
        filters: {
          participantQuery: "%' OR 1=1 --",
        },
      }),
    );

    expect(result.results).toEqual([]);
    expect(
      harness.db.selectValue("SELECT COUNT(*) FROM participants;"),
    ).toBe(3);
  });

  it("degrades snippet highlighting when a hostile body contains sentinel characters", async () => {
    const harness = await createHarness();

    await seedDataset(harness.ingestApi);
    unwrap(
      await harness.ingestApi.writeIngestBatch({
        backupId: testRequest.backupId,
        kind: "messages",
        items: [
          {
            id: "m-sentinel",
            conversationId: "c-direct",
            senderId: "p-alex",
            sentAtUtc: "2026-07-08T10:30:00.000Z",
            rawTimestamp: "804417000000000000",
            body: "Sneaky \u0001forged\u0002 zircon payload",
            service: "iMessage",
            isFromMe: false,
            edited: false,
            unsent: false,
            sourceGuid: "message-guid-sentinel",
            sourceRowId: 105,
            isSystemEvent: false,
          },
        ],
      }),
    );

    const result = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: "zircon",
      }),
    );
    const sentinelResult = result.results.find(
      (searchResult) => searchResult.message.id === "m-sentinel",
    );

    expect(sentinelResult).toBeDefined();
    expect(
      sentinelResult?.snippets.every(
        (segment) =>
          !segment.text.includes("\u0001") && !segment.text.includes("\u0002"),
      ),
    ).toBe(true);
    expect(
      sentinelResult?.snippets.some(
        (segment) => segment.highlighted && segment.text.includes("forged"),
      ),
    ).toBe(false);
    // Forged sentinels degrade the whole snippet to non-highlighted text.
    expect(
      sentinelResult?.snippets.every((segment) => !segment.highlighted),
    ).toBe(true);
    expect(
      sentinelResult?.snippets.map((segment) => segment.text).join(""),
    ).toContain("zircon");

    const quotedResult = unwrap(
      await harness.queryApi.searchMessages({
        backupId: testRequest.backupId,
        text: '"zircon"',
      }),
    ).results.find(
      (searchResult) => searchResult.message.id === "m-sentinel",
    );

    expect(quotedResult).toBeDefined();
    expect(
      quotedResult?.snippets.every(
        (segment) =>
          !segment.highlighted &&
          !segment.text.includes("\u0001") &&
          !segment.text.includes("\u0002"),
      ),
    ).toBe(true);
  });

  it("keeps a clipped highlight for quoted literals longer than the snippet budget", () => {
    const literal = "a".repeat(221);
    const segments = buildQuotedLiteralSnippetSegments(
      `before ${literal.toUpperCase()} after`,
      [literal],
    );

    expect(segments).toEqual([
      { text: "...", highlighted: false },
      { text: "A".repeat(220), highlighted: true },
      { text: "...", highlighted: false },
    ]);
    expect(
      segments.every(
        (segment) =>
          !segment.text.includes("\u0001") &&
          !segment.text.includes("\u0002"),
      ),
    ).toBe(true);
  });

  it("returns no snippet segments when a body strips to nothing after sentinel removal", () => {
    // A hostile body made entirely of the snippet sentinel characters must
    // not surface an empty { text: "" } segment; the UI omits the snippet.
    expect(buildSnippetSegments(undefined, "\u0001\u0002\u0001")).toEqual([]);
    expect(buildSnippetSegments("", "\u0001\u0002")).toEqual([]);
    // When the snippet itself still has text after stripping, the degraded
    // single non-highlighted segment is kept.
    expect(
      buildSnippetSegments("\u0001stray", "\u0002\u0002\u0001"),
    ).toEqual([{ text: "stray", highlighted: false }]);
    // A non-empty body still produces its single fallback segment.
    expect(buildSnippetSegments(undefined, "bronze")).toEqual([
      { text: "bronze", highlighted: false },
    ]);
    expect(
      buildQuotedLiteralSnippetSegments(
        "Sneaky \u0001forged\u0002 zircon payload",
        ["zircon"],
      ),
    ).toEqual([
      { text: "Sneaky forged zircon payload", highlighted: false },
    ]);
  });
});

async function createHarness(options: {
  boundedSearchRowBudget?: number;
} = {}): Promise<{
  db: DerivedSqliteDatabase;
  ingestApi: Pick<DbWorkerApi, "prepareIngest" | "writeIngestBatch">;
  queryApi: Pick<
    DbWorkerApi,
    | "listConversations"
    | "listThreads"
    | "getMessageTimelinePage"
    | "getMessageTimelineMessagesPage"
    | "getMessageDetails"
    | "searchMessages"
    | "listSearchConversations"
  >;
}> {
  const db = await createMemoryDatabase();
  const databaseFactory: DerivedDatabaseFactory = (request) =>
    Promise.resolve({
      db,
      databaseName: derivedDatabaseFilename,
      backupDirectoryName: request.deviceInfo?.udid ?? request.backupId,
      close: () => undefined,
    });
  const avatarStore: ContactAvatarStore = {
    reset: () => Promise.resolve(),
    write: (_backupDirectoryName, avatar) =>
      Promise.resolve(`thumbs/contact-avatars/${avatar.sha256}.png`),
  };

  return {
    db,
    ingestApi: createDbWorkerIngestApi({ databaseFactory, avatarStore }),
    queryApi: createDbWorkerQueryApi({
      databaseFactory,
      boundedSearchRowBudget: options.boundedSearchRowBudget,
    }),
  };
}

async function seedDataset(
  api: Pick<DbWorkerApi, "prepareIngest" | "writeIngestBatch">,
): Promise<void> {
  unwrap(await api.prepareIngest(testRequest));
  unwrap(
    await api.writeIngestBatch({
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
          contactFirstName: "Alex",
          contactName: "Alex Example",
          isSelf: false,
        },
        {
          id: "p-blair",
          handle: "blair@example.test",
          kind: "email",
          contactFirstName: "Blair",
          contactName: "Blair Example",
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
          id: "c-direct",
          providerKey: "chat-direct",
          kind: "direct",
          displayName: "Alex Example",
          service: "iMessage",
          lastMessageAt: "2026-07-08T10:10:00.000Z",
          messageCount: 3,
          participantIds: ["p-self", "p-alex"],
        },
        {
          id: "c-group",
          providerKey: "chat-group",
          kind: "group",
          displayName: "Case Group",
          service: "iMessage",
          lastMessageAt: "2026-07-08T11:00:00.000Z",
          messageCount: 2,
          participantIds: ["p-self", "p-alex", "p-blair"],
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
          id: "m-direct-older",
          conversationId: "c-direct",
          senderId: "p-alex",
          sentAtUtc: "2026-07-08T10:00:00.000Z",
          rawTimestamp: "804415200000000000",
          body: "Alpha bronze first",
          service: "iMessage",
          isFromMe: false,
          edited: false,
          unsent: false,
          sourceGuid: "message-guid-older",
          sourceRowId: 100,
          isSystemEvent: false,
        },
        {
          id: "m-direct-anchor",
          conversationId: "c-direct",
          senderId: "p-self",
          sentAtUtc: "2026-07-08T10:10:00.000Z",
          rawTimestamp: "804415800000000000",
          body: "Bronze photo update with quartz",
          service: "iMessage",
          isFromMe: true,
          dateDelivered: "2026-07-08T10:10:05.000Z",
          dateRead: "2026-07-08T10:11:00.000Z",
          edited: true,
          unsent: false,
          sourceGuid: "message-guid-anchor",
          sourceRowId: 101,
          isSystemEvent: false,
        },
        {
          id: "m-direct-same-time",
          conversationId: "c-direct",
          senderId: "p-alex",
          sentAtUtc: "2026-07-08T10:10:00.000Z",
          rawTimestamp: "804415800000000000",
          body: "Bronze reaction target",
          service: "iMessage",
          isFromMe: false,
          edited: false,
          unsent: false,
          sourceGuid: "message-guid-same-time",
          sourceRowId: 102,
          isSystemEvent: false,
        },
        {
          id: "m-group-old",
          conversationId: "c-group",
          senderId: "p-blair",
          sentAtUtc: "2026-07-08T09:30:00.000Z",
          rawTimestamp: "804413400000000000",
          body: "Group bronze plan",
          service: "iMessage",
          isFromMe: false,
          edited: false,
          unsent: false,
          sourceGuid: "message-guid-group-old",
          sourceRowId: 200,
          isSystemEvent: false,
        },
        {
          id: "m-group-last",
          conversationId: "c-group",
          senderId: "p-alex",
          sentAtUtc: "2026-07-08T11:00:00.000Z",
          rawTimestamp: "804418800000000000",
          body: "Latest silver note",
          service: "iMessage",
          isFromMe: false,
          edited: false,
          unsent: false,
          sourceGuid: "message-guid-group-last",
          sourceRowId: 201,
          isSystemEvent: false,
        },
      ],
    }),
  );
  unwrap(
    await api.writeIngestBatch({
      backupId: testRequest.backupId,
      kind: "attachments",
      items: [
        {
          id: "a-photo",
          messageId: "m-direct-anchor",
          filename: "photo.heic",
          mime: "image/heic",
          bytes: 2048,
          sourcePath: "Library/SMS/Attachments/photo.heic",
          sourceDomain: "MediaDomain",
          sha256: attachmentSha256,
          sourceGuid: "attachment-guid-photo",
        },
        {
          id: "a-note",
          messageId: "m-direct-same-time",
          filename: "notes.txt",
          sourcePath: "Library/SMS/Attachments/notes.txt",
          sourceDomain: "MediaDomain",
          sourceGuid: "attachment-guid-note",
        },
      ],
    }),
  );
  unwrap(
    await api.writeIngestBatch({
      backupId: testRequest.backupId,
      kind: "reactions",
      items: [
        {
          id: "r-like",
          targetMessageId: "m-direct-anchor",
          senderId: "p-alex",
          kind: "liked",
          sentAtUtc: "2026-07-08T10:11:00.000Z",
          rawTimestamp: "804415860000000000",
          sourceGuid: "reaction-guid-like",
          sourceRowId: 103,
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

const attachmentSha256 =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const testRequest: BackupIngestRequest = {
  backupId: "query-test-backup",
  provider: "ios-itunes",
  sourceKind: "itunes-finder",
  sourceFolderName: "Synthetic Backup",
  friendlyName: "Query Test Phone",
  deviceInfo: {
    udid: "11111111-1111111111111111",
    name: "Query Test Phone",
  },
  isEncrypted: false,
  derivedDbVersion,
};
