import { afterEach, describe, expect, it, vi } from "vitest";

import { stableHash } from "./hash";
import { getAvailableOpfsQuotaBytes, isSafeOpfsPathSegment } from "./opfs";

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

describe("getAvailableOpfsQuotaBytes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorageEstimate(estimate: {
    quota?: unknown;
    usage?: unknown;
  }): void {
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn(),
        estimate: () => Promise.resolve(estimate),
      },
    });
  }

  it("returns undefined when OPFS storage is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(getAvailableOpfsQuotaBytes()).resolves.toBeUndefined();
  });

  it("returns undefined when the estimate probe is unavailable", async () => {
    vi.stubGlobal("navigator", {
      storage: { getDirectory: vi.fn() },
    });

    await expect(getAvailableOpfsQuotaBytes()).resolves.toBeUndefined();
  });

  it("returns undefined for unusable estimate shapes", async () => {
    const unusableEstimates = [
      {},
      { quota: 1_000 },
      { usage: 0 },
      { quota: "1000", usage: 0 },
      { quota: Number.NaN, usage: 0 },
      { quota: Number.POSITIVE_INFINITY, usage: 0 },
      { quota: 1_000.5, usage: 0 },
      { quota: 1_000, usage: Number.MAX_SAFE_INTEGER + 2 },
    ];

    for (const estimate of unusableEstimates) {
      stubStorageEstimate(estimate);

      await expect(getAvailableOpfsQuotaBytes()).resolves.toBeUndefined();
    }
  });

  it("returns the available byte budget", async () => {
    stubStorageEstimate({ quota: 2_000, usage: 500 });

    await expect(getAvailableOpfsQuotaBytes()).resolves.toBe(1_500);
  });

  it("floors over-quota usage at zero", async () => {
    stubStorageEstimate({ quota: 2_000, usage: 3_000 });

    await expect(getAvailableOpfsQuotaBytes()).resolves.toBe(0);
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
