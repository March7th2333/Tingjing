import type {
  LyricDiagnostics,
  LyricLine,
  Lyrics,
  LyricTimingQuality,
  LyricTimingSource,
  NormalizedLyricDocument,
  NormalizedLyricLine,
  NormalizedLyricWord,
  WordTimingRejection,
} from "../../types/music";

export interface NormalizeLyricsOptions {
  provider: string;
  trackId: string;
  durationMs: number;
  lyrics: Lyrics;
  source?: LyricTimingSource;
}

const minimumLineDurationMs = 240;
const defaultLastLineDurationMs = 4_000;

export interface LyricTextUnit {
  text: string;
  unit: "character" | "word" | "space";
}

function lyricGraphemes(value: string) {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
      ({ segment }) => segment,
    );
  }
  return Array.from(value);
}

const latinLyricGrapheme = /^[\p{Script=Latin}\p{N}\p{M}]+$/u;
const lyricWordJoiner = /^[\u0027\u2019\-‐‑]$/u;

/**
 * Stable display segmentation only; this never assigns timing. Latin text is
 * grouped by word while CJK, emoji and punctuation retain grapheme boundaries.
 */
export function segmentLyricText(value: string): LyricTextUnit[] {
  const units: LyricTextUnit[] = [];
  let latinWord = "";
  let whitespace = "";

  const flushWord = () => {
    if (!latinWord) return;
    units.push({ text: latinWord, unit: "word" });
    latinWord = "";
  };
  const flushWhitespace = () => {
    if (!whitespace) return;
    units.push({ text: whitespace, unit: "space" });
    whitespace = "";
  };

  for (const grapheme of lyricGraphemes(value)) {
    if (/^\s+$/u.test(grapheme)) {
      flushWord();
      whitespace += grapheme;
      continue;
    }
    if (
      latinLyricGrapheme.test(grapheme)
      || (latinWord && lyricWordJoiner.test(grapheme))
    ) {
      flushWhitespace();
      latinWord += grapheme;
      continue;
    }
    flushWord();
    flushWhitespace();
    units.push({ text: grapheme, unit: "character" });
  }

  flushWord();
  flushWhitespace();
  return units;
}

function comparableText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, "\"")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function lineEndFromProvider(line: LyricLine) {
  if (Number.isFinite(line.endAtMs) && (line.endAtMs ?? 0) > line.atMs) {
    return line.endAtMs as number;
  }
  if (Number.isFinite(line.durationMs) && (line.durationMs ?? 0) > 0) {
    return line.atMs + (line.durationMs as number);
  }
  return undefined;
}

