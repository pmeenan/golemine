import { describe, expect, it } from "vitest";

import {
  includePinnedSearchResult,
  selectScopedCachedSearchResult,
} from "./search-result-pinning";

interface TestSearchResult {
  conversation: { id: string };
  label: string;
  message: { conversationId: string; id: string };
}

describe("includePinnedSearchResult", () => {
  const firstPage: TestSearchResult[] = [
    {
      conversation: { id: "conversation-a" },
      label: "newest",
      message: { conversationId: "conversation-a", id: "message-newest" },
    },
    {
      conversation: { id: "conversation-a" },
      label: "older",
      message: { conversationId: "conversation-a", id: "message-older" },
    },
  ];

  it("appends an activated result that is outside the scoped response page", () => {
    const pinned = {
      conversation: { id: "conversation-a" },
      label: "pinned",
      message: { conversationId: "conversation-a", id: "message-pinned" },
    };

    expect(includePinnedSearchResult(firstPage, pinned)).toEqual([
      ...firstPage,
      pinned,
    ]);
    expect(firstPage).toHaveLength(2);
  });

  it("deduplicates the retained result once pagination loads it naturally", () => {
    expect(includePinnedSearchResult(firstPage, firstPage[1])).toBe(firstPage);
  });

  it("selects only the cached result matching the current message and scope", () => {
    const otherConversationResult: TestSearchResult = {
      conversation: { id: "conversation-b" },
      label: "other conversation",
      message: { conversationId: "conversation-b", id: "message-b" },
    };
    const cached = new Map(
      [...firstPage, otherConversationResult].map((result) => [
        result.message.id,
        result,
      ]),
    );

    expect(
      selectScopedCachedSearchResult(
        cached,
        "message-older",
        "conversation-a",
      ),
    ).toBe(firstPage[1]);
    expect(
      selectScopedCachedSearchResult(
        cached,
        "message-older",
        "conversation-b",
      ),
    ).toBeUndefined();
    expect(
      selectScopedCachedSearchResult(cached, undefined, "conversation-a"),
    ).toBeUndefined();
    expect(
      selectScopedCachedSearchResult(cached, "message-b", "conversation-b"),
    ).toBe(otherConversationResult);
    expect(
      selectScopedCachedSearchResult(
        cached,
        "message-b",
        "conversation-a",
      ),
    ).toBeUndefined();
  });
});
