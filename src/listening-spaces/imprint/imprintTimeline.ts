import type {
  LyricsStatus,
  LyricLine as AuralLyricLine,
  Track as AuralTrack,
  WordTimingRejection,
} from "../../types/music";
import {
  distributeLyricUnits,
  estimateLineLyricUnits,
} from "../../features/lyrics/LyricUnitTiming.ts";

export type ImprintTimingMode = "word-exact" | "word-estimated" | "static-fallback";
export type ImprintRenderPolicy = "exact" | "adaptive" | "estimated" | "static";
export type ImprintLineTimingPolicy = "word-exact" | "word-estimated" | "static";
export type ImprintTimingSource = "provider" | "estimated" | "static";
export type ImprintLineRole = "sung" | "metadata" | "instrumental";
export type ImprintLineFallbackReason = WordTimingRejection | "none" | "non-sung";
export type ImprintFallbackReason =
  | "none"
  | "lyrics-loading"
  | "lyrics-error"
  | "lyrics-empty"
  | "no-valid-lines"
  | "partial-word-coverage"
  | "translation-primary";

export interface ImprintWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  timingSource: Exclude<ImprintTimingSource, "static">;
}

export interface ImprintLine {
  id: string;
  sourceIndex: number;
  text: string;
  translation?: string;
  startMs: number;
  endMs: number;
  words?: ImprintWord[];
  role: ImprintLineRole;
  timingMode: ImprintLineTimingPolicy;
  timingSource: ImprintTimingSource;
  fallbackReason: ImprintLineFallbackReason;
  wordTimingRejection?: WordTimingRejection;
}

export interface ImprintTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  coverImage?: string;
  lyrics: ImprintLine[];
  lyricsStatus: LyricsStatus;
  translationPrimary: boolean;
}

export interface ImprintPolicyAnalysis {
  renderPolicy: ImprintRenderPolicy;
  exactLineCount: number;
  lineOnlyCount: number;
  estimatedLineCount: number;
  ignoredLineCount: number;
  wordCoverage: number;
  fallbackReason: ImprintFallbackReason;
  rejections: ReadonlyArray<{
    lineId: string;
    sourceIndex: number;
    reason: WordTimingRejection;
  }>;
}

export interface ImprintTokenFrame {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  progress: number;
  state: "future" | "imprinting" | "imprinted";
  timingSource: Exclude<ImprintTimingSource, "static">;
}

export interface ImprintHistoryItem {
  id: string;
  line: ImprintLine;
  copyNumber: number;
  repeatKey: string;
  templateLineIndex: number;
}

export interface ImprintProofLayer {
  id: string;
  number: number;
  depth: number;
}

export interface ImprintFrame {
  elapsedMs: number;
  activeLineIndex: number;
  activeLine?: ImprintLine;
  upcomingLineIndex: number;
  timingMode: ImprintTimingMode;
  trackTimingMode: ImprintTimingMode;
  renderPolicy: ImprintRenderPolicy;
  lineRenderPolicy: Exclude<ImprintRenderPolicy, "adaptive">;
  currentTokens: ImprintTokenFrame[];
  compactedTokens: boolean;
  history: ImprintHistoryItem[];
  proofLayers: ImprintProofLayer[];
  currentCopyNumber: number;
  imprintCount: number;
}

export interface ImprintLimits {
  historyLimit: number;
}

interface OrderedLine {
  line: ImprintLine;
  lineIndex: number;
  timingMode: ImprintLineTimingPolicy;
}

interface RepeatOccurrence {
  key: string;
  templateLineIndex: number;
  copyNumber: number;
}

const punctuation = /\p{P}/gu;
const repeatedWhitespace = /\s+/gu;
const instrumentalPattern = /^(?:纯音乐|无歌词|暂无歌词|instrumental|music|interlude|intro|outro|間奏|间奏|前奏|尾奏)$/iu;
const creditPrefixPattern = /^(?:作词|词|填词|作曲|曲|编曲|制作人|制作|监制|混音|母带|录音|和声|演唱|歌手|吉他|贝斯|鼓|弦乐|键盘|配唱|统筹|出品|发行|lyricist|lyrics|composer|arranger|producer|mix(?:ing)?|master(?:ing)?|vocal|guitar|bass|drums?|strings?)\s*[:：]/iu;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeForTimingComparison(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, "\"")
    .toLocaleLowerCase("en-US")
    .replace(repeatedWhitespace, " ")
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu,
      "$1",
    )
    .trim();
}

function normalizeForTimingAlignment(value: string) {
  return normalizeForTimingComparison(value).replace(/[\s\p{P}\p{S}]/gu, "");
}

