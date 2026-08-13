import type { AudioFeatureFrame, RawAudioFeatureFrame } from "./audioTypes";

const clamp = (value: number, minimum = 0, maximum = 1) => (
  Math.min(maximum, Math.max(minimum, value))
);

const percentile = (values: readonly number[], quantile: number) => {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(quantile) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
};

const smoothingAlpha = (deltaMs: number, durationMs: number) => (
  1 - Math.exp(-Math.max(1, deltaMs) / Math.max(1, durationMs))
);

const smoothValue = (
  previous: number,
  target: number,
  deltaMs: number,
  attackMs: number,
  releaseMs: number,
) => {
  const duration = target > previous ? attackMs : releaseMs;
  return previous + (target - previous) * smoothingAlpha(deltaMs, duration);
};

export function normalizeFeatureTimeline(
  rawFrames: readonly RawAudioFeatureFrame[],
): readonly AudioFeatureFrame[] {
  if (rawFrames.length === 0) return [];

  const rmsScale = Math.max(1e-6, percentile(rawFrames.map((frame) => frame.rms), 0.95));
  const bandScale = Math.max(
    1e-6,
    percentile(rawFrames.map((frame) => Math.max(frame.low, frame.mid, frame.high)), 0.95),
  );
  const fluxScale = Math.max(
    1e-6,
    percentile(rawFrames.map((frame) => frame.spectralFlux), 0.97),
  );
  const silenceFloor = Math.max(0.0008, rmsScale * 0.018);
  const normalized: AudioFeatureFrame[] = [];
  const fluxHistory: number[] = [];
  let lastOnsetAt = Number.NEGATIVE_INFINITY;
  let previous = {
    low: 0,
    mid: 0,
    high: 0,
    flux: 0,
  };

  for (let index = 0; index < rawFrames.length; index += 1) {
    const raw = rawFrames[index];
    const deltaMs = index === 0 ? 23 : Math.max(1, raw.timeMs - rawFrames[index - 1].timeMs);
    const target = {
      rms: clamp(raw.rms / rmsScale),
      low: clamp(raw.low / bandScale),
      mid: clamp(raw.mid / bandScale),
      high: clamp(raw.high / bandScale),
      flux: clamp(raw.spectralFlux / fluxScale),
    };

    const values = {
      low: smoothValue(previous.low, target.low, deltaMs, 110, 620),
      mid: smoothValue(previous.mid, target.mid, deltaMs, 100, 480),
      high: smoothValue(previous.high, target.high, deltaMs, 80, 300),
      flux: smoothValue(previous.flux, target.flux, deltaMs, 80, 260),
    };

    fluxHistory.push(target.flux);
    if (fluxHistory.length > 20) fluxHistory.shift();
    const fluxMean = fluxHistory.reduce((sum, value) => sum + value, 0) / fluxHistory.length;
    const variance = fluxHistory.reduce(
      (sum, value) => sum + (value - fluxMean) ** 2,
      0,
    ) / fluxHistory.length;
    const adaptiveThreshold = Math.max(0.12, fluxMean + Math.sqrt(variance) * 1.65);
    const onsetCandidate = target.flux > adaptiveThreshold
      && target.flux > previous.flux + 0.08
      && target.rms > 0.04;
    const onset = onsetCandidate && raw.timeMs - lastOnsetAt >= 170 ? 1 : 0;
    if (onset > 0) lastOnsetAt = raw.timeMs;

    normalized.push({
      low: clamp(values.low),
      mid: clamp(values.mid),
      high: clamp(values.high),
      onset,
      silence: raw.rms <= silenceFloor,
    });
    previous = values;
  }

  return normalized;
}
