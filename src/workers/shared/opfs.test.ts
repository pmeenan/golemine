import { describe, expect, it } from "vitest";

import { stableHash } from "./hash";
import { isSafeOpfsPathSegment } from "./opfs";

describe("isSafeOpfsPathSegment", () => {
  it("accepts plain trimmed segment values", () => {
    expect(isSafeOpfsPathSegment("11111111-1111111111111111")).toBe(true);
    expect(isSafeOpfsPathSegment("  backup-id  ")).toBe(true);
  });

  it("rejects empty values and path separators", () => {
    expect(isSafeOpfsPathSegment("")).toBe(false);
    expect(isSafeOpfsPathSegment("   ")).toBe(false);
    expect(isSafeOpfsPathSegment("a/b")).toBe(false);
    expect(isSafeOpfsPathSegment("a\\b")).toBe(false);
    expect(isSafeOpfsPathSegment("a\0b")).toBe(false);
  });
});

describe("stableHash", () => {
  it("returns a stable 8-character lowercase hex FNV-1a hash", () => {
    expect(stableHash("golemine")).toBe(stableHash("golemine"));
    expect(stableHash("golemine")).toMatch(/^[0-9a-f]{8}$/u);
    expect(stableHash("")).toBe("811c9dc5");
    expect(stableHash("a")).not.toBe(stableHash("b"));
  });
});
