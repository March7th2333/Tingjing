import assert from "node:assert/strict";
import test from "node:test";
import {
  mapNeteaseLyrics,
  parseNeteaseWordSyncedLyrics,
} from "../src/providers/neteaseLyrics.ts";

test("preserves YRC, KRC and LRC source identity", () => {
  const timed = "[1000,600]你(1000,300,0)好(1300,300,0)";
  const original = "[00:01.00]你好";
  const yrc = mapNeteaseLyrics("yrc-source", {
    original,
    wordSynced: timed,
    wordSyncedSource: "yrc",
    translation: "",
  });
  const krc = mapNeteaseLyrics("krc-source", {
    original,
    wordSynced: timed,
    wordSyncedSource: "krc",
    translation: "",
  });
  const lrc = mapNeteaseLyrics("lrc-source", {
    original,
    wordSynced: "",
    wordSyncedSource: "lrc",
    translation: "",
  });

  assert.equal(yrc.source, "yrc");
  assert.equal(krc.source, "krc");
  assert.equal(lrc.source, "lrc");
});

test("parses NetEase prefix and postfix word markers", () => {
  const lines = parseNeteaseWordSyncedLyrics([
    "[1000,900](1000,300,0)你(1300,300,0)好(1600,300,0)啊",
    "[3000,900]君(3000,300,0)の(3300,300,0)声(3600,300,0)",
  ].join("\n"));

  assert.equal(lines[0].text, "你好啊");
  assert.equal(lines[0].durationMs, 900);
  assert.equal(lines[0].words?.map((word) => word.text).join(""), "你好啊");
  assert.equal(lines[1].text, "君の声");
  assert.equal(lines[1].words?.map((word) => word.text).join(""), "君の声");
});

test("chooses relative and absolute NetEase word times per line", () => {
  const lines = parseNeteaseWordSyncedLyrics([
    "[1000,900]你(0,300,0)好(300,300,0)啊(600,300,0)",
    "[3000,900]君(3000,300,0)の(3300,300,0)声(3600,300,0)",
  ].join("\n"));

  assert.deepEqual(lines[0].words?.map((word) => word.atMs), [1_000, 1_300, 1_600]);
  assert.deepEqual(lines[1].words?.map((word) => word.atMs), [3_000, 3_300, 3_600]);
});

test("partial NetEase YRC never replaces or drops original LRC lines", () => {
  const lyrics = mapNeteaseLyrics("partial", {
    original: [
      "[00:00.00]作词：测试作者",
      "[00:01.00]第一句",
      "[00:03.00]第二句",
    ].join("\n"),
    wordSynced: "[1000,1000]第(1000,250,0)一(1250,250,0)句(1500,500,0)",
    translation: "[00:01.00]First line",
  });

  assert.deepEqual(
    lyrics.lines.map((line) => line.text),
    ["作词：测试作者", "第一句", "第二句"],
  );
  assert.equal(lyrics.lines[0].wordTimingRejection, "provider-match-failed");
  assert.equal(lyrics.lines[1].words?.length, 3);
  assert.equal(lyrics.lines[1].durationMs, 1_000);
  assert.equal(lyrics.lines[1].endAtMs, 2_000);
  assert.equal(lyrics.lines[2].wordTimingRejection, "provider-match-failed");
  assert.equal(lyrics.lines[2].durationMs, undefined);
  assert.equal(lyrics.lines[2].endAtMs, undefined);
  assert.equal(lyrics.lines[1].translation, "First line");
});

test("preserves the NetEase line duration and absolute end when the LRC anchor differs", () => {
  const lyrics = mapNeteaseLyrics("offset-line-end", {
    original: "[00:01.00]Offset line",
    wordSynced: "[1300,800]Offset(1300,300,0) line(1600,500,0)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].atMs, 1_000);
  assert.equal(lyrics.lines[0].durationMs, 800);
  assert.equal(lyrics.lines[0].endAtMs, 2_100);
});

test("NetEase text mismatch is rejected rather than fuzzily attached", () => {
  const lyrics = mapNeteaseLyrics("mismatch", {
    original: "[00:01.00]你好吗",
    wordSynced: "[1000,900]你(1000,300,0)很(1300,300,0)好(1600,300,0)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].words, undefined);
  assert.equal(lyrics.lines[0].wordTimingRejection, "text-mismatch");
});

test("NetEase line markers with an optional third field remain supported", () => {
  const [line] = parseNeteaseWordSyncedLyrics(
    "[1000,900,0]I(1000,200) love(1200,300) music(1500,400)",
  );

  assert.equal(line.text, "I love music");
  assert.equal(line.words?.length, 3);
});

test("NetEase LRC-only lyrics stay complete and report missing word timing", () => {
  const lyrics = mapNeteaseLyrics("lrc-only", {
    original: "[00:01.00]第一句\n[00:03.00]第二句",
    wordSynced: "",
    translation: "",
  });

  assert.deepEqual(lyrics.lines.map((line) => line.text), ["第一句", "第二句"]);
  assert.deepEqual(
    lyrics.lines.map((line) => line.wordTimingRejection),
    ["missing", "missing"],
  );
  assert.deepEqual(
    lyrics.lines.map((line) => [line.durationMs, line.endAtMs]),
    [[undefined, undefined], [undefined, undefined]],
  );
});

test("repeated NetEase lines consume distinct timing candidates", () => {
  const lyrics = mapNeteaseLyrics("repeated", {
    original: "[00:01.00]Again\n[00:03.00]Again",
    wordSynced: [
      "[1000,500]Again(1000,500,0)",
      "[3000,500]Again(3000,500,0)",
    ].join("\n"),
    translation: "",
  });

  assert.deepEqual(
    lyrics.lines.map((line) => line.words?.[0].atMs),
    [1_000, 3_000],
  );
});

test("NetEase invalid timing keeps the line and reports the rejection", () => {
  const lyrics = mapNeteaseLyrics("invalid", {
    original: "[00:01.00]你好",
    wordSynced: "[1000,500]你(1000,0,0)好(1200,300,0)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].words, undefined);
  assert.equal(lyrics.lines[0].wordTimingRejection, "invalid-duration");
  assert.equal(lyrics.lines[0].durationMs, 500);
  assert.equal(lyrics.lines[0].endAtMs, 1_500);
});

test("unmatched NetEase translation is not attached", () => {
  const lyrics = mapNeteaseLyrics("unmatched-translation", {
    original: "[00:01.00]君の声",
    wordSynced: "",
    translation: "[01:40.00]不应错误挂接",
  });

  assert.equal(lyrics.lines[0].translation, undefined);
  assert.equal(lyrics.hasTranslation, false);
});
