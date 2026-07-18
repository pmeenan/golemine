import { expose } from "comlink";
import type { DbWorkerApi } from "../../lib/worker-types";
import { runDemoRoundTrip } from "../shared/demo";
import { createDbWorkerIngestApi } from "./ingest-sink";
import { createDbWorkerQueryApi } from "./queries";
import { createDbWorkerReportApi } from "./reports";
import { runSqliteSmoke } from "./sqlite-smoke";
import { createDbWorkerStorageApi } from "./storage";

const ingestApi = createDbWorkerIngestApi();
const queryApi = createDbWorkerQueryApi();
const reportApi = createDbWorkerReportApi();
const storageApi = createDbWorkerStorageApi();

export const dbWorkerApi: DbWorkerApi = {
  demoRoundTrip: (request, progress) => runDemoRoundTrip("db", request, progress),
  runSqliteSmoke,
  prepareIngest: ingestApi.prepareIngest,
  writeIngestBatch: ingestApi.writeIngestBatch,
  finalizeIngest: ingestApi.finalizeIngest,
  getIngestSummary: ingestApi.getIngestSummary,
  getDerivedDataStorageSummary: storageApi.getDerivedDataStorageSummary,
  clearDerivedDataStorage: storageApi.clearDerivedDataStorage,
  listConversations: queryApi.listConversations,
  listThreads: queryApi.listThreads,
  getMessageTimelinePage: queryApi.getMessageTimelinePage,
  getMessageTimelineMessagesPage: queryApi.getMessageTimelineMessagesPage,
  getMessageDetails: queryApi.getMessageDetails,
  searchMessages: queryApi.searchMessages,
  listSearchConversations: queryApi.listSearchConversations,
  listReports: reportApi.listReports,
  createReport: reportApi.createReport,
  getReport: reportApi.getReport,
  getMessageReportMembership: reportApi.getMessageReportMembership,
  setMessageReportMembership: reportApi.setMessageReportMembership,
  saveReport: reportApi.saveReport,
  deleteReport: reportApi.deleteReport,
};

expose(dbWorkerApi);
