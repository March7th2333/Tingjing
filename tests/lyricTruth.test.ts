import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLyricOffset,
  createUnavailableLyricDocument,
  getNormalizedLyricIndex,
  getNormalizedLyricWordIndex,
  normalizeLyricDocument,
  segmentLyricText,
} from "../src/features/lyrics/LyricTruth.ts";
import {
  LyricOffsetStore,
  lyricOffsetKey,
} from "../src/features/lyrics/LyricOffsetStore.ts";
import type { LyricLine, Lyrics, LyricTimingSource } from "../src/types/music.ts";

function normalize(
  lines: LyricLine[],
  source: LyricTimingSource = "qrc",
  durationMs = 20_000,
) {
  const lyrics: Lyrics = {
    trackId: "truth-track",
    hasTranslation: lines.some(({ translation }) => Boolean(translation)),
    lines,
    source,
  };
  return normalizeLyricDocument({
    provider: "qq",
    trackId: lyrics.trackId,
    durationMs,
    lyrics,
  });
}

function exactLine(
  atMs: number,
  text: string,
  words: LyricLine["words"],
  endAtMs: number,
): LyricLine {
  return { atMs, endAtMs, text, words };
}

test("validated provider word timing remains word-exact", () => {
  const document = normalize([
    exactLine(1_000, "僕らは", [
      { text: "僕", atMs: 1_000, durationMs: 180 },
      { text: "ら", atMs: 1_180, durationMs: 170 },
      { text: "は", atMs: 1_350, durationMs: 150 },
    ], 1_800),
  ]);

  assert.equal(document.timingQuality, "word-exact");
  assert.equal(document.diagnostics.providerWordTimingAvailable, true);
  assert.equal(document.diagnostics.providerWordTimingUsed, true);
  assert.equal(document.lines[0].words?.length, 3);
  assert.equal(document.lines[0].wordTimingRejection, undefined);
});

test("line-only and manual estimates keep honest quality labels", () => {
  const lineOnly = normalize([{ atMs: 1_000, text: "只有逐句时间" }], "lrc");
  const estimated = normalize([{ atMs: 1_000, text: "明确估算" }], "manual");

  assert.equal(lineOnly.timingQuality, "line-only");
  assert.equal(lineOnly.lines[0].words, undefined);
  assert.equal(estimated.timingQuality, "estimated");
  assert.equal(estimated.lines[0].words, undefined);
});

test("partial trustworthy word coverage is aligned, never word-exact", () => {
  const document = normalize([
    exactLine(1_000, "真", [
      { text: "真", atMs: 1_000, durationMs: 200 },
    ], 1_500),
    { atMs: 3_000, endAtMs: 4_000, text: "逐句" },
  ]);

  assert.equal(document.timingQuality, "aligned");
  assert.equal(document.diagnostics.wordTimedLineCount, 1);
  assert.equal(document.lines[1].wordTimingRejection, "missing");
});

test("strict validation rejects overlap, range, ordering and text mismatch", () => {
  const cases: Array<{
    expected: string;
    line: LyricLine;
  }> = [
    {
      expected: "overlap",
      line: exactLine(1_000, "AB", [
        { text: "A", atMs: 1_000, durationMs: 400 },
        { text: "B", atMs: 1_399, durationMs: 200 },
      ], 2_000),
    },
    {
      expected: "out-of-line-range",
      line: exactLine(1_000, "AB", [
        { text: "A", atMs: 999, durationMs: 100 },
        { text: "B", atMs: 1_200, durationMs: 100 },
      ], 2_000),
    },
    {
      expected: "non-monotonic",
      line: exactLine(1_000, "AB", [
        { text: "A", atMs: 1_400, durationMs: 100 },
        { text: "B", atMs: 1_200, durationMs: 100 },
      ], 2_000),
    },
    {
      expected: "text-mismatch",
      line: exactLine(1_000, "AB", [
        { text: "A", atMs: 1_000, durationMs: 100 },
        { text: "C", atMs: 1_200, durationMs: 100 },
      ], 2_000),
    },
  ];

  for (const fixture of cases) {
    const document = normalize([fixture.line]);
    assert.equal(document.timingQuality, "line-only", fixture.expected);
    assert.equal(document.lines[0].words, undefined, fixture.expected);
    assert.equal(document.lines[0].wordTimingRejection, fixture.expected);
    assert.equal(
      document.diagnostics.rejectedWordTimingReasons[
        fixture.expected as keyof typeof document.diagnostics.rejectedWordTimingReasons
      ],
      1,
      fixture.expected,
    );
  }
});

test("spaces, width variants and punctuation do not create false mismatches", () => {
  const document = normalize([
    exactLine(1_000, "Ｈｅｌｌｏ， world!", [
      { text: "Hello", atMs: 1_000, durationMs: 400 },
      { text: "world", atMs: 1_500, durationMs: 400 },
    ], 2_000),
  ]);

  assert.equal(document.timingQuality, "word-exact");
  assert.equal(document.lines[0].wordTimingRejection, undefined);
});

