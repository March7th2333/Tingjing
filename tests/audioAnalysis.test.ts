import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFeatureTimeline } from "../src/listening-spaces/audio-analysis/AudioFeatureNormalizer.ts";
import {
  extractFeatureTimeline,
  featureAt,
  type PcmAudioData,
} from "../src/listening-spaces/audio-analysis/featureExtraction.ts";
import type {
  RawAudioFeatureFrame,
} from "../src/listening-spaces/audio-analysis/audioTypes.ts";

const sampleRate = 22_050;

function sinePcm(
  frequency: number,
  seconds = 2,
  leftGain = 0.65,
  rightGain = leftGain,
): PcmAudioData {
  const count = Math.floor(sampleRate * seconds);
  const left = new Float32Array(count);
  const right = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    left[index] = sample * leftGain;
    right[index] = sample * rightGain;
  }
  return { sampleRate, left, right };
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0)
    / Math.max(1, values.length);
}

function stableFrames(frequency: number) {
  const timeline = extractFeatureTimeline(
    sinePcm(frequency),
    { frameSize: 2048, hopSize: 1024 },
  );
  return timeline.frames.slice(Math.floor(timeline.frames.length * 0.35));
}

test("real FFT routes low, mid and high tones to the expected bands", () => {
  const lowFrames = stableFrames(60);
  const midFrames = stableFrames(440);
  const highFrames = stableFrames(6_000);
  assert.ok(
    average(lowFrames.map((frame) => frame.low))
      > average(lowFrames.map((frame) => frame.mid)) * 4,
  );
  assert.ok(
    average(midFrames.map((frame) => frame.mid))
      > average(midFrames.map((frame) => frame.high)) * 4,
  );
  assert.ok(
    average(highFrames.map((frame) => frame.high))
      > average(highFrames.map((frame) => frame.mid)) * 4,
  );
});

test("silence and onset are derived from real PCM", () => {
  const empty = new Float32Array(sampleRate);
  const silent = extractFeatureTimeline({ sampleRate, left: empty, right: empty });
  assert.ok(silent.frames.every((frame) => frame.silence));

  const left = new Float32Array(sampleRate * 2);
  const right = new Float32Array(sampleRate * 2);
  const start = Math.floor(sampleRate * 0.8);
  for (let index = 0; index < 300; index += 1) {
    const envelope = 1 - index / 300;
    left[start + index] = envelope * 0.95;
    right[start + index] = -envelope * 0.9;
  }
  const transient = extractFeatureTimeline(
    { sampleRate, left, right },
    { frameSize: 2048, hopSize: 512 },
  );
  assert.equal(transient.frames.filter((frame) => frame.onset > 0).length, 1);
});

test("normalization is bounded and identical PCM stays deterministic", () => {
  const pcm = sinePcm(440, 1);
  assert.deepEqual(extractFeatureTimeline(pcm), extractFeatureTimeline(pcm));
  const raw = Array.from({ length: 8 }, (_, index): RawAudioFeatureFrame => ({
    timeMs: index * 100,
    rms: index === 7 ? 1_000_000 : index,
    low: index * 100,
    mid: index * 200,
    high: index * 300,
    spectralFlux: index * 100,
  }));
  for (const frame of normalizeFeatureTimeline(raw)) {
    assert.ok(frame.low <= 1 && frame.mid <= 1 && frame.high <= 1);
  }
});

test("featureAt clamps seeks and resolves the deterministic hop", () => {
  const timeline = extractFeatureTimeline(
    sinePcm(440, 1),
    { frameSize: 2048, hopSize: 1024 },
  );
  assert.equal(featureAt(null, 0), null);
  assert.equal(featureAt({ ...timeline, frames: [] }, 0), null);
  assert.equal(featureAt(timeline, -1_000), timeline.frames[0]);
  assert.equal(featureAt(timeline, 1_000_000), timeline.frames.at(-1));
  const frameDurationMs = (timeline.hopSize / timeline.sampleRate) * 1000;
  assert.equal(featureAt(timeline, frameDurationMs), timeline.frames[1]);
});
