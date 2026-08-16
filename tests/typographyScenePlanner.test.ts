import assert from "node:assert/strict";
import test from "node:test";
import {
  planTypographyScenes,
  type TypographySceneLineInput,
} from "../src/features/player/TypographyScenePlanner.ts";

function makeLines(): TypographySceneLineInput[] {
  return Array.from({ length: 20 }, (_, index) => ({
    index,
    text: index % 3 === 0
      ? `遠い記憶の中で${index}。`
      : index % 3 === 1
        ? `まだ見えない声${index}`
        : `the printed memory ${index}`,
    startTime: index * 3_200,
    endTime: index * 3_200 + 1_900,
    glyphCount: 8 + index % 12,
    language: index % 3 === 2 ? "en" : "ja",
  }));
}

function makeLongMixedLyrics(): TypographySceneLineInput[] {
  return Array.from({ length: 120 }, (_, index) => {
    const language = index % 3 === 0
      ? "zh-CN"
      : index % 3 === 1
        ? "ja"
        : "en";
    const text = language === "zh-CN"
      ? index % 8 === 0
        ? "光"
        : `这世间仍有克制的回声${index}`
      : language === "ja"
        ? index % 7 === 0
          ? "夢"
          : `遠い記憶の中で歌う${index}`
        : index % 6 === 0
          ? "stay"
          : `the quiet printed memory returns ${index}`;
    const startTime = index * 2_800;
    return {
      index,
      text,
      startTime,
      endTime: startTime + 1_900,
      glyphCount: Array.from(text).filter((unit) => !/\s/u.test(unit)).length,
      language,
    };
  });
}

test("Typography planning remains deterministic", () => {
  const input = {
    trackId: "typography-safe-zone",
    trackDurationMs: 72_000,
    lines: makeLines(),
  };

  assert.deepEqual(planTypographyScenes(input), planTypographyScenes(input));
});

test("ordinary memory glyphs remain inside the left-stage safe zone", () => {
  const plan = planTypographyScenes({
    trackId: "typography-safe-zone",
    trackDurationMs: 72_000,
    lines: makeLines(),
  });

  for (const scene of plan.scenes) {
    for (const glyph of scene.memoryGlyphs) {
      if (glyph.kind.startsWith("context")) {
        assert.ok(glyph.xVw >= -25 && glyph.xVw <= 24);
        assert.ok(glyph.yRatio >= 0.08 && glyph.yRatio <= 0.6);
      } else if (scene.template !== "crop") {
        assert.ok(glyph.xVw >= -19 && glyph.xVw <= 16);
        assert.ok(glyph.yRatio >= 0.08 && glyph.yRatio <= 0.6);
      }
      if (glyph.kind === "architectural") {
        assert.ok(glyph.scale >= 0.78 && glyph.scale <= 1.04);
      }
    }
  }
});

test("every scene stays inside the balanced visual occupancy budget", () => {
  const plan = planTypographyScenes({
    trackId: "typography-occupancy",
    trackDurationMs: 72_000,
    lines: makeLines(),
  });

  for (const scene of plan.scenes) {
    assert.ok(scene.occupancy.visualOccupancy >= 0.24);
    assert.ok(scene.occupancy.visualOccupancy <= 0.38);
    assert.ok(scene.occupancy.backgroundObjectCount >= 4);
    assert.ok(scene.occupancy.backgroundObjectCount <= 5);
    assert.ok(scene.occupancy.sceneBalanceScore >= 0.7);
    assert.ok(
      scene.occupancy.largestGlyphRatio
        <= (scene.template === "crop" ? 0.5 : 0.32),
    );
  }
});

test("crop remains rare and never repeats across adjacent scenes", () => {
  const plan = planTypographyScenes({
    trackId: "typography-crop-frequency",
    trackDurationMs: 72_000,
    lines: makeLines(),
  });
  const crops = plan.scenes.filter((scene) => scene.template === "crop");
  assert.ok(crops.length <= Math.ceil(plan.scenes.length / 4));
  for (let index = 1; index < plan.scenes.length; index += 1) {
    assert.notEqual(
      `${plan.scenes[index - 1].template}:${plan.scenes[index].template}`,
      "crop:crop",
    );
  }
});

test("scene architecture uses several restrained lyric fragments", () => {
  const plan = planTypographyScenes({
    trackId: "typography-fragments",
    trackDurationMs: 72_000,
    lines: makeLines(),
  });

  for (const scene of plan.scenes) {
    const architecture = scene.memoryGlyphs.filter(
      (glyph) => glyph.kind === "architectural",
    );
    assert.ok(architecture.length >= 2 && architecture.length <= 3);
    assert.ok(
      new Set(architecture.map((glyph) => glyph.text)).size >= 2,
    );
    assert.ok(architecture.every((glyph) => glyph.text.trim().length > 0));
  }
});

test("one hundred mixed lyric lines keep the same restrained scene budget", () => {
  const plan = planTypographyScenes({
    trackId: "typography-long-mixed",
    trackDurationMs: 340_000,
    lines: makeLongMixedLyrics(),
  });

  assert.equal(plan.linePlans.length, 120);
  assert.ok(plan.scenes.length >= 24);
  for (const scene of plan.scenes) {
    assert.ok(scene.occupancy.visualOccupancy >= 0.24);
    assert.ok(scene.occupancy.visualOccupancy <= 0.38);
    assert.ok(scene.occupancy.backgroundObjectCount >= 4);
    assert.ok(scene.occupancy.backgroundObjectCount <= 5);
    assert.ok(scene.memoryGlyphs.every((glyph) =>
      glyph.kind !== "architectural"
      || (glyph.scale >= 0.78 && glyph.scale <= 1.04)
    ));
  }
});

test("empty lyric input never fabricates a poster lyric", () => {
  const plan = planTypographyScenes({
    trackId: "typography-empty",
    trackDurationMs: 180_000,
    lines: [],
  });

  assert.deepEqual(plan.scenes, []);
  assert.deepEqual(plan.linePlans, []);
  assert.deepEqual(plan.interludes, []);
});