export function alignImprintWordText(
  lineText: string,
  words: readonly Pick<ImprintWord, "text">[],
) {
  const lineComparable = normalizeForTimingAlignment(lineText);
  const wordComparable = normalizeForTimingAlignment(
    words.map((word) => word.text).join(""),
  );
  if (!lineComparable || lineComparable !== wordComparable) return undefined;

  const slices: string[] = [];
  let cursor = 0;

  for (const word of words) {
    const target = normalizeForTimingAlignment(word.text);
    if (!target) {
      slices.push("");
      continue;
    }

    let end = cursor;
    let matchedEnd = -1;
    while (end < lineText.length) {
      const codePoint = lineText.codePointAt(end);
      end += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
      const candidate = normalizeForTimingAlignment(
        lineText.slice(cursor, end),
      );
      if (candidate === target) {
        matchedEnd = end;
        break;
      }
      if (
        candidate.length > target.length
        || (candidate.length >= target.length && !target.startsWith(candidate))
      ) {
        break;
      }
    }

    if (matchedEnd < 0) return undefined;
    slices.push(lineText.slice(cursor, matchedEnd));
    cursor = matchedEnd;
  }

  if (cursor < lineText.length && slices.length > 0) {
    let lastVisibleSlice = slices.length - 1;
    while (lastVisibleSlice > 0 && !slices[lastVisibleSlice]) {
      lastVisibleSlice -= 1;
    }
    slices[lastVisibleSlice] += lineText.slice(cursor);
  }
  return slices;
}

export function normalizeForRepeatKey(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(punctuation, "")
    .replace(repeatedWhitespace, " ")
    .trim();
}

function classifyLineRole(
  text: string,
  trackTitle: string,
  trackArtist: string,
): ImprintLineRole {
  const trimmed = text.normalize("NFKC").trim();
  if (instrumentalPattern.test(trimmed)) {
    return "instrumental";
  }
  if (
    creditPrefixPattern.test(trimmed)
    || /^[:：]/u.test(trimmed)
  ) {
    return "metadata";
  }

  const normalizedText = normalizeForTimingComparison(trimmed);
  const normalizedTitle = normalizeForTimingComparison(trackTitle);
  const normalizedArtist = normalizeForTimingComparison(trackArtist);
  if (
    normalizedArtist.length >= 3
    && normalizedText.includes(normalizedArtist)
    && (
      normalizedTitle.length === 0
      || normalizedText.includes(normalizedTitle)
      || /\s[-—–]\s/u.test(trimmed)
    )
  ) {
    return "metadata";
  }
  return "sung";
}

export function getWordTimingRejection(
  line: ImprintLine,
): WordTimingRejection | undefined {
  const normalizedLine = normalizeForTimingAlignment(line.text);
  const normalizedWords = normalizeForTimingAlignment(
    line.words?.map((word) => word.text).join("") ?? "",
  );

  if (
    line.wordTimingRejection
    && line.wordTimingRejection !== "missing"
    && line.wordTimingRejection !== "text-mismatch"
    && line.wordTimingRejection !== "provider-match-failed"
  ) {
    return line.wordTimingRejection;
  }
  if (!line.words?.length) {
    return "missing";
  }
  if (normalizedWords !== normalizedLine) {
    return "text-mismatch";
  }
  if (!alignImprintWordText(line.text, line.words)) {
    return "text-mismatch";
  }
  if (
    !Number.isFinite(line.startMs)
    || !Number.isFinite(line.endMs)
    || line.endMs <= line.startMs
  ) {
    return "invalid-duration";
  }

  let previousStart = Number.NEGATIVE_INFINITY;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const word of line.words) {
    if (
      !word.text.trim()
      || !Number.isFinite(word.startMs)
      || !Number.isFinite(word.endMs)
      || word.endMs <= word.startMs
    ) {
      return "invalid-duration";
    }
    if (word.startMs < line.startMs || word.endMs > line.endMs) {
      return "out-of-line-range";
    }
    if (word.startMs < previousStart) {
      return "non-monotonic";
    }
    if (word.startMs < previousEnd) {
      return "overlap";
    }
    previousStart = word.startMs;
    previousEnd = word.endMs;
  }

  return undefined;
}

function resolveLineTimingMode(line: ImprintLine): ImprintLineTimingPolicy {
  if (!normalizeForTimingComparison(line.text)) {
    return "static";
  }
  return line.timingMode;
}

