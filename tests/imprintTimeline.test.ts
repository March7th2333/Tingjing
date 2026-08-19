import assert from "node:assert/strict";
import test from "node:test";
import {
  alignImprintWordText,
  adaptAuralTrackToImprint,
  getWordTimingRejection,
  ImprintTimeline,
  type ImprintLine,
} from "../src/listening-spaces/imprint/imprintTimeline.ts";
import {
  clearImprintPolicySessionsForTests,
  commitPendingImprintPolicyPlan,
  createImprintPolicyPlan,
  stageImprintPolicyPlan,
} from "../src/listening-spaces/imprint/imprintPolicySession.ts";
import type { LyricLine, Track } from "../src/types/music.ts";

function makeTrack(lyrics: LyricLine[], overrides: Partial<Track> = {}): Track {
  return {
    id: "imprint-test",
    title: "印迹测试",
    artist: "Aural",
    album: "Space 04",
    durationMs: 12_000,
    coverLabel: "04",
    palette: {
      background: "#0d0d0f",
      ambient: "#171719",
      accent: "#f4f3ee",
      text: "#f4f3ee",
    },
    lyrics,
    ...overrides,
  };
}

function exactLine(atMs: number, text: string, unitDurationMs = 160): LyricLine {
  let cursor = atMs;
  return {
    atMs,
    text,
    words: Array.from(text).map((character) => {
      const word = { text: character, atMs: cursor, durationMs: unitDurationMs };
      cursor += unitDurationMs;
      return word;
    }),
  };
}

function timelineFor(
  lines: LyricLine[],
  showOriginalLyrics = true,
  status: "loading" | "ready" | "empty" | "error" = "ready",
) {
  const track = makeTrack(lines);
  return new ImprintTimeline(
    adaptAuralTrackToImprint(
      track,
      track.durationMs,
      showOriginalLyrics,
      status,
    ),
  );
}

test("all sung lines with trustworthy words select one exact track policy", () => {
  const timeline = timelineFor([
    exactLine(1_000, "君の声"),
    exactLine(4_000, "また会おう"),
  ]);

  assert.equal(timeline.renderPolicy, "exact");
  assert.equal(timeline.analysis.wordCoverage, 1);
  assert.equal(timeline.analysis.exactLineCount, 2);
  const frame = timeline.derive(1_200, { historyLimit: 14 });
  assert.equal(frame.renderPolicy, "exact");
  assert.ok(frame.currentTokens.length > 0);
});

test("partial coverage keeps exact rows exact and estimates missing units", () => {
  const timeline = timelineFor([
    exactLine(1_000, "逐字行"),
    { atMs: 4_000, text: "只有行时间" },
    exactLine(7_000, "再次逐字"),
  ]);

  assert.equal(timeline.renderPolicy, "adaptive");
  assert.equal(timeline.analysis.exactLineCount, 2);
  assert.equal(timeline.analysis.lineOnlyCount, 0);
  assert.equal(timeline.analysis.estimatedLineCount, 1);
  const exactSourceFrame = timeline.derive(1_200, { historyLimit: 5 });
  assert.equal(exactSourceFrame.timingMode, "word-exact");
  assert.equal(exactSourceFrame.lineRenderPolicy, "exact");
  assert.ok(exactSourceFrame.currentTokens.length > 0);
  const lineOnlyFrame = timeline.derive(4_200, { historyLimit: 5 });
  assert.equal(lineOnlyFrame.timingMode, "word-estimated");
  assert.equal(lineOnlyFrame.lineRenderPolicy, "estimated");
  assert.ok(lineOnlyFrame.currentTokens.length > 1);
  const laterExactFrame = timeline.derive(7_200, { historyLimit: 5 });
  assert.equal(laterExactFrame.lineRenderPolicy, "exact");
  assert.ok(laterExactFrame.currentTokens.length > 0);
});

