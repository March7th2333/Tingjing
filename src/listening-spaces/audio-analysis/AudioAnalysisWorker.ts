/// <reference lib="webworker" />

import { extractFeatureTimeline } from "./featureExtraction";
import type { WorkerAnalysisRequest, WorkerAnalysisResponse } from "./audioTypes";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<WorkerAnalysisRequest>) => {
  const request = event.data;
  try {
    const timeline = extractFeatureTimeline({
      sampleRate: request.sampleRate,
      left: request.left,
      right: request.right,
    }, {
      frameSize: 2048,
      hopSize: 1024,
    });
    const response: WorkerAnalysisResponse = {
      id: request.id,
      ok: true,
      timeline,
    };
    workerScope.postMessage(response);
  } catch (error) {
    const response: WorkerAnalysisResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};

export {};