function findNextStart(
  lines: Array<{ source: AuralLyricLine; sourceIndex: number }>,
  position: number,
  currentStart: number,
) {
  for (let index = position + 1; index < lines.length; index += 1) {
    const candidate = lines[index].source.atMs;
    if (Number.isFinite(candidate) && candidate > currentStart) {
      return candidate;
    }
  }
  return undefined;
}

export function adaptAuralTrackToImprint(
  track: AuralTrack,
  playbackDurationMs: number,
  showOriginalLyrics: boolean,
  lyricsStatus: LyricsStatus,
): ImprintTrack {
  const durationMs = Math.max(
    1,
    Number.isFinite(playbackDurationMs) && playbackDurationMs > 0
      ? playbackDurationMs
      : track.durationMs,
  );
  const sourceLines = lyricsStatus === "ready" ? track.lyrics : [];
  const orderedSource = sourceLines
    .map((source, sourceIndex) => ({ source, sourceIndex }))
    .filter(({ source }) => Number.isFinite(source.atMs) && source.atMs >= 0)
    .sort(
      (left, right) =>
        left.source.atMs - right.source.atMs
        || left.sourceIndex - right.sourceIndex,
    );

  const lyrics = orderedSource.map(({ source, sourceIndex }, position) => {
    const startMs = source.atMs;
    const nextStart = findNextStart(orderedSource, position, startMs);
    const providerEndMs = Number.isFinite(source.endAtMs)
      && (source.endAtMs ?? 0) > startMs
      ? source.endAtMs
      : Number.isFinite(source.durationMs)
          && (source.durationMs ?? 0) > 0
        ? startMs + (source.durationMs ?? 0)
        : undefined;
    const endMs = Math.max(
      startMs + 1,
      Math.min(
        providerEndMs ?? nextStart ?? Math.max(durationMs, startMs + 1),
        nextStart ?? Math.max(durationMs, startMs + 1),
      ),
    );
    const useTranslationAsPrimary =
      !showOriginalLyrics && Boolean(source.translation);
    const text = useTranslationAsPrimary
      ? source.translation ?? source.text
      : source.text;
    const lineId = `${track.id}:line:${sourceIndex}`;
    const providerWords = useTranslationAsPrimary
      ? undefined
      : source.words?.flatMap((word, wordIndex) =>
          distributeLyricUnits(
            word.text,
            word.atMs,
            word.atMs + word.durationMs,
          )
            .filter(({ unit }) => unit !== "space")
            .map((unit, unitIndex) => ({
              id: `${lineId}:word:${wordIndex}:unit:${unitIndex}`,
              text: unit.text,
              startMs: unit.startMs,
              endMs: unit.endMs,
              timingSource: "provider" as const,
            }))
        );

    const role = classifyLineRole(source.text, track.title, track.artist);
    const wordTimingRejection = useTranslationAsPrimary
      ? "translation-primary"
      : source.wordTimingRejection;
    const provisionalLine = {
      id: lineId,
      sourceIndex,
      text,
      translation: showOriginalLyrics ? source.translation : undefined,
      startMs,
      endMs,
      words: providerWords,
      role,
      timingMode: "static",
      timingSource: "static",
      fallbackReason: role === "sung" ? "missing" : "non-sung",
      wordTimingRejection,
    } satisfies ImprintLine;
    const rejection = role === "sung"
      ? getWordTimingRejection(provisionalLine)
      : undefined;
    const timingMode: ImprintLineTimingPolicy = role !== "sung"
      ? "static"
      : rejection
        ? "word-estimated"
        : "word-exact";
    const words = timingMode === "word-exact"
      ? providerWords
      : timingMode === "word-estimated"
        ? estimateLineLyricUnits(text, startMs, endMs)
            .filter(({ unit }) => unit !== "space")
            .map((unit, unitIndex) => ({
              id: `${lineId}:estimated:${unitIndex}`,
              text: unit.text,
              startMs: unit.startMs,
              endMs: unit.endMs,
              timingSource: "estimated" as const,
            }))
        : undefined;
    return {
      ...provisionalLine,
      words,
      timingMode,
      timingSource: timingMode === "word-exact"
        ? "provider"
        : timingMode === "word-estimated"
          ? "estimated"
          : "static",
      fallbackReason: role !== "sung" ? "non-sung" : rejection ?? "none",
    } satisfies ImprintLine;
  });

  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs,
    coverImage: track.coverImage,
    lyrics,
    lyricsStatus,
    translationPrimary: lyrics.some(
      ({ wordTimingRejection }) => wordTimingRejection === "translation-primary",
    ),
  };
}

function binaryCandidateIndex(ordered: readonly OrderedLine[], elapsedMs: number) {
  let low = 0;
  let high = ordered.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ordered[middle].line.startMs <= elapsedMs) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate;
}

