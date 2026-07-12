import type {
  LyricLine,
  LyricWordTiming,
  WordTimingRejection,
} from "../types/music";

export interface ParsedWordSyncedLine {
  atMs: number;
  durationMs?: number;
  text: string;
  words?: LyricWordTiming[];
  wordTimingRejection?: WordTimingRejection;
}

type WordMarker = {
  atMs: number;
  durationMs: number;
};

const linePattern = /^\[(\d+),(\d+)(?:,\d+)?\](.*)$/u;
const wordPattern = /\((-?\d+),(\d+)(?:,\d+)?\)/gu;

/**
 * Normalizes only differences that cannot change the lyric's meaning. This is
 * deliberately not fuzzy matching: punctuation is retained and characters
 * are never inserted, removed or transliterated.
 */
export function normalizeWordTimingMatchText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, "\"")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    // Spaces between CJK glyphs are a harmless layout difference. Latin word
    // boundaries are semantic, so they must remain intact (for example,
    // "the rapist" must never match "therapist").
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu,
      "$1",
    )
    .trim();
}

function splitMarkedContent(content: string) {
  const matches = Array.from(content.matchAll(wordPattern));
  const segments: string[] = [];
  let cursor = 0;

  for (const match of matches) {
    const start = match.index ?? cursor;
    segments.push(content.slice(cursor, start));
    cursor = start + match[0].length;
  }
  segments.push(content.slice(cursor));

  return {
    markers: matches.map<WordMarker>((match) => ({
      atMs: Number(match[1]),
      durationMs: Number(match[2]),
    })),
    segments,
  };
}

