import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPlaybackVolume,
  resolvePlaybackVolume,
} from "../src/features/player/playbackVolume.ts";

test("playback volume clamps persistent user values", () => {
  assert.equal(clampPlaybackVolume(-1), 0);
  assert.equal(clampPlaybackVolume(0.42), 0.42);
  assert.equal(clampPlaybackVolume(8), 1);
  assert.equal(clampPlaybackVolume(Number.NaN, 0.75), 0.75);
});

test("transition gain multiplies rather than overwrites user volume", () => {
  assert.equal(resolvePlaybackVolume(0.8, 0), 0);
  assert.equal(resolvePlaybackVolume(0.8, 0.5), 0.4);
  assert.equal(resolvePlaybackVolume(0.8, 1), 0.8);
  assert.equal(resolvePlaybackVolume(2, 2), 1);
});
