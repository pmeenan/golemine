import { describe, expect, it } from "vitest";
import {
  createWorkerProgressEvent,
  toWorkerError,
  workerFail,
  workerOk,
} from "./worker-types";

describe("worker shared types", () => {
  it("wraps successful worker payloads", () => {
    const result = workerOk({ value: 42 });

    expect(result).toEqual({
      ok: true,
      value: { value: 42 },
    });
  });

  it("keeps worker errors structured and serializable", () => {
    const error = toWorkerError({
      worker: "db",
      code: "sqlite_init_failed",
      message: "SQLite failed to initialize.",
      cause: new TypeError("bad wasm"),
      details: { vfs: "opfs-sahpool" },
    });

    expect(workerFail(error)).toEqual({
      ok: false,
      error: {
        worker: "db",
        code: "sqlite_init_failed",
        message: "SQLite failed to initialize.",
        recoverable: true,
        causeName: "TypeError",
        causeMessage: "bad wasm",
        details: { vfs: "opfs-sahpool" },
      },
    });
  });

  it("creates timestamped progress events", () => {
    const progress = createWorkerProgressEvent({
      worker: "backup",
      phase: "starting",
      label: "Starting",
      completedUnits: 0,
      totalUnits: 1,
    });

    expect(progress).toMatchObject({
      worker: "backup",
      phase: "starting",
      label: "Starting",
      completedUnits: 0,
      totalUnits: 1,
    });
    expect(Number.isNaN(Date.parse(progress.at))).toBe(false);
  });
});
