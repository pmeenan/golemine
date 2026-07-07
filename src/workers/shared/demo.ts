import { derivedDbVersion } from "../../lib/constants";
import {
  createWorkerProgressEvent,
  workerOk,
  type WorkerDemoRequest,
  type WorkerDemoResponse,
  type WorkerKind,
  type WorkerProgressCallback,
  type WorkerResult,
} from "../../lib/worker-types";

export async function runDemoRoundTrip(
  worker: WorkerKind,
  request: WorkerDemoRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<WorkerDemoResponse>> {
  await progress?.(
    createWorkerProgressEvent({
      worker,
      phase: "starting",
      label: `${worker}-worker received demo request`,
      completedUnits: 0,
      totalUnits: 1,
    }),
  );

  await progress?.(
    createWorkerProgressEvent({
      worker,
      phase: "complete",
      label: `${worker}-worker demo request complete`,
      completedUnits: 1,
      totalUnits: 1,
    }),
  );

  return workerOk({
    worker,
    message: `${worker}-worker online`,
    echo: request.message,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    derivedDbVersion,
    at: new Date().toISOString(),
  });
}
