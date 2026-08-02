import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { CSSProperties } from "react";
import { motionController } from "../../config/MotionController";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import {
  distributeLyricUnits,
  estimateLineLyricUnits,
} from "../lyrics/LyricUnitTiming.ts";
import { segmentLyricText } from "../lyrics/LyricTruth";
import type { LyricLine, LyricWordTiming } from "../../types/music";
import { motionTokens } from "./motionTokens";

export type LyricCharacterState = "future" | "current" | "past";

export interface LyricCharacter {
  char: string;
  revealTime: number;
  state: LyricCharacterState;
  duration: number;
  progress: number;
  opacity: number;
  blur: number;
  scale: number;
  unit: "character" | "word" | "space";
}

export type LyricLanguage = "ja" | "zh-CN" | "en";

export type LyricRevealSource =
  | "word-synced"
  | "enhanced-synced"
  | "line-estimated";

export interface LyricRevealPlan {
  timeline: LyricCharacter[];
  source: LyricRevealSource;
  reliableEndTime: number;
}

type RevealProperty =
  | "--lyric-reveal-progress"
  | "--lyric-reveal-opacity"
  | "--lyric-reveal-blur"
  | "--lyric-reveal-scale"
  | "--lyric-reveal-depth"
  | "--lyric-reveal-brightness";

type RevealStyle = CSSProperties & Record<RevealProperty, string>;

const revealProperties: RevealProperty[] = [
  "--lyric-reveal-progress",
  "--lyric-reveal-opacity",
  "--lyric-reveal-blur",
  "--lyric-reveal-scale",
  "--lyric-reveal-depth",
  "--lyric-reveal-brightness",
];

interface LyricRevealEngineProps {
  line: LyricLine;
  nextLine?: LyricLine;
  lineEndMs?: number;
  text: string;
  elapsedMs: number;
  isPlaying: boolean;
  active?: boolean;
  lang: LyricLanguage;
  className?: string;
  columnCount?: 1 | 2;
  lineState?: LyricCharacterState;
  variant?: "standard" | "flow" | "scroll";
}

interface IndexedLyricCharacter {
  segment: LyricCharacter;
  index: number;
}

