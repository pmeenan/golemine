import { expose, releaseProxy, wrap } from "comlink";
import type { Remote } from "comlink";
import type {
  BackupIngestRequest,
  BackupCredentials,
  BackupWorkerApi,
  DbWorkerApi,
  IngestSinkApi,
  WorkerProgressCallback,
  WorkerResult,
  BackupIngestReport,
} from "../../lib/worker-types";
import { nestedDbWorkerName } from "../../lib/worker-names";
import { detectBackupDirectory } from "./ios-backup";
import {
  ingestBackupDirectory,
  ingestUnencryptedBackupDirectory,
} from "./ios-ingest";
import {
  readSourceFile,
  readUnencryptedSourceFile,
  extractSourceFile,
  resetBackupSourceCaches,
} from "./attachment-read";
import { unlockBackupSession } from "./encrypted-session";
import { runDemoRoundTrip } from "../shared/demo";

export const backupWorkerApi: BackupWorkerApi = {
  demoRoundTrip: (request, progress) =>
    runDemoRoundTrip("backup", request, progress),
  detectBackup: (root, progress) => detectBackupDirectory(root, progress),
  ingestBackupToDb: (root, request, credentials, progress) =>
    ingestBackupToDb(root, request, credentials, progress),
  unlockBackupSession: (root, request, progress) =>
    unlockBackupSession(root, request, progress),
  lockBackupSession: () => resetBackupSourceCaches(),
  readSourceFile: (root, request, progress) =>
    readSourceFile(root, request, progress),
  extractSourceFile: (root, request, destination, progress) =>
    extractSourceFile(root, request, destination, progress),
  ingestUnencryptedBackup: (root, request, sink, progress) =>
    ingestUnencryptedBackupDirectory(root, request, sink, progress),
  ingestUnencryptedBackupToDb: (root, request, progress) =>
    ingestUnencryptedBackupToDb(root, request, progress),
  readUnencryptedSourceFile: (root, request, progress) =>
    readUnencryptedSourceFile(root, request, progress),
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

async function ingestBackupToDb(
  root: FileSystemDirectoryHandle,
  request: BackupIngestRequest,
  credentials?: BackupCredentials,
  progress?: WorkerProgressCallback,
): Promise<WorkerResult<BackupIngestReport>> {
  const client = createDbWorkerIngestSink();

  try {
    return await ingestBackupDirectory(
      root,
      request,
      client.sink,
      credentials,
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
