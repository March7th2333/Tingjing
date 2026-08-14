import { extractFeatureTimeline } from "./featureExtraction";
import type {
  AudioFeatureTimeline,
  WorkerAnalysisRequest,
  WorkerAnalysisResponse,
} from "./audioTypes";

const maximumRemoteAudioBytes = 96 * 1024 * 1024;
const maximumCachedRemoteTimelines = 2;

const cancelledError = () => {
  const error = new Error("Audio analysis was superseded");
  error.name = "AbortError";
  return error;
};

let decodeContext: OfflineAudioContext | null = null;

const getDecodeContext = () => {
  decodeContext ??= new OfflineAudioContext(2, 1, 44_100);
  return decodeContext;
};

export class AudioAnalysisEngine {
  private workerRequestId = 0;
  private analysisGeneration = 0;
  private activeAnalysisKey: string | null = null;
  private activeFetch: AbortController | null = null;
  private activeWorkerJob: {
    worker: Worker;
    cancel: () => void;
  } | null = null;
  private readonly remoteAnalysisCache = new Map<
    string,
    Promise<AudioFeatureTimeline>
  >();

  async analyzeRemoteSource(
    url: string,
    expectedSize?: number,
  ) {
    const key = `remote:${url}`;
    const cached = this.remoteAnalysisCache.get(url);
    if (cached) {
      if (this.activeAnalysisKey !== null && this.activeAnalysisKey !== key) {
        this.cancelActiveAnalysis();
      }
      // Refresh the small LRU without retaining decoded PCM or audio bytes.
      this.remoteAnalysisCache.delete(url);
      this.remoteAnalysisCache.set(url, cached);
      const result = await cached;
      return result;
    }

    if (expectedSize && expectedSize > maximumRemoteAudioBytes) {
      throw new Error("音频文件过大，已停止浏览器内分析");
    }

    const generation = this.beginAnalysis(key);
    const task = this.analyzeRemoteForGeneration(
      url,
      expectedSize,
      generation,
    );
    this.remoteAnalysisCache.set(url, task);
    while (this.remoteAnalysisCache.size > maximumCachedRemoteTimelines) {
      const oldestKey = this.remoteAnalysisCache.keys().next().value;
      if (typeof oldestKey === "string") this.remoteAnalysisCache.delete(oldestKey);
      else break;
    }
    void task.catch(() => {
      if (this.remoteAnalysisCache.get(url) === task) {
        this.remoteAnalysisCache.delete(url);
      }
    });
    return task;
  }

  cancelActiveAnalysis() {
    this.analysisGeneration += 1;
    this.activeFetch?.abort();
    this.activeFetch = null;
    this.activeWorkerJob?.cancel();
    this.activeWorkerJob = null;
    this.activeAnalysisKey = null;
  }

  private async analyzeRemoteForGeneration(
    url: string,
    expectedSize: number | undefined,
    generation: number,
  ) {
    const controller = new AbortController();
    this.activeFetch = controller;
    try {
      const response = await fetch(url, {
        cache: "force-cache",
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
      });
      this.throwIfSuperseded(generation);
      if (!response.ok || response.type === "opaque") {
        throw new Error(
          response.type === "opaque"
            ? "当前音源不允许读取真实音频数据"
            : `音频读取失败（HTTP ${response.status}）`,
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      const declaredSize = Number.isFinite(contentLength) && contentLength > 0
        ? contentLength
        : expectedSize ?? 0;
      if (declaredSize > maximumRemoteAudioBytes) {
        throw new Error("音频文件过大，已停止浏览器内分析");
      }
      const bytes = await response.arrayBuffer();
      this.throwIfSuperseded(generation);
      if (bytes.byteLength > maximumRemoteAudioBytes) {
        throw new Error("音频文件过大，已停止浏览器内分析");
      }
      return await this.analyzeArrayBufferForGeneration(
        bytes,
        generation,
      );
    } finally {
      if (this.activeFetch === controller) this.activeFetch = null;
      this.finishAnalysis(generation);
    }
  }

  private async analyzeArrayBufferForGeneration(
    bytes: ArrayBuffer,
    generation: number,
  ): Promise<AudioFeatureTimeline> {
    if (bytes.byteLength === 0) throw new Error("音频文件为空");
    this.throwIfSuperseded(generation);

    let decoded: AudioBuffer;
    try {
      decoded = await getDecodeContext().decodeAudioData(bytes.slice(0));
    } catch (error) {
      throw new Error(
        `浏览器无法解码此音频：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    this.throwIfSuperseded(generation);
    if (decoded.length === 0) throw new Error("解码后的音频没有采样数据");

    const left = new Float32Array(decoded.length);
    const right = new Float32Array(decoded.length);
    decoded.copyFromChannel(left, 0);
    decoded.copyFromChannel(right, Math.min(1, decoded.numberOfChannels - 1));
    const timeline = await this.extractInWorker(
      left,
      right,
      decoded.sampleRate,
      generation,
    );
    this.throwIfSuperseded(generation);
    return timeline;
  }

  private async extractInWorker(
    left: Float32Array,
    right: Float32Array,
    sampleRate: number,
    generation: number,
  ): Promise<AudioFeatureTimeline> {
    this.throwIfSuperseded(generation);
    if (typeof Worker === "undefined") {
      const timeline = extractFeatureTimeline(
        { left, right, sampleRate },
        { frameSize: 2048, hopSize: 1024 },
      );
      this.throwIfSuperseded(generation);
      return timeline;
    }

    const worker = new Worker(
      new URL("./AudioAnalysisWorker.ts", import.meta.url),
      { type: "module", name: "listening-space-audio-analysis" },
    );
    const id = ++this.workerRequestId;
    const request: WorkerAnalysisRequest = { id, left, right, sampleRate };
    const timeline = await new Promise<AudioFeatureTimeline>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        worker.terminate();
        if (this.activeWorkerJob?.worker === worker) {
          this.activeWorkerJob = null;
        }
      };
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const handleMessage = (event: MessageEvent<WorkerAnalysisResponse>) => {
        if (event.data.id !== id) return;
        if (generation !== this.analysisGeneration) {
          settle(() => reject(cancelledError()));
        } else if (event.data.ok && event.data.timeline) {
          settle(() => resolve(event.data.timeline!));
        } else {
          settle(() => reject(new Error(event.data.error ?? "Audio analysis failed")));
        }
      };
      const handleError = (event: ErrorEvent) => {
        settle(() => reject(new Error(event.message || "Audio analysis worker failed")));
      };
      this.activeWorkerJob = {
        worker,
        cancel: () => settle(() => reject(cancelledError())),
      };
      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);
      worker.postMessage(request, [left.buffer, right.buffer]);
    });
    this.throwIfSuperseded(generation);
    return timeline;
  }

  private beginAnalysis(key: string) {
    this.cancelActiveAnalysis();
    const generation = ++this.analysisGeneration;
    this.activeAnalysisKey = key;
    return generation;
  }

  private finishAnalysis(generation: number) {
    if (generation !== this.analysisGeneration) return;
    this.activeFetch = null;
    this.activeAnalysisKey = null;
  }

  private throwIfSuperseded(generation: number) {
    if (generation !== this.analysisGeneration) {
      throw cancelledError();
    }
  }
}