test("line-only, 80/20 and consecutive gaps keep truthful track summaries", () => {
  const fixtures = [
    {
      name: "line-only",
      lines: [
        { atMs: 1_000, text: "第一句" },
        { atMs: 4_000, text: "第二句" },
      ],
      exact: 0,
      estimated: 2,
      coverage: 0,
      policy: "estimated",
    },
    {
      name: "80-20",
      lines: [
        exactLine(1_000, "一"),
        exactLine(3_000, "二"),
        exactLine(5_000, "三"),
        exactLine(7_000, "四"),
        { atMs: 9_000, text: "五" },
      ],
      exact: 4,
      estimated: 1,
      coverage: 0.8,
      policy: "adaptive",
    },
    {
      name: "consecutive-gaps",
      lines: [
        exactLine(1_000, "一"),
        { atMs: 3_000, text: "二" },
        { atMs: 5_000, text: "三" },
        exactLine(7_000, "四"),
      ],
      exact: 2,
      estimated: 2,
      coverage: 0.5,
      policy: "adaptive",
    },
  ] satisfies Array<{
    name: string;
    lines: LyricLine[];
    exact: number;
    estimated: number;
    coverage: number;
    policy: "estimated" | "adaptive";
  }>;

  for (const fixture of fixtures) {
    const timeline = timelineFor(fixture.lines);
    assert.equal(timeline.renderPolicy, fixture.policy, fixture.name);
    assert.equal(timeline.analysis.exactLineCount, fixture.exact, fixture.name);
    assert.equal(timeline.analysis.lineOnlyCount, 0, fixture.name);
    assert.equal(
      timeline.analysis.estimatedLineCount,
      fixture.estimated,
      fixture.name,
    );
    assert.equal(timeline.analysis.wordCoverage, fixture.coverage, fixture.name);
    const firstFrame = timeline.derive(1_050, { historyLimit: 5 });
    if (fixture.exact > 0) {
      assert.equal(firstFrame.lineRenderPolicy, "exact", fixture.name);
      assert.ok(firstFrame.currentTokens.length > 0, fixture.name);
    } else {
      assert.equal(firstFrame.lineRenderPolicy, "estimated", fixture.name);
      assert.ok(firstFrame.currentTokens.length > 1, fixture.name);
    }
  }
});

test("credit and instrumental rows do not lower word coverage", () => {
  const timeline = timelineFor([
    { atMs: 0, text: "作词：测试作者" },
    exactLine(1_000, "真实演唱歌词"),
    { atMs: 5_000, text: "Instrumental" },
  ]);

  assert.equal(timeline.renderPolicy, "exact");
  assert.equal(timeline.analysis.exactLineCount, 1);
  assert.equal(timeline.analysis.lineOnlyCount, 0);
  assert.equal(timeline.analysis.ignoredLineCount, 2);
});

test("metadata-only ready lyrics use a static no-valid-lines plate", () => {
  const timeline = timelineFor([
    { atMs: 0, text: "作曲：测试作曲" },
    { atMs: 1_000, text: "编曲：测试编曲" },
    { atMs: 2_000, text: "間奏" },
  ]);

  assert.equal(timeline.renderPolicy, "static");
  assert.equal(timeline.analysis.fallbackReason, "no-valid-lines");
  assert.equal(timeline.analysis.ignoredLineCount, 3);
});

test("translation-primary estimates from the line window without borrowing original units", () => {
  const source = exactLine(1_000, "君の声");
  source.translation = "你的声音";
  const timeline = timelineFor([source], false);

  assert.equal(timeline.renderPolicy, "estimated");
  assert.equal(timeline.analysis.fallbackReason, "translation-primary");
  assert.equal(timeline.analysis.rejections[0].reason, "translation-primary");
  const frame = timeline.derive(1_200, { historyLimit: 5 });
  assert.equal(frame.timingMode, "word-estimated");
  assert.deepEqual(
    frame.currentTokens.map(({ text }) => text),
    ["你", "的", "声", "音"],
  );
});

test("more than one hundred real tokens remain exact", () => {
  const text = "あ".repeat(128);
  const timeline = timelineFor([exactLine(1_000, text, 40)]);
  const frame = timeline.derive(2_000, { historyLimit: 5 });

  assert.equal(timeline.renderPolicy, "exact");
  assert.equal(frame.currentTokens.length, 128);
  assert.equal(frame.compactedTokens, false);
  assert.equal(
    timeline.derive(2_000, { historyLimit: 14 }).currentTokens.length,
    128,
  );
});

test("one provider phrase becomes ordered display units without losing exact bounds", () => {
  const timeline = timelineFor([{
    atMs: 1_000,
    endAtMs: 2_200,
    text: "君の声",
    words: [{ text: "君の声", atMs: 1_000, durationMs: 1_200 }],
  }]);
  const frame = timeline.derive(1_400, { historyLimit: 5 });

  assert.equal(frame.lineRenderPolicy, "exact");
  assert.deepEqual(
    frame.currentTokens.map(({ text }) => text),
    ["君", "の", "声"],
  );
  assert.equal(frame.currentTokens[0].startMs, 1_000);
  assert.equal(frame.currentTokens.at(-1)!.endMs, 2_200);
});