function timingCandidateScore(
  timings: readonly LyricWordTiming[],
  lineAtMs: number,
  lineDurationMs: number,
) {
  if (timings.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const lineEndMs = lineAtMs + Math.max(1, lineDurationMs);
  let penalty = Math.abs(timings[0].atMs - lineAtMs);
  for (let index = 0; index < timings.length; index += 1) {
    const timing = timings[index];
    if (
      !Number.isFinite(timing.atMs)
      || !Number.isFinite(timing.durationMs)
      || timing.durationMs <= 0
    ) {
      return Number.POSITIVE_INFINITY;
    }
    if (timing.atMs < lineAtMs - 80) {
      penalty += (lineAtMs - timing.atMs) * 8;
    }
    if (index > 0 && timing.atMs < timings[index - 1].atMs) {
      penalty += (timings[index - 1].atMs - timing.atMs + 1) * 16;
    }
    const overflow = timing.atMs + timing.durationMs - lineEndMs;
    if (overflow > Math.max(500, lineDurationMs * 0.3)) {
      penalty += overflow * 4;
    }
  }
  return penalty;
}

function materializeWordTimes(
  markers: readonly WordMarker[],
  lineAtMs: number,
  lineDurationMs: number,
) {
  const build = (relative: boolean) => markers.map<LyricWordTiming>((marker) => ({
    text: "",
    atMs: relative ? lineAtMs + marker.atMs : marker.atMs,
    durationMs: marker.durationMs,
  }));
  const absolute = build(false);
  const relative = build(true);
  return timingCandidateScore(relative, lineAtMs, lineDurationMs)
    < timingCandidateScore(absolute, lineAtMs, lineDurationMs)
    ? relative
    : absolute;
}

function buildTextCandidate(
  direction: "prefix" | "postfix",
  segments: readonly string[],
  timings: readonly LyricWordTiming[],
) {
  const words = timings.map((timing, index) => ({
    text: segments[direction === "postfix" ? index : index + 1] ?? "",
    atMs: timing.atMs,
    durationMs: timing.durationMs,
  }));
  return words.every((word) => word.text.length > 0) ? words : undefined;
}

function candidateRejection(
  words: readonly LyricWordTiming[] | undefined,
  text: string,
): WordTimingRejection | undefined {
  if (!words?.length) {
    return "provider-match-failed";
  }
  if (words.some((word) => !Number.isFinite(word.durationMs) || word.durationMs <= 0)) {
    return "invalid-duration";
  }
  if (words.some((word, index) => index > 0 && word.atMs < words[index - 1].atMs)) {
    return "non-monotonic";
  }
  return normalizeWordTimingMatchText(words.map((word) => word.text).join(""))
    === normalizeWordTimingMatchText(text)
    ? undefined
    : "text-mismatch";
}

function parseMarkedLine(
  atMs: number,
  durationMs: number,
  content: string,
): ParsedWordSyncedLine | undefined {
  const { markers, segments } = splitMarkedContent(content);
  const text = segments.join("").trim();
  if (!text) {
    return undefined;
  }
  if (markers.length === 0) {
    return {
      atMs,
      durationMs,
      text,
      wordTimingRejection: "missing",
    };
  }

  const timings = materializeWordTimes(markers, atMs, durationMs);
  const prefix = buildTextCandidate("prefix", segments, timings);
  const postfix = buildTextCandidate("postfix", segments, timings);
  const prefixRejection = candidateRejection(prefix, text);
  const postfixRejection = candidateRejection(postfix, text);
  const prefixValid = prefixRejection === undefined;
  const postfixValid = postfixRejection === undefined;

  let words: LyricWordTiming[] | undefined;
  if (prefixValid !== postfixValid) {
    words = prefixValid ? prefix : postfix;
  } else if (prefixValid && postfixValid) {
    const leadingText = normalizeWordTimingMatchText(segments[0] ?? "");
    const trailingText = normalizeWordTimingMatchText(segments.at(-1) ?? "");
    if (leadingText && !trailingText) {
      words = postfix;
    } else if (!leadingText && trailingText) {
      words = prefix;
    }
  }

  return {
    atMs,
    durationMs,
    text,
    words,
    wordTimingRejection: words
      ? undefined
      : prefixRejection === "invalid-duration" || postfixRejection === "invalid-duration"
        ? "invalid-duration"
        : prefixRejection === "non-monotonic" || postfixRejection === "non-monotonic"
          ? "non-monotonic"
          : prefixRejection === "text-mismatch" || postfixRejection === "text-mismatch"
            ? "text-mismatch"
            : "provider-match-failed",
  };
}

export function parseBracketWordSyncedLyrics(value: string) {
  const result: ParsedWordSyncedLine[] = [];
  for (const row of value.split(/\r?\n/u)) {
    const match = linePattern.exec(row.trim());
    if (!match) {
      continue;
    }
    const line = parseMarkedLine(Number(match[1]), Number(match[2]), match[3]);
    if (line) {
      result.push(line);
    }
  }
  return result.sort((left, right) => left.atMs - right.atMs);
}

function validWordsForText(words: LyricWordTiming[] | undefined, text: string) {
  return candidateRejection(words, text) === undefined;
}

function sourceLineTiming(line: ParsedWordSyncedLine) {
  if (
    !Number.isFinite(line.durationMs)
    || (line.durationMs ?? 0) <= 0
  ) {
    return {};
  }
  const durationMs = line.durationMs as number;
  return {
    durationMs,
    endAtMs: line.atMs + durationMs,
  };
}

/**
 * Keeps the complete line-timed source as the primary lyric and attaches word
 * timing only on a strict normalized-text and local-time match.
 */
export function mergeTimedLinesWithWordTimings(
  original: readonly ParsedWordSyncedLine[],
  wordSynced: readonly ParsedWordSyncedLine[],
): LyricLine[] {
  if (original.length === 0) {
    return wordSynced.map((line) => ({
      atMs: line.atMs,
      ...sourceLineTiming(line),
      text: line.text,
      words: validWordsForText(line.words, line.text) ? line.words : undefined,
      wordTimingRejection: validWordsForText(line.words, line.text)
        ? undefined
        : line.wordTimingRejection ?? "provider-match-failed",
    }));
  }

  const used = new Set<number>();
  return original.map<LyricLine>((line, lineIndex) => {
    const nextAtMs = original[lineIndex + 1]?.atMs;
    const localWindow = nextAtMs
      ? Math.min(1_000, Math.max(280, (nextAtMs - line.atMs) * 0.35))
      : 700;
    const candidates = wordSynced.map((candidate, index) => ({ candidate, index }));
    const match = candidates
      .filter(({ candidate, index }) =>
        !used.has(index)
        && normalizeWordTimingMatchText(candidate.text)
          === normalizeWordTimingMatchText(line.text)
        && Math.abs(candidate.atMs - line.atMs) <= localWindow)
      .sort((left, right) =>
        Math.abs(left.candidate.atMs - line.atMs)
        - Math.abs(right.candidate.atMs - line.atMs))[0];

    if (match && validWordsForText(match.candidate.words, line.text)) {
      used.add(match.index);
      return {
        atMs: line.atMs,
        ...sourceLineTiming(match.candidate),
        text: line.text,
        words: match.candidate.words,
      };
    }

    const sameTimeDifferentText = candidates.some(({ candidate, index }) =>
      !used.has(index)
      && Math.abs(candidate.atMs - line.atMs) <= localWindow
      && normalizeWordTimingMatchText(candidate.text)
        !== normalizeWordTimingMatchText(line.text));
    return {
      atMs: line.atMs,
      ...(match ? sourceLineTiming(match.candidate) : {}),
      text: line.text,
      words: undefined,
      wordTimingRejection: wordSynced.length === 0
        ? "missing"
        : match?.candidate.wordTimingRejection
          ?? (sameTimeDifferentText ? "text-mismatch" : "provider-match-failed"),
    };
  });
}
