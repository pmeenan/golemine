import { describe, expect, it } from "vitest";
import { runSqliteSmoke } from "./sqlite-smoke";

describe("db-worker sqlite smoke", () => {
  it("returns a typed error when OPFS is unavailable", async () => {
    const result = await runSqliteSmoke();

    expect(result).toEqual({
      ok: false,
      error: {
        worker: "db",
        code: "sqlite_opfs_unavailable",
        message:
          "OPFS is not available in this runtime, so the sqlite smoke database was not opened.",
        recoverable: false,
        details: { vfs: "opfs-sahpool" },
      },
    });
  });
});