test("non-uniform real token times drive state and seek reconstruction", () => {
  const timeline = timelineFor([
    {
      atMs: 1_000,
      text: "ABC",
      words: [
        { text: "A", atMs: 1_000, durationMs: 120 },
        { text: "B", atMs: 2_000, durationMs: 400 },
        { text: "C", atMs: 3_700, durationMs: 160 },
      ],
    },
  ]);

  assert.deepEqual(
    timeline.derive(1_500, { historyLimit: 5 }).currentTokens.map(({ state }) => state),
    ["imprinted", "future", "future"],
  );
  const duringB = timeline.derive(2_050, { historyLimit: 5 }).currentTokens;
  assert.equal(duringB[1].state, "imprinting");
  assert.ok(duringB[1].progress > 0 && duringB[1].progress < 1);
  assert.equal(
    timeline.derive(2_500, { historyLimit: 5 }).currentTokens[1].state,
    "imprinted",
  );
  assert.equal(
    timeline.derive(1_500, { historyLimit: 5 }).currentTokens[1].state,
    "future",
  );
});

test("provider line duration creates a real gap without exposing the next row", () => {
  const first = exactLine(1_000, "第一句");
  first.durationMs = 900;
  first.endAtMs = 1_900;
  const timeline = timelineFor([
    first,
    exactLine(5_000, "第二句"),
  ]);

  const gap = timeline.derive(2_500, { historyLimit: 5 });
  assert.equal(gap.activeLine, undefined);
  assert.equal(gap.upcomingLineIndex, 1);
  assert.equal(gap.history.at(-1)?.line.text, "第一句");
  assert.equal(gap.history.at(-1)?.line.endMs, 1_900);
});

test("canonical lyric owner remains the only current line through a long gap", () => {
  const first = exactLine(1_000, "第一句");
  first.durationMs = 900;
  first.endAtMs = 1_900;
  const timeline = timelineFor([
    first,
    exactLine(5_000, "第二句"),
  ]);

  const canonicalGap = timeline.derive(
    2_500,
    { historyLimit: 5 },
    0,
  );
  assert.equal(canonicalGap.activeLineIndex, 0);
  assert.equal(canonicalGap.activeLine?.text, "第一句");
  assert.equal(
    canonicalGap.history.some(({ line }) => line.text === "第一句"),
    false,
  );

  const beforeFirstLine = timeline.derive(
    500,
    { historyLimit: 5 },
    -1,
  );
  assert.equal(beforeFirstLine.activeLine, undefined);
  assert.equal(beforeFirstLine.activeLineIndex, -1);
});

test("a long intro has registration time but no active lyric", () => {
  const timeline = timelineFor([exactLine(9_000, "前奏之后才出现")]);
  const intro = timeline.derive(7_000, { historyLimit: 5 });

  assert.equal(timeline.firstLineStartMs, 9_000);
  assert.equal(intro.activeLine, undefined);
  assert.equal(intro.history.length, 0);
  assert.equal(intro.upcomingLineIndex, 0);
});

test("empty, failed, loading and invalid lyric sets use static", () => {
  assert.equal(timelineFor([], true, "loading").renderPolicy, "static");
  assert.equal(timelineFor([], true, "empty").renderPolicy, "static");
  assert.equal(timelineFor([], true, "error").renderPolicy, "static");
  assert.equal(
    timelineFor([{ atMs: Number.NaN, text: "invalid" }]).renderPolicy,
    "static",
  );
});

test("strict timing validator reports structured rejection reasons", () => {
  const base: ImprintLine = {
    id: "line",
    sourceIndex: 0,
    text: "AB",
    startMs: 1_000,
    endMs: 2_000,
    role: "sung",
    timingMode: "word-estimated",
    timingSource: "estimated",
    fallbackReason: "missing",
  };
  assert.equal(getWordTimingRejection(base), "missing");
  assert.equal(getWordTimingRejection({
    ...base,
    words: [{ id: "a", text: "AC", startMs: 1_000, endMs: 1_200 }],
  }), "text-mismatch");
  assert.equal(getWordTimingRejection({
    ...base,
    words: [
      { id: "a", text: "A", startMs: 1_000, endMs: 1_600 },
      { id: "b", text: "B", startMs: 1_500, endMs: 1_800 },
    ],
  }), "overlap");
  assert.equal(getWordTimingRejection({
    ...base,
    words: [
      { id: "a", text: "A", startMs: 1_600, endMs: 1_700 },
      { id: "b", text: "B", startMs: 1_400, endMs: 1_500 },
    ],
  }), "non-monotonic");
  assert.equal(getWordTimingRejection({
    ...base,
    words: [
      { id: "a", text: "A", startMs: 900, endMs: 1_100 },
      { id: "b", text: "B", startMs: 1_100, endMs: 1_300 },
    ],
  }), "out-of-line-range");
});

