import { expose } from "comlink";
import type { BackupWorkerApi } from "../../lib/worker-types";
import { detectBackupDirectory } from "./ios-backup";
import { runDemoRoundTrip } from "../shared/demo";

export const backupWorkerApi: BackupWorkerApi = {
  demoRoundTrip: (request, progress) =>
    runDemoRoundTrip("backup", request, progress),
  detectBackup: (root, progress) => detectBackupDirectory(root, progress),
};

expose(backupWorkerApi);
