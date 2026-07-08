import {
  createWorkerProgressEvent,
  type WorkerKind,
  type WorkerProgressCallback,
  type WorkerProgressPhase,
} from "../../lib/worker-types";

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
