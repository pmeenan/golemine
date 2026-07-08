import { expose } from "comlink";
import type { DbWorkerApi } from "../../lib/worker-types";
import { runDemoRoundTrip } from "../shared/demo";
import { createDbWorkerIngestApi } from "./ingest-sink";
import { runSqliteSmoke } from "./sqlite-smoke";

const ingestApi = createDbWorkerIngestApi();

export const dbWorkerApi: DbWorkerApi = {
  demoRoundTrip: (request, progress) => runDemoRoundTrip("db", request, progress),
  runSqliteSmoke,
  prepareIngest: ingestApi.prepareIngest,
  writeIngestBatch: ingestApi.writeIngestBatch,
  finalizeIngest: ingestApi.finalizeIngest,
  getIngestSummary: ingestApi.getIngestSummary,
};

expose(dbWorkerApi);
