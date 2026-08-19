import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeQqLyricPayload,
  mapQqLyrics,
  parseTimedQqLyrics,
  parseWordSyncedLyrics,
} from "../src/providers/qqLyrics.ts";

test("preserves the QQ lyric source identity", () => {
  const exact = mapQqLyrics("qrc-source", {
    original: "[00:01.00]你好",
    wordSynced: "[1000,600]你(1000,300)好(1300,300)",
    wordSyncedSource: "qrc",
    translation: "",
  });
  const lineOnly = mapQqLyrics("lrc-source", {
    original: "[00:01.00]你好",
    wordSynced: "",
    wordSyncedSource: "lrc",
    translation: "",
  });

  assert.equal(exact.source, "qrc");
  assert.equal(lineOnly.source, "lrc");
});

test("parses QQ postfix timings without dropping the first character", () => {
  const [line] = parseWordSyncedLyrics(
    "[1000,900]你(1000,300)好(1300,300)啊(1600,300)",
  );

  assert.equal(line.text, "你好啊");
  assert.equal(line.durationMs, 900);
  assert.deepEqual(line.words, [
    { text: "你", atMs: 1_000, durationMs: 300 },
    { text: "好", atMs: 1_300, durationMs: 300 },
    { text: "啊", atMs: 1_600, durationMs: 300 },
  ]);
});

test("parses prefix timings into the same complete line", () => {
  const [line] = parseWordSyncedLyrics(
    "[1000,900](1000,300)你(1300,300)好(1600,300)啊",
  );

  assert.equal(line.text, "你好啊");
  assert.deepEqual(line.words?.map((word) => word.atMs), [1_000, 1_300, 1_600]);
});

test("preserves Japanese, English spaces and Chinese punctuation", () => {
  const lines = parseWordSyncedLyrics([
    "[1000,550]君(1000,200)の(1200,100)声(1300,250)",
    "[2000,600]I(2000,100) love(2100,200) you(2300,300)",
    "[3000,680]你(3000,300)，(3300,80)好(3380,300)",
  ].join("\n"));

  assert.equal(lines[0].text, "君の声");
  assert.equal(lines[1].text, "I love you");
  assert.equal(lines[1].words?.map((word) => word.text).join(""), "I love you");
  assert.equal(lines[2].text, "你，好");
});

test("supports relative word timings even near the start of a song", () => {
  const [line] = parseWordSyncedLyrics(
    "[1000,900]你(0,300)好(300,300)啊(600,300)",
  );

  assert.deepEqual(line.words?.map((word) => word.atMs), [1_000, 1_300, 1_600]);
});

test("rejects invalid QQ word durations with a structured reason", () => {
  const [line] = parseWordSyncedLyrics(
    "[1000,900]你(1000,0)好(1300,300)啊(1600,300)",
  );

  assert.equal(line.words, undefined);
  assert.equal(line.wordTimingRejection, "invalid-duration");
});

test("unwraps XML LyricContent and decodes entities", () => {
  const xml = "<LyricInfo LyricContent=\"[1000,900]你(1000,300)好(1300,300)啊(1600,300)&#10;[2000,400]A(2000,400)&amp;\"/>";
  const decoded = decodeQqLyricPayload(xml);
  const lines = parseWordSyncedLyrics(decoded);

  assert.match(decoded, /\n/u);
  assert.equal(lines[0].text, "你好啊");
  assert.equal(lines[1].text, "A&");
});

test("decodes base64 and plain UTF-8 hex timed lyrics", () => {
  const source = "[00:01.00]你好";
  const base64 = Buffer.from(source, "utf8").toString("base64");
  const hex = Buffer.from(source, "utf8").toString("hex");

  assert.equal(parseTimedQqLyrics(base64)[0].text, "你好");
  assert.equal(parseTimedQqLyrics(hex)[0].text, "你好");
});

