import { describe, expect, it } from "vitest";

import { assertPositiveSafeInteger, isObjectRecord } from "./guards";

describe("isObjectRecord", () => {
  it("accepts objects and arrays", () => {
    expect(isObjectRecord({})).toBe(true);
    expect(isObjectRecord({ key: "value" })).toBe(true);
    expect(isObjectRecord([])).toBe(true);
  });

  it("rejects null and primitives", () => {
    expect(isObjectRecord(null)).toBe(false);
    expect(isObjectRecord(undefined)).toBe(false);
    expect(isObjectRecord("value")).toBe(false);
    expect(isObjectRecord(42)).toBe(false);
    expect(isObjectRecord(true)).toBe(false);
  });
});

describe("assertPositiveSafeInteger", () => {
  it("accepts positive safe integers", () => {
    expect(() => {
      assertPositiveSafeInteger(1, "Test size");
    }).not.toThrow();
    expect(() => {
      assertPositiveSafeInteger(Number.MAX_SAFE_INTEGER, "Test size");
    }).not.toThrow();
  });

  it("rejects zero, negative, fractional, and unsafe values", () => {
    const invalidValues = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const value of invalidValues) {
      expect(() => {
        assertPositiveSafeInteger(value, "Test size");
      }).toThrow(RangeError);
    }
  });

  it("includes the caller-supplied label in the error message", () => {
    expect(() => {
      assertPositiveSafeInteger(0, "SHA-256 Blob chunk size");
    }).toThrow("SHA-256 Blob chunk size must be a positive integer.");
  });
});