test("source ordering is diagnosed while duplicate rows keep stable identities", () => {
  const document = normalize([
    { atMs: 5_000, text: "后来" },
    { atMs: 1_000, text: "先唱" },
    { atMs: 1_000, text: "先唱" },
  ], "lrc");

  assert.deepEqual(document.lines.map(({ text }) => text), ["先唱", "先唱", "后来"]);
  assert.notEqual(document.lines[0].id, document.lines[1].id);
  assert.ok(document.diagnostics.invalidLineReasons.includes("line-1:non-monotonic"));
  assert.equal(getNormalizedLyricIndex(document, 1_000), 1);
});

test("provider overlap is clipped at the next row and diagnosed", () => {
  const document = normalize([
    { atMs: 1_000, endAtMs: 4_000, text: "第一句" },
    { atMs: 3_000, endAtMs: 4_500, text: "第二句" },
  ], "lrc");

  assert.equal(document.lines[0].endTimeMs, 3_000);
  assert.ok(document.diagnostics.invalidLineReasons.includes("line-0:overlap"));
});

test("long pauses preserve raw end and a separate render window", () => {
  const document = normalize([
    { atMs: 1_000, endAtMs: 2_000, text: "唱完后停顿" },
    { atMs: 10_000, endAtMs: 11_000, text: "下一句" },
  ], "lrc", 12_000);

  assert.equal(document.lines[0].endTimeMs, 2_000);
  assert.equal(document.lines[0].renderEndTimeMs, 10_000);
  assert.equal(getNormalizedLyricIndex(document, 9_999), 0);
  assert.equal(getNormalizedLyricIndex(document, 10_000), 1);
});

test("out-of-track and empty lyrics produce deterministic unavailable results", () => {
  const outOfRange = normalize([
    { atMs: 20_000, text: "超出歌曲" },
  ], "lrc", 10_000);
  const unavailable = createUnavailableLyricDocument("qq", "empty-track");

  assert.equal(outOfRange.lines.length, 0);
  assert.ok(outOfRange.diagnostics.invalidLineReasons.includes("line-0:out-of-track-range"));
  assert.equal(unavailable.timingQuality, "unavailable");
  assert.equal(unavailable.lines.length, 0);
});

test("offsets are absolute, shared by line and word timing, and seek indexes follow", () => {
  const base = normalize([
    exactLine(1_000, "AB", [
      { text: "A", atMs: 1_000, durationMs: 200 },
      { text: "B", atMs: 1_300, durationMs: 200 },
    ], 2_000),
    { atMs: 4_000, endAtMs: 5_000, text: "下一句" },
  ]);
  const delayed = applyLyricOffset(base, 300);
  const advanced = applyLyricOffset(delayed, -200);

  assert.equal(delayed.lines[0].startTimeMs, 1_300);
  assert.equal(delayed.lines[0].words?.[1].startTimeMs, 1_600);
  assert.equal(advanced.lines[0].startTimeMs, 800);
  assert.equal(advanced.lines[0].rawStartTimeMs, 1_000);
  assert.equal(getNormalizedLyricIndex(advanced, 799), -1);
  assert.equal(getNormalizedLyricIndex(advanced, 800), 0);
  assert.equal(getNormalizedLyricWordIndex(advanced, 0, 799), -1);
  assert.equal(getNormalizedLyricWordIndex(advanced, 0, 1_100), 1);
});

test("per-track offsets persist and stay isolated by provider, track and lyric source", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const qqQrc = lyricOffsetKey("qq", "track-1", "qrc");
  const qqLrc = lyricOffsetKey("qq", "track-1", "lrc");
  const neteaseYrc = lyricOffsetKey("netease", "track-1", "yrc");
  const first = new LyricOffsetStore(storage);

  first.set(qqQrc, 300);
  first.set(qqLrc, -200);
  first.set(neteaseYrc, 700);

  const restored = new LyricOffsetStore(storage);
  assert.equal(restored.get(qqQrc), 300);
  assert.equal(restored.get(qqLrc), -200);
  assert.equal(restored.get(neteaseYrc), 700);
  restored.reset(qqQrc);
  assert.equal(restored.get(qqQrc), 0);
  assert.equal(restored.get(qqLrc), -200);
});

test("segmentation keeps English words and CJK or composed graphemes honest", () => {
  assert.deepEqual(
    segmentLyricText("Hello, brave world!"),
    [
      { text: "Hello", unit: "word" },
      { text: ",", unit: "character" },
      { text: " ", unit: "space" },
      { text: "brave", unit: "word" },
      { text: " ", unit: "space" },
      { text: "world", unit: "word" },
      { text: "!", unit: "character" },
    ],
  );
  assert.deepEqual(
    segmentLyricText("你A\u030A好、世界"),
    [
      { text: "你", unit: "character" },
      { text: "A\u030A", unit: "word" },
      { text: "好", unit: "character" },
      { text: "、", unit: "character" },
      { text: "世", unit: "character" },
      { text: "界", unit: "character" },
    ],
  );
});

test("segmentation and normalization remain bounded for 1000+ characters", () => {
  const text = "あ".repeat(1_024);
  const units = segmentLyricText(text);
  const document = normalize([{ atMs: 1_000, endAtMs: 8_000, text }], "lrc");

  assert.equal(units.length, 1_024);
  assert.equal(units.map(({ text: value }) => value).join(""), text);
  assert.equal(document.lines.length, 1);
  assert.equal(document.lines[0].words, undefined);
  assert.equal(document.timingQuality, "line-only");
});