test("keeps complete LRC text when QRC words do not match", () => {
  const lyrics = mapQqLyrics("mismatch", {
    original: "[00:01.00]你好吗",
    wordSynced: "[1000,900]你(1000,300)很(1300,300)好(1600,300)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].text, "你好吗");
  assert.equal(lyrics.lines[0].words, undefined);
  assert.equal(lyrics.lines[0].wordTimingRejection, "text-mismatch");
});

test("strict matching safely normalizes English case and straight or curly quotes", () => {
  const lyrics = mapQqLyrics("english-quotes", {
    original: "[00:01.00]“HELLO” World",
    wordSynced: "[1000,1000]\"hello\"(1000,500) world(1500,500)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].text, "“HELLO” World");
  assert.equal(lyrics.lines[0].words?.map((word) => word.text).join(""), "\"hello\" world");
  assert.equal(lyrics.lines[0].wordTimingRejection, undefined);
});

test("strict matching preserves Latin word boundaries", () => {
  const lyrics = mapQqLyrics("latin-boundary", {
    original: "[00:01.00]the rapist",
    wordSynced: "[1000,900]therapist(1000,900)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].words, undefined);
  assert.equal(lyrics.lines[0].wordTimingRejection, "text-mismatch");
});

test("strict matching accepts safe Unicode width, quote and whitespace normalization", () => {
  const lyrics = mapQqLyrics("safe-normalization", {
    original: "[00:01.00]Ｉ  LOVE  YOU’S",
    wordSynced: "[1000,900]i(1000,200) love(1200,300) you's(1500,400)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].words?.map((word) => word.text).join(""), "i love you's");
  assert.equal(lyrics.lines[0].wordTimingRejection, undefined);
});

test("strict matching does not erase punctuation differences", () => {
  const lyrics = mapQqLyrics("punctuation", {
    original: "[00:01.00]Hello, world",
    wordSynced: "[1000,900]Hello(1000,300) world(1300,600)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].words, undefined);
  assert.equal(lyrics.lines[0].wordTimingRejection, "text-mismatch");
});

test("reports missing and provider matching failures without fabricating timing", () => {
  const missing = mapQqLyrics("missing", {
    original: "[00:01.00]No word timing",
    wordSynced: "",
    translation: "",
  });
  const outOfWindow = mapQqLyrics("out-of-window", {
    original: "[00:01.00]Same text",
    wordSynced: "[5000,800]Same(5000,400) text(5400,400)",
    translation: "",
  });

  assert.equal(missing.lines[0].wordTimingRejection, "missing");
  assert.equal(missing.lines[0].durationMs, undefined);
  assert.equal(missing.lines[0].endAtMs, undefined);
  assert.equal(outOfWindow.lines[0].words, undefined);
  assert.equal(outOfWindow.lines[0].durationMs, undefined);
  assert.equal(outOfWindow.lines[0].endAtMs, undefined);
  assert.equal(outOfWindow.lines[0].wordTimingRejection, "provider-match-failed");
});

test("preserves the QQ line duration and absolute end when the LRC anchor differs", () => {
  const lyrics = mapQqLyrics("offset-line-end", {
    original: "[00:01.00]Offset line",
    wordSynced: "[1300,800]Offset(1300,300) line(1600,500)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].atMs, 1_000);
  assert.equal(lyrics.lines[0].durationMs, 800);
  assert.equal(lyrics.lines[0].endAtMs, 2_100);
});

test("keeps every original line when only part of QRC is valid", () => {
  const lyrics = mapQqLyrics("partial", {
    original: "[00:01.00]第一句\n[00:03.00]第二句",
    wordSynced: "[1000,1000]第(1000,250)一(1250,250)句(1500,500)",
    translation: "",
  });

  assert.deepEqual(lyrics.lines.map((line) => line.text), ["第一句", "第二句"]);
  assert.equal(lyrics.lines[0].words?.length, 3);
  assert.equal(lyrics.lines[0].durationMs, 1_000);
  assert.equal(lyrics.lines[0].endAtMs, 2_000);
  assert.equal(lyrics.lines[1].words, undefined);
  assert.equal(lyrics.lines[1].durationMs, undefined);
  assert.equal(lyrics.lines[1].endAtMs, undefined);
  assert.equal(lyrics.lines[1].wordTimingRejection, "provider-match-failed");
});

test("keeps valid QQ line timing when only its word timing is invalid", () => {
  const lyrics = mapQqLyrics("invalid-word-duration", {
    original: "[00:01.00]你好",
    wordSynced: "[1000,900]你(1000,0)好(1300,300)",
    translation: "",
  });

  assert.equal(lyrics.lines[0].words, undefined);
  assert.equal(lyrics.lines[0].wordTimingRejection, "invalid-duration");
  assert.equal(lyrics.lines[0].durationMs, 900);
  assert.equal(lyrics.lines[0].endAtMs, 1_900);
});

test("repeated QQ lyric lines consume distinct local timing candidates", () => {
  const lyrics = mapQqLyrics("repeated", {
    original: "[00:01.00]Again\n[00:03.00]Again",
    wordSynced: [
      "[1000,500]Again(1000,500)",
      "[3000,500]Again(3000,500)",
    ].join("\n"),
    translation: "",
  });

  assert.deepEqual(
    lyrics.lines.map((line) => line.words?.[0].atMs),
    [1_000, 3_000],
  );
});

test("parses QRC translation and aligns a stable offset one-to-one", () => {
  const lyrics = mapQqLyrics("translated", {
    original: "[00:01.00]君の声\n[00:03.00]また会おう",
    wordSynced: [
      "[1000,600]君(1000,200)の(1200,100)声(1300,300)",
      "[3000,900]ま(3000,200)た(3200,200)会(3400,250)お(3650,125)う(3775,125)",
    ].join("\n"),
    translation: "[1300,1000]你的声音\n[3300,1000]下次再见",
  });

  assert.deepEqual(
    lyrics.lines.map((line) => line.translation),
    ["你的声音", "下次再见"],
  );
  assert.equal(lyrics.hasTranslation, true);
});

test("hasTranslation reflects attached translations, not parsed payload alone", () => {
  const lyrics = mapQqLyrics("unmatched", {
    original: "[00:01.00]君の声",
    wordSynced: "",
    translation: "[01:40.00]不应错误挂接",
  });

  assert.equal(lyrics.lines[0].translation, undefined);
  assert.equal(lyrics.hasTranslation, false);
});
