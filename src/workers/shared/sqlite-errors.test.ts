import { describe, expect, it } from "vitest";

import { hasOpfsStorage } from "./opfs";
import { classifySqliteWasmError } from "./sqlite-errors";

describe("classifySqliteWasmError", () => {
  it("maps wasm compile and link failures to sqlite_unavailable", () => {
    expect(
      classifySqliteWasmError(new WebAssembly.CompileError("bad"), "db_ingest_failed"),
    ).toBe("sqlite_unavailable");
    expect(
      classifySqliteWasmError(new WebAssembly.LinkError("bad"), "sqlite_query_failed"),
    ).toBe("sqlite_unavailable");
  });

  it("maps wasm runtime failures by OPFS availability", () => {
    const code = classifySqliteWasmError(
      new WebAssembly.RuntimeError("bad"),
      "sqlite_query_failed",
    );

    expect(code).toBe(
      hasOpfsStorage() ? "sqlite_init_failed" : "sqlite_opfs_unavailable",
    );
  });

  it("returns the caller's fallback for unrecognized failures", () => {
    expect(classifySqliteWasmError(new Error("boom"), "db_ingest_failed")).toBe(
      "db_ingest_failed",
    );
    expect(classifySqliteWasmError("boom", "sqlite_query_failed")).toBe(
      "sqlite_query_failed",
    );
  });
});
