import { expose } from "comlink";
import type { BackupWorkerApi } from "../../lib/worker-types";
import { runDemoRoundTrip } from "../shared/demo";

export const backupWorkerApi: BackupWorkerApi = {
  demoRoundTrip: (request, progress) =>
    runDemoRoundTrip("backup", request, progress),
};

expose(backupWorkerApi);
