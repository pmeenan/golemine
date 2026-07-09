import { expose, transfer } from "comlink";
import type { MediaWorkerApi } from "../../lib/worker-types";
import { runDemoRoundTrip } from "../shared/demo";
import {
  createAttachmentThumbnail,
  getCachedAttachmentThumbnail,
} from "./thumbnails";

export const mediaWorkerApi: MediaWorkerApi = {
  demoRoundTrip: (request, progress) =>
    runDemoRoundTrip("media", request, progress),
  createAttachmentThumbnail: async (request, progress) => {
    const result = await createAttachmentThumbnail(request, progress);

    return result.ok && result.value.status === "ok"
      ? transfer(result, [result.value.bytes.buffer as ArrayBuffer])
      : result;
  },
  getCachedAttachmentThumbnail: async (request, progress) => {
    const result = await getCachedAttachmentThumbnail(request, progress);

    return result.ok && result.value.status === "ok"
      ? transfer(result, [result.value.bytes.buffer as ArrayBuffer])
      : result;
  },
};

expose(mediaWorkerApi);
