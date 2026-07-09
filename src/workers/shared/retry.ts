export interface RetryAsyncOptions {
  /** Total attempts including the first one. Must be at least 1. */
  attempts: number;
  /**
   * Delay before each retry attempt, in milliseconds. A single number applies
   * a fixed backoff; an array is a per-retry schedule (the delay before retry
   * N is entry N-1, with the last entry repeating once the schedule runs out).
   */
  delayMs: number | readonly number[];
  /** Injectable sleep for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs an async operation, retrying on rejection with a fixed or scheduled
 * backoff delay. Used for transient environment races such as OPFS sync-access
 * handles from a just-terminated worker still releasing while a new
 * route-scoped worker installs its SAH pool. The operation receives the
 * 1-based attempt number so callers can vary behavior on retries.
 */
export async function retryAsyncOperation<TValue>(
  operation: (attempt: number) => Promise<TValue>,
  options: RetryAsyncOptions,
): Promise<TValue> {
  const attempts = Math.max(1, Math.trunc(options.attempts));
  const sleep = options.sleep ?? defaultSleep;
  let lastCause: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(retryDelayMs(options.delayMs, attempt));
    }

    try {
      return await operation(attempt);
    } catch (cause) {
      lastCause = cause;
    }
  }

  throw lastCause;
}

function retryDelayMs(
  delayMs: number | readonly number[],
  attempt: number,
): number {
  if (typeof delayMs === "number") {
    return delayMs;
  }

  if (delayMs.length === 0) {
    return 0;
  }

  // attempt is 2 for the first retry, so the first retry reads index 0.
  return delayMs[Math.min(attempt - 2, delayMs.length - 1)];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
