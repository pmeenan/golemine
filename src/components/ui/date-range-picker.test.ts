import { describe, expect, it } from "vitest";

import {
  formatDateRangeLabel,
  formatIsoCalendarDate,
  parseIsoCalendarDate,
} from "./date-range";

describe("date range picker values", () => {
  it("parses and formats calendar dates without a UTC conversion", () => {
    const date = parseIsoCalendarDate("2026-07-01");

    expect(date).toBeDefined();
    expect(date === undefined ? undefined : formatIsoCalendarDate(date)).toBe(
      "2026-07-01",
    );
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseIsoCalendarDate("2026-02-29")).toBeUndefined();
    expect(parseIsoCalendarDate("07/01/2026")).toBeUndefined();
    expect(parseIsoCalendarDate("")).toBeUndefined();
  });

  it("formats empty, single-day, and multi-day selections", () => {
    expect(formatDateRangeLabel({ from: "", to: "" })).toBe("Any date");
    expect(
      formatDateRangeLabel({ from: "2026-07-01", to: "2026-07-01" }),
    ).toBe("Jul 1, 2026");
    expect(
      formatDateRangeLabel({ from: "2026-06-30", to: "2026-07-01" }),
    ).toBe("Jun 30, 2026 – Jul 1, 2026");
  });
});
