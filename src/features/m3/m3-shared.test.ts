import { describe, expect, it } from "vitest";

import {
  conversationTitle,
  isInlinePreviewMediaKind,
  isThumbnailPreviewMediaKind,
  mergeBy,
  mergeById,
} from "./m3-shared";
import type { DbAttachmentMediaKind } from "../../lib/worker-types";

describe("M3 media-kind preview helpers", () => {
  it("treats HEIC as an inline thumbnail preview kind", () => {
    const kinds: DbAttachmentMediaKind[] = ["image", "heic", "video", "file"];

    expect(kinds.filter(isInlinePreviewMediaKind)).toEqual([
      "image",
      "heic",
      "video",
    ]);
    expect(kinds.filter(isThumbnailPreviewMediaKind)).toEqual(["image", "heic"]);
  });
});

describe("M3 page merge helpers", () => {
  it("preserves first-occurrence order and keeps stable references for duplicates", () => {
    // Models the timeline "load earlier" overlap: the fresh before-page is
    // the first input and the already-rendered page is the second input.
    const existingB = { id: "b", label: "existing-b" };
    const existingC = { id: "c", label: "existing-c" };
    const incomingA = { id: "a", label: "incoming-a" };
    const incomingB = { id: "b", label: "incoming-b" };
    const merged = mergeById([incomingA, incomingB], [existingB, existingC]);

    // Order follows the first occurrence of each key.
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);

    // Duplicate keys resolve to the previously-existing (second input)
    // object reference so React identity stays stable.
    expect(Object.is(merged[1], existingB)).toBe(true);
    expect(Object.is(merged[1], incomingB)).toBe(false);

    // Non-duplicates pass through unchanged from their source input.
    expect(Object.is(merged[0], incomingA)).toBe(true);
    expect(Object.is(merged[2], existingC)).toBe(true);
  });

  it("dedupes within a single input while keeping its first occurrence", () => {
    const firstA = { key: "a", n: 1 };
    const duplicateA = { key: "a", n: 2 };
    const merged = mergeBy([firstA, duplicateA], [], (item) => item.key);

    expect(merged).toHaveLength(1);
    expect(Object.is(merged[0], firstA)).toBe(true);
  });
});

describe("conversationTitle", () => {
  it("keeps an explicit conversation name", () => {
    expect(
      conversationTitle({
        displayName: "Weekend plans",
        participants: [
          {
            contactFirstName: "Brian",
            contactName: "Brian Meenan",
            handle: "+15550101001",
          },
          {
            contactFirstName: "Karin",
            contactName: "Karin Stone",
            handle: "+15550101002",
          },
        ],
      }),
    ).toBe("Weekend plans");
  });

  it("lists the first names of every non-self participant in an unnamed group", () => {
    expect(
      conversationTitle({
        participants: [
          {
            contactFirstName: "Mina",
            contactName: "Mina Talos",
            handle: "self",
            isSelf: true,
          },
          {
            contactFirstName: "Brian",
            contactName: "Brian Meenan",
            handle: "+15550101001",
          },
          {
            contactFirstName: "Karin",
            contactName: "Karin Stone",
            handle: "+15550101002",
          },
          {
            contactFirstName: "Sean",
            contactName: "Sean Parker",
            handle: "+15550101003",
          },
        ],
      }),
    ).toBe("Brian, Karin and Sean");
  });

  it("uses full contact names and raw handles when first names are unavailable", () => {
    expect(
      conversationTitle({
        participants: [
          { contactName: "Northwind Legal", handle: "legal@example.test" },
          { handle: "+15550101004" },
        ],
      }),
    ).toBe("Northwind Legal and +15550101004");
  });

  it("keeps the full contact name for a one-to-one conversation", () => {
    expect(
      conversationTitle({
        participants: [
          {
            contactFirstName: "Brian",
            contactName: "Brian Meenan",
            handle: "+15550101001",
          },
        ],
      }),
    ).toBe("Brian Meenan");
  });
});