test("safe Unicode normalization retains the original printed glyph slices", () => {
  const words = [
    { id: "a", text: "A", startMs: 1_000, endMs: 1_200 },
    { id: "b", text: "B", startMs: 1_200, endMs: 1_400 },
  ];
  assert.deepEqual(alignImprintWordText("ＡＢ", words), ["Ａ", "Ｂ"]);
  assert.deepEqual(
    alignImprintWordText("Hello， world!", [
      { text: "Hello" },
      { text: "world" },
    ]),
    ["Hello", "， world!"],
  );
});

test("very short line-only timing still keeps separate display units", () => {
  const track = makeTrack([
    { atMs: 1_000, endAtMs: 1_006, text: "短句测试" },
  ]);
  const timeline = new ImprintTimeline(
    adaptAuralTrackToImprint(track, track.durationMs, true, "ready"),
  );
  const frame = timeline.derive(1_001, { historyLimit: 14 });
  assert.equal(frame.lineRenderPolicy, "estimated");
  assert.deepEqual(
    frame.currentTokens.map(({ text }) => text),
    ["短", "句", "测", "试"],
  );
});

test("history derives the requested stable capacity and repeat metadata", () => {
  const lines = Array.from({ length: 24 }, (_, index) => ({
    atMs: index * 400,
    endAtMs: index * 400 + 300,
    text: index === 3 || index === 18 ? "副歌再来" : `历史歌词${index}`,
  }));
  const timeline = timelineFor(lines);
  const frame = timeline.derive(11_000, { historyLimit: 18 });
  assert.equal(frame.history.length, 18);
  const repeatCopies = frame.history.filter(({ repeatKey }) => repeatKey === "副歌再来");
  assert.equal(repeatCopies.at(-1)?.copyNumber, 2);
  assert.equal(repeatCopies.at(-1)?.templateLineIndex, 3);
});

test("an asynchronous ready policy commits only at the next line boundary", () => {
  clearImprintPolicySessionsForTests();
  const loadingTrack = adaptAuralTrackToImprint(
    makeTrack([]),
    12_000,
    true,
    "loading",
  );
  const readyTrack = adaptAuralTrackToImprint(
    makeTrack([
      exactLine(1_000, "第一句"),
      exactLine(4_000, "第二句"),
      exactLine(7_000, "第三句"),
    ]),
    12_000,
    true,
    "ready",
  );
  const loading = createImprintPolicyPlan(loadingTrack, "loading");
  const ready = createImprintPolicyPlan(readyTrack, "ready");

  assert.equal(
    stageImprintPolicyPlan("session", loading, 2_000).timeline.renderPolicy,
    "static",
  );
  assert.equal(
    stageImprintPolicyPlan("session", ready, 2_000).timeline.renderPolicy,
    "static",
  );
  assert.equal(
    commitPendingImprintPolicyPlan("session", 3_900, 3_800),
    undefined,
  );
  assert.equal(
    commitPendingImprintPolicyPlan("session", 4_000, 3_900)?.timeline.renderPolicy,
    "exact",
  );
});

test("a compositor pause and a seek within the active line keep the pending policy", () => {
  clearImprintPolicySessionsForTests();
  const loading = createImprintPolicyPlan(
    adaptAuralTrackToImprint(makeTrack([]), 12_000, true, "loading"),
    "loading",
  );
  const ready = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        exactLine(1_000, "第一句"),
        exactLine(5_000, "第二句"),
      ]),
      12_000,
      true,
      "ready",
    ),
    "ready",
  );
  stageImprintPolicyPlan("seek-session", loading, 2_000);
  stageImprintPolicyPlan("seek-session", ready, 2_000);

  assert.equal(
    commitPendingImprintPolicyPlan("seek-session", 3_500, 2_000),
    undefined,
  );
  assert.equal(
    commitPendingImprintPolicyPlan("seek-session", 3_500, 2_000, true)
      ?.timeline.renderPolicy,
    undefined,
  );
  assert.equal(
    commitPendingImprintPolicyPlan("seek-session", 5_500, 3_500, true)
      ?.timeline.renderPolicy,
    "exact",
  );
});

