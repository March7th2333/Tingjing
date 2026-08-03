import assert from "node:assert/strict";
import test from "node:test";
import {
  distributeLyricUnits,
  estimateLineLyricUnits,
} from "../src/features/lyrics/LyricUnitTiming.ts";

test("line-only CJK lyrics receive ordered grapheme timing", () => {
  const units = estimateLineLyricUnits("光の中へ", 1_000, 5_000);

  assert.deepEqual(units.map(({ text }) => text), ["光", "の", "中", "へ"]);
  assert.ok(units.every((unit, index) =>
    index === 0 || unit.startMs >= units[index - 1].endMs
  ));
  assert.ok(units.at(-1)!.endMs < 5_000);
});

test("Latin lyrics reveal by sung words instead of one whole line", () => {
  const units = estimateLineLyricUnits(
    "I'm good at letting go",
    2_000,
    8_000,
  );
  const visible = units.filter(({ unit }) => unit !== "space");

  assert.deepEqual(
    visible.map(({ text }) => text),
    ["I'm", "good", "at", "letting", "go"],
  );
  assert.ok(visible[1].startMs > visible[0].startMs);
});

test("one provider phrase is subdivided inside its truthful time window", () => {
  const units = distributeLyricUnits("君の声", 10_000, 11_200);

  assert.deepEqual(units.map(({ text }) => text), ["君", "の", "声"]);
  assert.equal(units[0].startMs, 10_000);
  assert.equal(units.at(-1)!.endMs, 11_200);
  assert.ok(units[1].startMs > units[0].startMs);
});

test("mixed text keeps spaces and never escapes the line boundary", () => {
  const units = estimateLineLyricUnits("夜に stay alive", 0, 3_000);

  assert.equal(units.map(({ text }) => text).join(""), "夜に stay alive");
  assert.ok(units.every(({ startMs, endMs }) =>
    startMs >= 0 && endMs <= 3_000
  ));
});
