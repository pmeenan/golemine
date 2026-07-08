import { proxy, releaseProxy, wrap } from "comlink";
import type { Remote } from "comlink";
import type {
  BackupWorkerApi,
  DbWorkerApi,
  MediaWorkerApi,
  WorkerProgressCallback,
} from "./worker-types";

export interface WorkerClient<TApi extends object> {
  api: Remote<TApi>;
  worker: Worker;
  release: () => void;
}

function createWorkerClient<TApi extends object>(worker: Worker): WorkerClient<TApi> {
  const api = wrap<TApi>(worker);
  let released = false;

  return {
    api,
    worker,
    release: () => {
      if (released) {
        return;
      }

      api[releaseProxy]();
      worker.terminate();
      released = true;
    },
  };
}

export function proxiedWorkerProgress(
  callback: WorkerProgressCallback,
): WorkerProgressCallback {
  return proxy(callback);
}

export function createBackupWorkerClient(): WorkerClient<BackupWorkerApi> {
  return createWorkerClient<BackupWorkerApi>(
    new Worker(new URL("../workers/backup/backup.worker.ts", import.meta.url), {
      name: "golemine-backup-worker",
      type: "module",
    }),
  );
}

/**
 * Raw worker for the boot capability probe. The probe speaks a one-shot
 * postMessage protocol with its own timeout, so it does not go through the
 * Comlink client factory — but all worker construction conventions
 * (bundler-visible URL, golemine-* name, module type) stay in this module.
 */
export function createCapabilityProbeWorker(): Worker {
  return new Worker(
    new URL("../workers/capability/capability.worker.ts", import.meta.url),
    {
      name: "golemine-capability-worker",
      type: "module",
    },
  );
}

export function createDbWorkerClient(): WorkerClient<DbWorkerApi> {
  return createWorkerClient<DbWorkerApi>(
    new Worker(new URL("../workers/db/db.worker.ts", import.meta.url), {
      name: "golemine-db-worker",
      type: "module",
    }),
  );
}

export function createMediaWorkerClient(): WorkerClient<MediaWorkerApi> {
  return createWorkerClient<MediaWorkerApi>(
    new Worker(new URL("../workers/media/media.worker.ts", import.meta.url), {
      name: "golemine-media-worker",
      type: "module",
    }),
  );
}

export function releaseWorkerClient(client: WorkerClient<object>): void {
  client.release();
}
