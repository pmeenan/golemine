import { expose, releaseProxy, transfer, wrap } from "comlink";
import type { Remote } from "comlink";
import type {
  BackupIngestRequest,
  BackupWorkerApi,
  DbWorkerApi,
  IngestSinkApi,
  WorkerProgressCallback,
  WorkerResult,
  BackupIngestReport,
} from "../../lib/worker-types";
import { nestedDbWorkerName } from "../../lib/worker-names";
import { detectBackupDirectory } from "./ios-backup";
import { ingestUnencryptedBackupDirectory } from "./ios-ingest";
import { readUnencryptedSourceFile } from "./attachment-read";
import { runDemoRoundTrip } from "../shared/demo";

export const backupWorkerApi: BackupWorkerApi = {
  demoRoundTrip: (request, progress) =>
    runDemoRoundTrip("backup", request, progress),
  detectBackup: (root, progress) => detectBackupDirectory(root, progress),
  ingestUnencryptedBackup: (root, request, sink, progress) =>
    ingestUnencryptedBackupDirectory(root, request, sink, progress),
  ingestUnencryptedBackupToDb: (root, request, progress) =>
    ingestUnencryptedBackupToDb(root, request, progress),
  readUnencryptedSourceFile: async (root, request, progress) => {
    const result = await readUnencryptedSourceFile(root, request, progress);

    return result.ok
      ? transfer(result, [result.value.bytes.buffer as ArrayBuffer])
      : result;
  },
};

expose(backupWorkerApi);

async function ingestUnencryptedBackupToDb(
  root: FileSystemDirectoryHandle,
  request: BackupIngestRequest,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<BackupIngestReport>> {
  const client = createDbWorkerIngestSink();

  try {
    return await ingestUnencryptedBackupDirectory(
      root,
      request,
      client.sink,
      progress,
    );
  } finally {
    client.release();
  }
}

function createDbWorkerIngestSink(): {
  sink: IngestSinkApi;
  release(): void;
} {
  const worker = new Worker(new URL("../db/db.worker.ts", import.meta.url), {
    name: nestedDbWorkerName,
    type: "module",
  });
  const api: Remote<DbWorkerApi> = wrap<DbWorkerApi>(worker);
  let released = false;

  return {
    sink: {
      prepareIngest: (request) => api.prepareIngest(request),
      writeIngestBatch: (batch) => api.writeIngestBatch(batch),
      finalizeIngest: (report) => api.finalizeIngest(report),
    },
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
