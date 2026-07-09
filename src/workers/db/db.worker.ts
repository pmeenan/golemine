import { expose } from "comlink";
import type { DbWorkerApi } from "../../lib/worker-types";
import { runDemoRoundTrip } from "../shared/demo";
import { createDbWorkerIngestApi } from "./ingest-sink";
import { createDbWorkerQueryApi } from "./queries";
import { runSqliteSmoke } from "./sqlite-smoke";

const ingestApi = createDbWorkerIngestApi();
const queryApi = createDbWorkerQueryApi();

export const dbWorkerApi: DbWorkerApi = {
  demoRoundTrip: (request, progress) => runDemoRoundTrip("db", request, progress),
  runSqliteSmoke,
  prepareIngest: ingestApi.prepareIngest,
  writeIngestBatch: ingestApi.writeIngestBatch,
  finalizeIngest: ingestApi.finalizeIngest,
  getIngestSummary: ingestApi.getIngestSummary,
  listConversations: queryApi.listConversations,
  listThreads: queryApi.listThreads,
  getMessageTimelinePage: queryApi.getMessageTimelinePage,
  getMessageTimelineMessagesPage: queryApi.getMessageTimelineMessagesPage,
  getMessageDetails: queryApi.getMessageDetails,
  searchMessages: queryApi.searchMessages,
};

expose(dbWorkerApi);
