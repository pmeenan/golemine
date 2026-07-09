import { describe, expect, it } from "vitest";

import { retryAsyncOperation } from "./retry";

describe("retryAsyncOperation", () => {
  it("returns the first successful result without sleeping", async () => {
    const sleeps: number[] = [];
    const result = await retryAsyncOperation(() => Promise.resolve("ok"), {
      attempts: 4,
      delayMs: 150,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    expect(result).toBe("ok");
    expect(sleeps).toEqual([]);
  });

  it("retries with the configured backoff until an attempt succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await retryAsyncOperation(
      () => {
        calls += 1;

        return calls < 3
          ? Promise.reject(new Error("transient"))
          : Promise.resolve(calls);
      },
      {
        attempts: 4,
        delayMs: 150,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );

    expect(result).toBe(3);
    expect(sleeps).toEqual([150, 150]);
  });

  it("applies a per-retry delay schedule and repeats the final entry", async () => {
    const sleeps: number[] = [];
    let calls = 0;

    await expect(
      retryAsyncOperation(
        () => {
          calls += 1;
          return Promise.reject(new Error("transient"));
        },
        {
          attempts: 5,
          delayMs: [150, 300, 600],
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("transient");
    expect(calls).toBe(5);
    expect(sleeps).toEqual([150, 300, 600, 600]);
  });

  it("passes the 1-based attempt number to the operation", async () => {
    const attempts: number[] = [];

    await expect(
      retryAsyncOperation(
        (attempt) => {
          attempts.push(attempt);
          return Promise.reject(new Error("transient"));
        },
        {
          attempts: 3,
          delayMs: [150, 300],
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow("transient");
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("throws the final rejection after exhausting all attempts", async () => {
    const sleeps: number[] = [];
    let calls = 0;

    await expect(
      retryAsyncOperation(
        () => {
          calls += 1;
          return Promise.reject(new Error(`attempt-${String(calls)}`));
        },
        {
          attempts: 4,
          delayMs: 150,
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("attempt-4");
    expect(calls).toBe(4);
    expect(sleeps).toEqual([150, 150, 150]);
  });
});
