import { normalizeFeatureTimeline } from "./AudioFeatureNormalizer";
import { realFftMagnitudes } from "./fft";
import type {
  AudioFeatureTimeline,
  RawAudioFeatureFrame,
} from "./audioTypes";

export interface PcmAudioData {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

interface FeatureExtractionOptions {
  frameSize?: number;
  hopSize?: number;
}

const bandEnergy = (
  spectrum: Float32Array,
  sampleRate: number,
  frameSize: number,
  minimumHz: number,
  maximumHz: number,
) => {
  const binHz = sampleRate / frameSize;
  const start = Math.max(1, Math.floor(minimumHz / binHz));
  const end = Math.min(spectrum.length - 1, Math.ceil(maximumHz / binHz));
  let sum = 0;
  let count = 0;
  for (let index = start; index <= end; index += 1) {
    sum += spectrum[index] ** 2;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
};

export function extractFeatureTimeline(
  pcm: PcmAudioData,
  options: FeatureExtractionOptions = {},
): AudioFeatureTimeline {
  const frameSize = options.frameSize ?? 1024;
  const hopSize = options.hopSize ?? 512;
  if (pcm.left.length !== pcm.right.length) {
    throw new Error("Stereo channel lengths must match");
  }
  if (pcm.left.length === 0) {
    throw new Error("Audio contains no samples");
  }

  const window = new Float32Array(frameSize);
  for (let index = 0; index < frameSize; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (frameSize - 1));
  }

  const rawFrames: RawAudioFeatureFrame[] = [];
  let previousSpectrum: Float32Array | null = null;
  const nyquist = pcm.sampleRate / 2;
  for (let start = 0; start < pcm.left.length; start += hopSize) {
    const mono = new Float32Array(frameSize);
    let sumSquares = 0;
    for (let offset = 0; offset < frameSize; offset += 1) {
      const left = pcm.left[start + offset] ?? 0;
      const right = pcm.right[start + offset] ?? left;
      const mixed = (left + right) * 0.5;
      mono[offset] = mixed * window[offset];
      sumSquares += mixed * mixed;
    }

    const spectrum = realFftMagnitudes(mono);
    let magnitudeSum = 0;
    let positiveFlux = 0;
    for (let bin = 1; bin < spectrum.length; bin += 1) {
      const magnitude = spectrum[bin];
      magnitudeSum += magnitude;
      if (previousSpectrum) {
        positiveFlux += Math.max(0, magnitude - previousSpectrum[bin]);
      }
    }

    rawFrames.push({
      timeMs: Math.round((start / pcm.sampleRate) * 1000),
      rms: Math.sqrt(sumSquares / frameSize),
      low: bandEnergy(spectrum, pcm.sampleRate, frameSize, 20, 180),
      mid: bandEnergy(spectrum, pcm.sampleRate, frameSize, 180, 3000),
      high: bandEnergy(spectrum, pcm.sampleRate, frameSize, 3000, Math.min(10000, nyquist)),
      spectralFlux: previousSpectrum && magnitudeSum > 1e-9
        ? positiveFlux / magnitudeSum
        : 0,
    });
    previousSpectrum = spectrum;
    if (start + frameSize >= pcm.left.length) break;
  }

  return {
    sampleRate: pcm.sampleRate,
    hopSize,
    frames: normalizeFeatureTimeline(rawFrames),
  };
}

export function featureAt(
  timeline: AudioFeatureTimeline | null,
  timeMs: number,
) {
  if (!timeline || timeline.frames.length === 0) return null;
  const frameDuration = (timeline.hopSize / timeline.sampleRate) * 1000;
  const index = Math.min(
    timeline.frames.length - 1,
    Math.max(0, Math.round(timeMs / frameDuration)),
  );
  return timeline.frames[index];
}