function createRepeatIndex(lines: readonly ImprintLine[]) {
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const key = normalizeForRepeatKey(line.text);
    if (!key) return;
    const indexes = groups.get(key) ?? [];
    indexes.push(index);
    groups.set(key, indexes);
  });

  const occurrences = new Map<number, RepeatOccurrence>();
  groups.forEach((indexes, key) => {
    if (indexes.length < 2) return;
    indexes.forEach((lineIndex, copyIndex) => {
      occurrences.set(lineIndex, {
        key,
        templateLineIndex: indexes[0],
        copyNumber: copyIndex + 1,
      });
    });
  });
  return occurrences;
}

function pressDurationMs(
  startMs: number,
  endMs: number,
  timingSource: Exclude<ImprintTimingSource, "static">,
) {
  const availableMs = Math.max(1, endMs - startMs);
  const minimumMs = timingSource === "provider" ? 120 : 48;
  return Math.min(
    availableMs,
    clamp(availableMs * 0.72, minimumMs, timingSource === "provider" ? 280 : 240),
  );
}

function createToken(
  id: string,
  text: string,
  startMs: number,
  endMs: number,
  elapsedMs: number,
  timingSource: Exclude<ImprintTimingSource, "static">,
): ImprintTokenFrame {
  const progress = clamp(
    (elapsedMs - startMs) / pressDurationMs(startMs, endMs, timingSource),
    0,
    1,
  );
  return {
    id,
    text,
    startMs,
    endMs,
    progress,
    state:
      elapsedMs < startMs
        ? "future"
        : progress < 1
          ? "imprinting"
          : "imprinted",
    timingSource,
  };
}

function createProofLayers(completedCount: number): ImprintProofLayer[] {
  const pageCount = Math.ceil(completedCount / 5);
  const firstPage = Math.max(1, pageCount - 2);
  return Array.from(
    { length: Math.min(3, pageCount) },
    (_, index) => ({
      id: `imprint-proof-${firstPage + index}`,
      number: firstPage + index,
      depth: -(Math.min(3, pageCount) - index) * 28,
    }),
  );
}

export class ImprintTimeline {
  readonly analysis: ImprintPolicyAnalysis;
  readonly renderPolicy: ImprintRenderPolicy;
  readonly trackTimingMode: ImprintTimingMode;
  readonly firstLineStartMs?: number;
  private readonly track: ImprintTrack;
  private readonly ordered: OrderedLine[];
  private readonly repeats: ReadonlyMap<number, RepeatOccurrence>;

  constructor(track: ImprintTrack) {
    this.track = track;
    this.ordered = track.lyrics
      .map((line, lineIndex) => ({
        line,
        lineIndex,
        timingMode: resolveLineTimingMode(line),
      }))
      .filter(
        ({ line }) =>
          line.role === "sung"
          && Boolean(normalizeForTimingComparison(line.text)),
      )
      .sort(
        (left, right) =>
          left.line.startMs - right.line.startMs
          || left.lineIndex - right.lineIndex,
      );
    const exactLineCount = this.ordered.filter(
      ({ timingMode }) => timingMode === "word-exact",
    ).length;
    const estimatedLineCount = this.ordered.filter(
      ({ timingMode }) => timingMode === "word-estimated",
    ).length;
    const lineOnlyCount = this.ordered.filter(
      ({ timingMode }) => timingMode === "static",
    ).length;
    const rejections = this.ordered.flatMap(({ line }) => {
      const reason = getWordTimingRejection(line);
      return reason
        ? [{ lineId: line.id, sourceIndex: line.sourceIndex, reason }]
        : [];
    });
    const fallbackReason: ImprintFallbackReason =
      track.lyricsStatus === "loading"
        ? "lyrics-loading"
        : track.lyricsStatus === "error"
          ? "lyrics-error"
          : track.lyricsStatus === "empty"
            ? "lyrics-empty"
            : this.ordered.length === 0
              ? "no-valid-lines"
              : estimatedLineCount === 0
                ? "none"
                : rejections.some(({ reason }) => reason === "translation-primary")
                  ? "translation-primary"
                  : "partial-word-coverage";
    this.renderPolicy = fallbackReason === "lyrics-loading"
      || fallbackReason === "lyrics-error"
      || fallbackReason === "lyrics-empty"
      || fallbackReason === "no-valid-lines"
      ? "static"
      : exactLineCount > 0 && estimatedLineCount > 0
        ? "adaptive"
      : exactLineCount > 0
        ? "exact"
        : estimatedLineCount > 0
          ? "estimated"
        : "static";
    this.trackTimingMode = estimatedLineCount > 0
      ? "word-estimated"
      : exactLineCount > 0
        ? "word-exact"
        : "static-fallback";
    this.analysis = {
      renderPolicy: this.renderPolicy,
      exactLineCount,
      lineOnlyCount,
      estimatedLineCount,
      ignoredLineCount: Math.max(0, track.lyrics.length - this.ordered.length),
      wordCoverage: this.ordered.length > 0
        ? exactLineCount / this.ordered.length
        : 0,
      fallbackReason,
      rejections,
    };
    this.repeats = createRepeatIndex(track.lyrics);
    this.firstLineStartMs = this.ordered[0]?.line.startMs;
  }

