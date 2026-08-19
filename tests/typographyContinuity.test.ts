import assert from "node:assert/strict";
import test from "node:test";
import {
  createTypographyArchitectureSignature,
  createTypographyContextSignature,
  resolveTypographyPresenceMode,
} from "../src/features/player/TypographyContinuity.ts";

const readyGap = {
  lyricsStatus: "ready" as const,
  hasReadyLyrics: true,
  hasCurrentLyric: false,
  waiting: true,
  gapStartMs: 10_000,
};

test("short lyric gaps never open Breath Presence", () => {
  for (const duration of [100, 500, 1_599]) {
    assert.equal(resolveTypographyPresenceMode({
      ...readyGap,
      playbackTimeMs: 10_000 + duration / 2,
      gapEndMs: 10_000 + duration,
      gapDurationMs: duration,
    }), "lyrics");
  }
});

test("a medium gap with no stable hold window skips Breath Presence", () => {
  for (const duration of [2_000, 2_500]) {
    assert.equal(resolveTypographyPresenceMode({
      ...readyGap,
      playbackTimeMs: 10_000 + duration / 2,
      gapEndMs: 10_000 + duration,
      gapDurationMs: duration,
    }), "lyrics");
  }
});

test("a sustained gap enters late and leaves before the next lyric", () => {
  const gapEndMs = 14_000;
  const gapDurationMs = 4_000;
  assert.equal(resolveTypographyPresenceMode({
    ...readyGap,
    playbackTimeMs: 10_699,
    gapEndMs,
    gapDurationMs,
  }), "lyrics");
  assert.equal(resolveTypographyPresenceMode({
    ...readyGap,
    playbackTimeMs: 10_700,
    gapEndMs,
    gapDurationMs,
  }), "sustained-gap");
  assert.equal(resolveTypographyPresenceMode({
    ...readyGap,
    playbackTimeMs: 13_001,
    gapEndMs,
    gapDurationMs,
  }), "lyrics");
});

test("loading, empty, and error keep the unavailable spatial state", () => {
  for (const lyricsStatus of ["loading", "empty", "error"] as const) {
    assert.equal(resolveTypographyPresenceMode({
      ...readyGap,
      lyricsStatus,
      hasReadyLyrics: false,
      playbackTimeMs: 10_000,
      gapEndMs: 10_000,
      gapDurationMs: 0,
    }), "lyrics-unavailable");
  }
});

test("architecture identity ignores line context while context remains line specific", () => {
  const architecture = createTypographyArchitectureSignature(
    "track-1",
    "scene-1",
    "paired",
    false,
  );
  assert.equal(
    architecture,
    createTypographyArchitectureSignature(
      "track-1",
      "scene-1",
      "paired",
      false,
    ),
  );
  assert.notEqual(
    createTypographyContextSignature("track-1", "past", 1, 4_000),
    createTypographyContextSignature("track-1", "past", 2, 8_000),
  );
});
