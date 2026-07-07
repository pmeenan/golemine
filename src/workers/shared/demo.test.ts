import { describe, expect, it } from "vitest";
import { derivedDbVersion } from "../../lib/constants";
import type { WorkerProgressEvent } from "../../lib/worker-types";
import { runDemoRoundTrip } from "./demo";

describe("worker demo round trip", () => {
  it("echoes the request and emits progress", async () => {
    const progress: WorkerProgressEvent[] = [];
    const result = await runDemoRoundTrip(
      "backup",
      { message: "hello", requestId: "demo-1" },
      (event) => {
        progress.push(event);
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        worker: "backup",
        message: "backup-worker online",
        echo: "hello",
        requestId: "demo-1",
        derivedDbVersion,
      },
    });
    expect(progress.map((event) => event.phase)).toEqual(["starting", "complete"]);
  });
});
