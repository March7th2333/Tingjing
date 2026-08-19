export interface AudioFeatureFrame {
  low: number;
  mid: number;
  high: number;
  onset: number;
  silence: boolean;
}

export interface RawAudioFeatureFrame {
  timeMs: number;
  rms: number;
  low: number;
  mid: number;
  high: number;
  spectralFlux: number;
}

export interface AudioFeatureTimeline {
  sampleRate: number;
  hopSize: number;
  frames: readonly AudioFeatureFrame[];
}

export interface WorkerAnalysisRequest {
  id: number;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

export interface WorkerAnalysisResponse {
  id: number;
  ok: boolean;
  timeline?: AudioFeatureTimeline;
  error?: string;
}
