import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerProgressEvent } from "../../lib/worker-types";
import { createThrottledWorkerProgress } from "./progress";

describe("createThrottledWorkerProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays counted progress until a loop runs past the interval", async () => {
    const events: WorkerProgressEvent[] = [];
    const progress = createThrottledWorkerProgress({
      worker: "backup",
      progress: (event) => {
        events.push(event);
      },
      phase: "writing",
      label: "Writing messages",
      totalUnits: 100,
    });

    expect(progress.maybeEmit(10)).toBeUndefined();
    vi.advanceTimersByTime(499);
    expect(progress.maybeEmit(20)).toBeUndefined();

    vi.advanceTimersByTime(1);
    const firstEmission = progress.maybeEmit(50);

    if (firstEmission === undefined) {
      throw new Error("Expected a throttled progress event after the interval.");
    }

    await firstEmission;
    expect(events).toMatchObject([
      {
        worker: "backup",
        phase: "writing",
        label: "Writing messages",
        completedUnits: 50,
        totalUnits: 100,
      },
    ]);

    expect(progress.maybeEmit(60)).toBeUndefined();
    vi.advanceTimersByTime(500);

    const secondEmission = progress.maybeEmit(75);

    if (secondEmission === undefined) {
      throw new Error("Expected a second throttled progress event.");
    }

    await secondEmission;
    const finalEmission = progress.finish(100);

    if (finalEmission === undefined) {
      throw new Error("Expected a final progress event after throttled output.");
    }

    await finalEmission;
    expect(events.map((event) => event.completedUnits)).toEqual([50, 75, 100]);
  });

  it("skips final progress for loops that never reached the interval", () => {
    const events: WorkerProgressEvent[] = [];
    const progress = createThrottledWorkerProgress({
      worker: "backup",
      progress: (event) => {
        events.push(event);
      },
      phase: "normalizing",
      label: "Normalizing messages",
      totalUnits: 100,
    });

    expect(progress.maybeEmit(100)).toBeUndefined();
    expect(progress.finish(100)).toBeUndefined();
    expect(events).toEqual([]);
  });
});
