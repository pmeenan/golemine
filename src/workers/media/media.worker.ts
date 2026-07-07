import { expose } from "comlink";
import type { MediaWorkerApi } from "../../lib/worker-types";
import { runDemoRoundTrip } from "../shared/demo";

export const mediaWorkerApi: MediaWorkerApi = {
  demoRoundTrip: (request, progress) =>
    runDemoRoundTrip("media", request, progress),
};

expose(mediaWorkerApi);
