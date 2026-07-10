import { describe, expect, it } from "vitest";

import {
  consumeSourceDatabaseBudget,
  maxInMemorySourceDatabaseBytes,
} from "./ios-ingest";
import { SourceFileTooLargeError } from "./manifest-db";

describe("source database aggregate budget", () => {
  it("charges main and sidecars against one combined limit", () => {
    const afterMain = consumeSourceDatabaseBudget(
      maxInMemorySourceDatabaseBytes,
      maxInMemorySourceDatabaseBytes - 32,
    );
    const afterWal = consumeSourceDatabaseBudget(afterMain, 16);

    expect(consumeSourceDatabaseBudget(afterWal, 16)).toBe(0);
  });

  it("rejects the first source file that crosses the combined boundary", () => {
    expect(() => consumeSourceDatabaseBudget(16, 17)).toThrow(
      SourceFileTooLargeError,
    );
  });
});