  findActiveLineIndex(elapsedMs: number) {
    const candidate = binaryCandidateIndex(this.ordered, elapsedMs);
    if (candidate < 0 || elapsedMs >= this.ordered[candidate].line.endMs) {
      return -1;
    }
    return this.ordered[candidate].lineIndex;
  }

  derive(
    elapsedMs: number,
    limits: ImprintLimits,
    canonicalActiveLineIndex?: number,
  ): ImprintFrame {
    const safeElapsedMs = clamp(
      Number.isFinite(elapsedMs) ? elapsedMs : 0,
      0,
      this.track.durationMs,
    );
    const candidatePosition = binaryCandidateIndex(this.ordered, safeElapsedMs);
    const canonicalPosition = canonicalActiveLineIndex === undefined
      ? -1
      : this.ordered.findIndex(
          ({ line }) => line.sourceIndex === canonicalActiveLineIndex,
        );
    const activePosition = canonicalActiveLineIndex === undefined
      ? (
          candidatePosition >= 0
          && safeElapsedMs < this.ordered[candidatePosition].line.endMs
            ? candidatePosition
            : -1
        )
      : canonicalPosition;
    const activeRecord = activePosition >= 0
      ? this.ordered[activePosition]
      : undefined;
    const upcomingRecord = activePosition >= 0
      ? this.ordered[activePosition + 1]
      : this.ordered.find(({ line }) => line.startMs > safeElapsedMs);
    const completed = this.ordered.filter(
      (record) =>
        record !== activeRecord
        && record.line.endMs <= safeElapsedMs,
    );
    const history = completed
      .slice(-Math.max(0, limits.historyLimit))
      .map((record): ImprintHistoryItem => {
        const repeat = this.repeats.get(record.lineIndex);
        return {
          id: `imprint-history-${record.line.id}`,
          line: record.line,
          copyNumber: repeat?.copyNumber ?? 1,
          repeatKey:
            repeat?.key ?? normalizeForRepeatKey(record.line.text),
          templateLineIndex:
            repeat?.templateLineIndex ?? record.lineIndex,
        };
      });
    const currentTokens =
      activeRecord
      && activeRecord.timingMode !== "static"
      && activeRecord.line.words
        ? activeRecord.line.words.map((word) =>
            createToken(
              word.id,
              word.text,
              word.startMs,
              word.endMs,
              safeElapsedMs,
              word.timingSource,
            ))
        : [];
    const activeRepeat = activeRecord
      ? this.repeats.get(activeRecord.lineIndex)
      : undefined;
    let imprintCount = 0;
    for (const record of this.ordered) {
      if (record.line.startMs > safeElapsedMs) break;
      if (
        record.timingMode !== "static"
        && record.line.words
      ) {
        imprintCount += record.line.words.filter(
          ({ startMs }) => startMs <= safeElapsedMs,
        ).length;
      } else {
        imprintCount += 1;
      }
    }

    return {
      elapsedMs: safeElapsedMs,
      activeLineIndex: activeRecord?.line.sourceIndex ?? -1,
      activeLine: activeRecord?.line,
      upcomingLineIndex: upcomingRecord?.line.sourceIndex ?? -1,
      timingMode: activeRecord?.timingMode === "static"
        ? "static-fallback"
        : activeRecord?.timingMode ?? "static-fallback",
      trackTimingMode: this.trackTimingMode,
      renderPolicy: this.renderPolicy,
      lineRenderPolicy: activeRecord?.timingMode === "word-exact"
        ? "exact"
        : activeRecord?.timingMode === "word-estimated"
          ? "estimated"
          : "static",
      currentTokens,
      compactedTokens: false,
      history,
      proofLayers: createProofLayers(completed.length),
      currentCopyNumber: activeRepeat?.copyNumber ?? (activeRecord ? 1 : 0),
      imprintCount,
    };
  }
}
