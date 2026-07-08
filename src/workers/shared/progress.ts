import {
  createWorkerProgressEvent,
  type WorkerKind,
  type WorkerProgressCallback,
  type WorkerProgressPhase,
} from "../../lib/worker-types";

/**
 * Both methods return `undefined` when nothing is emitted so per-row hot
 * loops can skip the `await` and stay synchronous between emissions; a plain
 * `await` of the result is fine anywhere that runs per batch or per phase.
 */
export interface ThrottledWorkerProgress {
  maybeEmit(completedUnits: number, label?: string): Promise<void> | undefined;
  finish(completedUnits: number, label?: string): Promise<void> | undefined;
}

export interface ThrottledWorkerProgressOptions {
  worker: WorkerKind;
  progress: WorkerProgressCallback | undefined;
  phase: WorkerProgressPhase;
  label: string;
  totalUnits?: number;
  intervalMs?: number;
}

/**
 * Emits a worker progress event through an optional (possibly Comlink-proxied)
 * progress callback.
 */
export async function emitWorkerProgress(
  worker: WorkerKind,
  progress: WorkerProgressCallback | undefined,
  phase: WorkerProgressPhase,
  label: string,
  completedUnits?: number,
  totalUnits?: number,
): Promise<void> {
  await progress?.(
    createWorkerProgressEvent({
      worker,
      phase,
      label,
      completedUnits,
      totalUnits,
    }),
  );
}

/**
 * Emits counted progress for long loops without spamming Comlink. The first
 * update is delayed by the interval, so fast loops do not add noisy events.
 */
export function createThrottledWorkerProgress(
  options: ThrottledWorkerProgressOptions,
): ThrottledWorkerProgress {
  const intervalMs = options.intervalMs ?? 500;
  let nextEmitAt = Date.now() + intervalMs;
  let emitted = false;

  return {
    maybeEmit(completedUnits: number, label = options.label): Promise<void> | undefined {
      const now = Date.now();

      if (now < nextEmitAt) {
        return undefined;
      }

      const emission = emitWorkerProgress(
        options.worker,
        options.progress,
        options.phase,
        label,
        completedUnits,
        options.totalUnits,
      );
      emitted = true;
      nextEmitAt = now + intervalMs;

      return emission;
    },

    finish(completedUnits: number, label = options.label): Promise<void> | undefined {
      if (!emitted) {
        return undefined;
      }

      return emitWorkerProgress(
        options.worker,
        options.progress,
        options.phase,
        label,
        completedUnits,
        options.totalUnits,
      );
    },
  };
}
