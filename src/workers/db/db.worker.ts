import { expose } from "comlink";
import type { DbWorkerApi } from "../../lib/worker-types";
import { runDemoRoundTrip } from "../shared/demo";
import { runSqliteSmoke } from "./sqlite-smoke";

export const dbWorkerApi: DbWorkerApi = {
  demoRoundTrip: (request, progress) => runDemoRoundTrip("db", request, progress),
  runSqliteSmoke,
};

expose(dbWorkerApi);
