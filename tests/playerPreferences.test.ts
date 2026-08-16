import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultPlayerPreferences,
  normalizePlayerPreferences,
} from "../src/features/settings/playerPreferences.ts";

test("legacy original-lyrics opt-out is migrated back to always visible", () => {
  const preferences = normalizePlayerPreferences({
    showOriginalLyrics: false,
    showTranslation: false,
  });

  assert.equal(preferences.showOriginalLyrics, true);
  assert.equal(preferences.showTranslation, false);
  assert.equal(preferences.scrollShowTranslation, false);
});

test("canonical translation preference wins over a conflicting legacy scroll flag", () => {
  const preferences = normalizePlayerPreferences({
    showTranslation: false,
    scrollShowTranslation: true,
  });

  assert.equal(preferences.showTranslation, false);
  assert.equal(preferences.scrollShowTranslation, false);
});

test("legacy scroll translation is migrated when the canonical field is absent", () => {
  const preferences = normalizePlayerPreferences({
    scrollShowTranslation: false,
  });

  assert.equal(preferences.showTranslation, false);
  assert.equal(preferences.scrollShowTranslation, false);
});

test("new installations enable original lyrics and translation in every space", () => {
  const preferences = normalizePlayerPreferences(undefined);

  assert.equal(preferences.showOriginalLyrics, true);
  assert.equal(preferences.showTranslation, true);
  assert.equal(preferences.scrollShowTranslation, true);
  assert.deepEqual(preferences, defaultPlayerPreferences);
});

test("removed spaces migrate while current spaces remain available", () => {
  for (const removedSpace of [
    "cinema",
    "orbit",
    "press",
    "construct",
    "void",
  ]) {
    assert.equal(
      normalizePlayerPreferences({ listeningSpace: removedSpace })
        .listeningSpace,
      "music",
    );
  }

  assert.equal(
    normalizePlayerPreferences({ listeningSpace: "imprint" }).listeningSpace,
    "imprint",
  );

});

test("removed cloud listening scope is discarded during migration", () => {
  const preferences = normalizePlayerPreferences({
    listeningStatisticsScope: "qq-account",
  });

  assert.equal("listeningStatisticsScope" in preferences, false);
});

test("legacy player settings migrate repeat, volume and mute defaults", () => {
  const preferences = normalizePlayerPreferences({
    playbackOrder: "shuffle",
  });

  assert.equal(preferences.playbackOrder, "shuffle");
  assert.equal(preferences.repeatMode, "off");
  assert.equal(preferences.volume, 1);
  assert.equal(preferences.muted, false);
});

test("valid repeat and audio preferences are preserved", () => {
  const preferences = normalizePlayerPreferences({
    repeatMode: "one",
    volume: 0.37,
    muted: true,
  });

  assert.equal(preferences.repeatMode, "one");
  assert.equal(preferences.volume, 0.37);
  assert.equal(preferences.muted, true);
});

test("volume is clamped and invalid audio preferences use safe defaults", () => {
  assert.equal(normalizePlayerPreferences({ volume: -4 }).volume, 0);
  assert.equal(normalizePlayerPreferences({ volume: 4 }).volume, 1);
  assert.equal(
    normalizePlayerPreferences({ volume: Number.NaN }).volume,
    defaultPlayerPreferences.volume,
  );
  assert.equal(
    normalizePlayerPreferences({ repeatMode: "invalid" }).repeatMode,
    "off",
  );
  assert.equal(normalizePlayerPreferences({ muted: "yes" }).muted, false);
});