const latinWordPattern = /^[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*$/u;
const latinCharacterPattern = /[A-Za-z]/u;
const japaneseCharacterPattern = /[\u3040-\u30ff]/u;
const readableCharacterPattern = /[\p{L}\p{N}]/u;

export function detectLyricLanguage(text: string): LyricLanguage {
  const readableCharacters = Array.from(text.normalize("NFKC")).filter(
    (character) => readableCharacterPattern.test(character),
  );
  const latinCharacters = readableCharacters.filter((character) =>
    latinCharacterPattern.test(character)
  );

  if (
    readableCharacters.length > 0
    && latinCharacters.length / readableCharacters.length >= 0.55
  ) {
    return "en";
  }

  if (japaneseCharacterPattern.test(text)) {
    return "ja";
  }

  return "zh-CN";
}

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothStep(value: number) {
  const progress = clamp(value);
  return progress * progress * (3 - 2 * progress);
}

function normalizeText(text: string) {
  return text.replace(/\s+/gu, "").trim();
}

function normalizeComparableText(text: string) {
  return Array.from(text.normalize("NFKC").toLocaleLowerCase())
    .filter((character) => !/[\p{P}\p{S}\s]/u.test(character))
    .join("");
}

function getSequenceSimilarity(left: string, right: string) {
  const leftUnits = Array.from(left);
  const rightUnits = Array.from(right);
  if (leftUnits.length === 0 || rightUnits.length === 0) {
    return 0;
  }

  const previous = new Uint16Array(rightUnits.length + 1);
  const current = new Uint16Array(rightUnits.length + 1);
  for (const leftUnit of leftUnits) {
    current.fill(0);
    for (let rightIndex = 0; rightIndex < rightUnits.length; rightIndex += 1) {
      current[rightIndex + 1] = leftUnit === rightUnits[rightIndex]
        ? previous[rightIndex] + 1
        : Math.max(previous[rightIndex + 1], current[rightIndex]);
    }
    previous.set(current);
  }

  return previous[rightUnits.length]
    / Math.max(leftUnits.length, rightUnits.length);
}

function tokenize(text: string) {
  return segmentLyricText(text).map(({ text: unitText }) => unitText);
}

function getUnit(token: string): LyricCharacter["unit"] {
  if (/^\s+$/u.test(token)) {
    return "space";
  }
  return latinWordPattern.test(token) ? "word" : "character";
}

function createCharacter(
  char: string,
  revealTime: number,
  duration: number,
): LyricCharacter {
  return {
    char,
    revealTime,
    state: "future",
    duration,
    progress: 0,
    opacity: 0.25,
    blur: 6,
    scale: 0.98,
    unit: getUnit(char),
  };
}

function expandWord(word: LyricWordTiming): LyricCharacter[] {
  return distributeLyricUnits(
    word.text,
    word.atMs,
    word.atMs + word.durationMs,
  ).map((unit) => createCharacter(
    unit.text,
    unit.startMs,
    Math.max(1, unit.endMs - unit.startMs),
  ));
}

function alignTimedSegments(
  text: string,
  timedSegments: LyricCharacter[],
) {
  const sourceTokens = tokenize(text);
  const timedVisible = timedSegments.filter(
    (segment) => segment.unit !== "space",
  );
  const sourceVisible = sourceTokens.filter(
    (token) => !/^\s+$/u.test(token),
  );

  if (
    sourceVisible.length !== timedVisible.length
    || sourceVisible.some(
      (token, index) =>
        normalizeText(token)
        !== normalizeText(timedVisible[index]?.char ?? ""),
    )
  ) {
    return timedSegments;
  }

  let timedIndex = 0;
  let previousTime = timedVisible[0]?.revealTime ?? 0;

  return sourceTokens.map((token): LyricCharacter => {
    if (/^\s+$/u.test(token)) {
      return createCharacter(token, previousTime, 0);
    }

    const timed = timedVisible[timedIndex];
    timedIndex += 1;
    previousTime = timed.revealTime + timed.duration;

    return { ...timed, char: token, unit: getUnit(token) };
  });
}

function looselyAlignTimedSegments(
  text: string,
  timedSegments: LyricCharacter[],
) {
  const comparableSource = normalizeComparableText(text);
  const comparableTimed = normalizeComparableText(
    timedSegments.map((segment) => segment.char).join(""),
  );
  const similarity = getSequenceSimilarity(
    comparableSource,
    comparableTimed,
  );
  const coverage = Math.min(
    comparableSource.length,
    comparableTimed.length,
  ) / Math.max(1, comparableSource.length, comparableTimed.length);
  if (similarity < 0.78 || coverage < 0.62) {
    return null;
  }

  const timedVisible = timedSegments
    .map((segment) => ({
      segment,
      weight: Array.from(normalizeComparableText(segment.char)).length,
    }))
    .filter(({ weight }) => weight > 0);
  const targetWeight = timedVisible.reduce(
    (total, item) => total + item.weight,
    0,
  );
  if (targetWeight <= 0) {
    return null;
  }

  const getTimeAtWeight = (target: number, preferNext = false) => {
    const clampedTarget = clamp(target, 0, targetWeight);
    let consumed = 0;
    for (const item of timedVisible) {
      const itemEnd = consumed + item.weight;
      if (
        clampedTarget < itemEnd
        || (!preferNext && clampedTarget <= itemEnd)
      ) {
        const progress = (clampedTarget - consumed) / item.weight;
        return item.segment.revealTime
          + item.segment.duration * clamp(progress);
      }
      consumed = itemEnd;
    }

    const finalSegment = timedVisible[timedVisible.length - 1].segment;
    return finalSegment.revealTime + finalSegment.duration;
  };

  const sourceTokens = tokenize(text);
  const sourceWeights = sourceTokens.map((token) =>
    Array.from(normalizeComparableText(token)).length
  );
  const sourceWeight = Math.max(
    1,
    sourceWeights.reduce((total, weight) => total + weight, 0),
  );
  let consumedSourceWeight = 0;
  let previousTime = timedVisible[0].segment.revealTime;

  return sourceTokens.map((token, index) => {
    const weight = sourceWeights[index];
    if (weight <= 0) {
      return createCharacter(token, previousTime, 80);
    }

    const startWeight = consumedSourceWeight / sourceWeight * targetWeight;
    consumedSourceWeight += weight;
    const endWeight = consumedSourceWeight / sourceWeight * targetWeight;
    const revealTime = getTimeAtWeight(startWeight, true);
    const revealEnd = getTimeAtWeight(endWeight);
    previousTime = revealEnd;
    return createCharacter(
      token,
      revealTime,
      Math.max(80, revealEnd - revealTime),
    );
  });
}

function createFallbackTimeline(
  line: LyricLine,
  nextLine: LyricLine | undefined,
  text: string,
) {
  const lineBoundary = line.endAtMs
    ?? (line.durationMs ? line.atMs + line.durationMs : undefined)
    ?? nextLine?.atMs
    ?? line.atMs + 4_200;
  const availableMs = Math.max(1, lineBoundary - line.atMs);
  return estimateLineLyricUnits(
    text,
    line.atMs,
    line.atMs + availableMs,
  ).map((unit) => createCharacter(
    unit.text,
    unit.startMs,
    Math.min(
      Math.max(80, unit.endMs - unit.startMs),
      motionTokens.lyricRevealDuration,
    ),
  ));
}

function getLineBoundary(
  line: LyricLine,
  nextLine: LyricLine | undefined,
) {
  const providerBoundary = line.endAtMs
    ?? (line.durationMs ? line.atMs + line.durationMs : undefined);
  return Math.max(
    line.atMs + 1,
    Math.min(
      providerBoundary ?? nextLine?.atMs ?? line.atMs + 4_200,
      nextLine?.atMs ?? Number.POSITIVE_INFINITY,
    ),
  );
}

function getReliableTimelineEnd(
  line: LyricLine,
  nextLine: LyricLine | undefined,
  timeline: LyricCharacter[],
) {
  const timelineEnd = timeline.reduce(
    (latest, segment) =>
      Math.max(latest, segment.revealTime + segment.duration),
    line.atMs,
  );
  const nextBoundary = nextLine?.atMs ?? Number.POSITIVE_INFINITY;
  return Math.max(
    line.atMs + 1,
    Math.min(nextBoundary, timelineEnd),
  );
}

export function createLyricRevealPlan(
  line: LyricLine,
  nextLine: LyricLine | undefined,
  text: string,
): LyricRevealPlan {
  const timedSegments = (line.words ?? []).flatMap(expandWord);
  const timedText = timedSegments
    .map((segment) => segment.char)
    .join("");

  if (
    timedSegments.length > 0
    && normalizeText(timedText) === normalizeText(text)
  ) {
    const timeline = alignTimedSegments(text, timedSegments);
    return {
      timeline,
      source: "word-synced",
      reliableEndTime: getReliableTimelineEnd(line, nextLine, timeline),
    };
  }

  if (
    timedSegments.length > 0
    && normalizeComparableText(timedText)
      === normalizeComparableText(text)
  ) {
    const looselyAligned = looselyAlignTimedSegments(text, timedSegments);
    if (looselyAligned) {
      return {
        timeline: looselyAligned,
        source: "enhanced-synced",
        reliableEndTime: getReliableTimelineEnd(
          line,
          nextLine,
          looselyAligned,
        ),
      };
    }
  }

  const timeline = createFallbackTimeline(line, nextLine, text);
  return {
    timeline,
    source: "line-estimated",
    reliableEndTime: getLineBoundary(line, nextLine),
  };
}

export function createLyricRevealTimeline(
  line: LyricLine,
  nextLine: LyricLine | undefined,
  text: string,
) {
  return createLyricRevealPlan(line, nextLine, text).timeline;
}

function splitTimelineIntoColumns(
  timeline: LyricCharacter[],
  columnCount: 1 | 2,
): IndexedLyricCharacter[][] {
  const indexedTimeline = timeline.map((segment, index) => ({
    segment,
    index,
  }));
  if (columnCount === 1 || timeline.length < 2) {
    return [indexedTimeline];
  }

  const weights = timeline.map((segment) => {
    if (segment.unit === "space") {
      return 0.28;
    }
    return Math.max(1, Array.from(segment.char).length);
  });
  const targetWeight = weights.reduce(
    (total, weight) => total + weight,
    0,
  ) / 2;
  let accumulatedWeight = 0;
  let splitIndex = 1;

  for (let index = 0; index < weights.length - 1; index += 1) {
    accumulatedWeight += weights[index];
    splitIndex = index + 1;
    if (accumulatedWeight >= targetWeight) {
      break;
    }
  }

  while (
    splitIndex < indexedTimeline.length - 1
    && indexedTimeline[splitIndex]?.segment.unit === "space"
  ) {
    splitIndex += 1;
  }

  return [
    indexedTimeline.slice(0, splitIndex),
    indexedTimeline.slice(splitIndex),
  ];
}

function getProgress(
  startTime: number,
  duration: number,
  elapsedMs: number,
  active: boolean,
  reducedMotion: boolean,
) {
  if (!active || reducedMotion) {
    return 1;
  }

  return clamp(
    (elapsedMs - startTime)
    / Math.max(duration, motionTokens.lyricRevealDuration * 0.5),
  );
}

function getRevealStyle(progress: number): RevealStyle {
  return {
    "--lyric-reveal-progress": `${progress}`,
    "--lyric-reveal-opacity": `${0.06 + progress * 0.94}`,
    "--lyric-reveal-blur": `${
      (1 - progress) * motionTokens.lyricRevealBlurPx
    }px`,
    "--lyric-reveal-scale": `${
      motionTokens.lyricRevealScale
      + progress * (1 - motionTokens.lyricRevealScale)
    }`,
    "--lyric-reveal-depth": `${(1 - progress) * -18}px`,
    "--lyric-reveal-brightness": "1",
  };
}

function applyRevealStyle(element: HTMLElement, progress: number) {
  element.style.setProperty(
    "--lyric-reveal-progress",
    `${progress}`,
  );
  element.style.setProperty(
    "--lyric-reveal-opacity",
    `${0.06 + progress * 0.94}`,
  );
  element.style.setProperty(
    "--lyric-reveal-blur",
    `${(1 - progress) * motionTokens.lyricRevealBlurPx}px`,
  );
  element.style.setProperty(
    "--lyric-reveal-scale",
    `${
      motionTokens.lyricRevealScale
      + progress * (1 - motionTokens.lyricRevealScale)
    }`,
  );
  element.style.setProperty(
    "--lyric-reveal-depth",
    `${(1 - progress) * -18}px`,
  );
  element.style.setProperty("--lyric-reveal-brightness", "1");
}

function getCharacterAnimationDuration(duration: number) {
  return clamp(duration * 0.72, 200, 400);
}

function getCharacterState(
  revealTime: number,
  duration: number,
  elapsedMs: number,
  lineState: LyricCharacterState,
  reducedMotion: boolean,
) {
  if (lineState !== "current") {
    return { state: lineState, progress: lineState === "past" ? 1 : 0 };
  }

  if (reducedMotion) {
    return elapsedMs >= revealTime
      ? { state: "past" as const, progress: 1 }
      : { state: "future" as const, progress: 0 };
  }

  const progress = clamp(
    (elapsedMs - revealTime) / getCharacterAnimationDuration(duration),
  );

  if (progress <= 0) {
    return { state: "future" as const, progress: 0 };
  }
  if (progress >= 1) {
    return { state: "past" as const, progress: 1 };
  }
  return { state: "current" as const, progress };
}

interface FlowCharacterVisual {
  state: LyricCharacterState;
  progress: number;
  opacity: number;
  blur: number;
  scale: number;
}

function getFlowCharacterVisual(
  lineState: LyricCharacterState,
  revealTime: number,
  duration: number,
  elapsedMs: number,
  reducedMotion: boolean,
): FlowCharacterVisual {
  const timing = getCharacterState(
    revealTime,
    duration,
    elapsedMs,
    lineState,
    reducedMotion,
  );

  if (lineState === "past") {
    return {
      state: "past",
      progress: 1,
      opacity: 0.4,
      blur: 0,
      scale: 1,
    };
  }

  if (lineState === "future" || timing.progress <= 0) {
    return {
      state: "future",
      progress: 0,
      opacity: 0.25,
      blur: 6,
      scale: 0.98,
    };
  }

  const focusProgress = smoothStep(timing.progress);
  const scale =
    focusProgress < 0.68
      ? 0.98 + (1.05 - 0.98) * (focusProgress / 0.68)
      : 1.05
        + (1 - 1.05) * ((focusProgress - 0.68) / 0.32);

  return {
    state: timing.state,
    progress: timing.progress,
    opacity: 0.25 + focusProgress * 0.75,
    blur: 6 * (1 - focusProgress),
    scale,
  };
}

function getFlowRevealStyle(
  visual: FlowCharacterVisual,
): RevealStyle {
  return {
    "--lyric-reveal-progress": `${visual.progress}`,
    "--lyric-reveal-opacity": `${visual.opacity}`,
    "--lyric-reveal-blur": `${visual.blur}px`,
    "--lyric-reveal-scale": `${visual.scale}`,
    "--lyric-reveal-depth": "0px",
    "--lyric-reveal-brightness": "1",
  };
}

function mixFlowVisual(
  current: FlowCharacterVisual,
  target: FlowCharacterVisual,
  amount: number,
): FlowCharacterVisual {
  const mix = (from: number, to: number) => from + (to - from) * amount;

  return {
    state: target.state,
    progress: mix(current.progress, target.progress),
    opacity: mix(current.opacity, target.opacity),
    blur: mix(current.blur, target.blur),
    scale: mix(current.scale, target.scale),
  };
}

function flowVisualDistance(
  current: FlowCharacterVisual,
  target: FlowCharacterVisual,
) {
  return Math.max(
    Math.abs(current.opacity - target.opacity),
    Math.abs(current.blur - target.blur) / 6,
    Math.abs(current.scale - target.scale) * 12,
  );
}

function applyFlowCharacterVisual(
  element: HTMLElement,
  visual: FlowCharacterVisual,
  previous?: FlowCharacterVisual,
) {
  const style = getFlowRevealStyle(visual);
  const previousStyle = previous
    ? getFlowRevealStyle(previous)
    : undefined;

  if (!previous || previous.state !== visual.state) {
    element.dataset.characterState = visual.state;
  }
  revealProperties.forEach((property) => {
    const value = style[property];
    if (!previousStyle || previousStyle[property] !== value) {
      element.style.setProperty(property, value);
    }
  });
}

interface ScrollCharacterVisual {
  state: LyricCharacterState;
  colorState: "muted" | "primary" | "secondary";
  opacity: number;
  blur: number;
  scale: number;
  brightness: number;
  depth: number;
}

function getScrollCharacterVisual(
  lineState: LyricCharacterState,
  revealTime: number,
  duration: number,
  elapsedMs: number,
  reducedMotion: boolean,
): ScrollCharacterVisual {
  if (lineState === "future") {
    return {
      state: "future",
      colorState: "muted",
      opacity: 1,
      blur: 0,
      scale: 1,
      brightness: 1,
      depth: 0,
    };
  }

  if (lineState === "past") {
    return {
      state: "past",
      colorState: "secondary",
      opacity: 1,
      blur: 0,
      scale: 1,
      brightness: 1,
      depth: 0,
    };
  }

  const progress = reducedMotion
    ? Number(elapsedMs >= revealTime)
    : smoothStep(
        clamp(
          (elapsedMs - revealTime)
          / getCharacterAnimationDuration(duration),
        ),
      );

  return {
    state:
      progress <= 0
        ? "future"
        : progress >= 1
          ? "past"
          : "current",
    colorState: progress > 0 ? "primary" : "muted",
    opacity: 0.25 + progress * 0.75,
    blur: 6 * (1 - progress),
    scale: 0.98 + progress * 0.02,
    brightness: 0.76 + progress * 0.24,
    depth: -18 * (1 - progress),
  };
}

function getScrollLineState(
  playbackPosition: number,
  lineStartMs: number,
  lineEndMs: number,
): LyricCharacterState {
  if (playbackPosition < lineStartMs) {
    return "future";
  }
  if (playbackPosition < lineEndMs) {
    return "current";
  }
  return "past";
}

function getScrollUnitStyle(
  visual: ScrollCharacterVisual,
): CSSProperties {
  return {
    opacity: visual.opacity,
    filter: `blur(${visual.blur}px) brightness(${visual.brightness})`,
    transform: `translateZ(${visual.depth}px) scale(${visual.scale})`,
  };
}

function mixScrollVisual(
  current: ScrollCharacterVisual,
  target: ScrollCharacterVisual,
  amount: number,
): ScrollCharacterVisual {
  const mix = (from: number, to: number) => from + (to - from) * amount;
  return {
    state: target.state,
    colorState: target.colorState,
    opacity: mix(current.opacity, target.opacity),
    blur: mix(current.blur, target.blur),
    scale: mix(current.scale, target.scale),
    brightness: mix(current.brightness, target.brightness),
    depth: mix(current.depth, target.depth),
  };
}

function scrollVisualDistance(
  current: ScrollCharacterVisual,
  target: ScrollCharacterVisual,
) {
  return Math.max(
    Math.abs(current.opacity - target.opacity),
    Math.abs(current.blur - target.blur) / 6,
    Math.abs(current.scale - target.scale) * 10,
    Math.abs(current.brightness - target.brightness),
    Math.abs(current.depth - target.depth) / 18,
  );
}

function applyScrollCharacterVisual(
  element: HTMLElement,
  visual: ScrollCharacterVisual,
  previous?: ScrollCharacterVisual,
) {
  if (!previous || previous.state !== visual.state) {
    element.dataset.characterState = visual.state;
  }
  if (!previous || previous.colorState !== visual.colorState) {
    element.dataset.characterColor = visual.colorState;
  }

  const opacity = visual.opacity.toFixed(3);
  if (!previous || previous.opacity.toFixed(3) !== opacity) {
    element.style.opacity = opacity;
  }
  const filter = `blur(${visual.blur.toFixed(2)}px) `
    + `brightness(${visual.brightness.toFixed(3)})`;
  const previousFilter = previous
    ? `blur(${previous.blur.toFixed(2)}px) `
      + `brightness(${previous.brightness.toFixed(3)})`
    : "";
  if (!previous || previousFilter !== filter) {
    element.style.filter = filter;
  }
  const transform = `translateZ(${visual.depth.toFixed(2)}px) `
    + `scale(${visual.scale.toFixed(4)})`;
  const previousTransform = previous
    ? `translateZ(${previous.depth.toFixed(2)}px) `
      + `scale(${previous.scale.toFixed(4)})`
    : "";
  if (!previous || previousTransform !== transform) {
    element.style.transform = transform;
  }
}

export const LyricRevealEngine = memo(function LyricRevealEngine({
  line,
  nextLine,
  lineEndMs,
  text,
  elapsedMs,
  isPlaying,
  active = true,
  lang,
  className,
  columnCount = 1,
  lineState = "current",
  variant = "standard",
}: LyricRevealEngineProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef({
    elapsedMs,
    capturedAt: performance.now(),
  });
  const renderFrameRef = useRef<
    ((now: number, deltaMs?: number) => unknown) | null
  >(null);
  const restartAnimationRef = useRef<(() => void) | null>(null);
  const flowVisualsRef = useRef(
    new WeakMap<HTMLElement, FlowCharacterVisual>(),
  );
  const scrollVisualsRef = useRef(
    new WeakMap<HTMLElement, ScrollCharacterVisual>(),
  );
  const reducedMotion = useReducedMotion();
  const revealPlan = useMemo(
    () => createLyricRevealPlan(line, nextLine, text),
    [line, nextLine, text],
  );
  const timeline = revealPlan.timeline;
  const scrollColumns = useMemo(
    () => splitTimelineIntoColumns(
      timeline,
      variant === "scroll" ? columnCount : 1,
    ),
    [columnCount, timeline, variant],
  );
  const resolvedLineEndMs = Math.max(
    line.atMs + 1,
    lineEndMs ?? revealPlan.reliableEndTime,
  );

  useLayoutEffect(() => {
    clockRef.current = {
      elapsedMs,
      capturedAt: performance.now(),
    };
    const shouldAnimate = renderFrameRef.current?.(performance.now(), 0);
    if (shouldAnimate) {
      restartAnimationRef.current?.();
    }
  }, [elapsedMs]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const elements = Array.from(
      root.querySelectorAll<HTMLElement>("[data-reveal-start]"),
    );
    if (variant === "scroll") {
      const timedElements = elements.map((element) => ({
        element,
        startTime: Number(element.dataset.revealStart ?? 0),
        duration: Number(element.dataset.revealDuration ?? 1),
      }));
      let unsubscribe: (() => void) | null = null;
      let settledFrames = 0;
      let runtimeLineState = lineState;

      const renderScroll = (now: number, deltaMs = 16.67) => {
        const playbackPosition = isPlaying
          ? motionController.readPlaybackTime(now)
          : clockRef.current.elapsedMs;
        const nextRuntimeLineState = getScrollLineState(
          playbackPosition,
          line.atMs,
          resolvedLineEndMs,
        );
        if (nextRuntimeLineState !== runtimeLineState) {
          runtimeLineState = nextRuntimeLineState;
          root.dataset.lineState = runtimeLineState;
        }
        if (
          runtimeLineState === "future"
          && isPlaying
          && line.atMs - playbackPosition > 4_000
        ) {
          return true;
        }
        const damping =
          reducedMotion
            ? 1
            : 1 - Math.pow(0.76, Math.max(1, deltaMs) / 16.67);
        let maximumDistance = 0;
        let revealIsRunning = false;

        for (const timedElement of timedElements) {
          const target = getScrollCharacterVisual(
            runtimeLineState,
            timedElement.startTime,
            timedElement.duration,
            playbackPosition,
            reducedMotion,
          );
          const previous =
            scrollVisualsRef.current.get(timedElement.element) ?? target;
          const next = mixScrollVisual(previous, target, damping);
          const distance = scrollVisualDistance(next, target);
          maximumDistance = Math.max(maximumDistance, distance);
          revealIsRunning ||=
            (
              runtimeLineState === "current"
              || runtimeLineState === "future"
            )
            && isPlaying
            && (
              runtimeLineState === "future"
              || playbackPosition
                < timedElement.startTime
                  + getCharacterAnimationDuration(timedElement.duration)
            );

          applyScrollCharacterVisual(
            timedElement.element,
            next,
            scrollVisualsRef.current.get(timedElement.element),
          );
          scrollVisualsRef.current.set(timedElement.element, next);
        }

        if (maximumDistance < 0.003 && !revealIsRunning) {
          settledFrames += 1;
        } else {
          settledFrames = 0;
        }

        if (settledFrames >= 2) {
          const stop = unsubscribe;
          unsubscribe = null;
          stop?.();
        }

        return maximumDistance >= 0.003 || revealIsRunning;
      };

      const shouldAnimate = renderScroll(performance.now());
      renderFrameRef.current = renderScroll;
      const ensureAnimation = () => {
        if (unsubscribe === null) {
          unsubscribe = motionController.subscribeFrame(renderScroll);
        }
      };
      restartAnimationRef.current = ensureAnimation;
      if (shouldAnimate) {
        ensureAnimation();
      }
      return () => {
        if (renderFrameRef.current === renderScroll) {
          renderFrameRef.current = null;
        }
        if (restartAnimationRef.current === ensureAnimation) {
          restartAnimationRef.current = null;
        }
        const stop = unsubscribe;
        unsubscribe = null;
        stop?.();
      };
    }

    if (variant === "flow") {
      const timedElements = elements.map((element) => ({
        element,
        startTime: Number(element.dataset.revealStart ?? 0),
        duration: Number(element.dataset.revealDuration ?? 1),
      }));
      let unsubscribe: (() => void) | null = null;
      let settledFrames = 0;

      const renderFlow = (now: number, deltaMs = 16.67) => {
        const playbackPosition =
          clockRef.current.elapsedMs
          + (
            active && isPlaying && !reducedMotion
              ? now - clockRef.current.capturedAt
              : 0
          );
        const damping =
          reducedMotion
            ? 1
            : 1 - Math.pow(0.7, Math.max(1, deltaMs) / 16.67);
        let maximumDistance = 0;
        let revealIsRunning = false;

        for (const timedElement of timedElements) {
          const target = getFlowCharacterVisual(
            lineState,
            timedElement.startTime,
            timedElement.duration,
            playbackPosition,
            reducedMotion,
          );
          const previous =
            flowVisualsRef.current.get(timedElement.element) ?? target;
          const next = mixFlowVisual(previous, target, damping);
          maximumDistance = Math.max(
            maximumDistance,
            flowVisualDistance(next, target),
          );
          revealIsRunning ||=
            lineState === "current"
            && active
            && isPlaying
            && playbackPosition
              < timedElement.startTime
                + getCharacterAnimationDuration(timedElement.duration);

          applyFlowCharacterVisual(
            timedElement.element,
            next,
            flowVisualsRef.current.get(timedElement.element),
          );
          flowVisualsRef.current.set(timedElement.element, next);
        }

        if (maximumDistance < 0.003 && !revealIsRunning) {
          settledFrames += 1;
        } else {
          settledFrames = 0;
        }

        if (settledFrames >= 2) {
          const stop = unsubscribe;
          unsubscribe = null;
          stop?.();
        }

        return maximumDistance >= 0.003 || revealIsRunning;
      };

      const shouldAnimate = renderFlow(performance.now());
      renderFrameRef.current = renderFlow;
      const ensureAnimation = () => {
        if (!reducedMotion && unsubscribe === null) {
          unsubscribe = motionController.subscribeFrame(renderFlow);
        }
      };
      restartAnimationRef.current = ensureAnimation;
      if (shouldAnimate) {
        ensureAnimation();
      }
      return () => {
        if (renderFrameRef.current === renderFlow) {
          renderFrameRef.current = null;
        }
        if (restartAnimationRef.current === ensureAnimation) {
          restartAnimationRef.current = null;
        }
        const stop = unsubscribe;
        unsubscribe = null;
        stop?.();
      };
    }

    const render = (now = performance.now()) => {
      const playbackPosition =
        clockRef.current.elapsedMs
        + (
          active && isPlaying && !reducedMotion
            ? now - clockRef.current.capturedAt
            : 0
        );

      elements.forEach((element) => {
        const startTime = Number(element.dataset.revealStart ?? 0);
        const duration = Number(element.dataset.revealDuration ?? 1);
        const progress = getProgress(
          startTime,
          duration,
          playbackPosition,
          active,
          reducedMotion,
        );
        applyRevealStyle(element, progress);
      });

    };

    render();
    renderFrameRef.current = render;
    if (active && isPlaying && !reducedMotion) {
      const unsubscribe = motionController.subscribeFrame(render);
      return () => {
        if (renderFrameRef.current === render) {
          renderFrameRef.current = null;
        }
        unsubscribe();
      };
    }

    return () => {
      if (renderFrameRef.current === render) {
        renderFrameRef.current = null;
      }
    };
  }, [
    active,
    isPlaying,
    line.atMs,
    resolvedLineEndMs,
    lineState,
    reducedMotion,
    timeline,
    variant,
  ]);

  const renderSegment = (
    segment: LyricCharacter,
    index: number,
  ) => {
    const progress = getProgress(
      segment.revealTime,
      segment.duration,
      elapsedMs,
      active,
      reducedMotion,
    );
    const characterVisual =
      variant === "flow"
        ? getFlowCharacterVisual(
            lineState,
            segment.revealTime,
            segment.duration,
            elapsedMs,
            reducedMotion,
          )
        : null;
    const initialScrollLineState = getScrollLineState(
      elapsedMs,
      line.atMs,
      resolvedLineEndMs,
    );
    const scrollCharacterVisual =
      variant === "scroll"
        ? getScrollCharacterVisual(
            initialScrollLineState,
            segment.revealTime,
            segment.duration,
            elapsedMs,
            reducedMotion,
          )
        : null;

    return (
      <span
        className="lyric-reveal-engine__unit"
        data-character-state={
          scrollCharacterVisual?.state
            ?? characterVisual?.state
            ?? segment.state
        }
        data-character-color={scrollCharacterVisual?.colorState}
        data-reveal-unit={segment.unit}
        data-reveal-start={segment.revealTime}
        data-reveal-duration={segment.duration}
        key={`${segment.revealTime}:${index}:${segment.char}`}
        style={
          variant === "scroll" && scrollCharacterVisual
            ? getScrollUnitStyle(scrollCharacterVisual)
            : variant === "flow"
            ? undefined
            : getRevealStyle(progress)
        }
      >
        {segment.char.replaceAll(" ", "\u00A0")}
      </span>
    );
  };

  return (
    <span
      className={["lyric-reveal-engine", className]
        .filter(Boolean)
        .join(" ")}
      data-active={active}
      data-language={lang}
      data-line-state={lineState}
      data-variant={variant}
      data-column-count={variant === "scroll" ? columnCount : 1}
      ref={rootRef}
      lang={lang}
    >
      {variant === "scroll"
        ? scrollColumns.map((column, columnIndex) => (
          <span
            className="lyric-reveal-engine__column"
            data-column-index={columnIndex}
            key={`column-${columnIndex}`}
          >
            {column.map(({ segment, index }) =>
              renderSegment(segment, index)
            )}
          </span>
        ))
        : timeline.map(renderSegment)}
    </span>
  );
});