function incrementReason(
  reasons: Partial<Record<WordTimingRejection, number>>,
  reason: WordTimingRejection,
) {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function normalizeWords(
  line: LyricLine,
  rawLineEndMs: number,
): { words?: NormalizedLyricWord[]; rejection?: WordTimingRejection } {
  const words = line.words;
  if (!words?.length) {
    return { rejection: line.wordTimingRejection ?? "missing" };
  }
  if (words.some((word) =>
    !Number.isFinite(word.atMs)
    || !Number.isFinite(word.durationMs)
    || word.durationMs <= 0
  )) {
    return { rejection: "invalid-duration" };
  }
  if (words.some((word, index) =>
    index > 0 && word.atMs < words[index - 1].atMs
  )) {
    return { rejection: "non-monotonic" };
  }
  if (words.some((word, index) =>
    index > 0
    && word.atMs < words[index - 1].atMs
      + words[index - 1].durationMs
  )) {
    return { rejection: "overlap" };
  }
  if (words.some((word) =>
    word.atMs < line.atMs
    || word.atMs + word.durationMs > rawLineEndMs
  )) {
    return { rejection: "out-of-line-range" };
  }
  if (
    comparableText(words.map((word) => word.text).join(""))
    !== comparableText(line.text)
  ) {
    return { rejection: "text-mismatch" };
  }

  return {
    words: words.map((word) => ({
      ...word,
      startTimeMs: word.atMs,
      endTimeMs: word.atMs + word.durationMs,
      rawStartTimeMs: word.atMs,
      rawEndTimeMs: word.atMs + word.durationMs,
    })),
  };
}

function timingQuality(
  source: LyricTimingSource,
  validLineCount: number,
  wordTimedLineCount: number,
): LyricTimingQuality {
  if (validLineCount === 0 || source === "none") {
    return "unavailable";
  }
  if (wordTimedLineCount === validLineCount) {
    return "word-exact";
  }
  if (wordTimedLineCount > 0) {
    return "aligned";
  }
  return source === "manual" ? "estimated" : "line-only";
}

export function normalizeLyricDocument({
  provider,
  trackId,
  durationMs,
  lyrics,
  source: sourceOverride,
}: NormalizeLyricsOptions): NormalizedLyricDocument {
  const source = sourceOverride ?? lyrics.source ?? "provider";
  const indexedLines = lyrics.lines
    .map((line, sourceIndex) => ({ line, sourceIndex }))
    .filter(({ line }) => line.text.trim().length > 0)
    .sort((left, right) =>
      left.line.atMs - right.line.atMs
      || left.sourceIndex - right.sourceIndex
    );
  const invalidLineReasons: string[] = [];
  const rejectedWordTimingReasons: Partial<
    Record<WordTimingRejection, number>
  > = {};

  lyrics.lines.forEach((line, sourceIndex) => {
    const previous = lyrics.lines[sourceIndex - 1];
    if (
      previous
      && Number.isFinite(previous.atMs)
      && Number.isFinite(line.atMs)
      && line.atMs < previous.atMs
    ) {
      invalidLineReasons.push(`line-${sourceIndex}:non-monotonic`);
    }
  });

  const lines = indexedLines.flatMap<NormalizedLyricLine>(
    ({ line, sourceIndex }, index) => {
      if (!Number.isFinite(line.atMs) || line.atMs < 0) {
        invalidLineReasons.push(`line-${sourceIndex}:invalid-start`);
        return [];
      }
      if (durationMs > 0 && line.atMs >= durationMs) {
        invalidLineReasons.push(`line-${sourceIndex}:out-of-track-range`);
        return [];
      }

      const nextStartMs = indexedLines
        .slice(index + 1)
        .find((candidate) => candidate.line.atMs > line.atMs)
        ?.line.atMs;
      const providerEndMs = lineEndFromProvider(line);
      const fallbackEndMs = nextStartMs
        ?? (durationMs > line.atMs
          ? durationMs
          : line.atMs + defaultLastLineDurationMs);
      const unclampedEndTimeMs = Math.max(
        line.atMs + minimumLineDurationMs,
        providerEndMs ?? fallbackEndMs,
      );
      if (nextStartMs !== undefined && unclampedEndTimeMs > nextStartMs) {
        invalidLineReasons.push(`line-${sourceIndex}:overlap`);
      }
      const trackBoundaryMs = durationMs > line.atMs
        ? durationMs
        : Number.POSITIVE_INFINITY;
      const nextBoundaryMs = nextStartMs ?? Number.POSITIVE_INFINITY;
      const rawEndTimeMs = Math.max(
        line.atMs + 1,
        Math.min(unclampedEndTimeMs, nextBoundaryMs, trackBoundaryMs),
      );
      const renderEndTimeMs = Math.max(
        rawEndTimeMs,
        Math.min(nextStartMs ?? rawEndTimeMs, trackBoundaryMs),
      );
      const normalizedWords = normalizeWords(line, rawEndTimeMs);
      if (normalizedWords.rejection) {
        incrementReason(
          rejectedWordTimingReasons,
          normalizedWords.rejection,
        );
      }

      return [{
        ...line,
        id: `${provider}:${trackId}:${line.atMs}:${sourceIndex}`,
        atMs: line.atMs,
        durationMs: rawEndTimeMs - line.atMs,
        endAtMs: rawEndTimeMs,
        startTimeMs: line.atMs,
        endTimeMs: rawEndTimeMs,
        renderEndTimeMs,
        rawStartTimeMs: line.atMs,
        rawEndTimeMs,
        words: normalizedWords.words,
        wordTimingRejection: normalizedWords.words
          ? undefined
          : normalizedWords.rejection,
      }];
    },
  );
  const wordTimedLineCount = lines.filter((line) => line.words?.length).length;
  const quality = timingQuality(source, lines.length, wordTimedLineCount);
  const providerWordTimingAvailable = lyrics.lines.some(
    (line) => Boolean(line.words?.length),
  );
  const diagnostics: LyricDiagnostics = {
    provider,
    source,
    timingQuality: quality,
    sourceLineCount: lyrics.lines.length,
    validLineCount: lines.length,
    wordTimedLineCount,
    providerWordTimingAvailable,
    providerWordTimingUsed: providerWordTimingAvailable
      && wordTimedLineCount > 0,
    rejectedWordTimingReasons,
    invalidLineReasons,
  };

  return {
    trackKey: `${provider}:${trackId}`,
    provider,
    source,
    timingQuality: quality,
    offsetMs: 0,
    lines,
    diagnostics,
  };
}

export function createUnavailableLyricDocument(
  provider: string,
  trackId: string,
): NormalizedLyricDocument {
  return normalizeLyricDocument({
    provider,
    trackId,
    durationMs: 0,
    lyrics: {
      trackId,
      lines: [],
      hasTranslation: false,
      source: "none",
    },
    source: "none",
  });
}

export function applyLyricOffset(
  document: NormalizedLyricDocument,
  offsetMs: number,
): NormalizedLyricDocument {
  const safeOffset = Number.isFinite(offsetMs) ? Math.round(offsetMs) : 0;
  if (document.offsetMs === safeOffset) {
    return document;
  }

  const lines = document.lines.map<NormalizedLyricLine>((line) => {
    const startTimeMs = Math.max(0, line.rawStartTimeMs + safeOffset);
    const endTimeMs = Math.max(
      startTimeMs + minimumLineDurationMs,
      line.rawEndTimeMs + safeOffset,
    );
    const renderEndTimeMs = Math.max(
      endTimeMs,
      line.renderEndTimeMs - document.offsetMs + safeOffset,
    );
    const words = line.words?.map<NormalizedLyricWord>((word) => {
      const wordStart = Math.max(0, word.rawStartTimeMs + safeOffset);
      const wordEnd = Math.max(wordStart + 1, word.rawEndTimeMs + safeOffset);
      return {
        ...word,
        atMs: wordStart,
        durationMs: wordEnd - wordStart,
        startTimeMs: wordStart,
        endTimeMs: wordEnd,
      };
    });

    return {
      ...line,
      atMs: startTimeMs,
      durationMs: endTimeMs - startTimeMs,
      endAtMs: endTimeMs,
      startTimeMs,
      endTimeMs,
      renderEndTimeMs,
      words,
    };
  });

  return { ...document, offsetMs: safeOffset, lines };
}

export function getNormalizedLyricIndex(
  document: NormalizedLyricDocument,
  elapsedMs: number,
) {
  if (document.lines.length === 0 || elapsedMs < document.lines[0].startTimeMs) {
    return -1;
  }

  let low = 0;
  let high = document.lines.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (document.lines[middle].startTimeMs <= elapsedMs) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

export function getNormalizedLyricWordIndex(
  document: NormalizedLyricDocument,
  lineIndex: number,
  elapsedMs: number,
) {
  const words = document.lines[lineIndex]?.words;
  if (!words?.length || elapsedMs < words[0].startTimeMs) {
    return -1;
  }
  let result = 0;
  for (let index = 0; index < words.length; index += 1) {
    if (words[index].startTimeMs > elapsedMs) {
      break;
    }
    result = index;
  }
  return result;
}