test("a remounted Space 04 commits a pending plan after its safe boundary", () => {
  clearImprintPolicySessionsForTests();
  const loading = createImprintPolicyPlan(
    adaptAuralTrackToImprint(makeTrack([]), 12_000, true, "loading"),
    "loading",
  );
  const ready = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        exactLine(1_000, "第一句"),
        exactLine(4_000, "第二句"),
      ]),
      12_000,
      true,
      "ready",
    ),
    "ready",
  );

  stageImprintPolicyPlan("remount-session", loading, 2_000);
  assert.equal(
    stageImprintPolicyPlan("remount-session", ready, 2_000).timeline.renderPolicy,
    "static",
  );

  // Space 04 is absent while playback crosses 4s. Staging the same candidate
  // on remount must recover the exact plan without a fresh visual handoff.
  assert.equal(
    stageImprintPolicyPlan("remount-session", ready, 4_500).timeline.renderPolicy,
    "exact",
  );
});

test("a ready lyric revision keeps the committed line as the safe boundary", () => {
  clearImprintPolicySessionsForTests();
  const committed = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        exactLine(1_000, "旧第一句"),
        exactLine(5_000, "旧第二句"),
      ]),
      12_000,
      true,
      "ready",
    ),
    "old-ready",
  );
  const candidate = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        exactLine(1_000, "新第一句"),
        exactLine(3_000, "新第二句"),
      ]),
      12_000,
      true,
      "ready",
    ),
    "new-ready",
  );

  stageImprintPolicyPlan("revision-session", committed, 2_000);
  stageImprintPolicyPlan("revision-session", candidate, 2_000);
  assert.equal(
    commitPendingImprintPolicyPlan("revision-session", 3_100, 2_900),
    undefined,
  );
  assert.equal(
    commitPendingImprintPolicyPlan("revision-session", 5_000, 4_900)
      ?.fingerprint,
    "new-ready",
  );
});

test("line-only to exact data waits for a safe row boundary", () => {
  clearImprintPolicySessionsForTests();
  const lineOnly = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        { atMs: 1_000, text: "第一句" },
        { atMs: 5_000, text: "第二句" },
      ]),
      12_000,
      true,
      "ready",
    ),
    "line-only",
  );
  const exact = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        exactLine(1_000, "第一句"),
        exactLine(5_000, "第二句"),
      ]),
      12_000,
      true,
      "ready",
    ),
    "exact",
  );

  stageImprintPolicyPlan("precision-session", lineOnly, 2_000);
  assert.equal(
    stageImprintPolicyPlan("precision-session", exact, 2_000).timeline.renderPolicy,
    "estimated",
  );
  assert.equal(
    commitPendingImprintPolicyPlan("precision-session", 4_900, 4_800),
    undefined,
  );
  assert.equal(
    commitPendingImprintPolicyPlan("precision-session", 5_000, 4_900)
      ?.timeline.renderPolicy,
    "exact",
  );
});

test("out-of-order line-only data cannot replace exact timing", () => {
  clearImprintPolicySessionsForTests();
  const lineOnly = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        { atMs: 1_000, text: "第一句" },
        { atMs: 5_000, text: "第二句" },
      ]),
      12_000,
      true,
      "ready",
    ),
    "line-only",
  );
  const exact = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([
        exactLine(1_000, "第一句"),
        exactLine(5_000, "第二句"),
      ]),
      12_000,
      true,
      "ready",
    ),
    "exact",
  );

  stageImprintPolicyPlan("monotonic-session", lineOnly, 2_000);
  stageImprintPolicyPlan("monotonic-session", exact, 2_000);
  assert.equal(
    stageImprintPolicyPlan("monotonic-session", lineOnly, 2_100).timeline.renderPolicy,
    "estimated",
  );
  assert.equal(
    commitPendingImprintPolicyPlan("monotonic-session", 5_000, 4_900)
      ?.timeline.renderPolicy,
    "exact",
  );
  assert.equal(
    stageImprintPolicyPlan("monotonic-session", lineOnly, 5_100).timeline.renderPolicy,
    "exact",
  );
});

test("restart commits pending lyrics and a new session never inherits them", () => {
  clearImprintPolicySessionsForTests();
  const loading = createImprintPolicyPlan(
    adaptAuralTrackToImprint(makeTrack([]), 12_000, true, "loading"),
    "loading",
  );
  const ready = createImprintPolicyPlan(
    adaptAuralTrackToImprint(
      makeTrack([exactLine(1_000, "第一句"), exactLine(5_000, "第二句")]),
      12_000,
      true,
      "ready",
    ),
    "ready",
  );

  stageImprintPolicyPlan("old-session", loading, 2_000);
  stageImprintPolicyPlan("old-session", ready, 2_000);
  assert.equal(
    commitPendingImprintPolicyPlan("old-session", 0, 2_000)
      ?.timeline.renderPolicy,
    "exact",
  );
  assert.equal(
    stageImprintPolicyPlan("new-session", loading, 2_000).timeline.renderPolicy,
    "static",
  );
});
