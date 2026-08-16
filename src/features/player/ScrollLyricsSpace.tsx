import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import { motion } from "../../config/motion";
import { motionController } from "../../config/MotionController";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useLanguage } from "../../i18n/LanguageContext";
import type {
  LyricLine,
  LyricsStatus,
  NormalizedLyricDocument,
  Track,
} from "../../types/music";
import {
  createLyricRevealPlan,
  detectLyricLanguage,
  LyricRevealEngine,
} from "./LyricRevealEngine";
import type { LyricRevealSource } from "./LyricRevealEngine";
import {
  getTypographyInterludeAtTime,
  getTypographySceneAtLine,
  planTypographyScenes,
} from "./TypographyScenePlanner";
import type {
  TypographyMemoryGlyph,
  TypographyPosterPlan,
  TypographySceneTemplate,
} from "./TypographyScenePlanner";
import {
  createTypographyArchitectureSignature,
  createTypographyContextSignature,
  resolveTypographyPresenceMode,
} from "./TypographyContinuity";
import type {
  TypographyContextRole,
  TypographyPresenceMode,
} from "./TypographyContinuity";
import { motionTokens } from "./motionTokens";

type LyricNodeState = "future" | "current" | "past";
type TypographyLyricRole =
  | "primary"
  | "departing"
  | "preview"
  | "hidden";
type TypographyPlaybackStage = "origin" | "flow" | "interlude" | "return";
type TypographyGapKind = "none" | "continuity" | "breath" | "interlude";

export interface LyricNode {
  index: number;
  text: string;
  translation?: string;
  startTime: number;
  endTime: number;
  x: number;
  y: number;
  depth: number;
  opacity: number;
  blur: number;
  scale: number;
  state: LyricNodeState;
  role: TypographyLyricRole;
  activeProtected: boolean;
  waitingRole: "none" | "trace" | "preview";
}

type ScrollLyricStyle = CSSProperties &
  Record<
    | "--scroll-x"
    | "--scroll-y"
    | "--scroll-depth"
    | "--scroll-opacity"
    | "--scroll-blur"
    | "--scroll-scale"
    | "--scroll-line-height"
    | "--scroll-font-size",
    string
  >;

type AlbumSpaceStyle = CSSProperties &
  Record<
    | "--album-space-cover"
    | "--album-space-fallback"
    | "--album-space-accent"
    | "--album-space-text",
    string
  >;

type TypographySpaceStyle = CSSProperties &
  Record<
    | "--typography-gaze-y"
    | "--typography-album-y"
    | "--typography-stage-width"
    | "--poster-quiet-center-alpha",
    string
  >;

interface ScrollNodeVisual {
  index: number;
  state: LyricNodeState;
  role: TypographyLyricRole;
  activeProtected: boolean;
  waitingRole: LyricNode["waitingRole"];
  ending: boolean;
  x: string;
  y: string;
  depth: string;
  opacity: string;
  blur: string;
  scale: string;
  lineHeight: string;
  fontSize: string;
  columnCount: number;
}

interface ScrollPlaybackPhase {
  activeLineIndex: number | null;
  nextLineIndex: number | null;
  waiting: boolean;
  waitingProgress: number;
  gapStartMs: number;
  gapEndMs: number;
  gapDurationMs: number;
  gapKind: TypographyGapKind;
  scene: TypographyPlaybackStage;
  interludeStrength: number;
}

interface LyricLineTiming {
  endTime: number;
  glyphCount: number;
  source: LyricRevealSource;
}

interface LyricLayoutMetric {
  extentPx: number;
  columnCount: 1 | 2;
  fontSizePx: number;
}

interface ScrollLyricsSpaceProps {
  track: Track;
  lyrics: NormalizedLyricDocument;
  activeIndex: number;
  elapsedMs: number;
  isPlaying: boolean;
  lyricsStatus: LyricsStatus;
  showOriginalLyrics: boolean;
  showTranslation: boolean;
}

const visiblePastLines = 8;
const visibleFutureLines = 5;
const lyricPoolSize = visiblePastLines + visibleFutureLines + 1;
const typographyMemorySlotCount = motionTokens.typographyPoster.memorySlots;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveModulo(value: number, length: number) {
  return ((value % length) + length) % length;
}

function smoothStep(value: number) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function easeOutCubic(value: number) {
  const progress = clamp(value, 0, 1);
  return 1 - (1 - progress) ** 3;
}

function getPrimaryText(
  line: LyricLine,
  showOriginalLyrics: boolean,
) {
  if (!showOriginalLyrics && line.translation) {
    return line.translation;
  }

  return line.text;
}

function getTimestampGroupOwnerIndex(
  lines: LyricLine[],
  index: number,
) {
  const safeIndex = clamp(index, 0, Math.max(0, lines.length - 1));
  const timestamp = lines[safeIndex]?.atMs;
  let ownerIndex = safeIndex;
  while (
    ownerIndex + 1 < lines.length
    && lines[ownerIndex + 1].atMs === timestamp
  ) {
    ownerIndex += 1;
  }
  return ownerIndex;
}

function getPreviousTimestampGroupOwnerIndex(
  lines: LyricLine[],
  index: number,
) {
  const safeIndex = clamp(index, 0, Math.max(0, lines.length - 1));
  const timestamp = lines[safeIndex]?.atMs;
  let groupStartIndex = safeIndex;
  while (
    groupStartIndex > 0
    && lines[groupStartIndex - 1].atMs === timestamp
  ) {
    groupStartIndex -= 1;
  }
  return groupStartIndex > 0 ? groupStartIndex - 1 : null;
}

function getNextTimestampGroupOwnerIndex(
  lines: LyricLine[],
  index: number,
) {
  const currentOwnerIndex = getTimestampGroupOwnerIndex(lines, index);
  const nextGroupStartIndex = currentOwnerIndex + 1;
  return nextGroupStartIndex < lines.length
    ? getTimestampGroupOwnerIndex(lines, nextGroupStartIndex)
    : null;
}

function createLineTimings(
  lines: LyricLine[],
  trackDurationMs: number,
  showOriginalLyrics: boolean,
): LyricLineTiming[] {
  return lines.map((line, index) => {
    const primaryText = getPrimaryText(line, showOriginalLyrics);
    const readableUnitCount = Math.max(
      1,
      Array.from(primaryText).filter((character) => !/\s/u.test(character))
        .length,
    );
    const nextLineAt = lines[index + 1]?.atMs;
    const providerEnd = Number.isFinite(line.endAtMs)
      ? line.endAtMs
      : Number.isFinite(line.durationMs)
        ? line.atMs + (line.durationMs ?? 0)
        : undefined;
    const boundary = nextLineAt
      ?? (trackDurationMs > line.atMs
        ? trackDurationMs
        : providerEnd ?? line.atMs + 1);
    const timingBoundary = {
      atMs: Math.max(line.atMs + 1, boundary),
      text: "",
    } satisfies LyricLine;
    const revealPlan = createLyricRevealPlan(
      line,
      timingBoundary,
      primaryText,
    );
    const hasReliableWordEnd = revealPlan.source !== "line-estimated";
    const truthfulLineEnd = Math.max(
      line.atMs + 1,
      Math.min(timingBoundary.atMs, providerEnd ?? timingBoundary.atMs),
    );
    return {
      endTime: hasReliableWordEnd
        ? Math.max(
            line.atMs + 1,
            Math.min(timingBoundary.atMs, revealPlan.reliableEndTime),
          )
        : truthfulLineEnd,
      glyphCount: readableUnitCount,
      source: revealPlan.source,
    };
  });
}

function getGapKind(gapDurationMs: number): TypographyGapKind {
  if (gapDurationMs <= 0) {
    return "none";
  }
  if (gapDurationMs < motion.scrollLyricContinuityGapMs) {
    return "continuity";
  }
  if (gapDurationMs <= motion.scrollLyricInterludeGapMs) {
    return "breath";
  }
  return "interlude";
}

function getPlaybackPhase(
  lines: LyricLine[],
  timings: LyricLineTiming[],
  playbackTimeMs: number,
  trackDurationMs: number,
  canonicalActiveIndex: number,
): ScrollPlaybackPhase {
  if (canonicalActiveIndex < 0 || playbackTimeMs < lines[0].atMs) {
    const gapDurationMs = Math.max(0, lines[0].atMs);
    return {
      activeLineIndex: null,
      nextLineIndex: getTimestampGroupOwnerIndex(lines, 0),
      waiting: true,
      waitingProgress: clamp(
        playbackTimeMs / Math.max(1, lines[0].atMs),
        0,
        1,
      ),
      gapStartMs: 0,
      gapEndMs: lines[0].atMs,
      gapDurationMs,
      gapKind: getGapKind(gapDurationMs),
      scene: "origin",
      interludeStrength: 0,
    };
  }

  const activeLineIndex = getTimestampGroupOwnerIndex(
    lines,
    clamp(canonicalActiveIndex, 0, lines.length - 1),
  );
  const nextLineIndex = getNextTimestampGroupOwnerIndex(
    lines,
    activeLineIndex,
  );
  const activeLineEnd = timings[activeLineIndex].endTime;
  const nextLineAt = nextLineIndex === null
    ? Math.max(activeLineEnd, trackDurationMs)
    : lines[nextLineIndex].atMs;
  const waiting = playbackTimeMs >= activeLineEnd
    && playbackTimeMs < nextLineAt;
  const waitingDuration = Math.max(0, nextLineAt - activeLineEnd);
  const originLineCount = Math.min(
    motion.scrollLyricOriginLineCount,
    lines.length,
  );

  if (!waiting) {
    const previousOwnerIndex = getPreviousTimestampGroupOwnerIndex(
      lines,
      activeLineIndex,
    );
    const previousEnd = previousOwnerIndex === null
      ? 0
      : timings[previousOwnerIndex].endTime;
    const previousGapDuration = Math.max(
      0,
      lines[activeLineIndex].atMs - previousEnd,
    );
    const returnElapsed = playbackTimeMs - lines[activeLineIndex].atMs;
    const isReturning =
      activeLineIndex > 0
      && previousGapDuration > motion.scrollLyricInterludeGapMs
      && returnElapsed >= 0
      && returnElapsed < motion.scrollLyricReturnMs;
    return {
      activeLineIndex,
      nextLineIndex,
      waiting: false,
      waitingProgress: 0,
      gapStartMs: previousEnd,
      gapEndMs: lines[activeLineIndex].atMs,
      gapDurationMs: previousGapDuration,
      gapKind: isReturning ? "interlude" : "none",
      scene:
        isReturning
            ? "return"
          : activeLineIndex < originLineCount
            ? "origin"
            : "flow",
      interludeStrength: 0,
    };
  }

  const gapKind = getGapKind(waitingDuration);
  const gapElapsed = playbackTimeMs - activeLineEnd;
  const remaining = nextLineAt - playbackTimeMs;
  const returnLeadMs = clamp(waitingDuration * 0.24, 900, 1_400);
  const scene: TypographyPlaybackStage = gapKind === "interlude"
      ? nextLineIndex !== null && remaining <= returnLeadMs
        ? "return"
        : "interlude"
      : activeLineIndex < originLineCount
        ? "origin"
        : "flow";
  const rampInProgress = smoothStep(
    gapElapsed / Math.max(1, motion.scrollLyricInterludeRampMs),
  );
  const returnStrength = scene === "return"
    ? smoothStep(remaining / Math.max(1, returnLeadMs))
    : 1;

  return {
    activeLineIndex,
    nextLineIndex,
    waiting,
    waitingProgress:
      waiting && Number.isFinite(waitingDuration)
        ? clamp(
            (playbackTimeMs - activeLineEnd)
              / Math.max(1, waitingDuration),
            0,
          1,
        )
        : 0,
    gapStartMs: activeLineEnd,
    gapEndMs: nextLineAt,
    gapDurationMs: waitingDuration,
    gapKind,
    scene,
    interludeStrength:
      gapKind === "interlude"
        ? rampInProgress * returnStrength
        : 0,
  };
}

type LyricSpatialValues = Omit<
  LyricNode,
  "index" | "text" | "translation" | "startTime" | "endTime"
>;

function getPosterFocusY(
  timing: LyricLineTiming,
  linePlan: TypographyPosterPlan["linePlans"][number],
  layoutMetric: LyricLayoutMetric | undefined,
  viewportHeight: number,
) {
  const safeTop = viewportHeight * 0.1;
  const safeBottom = viewportHeight * 0.78;
  const maximumLineExtent = viewportHeight * 0.58;
  const fallbackExtent = clamp(
    timing.glyphCount * 18,
    viewportHeight * 0.08,
    maximumLineExtent,
  );
  const lineExtent = clamp(
    layoutMetric?.extentPx ?? fallbackExtent,
    24,
    maximumLineExtent,
  );
  const halfExtent = lineExtent * 0.5;
  const minimumCenter = safeTop + halfExtent;
  const maximumCenter = safeBottom - halfExtent;
  return clamp(
    viewportHeight * linePlan.focusYRatio,
    minimumCenter,
    maximumCenter,
  );
}

function getSpatialValues(
  lines: LyricLine[],
  timings: LyricLineTiming[],
  posterPlan: TypographyPosterPlan,
  index: number,
  playbackTimeMs: number,
  viewportHeight: number,
  layoutMetric: LyricLayoutMetric | undefined,
  playbackPhase: ScrollPlaybackPhase,
  reducedMotion: boolean,
): LyricSpatialValues {
  const line = lines[index];
  const endTime = timings[index].endTime;
  const linePlan = posterPlan.linePlans[index];
  const ownsCurrentState =
    playbackPhase.activeLineIndex === index
    && !playbackPhase.waiting
    && playbackTimeMs >= line.atMs
    && playbackTimeMs < endTime;
  const state: LyricNodeState = ownsCurrentState
    ? "current"
    : playbackTimeMs < line.atMs
      ? "future"
      : "past";
  const visualTime = playbackTimeMs;
  const focusY = getPosterFocusY(
    timings[index],
    linePlan,
    layoutMetric,
    viewportHeight,
  );
  const x = linePlan.focusX;
  const waitingRole: LyricNode["waitingRole"] =
    playbackPhase.waiting
      && index === playbackPhase.activeLineIndex
      ? "trace"
      : playbackPhase.waiting
          && index === playbackPhase.nextLineIndex
        ? "preview"
        : "none";
  if (state === "current") {
    return {
      state,
      role: "primary",
      x,
      y: focusY,
      depth: 0,
      opacity: 1,
      blur: 0,
      scale: 1,
      activeProtected: true,
      waitingRole,
    };
  }

  if (state === "future") {
    const previousOwnerIndex = getPreviousTimestampGroupOwnerIndex(
      lines,
      index,
    );
    const previousLineEnd = previousOwnerIndex === null
      ? 0
      : timings[previousOwnerIndex].endTime;
    const upcomingGapMs = Math.max(0, line.atMs - previousLineEnd);
    const previewLeadMs = upcomingGapMs >= motionTokens.typographyPoster
        .mediumInterludeMinimumMs
      ? clamp(
          upcomingGapMs * 0.28,
          motionTokens.typographyPoster.interludePreviewMinimumMs,
          motionTokens.typographyPoster.interludePreviewMaximumMs,
        )
      : linePlan.preRollMs;
    const preRollStartTime = line.atMs - previewLeadMs;
    const approach = smoothStep(
      (visualTime - preRollStartTime) / Math.max(1, previewLeadMs),
    );
    const isPreview = index === playbackPhase.nextLineIndex
      && visualTime >= preRollStartTime
      && visualTime < line.atMs;

    return {
      state,
      role: isPreview ? "preview" : "hidden",
      x,
      y: focusY,
      depth: linePlan.futureDepth * (1 - approach),
      opacity: isPreview ? 0.04 + approach * 0.03 : 0,
      blur: isPreview ? 14 - approach * 4 : 0,
      scale: 0.92 + approach * 0.04,
      activeProtected: false,
      waitingRole: isPreview ? "preview" : "none",
    };
  }

  const currentOwnerIndex = playbackPhase.activeLineIndex !== null
      && !playbackPhase.waiting
      && playbackTimeMs >= lines[playbackPhase.activeLineIndex].atMs
      && playbackTimeMs < timings[playbackPhase.activeLineIndex].endTime
    ? playbackPhase.activeLineIndex
    : null;
  const departureIndex = currentOwnerIndex === null
    ? playbackPhase.activeLineIndex
    : getPreviousTimestampGroupOwnerIndex(lines, currentOwnerIndex);
  const durationRatio = clamp(
    (linePlan.pastDurationMs
      - motionTokens.typographyPoster.pastTransitionMinimumMs)
      / Math.max(
        1,
        motionTokens.typographyPoster.pastTransitionMaximumMs
          - motionTokens.typographyPoster.pastTransitionMinimumMs,
      ),
    0,
    1,
  );
  const departureDurationMs = reducedMotion
    ? motionTokens.typographyPoster.pastReducedTransitionMinimumMs
      + durationRatio
        * (
          motionTokens.typographyPoster.pastReducedTransitionMaximumMs
          - motionTokens.typographyPoster.pastReducedTransitionMinimumMs
        )
    : linePlan.pastDurationMs;
  const departureElapsedMs = visualTime - endTime;
  const isDeparting = index === departureIndex
    && departureElapsedMs >= 0
    && departureElapsedMs < departureDurationMs;
  const normalizedDeparture = clamp(
    departureElapsedMs / Math.max(1, departureDurationMs),
    0,
    1,
  );
  const motionProgress = smoothStep(normalizedDeparture);
  const handoffDurationMs = reducedMotion
    ? Math.min(90, departureDurationMs * 0.32)
    : motionTokens.typographyPoster.pastHandoffMs;
  const handoffProgress = easeOutCubic(
    departureElapsedMs / Math.max(1, handoffDurationMs),
  );
  const exitProgress = smoothStep(
    (departureElapsedMs - handoffDurationMs)
      / Math.max(1, departureDurationMs - handoffDurationMs),
  );
  const contextOpacity = 0.2;
  const opacity = departureElapsedMs <= handoffDurationMs
    ? 1 + (contextOpacity - 1) * handoffProgress
    : contextOpacity * (1 - exitProgress);
  const blur = departureElapsedMs <= handoffDurationMs
    ? 1.5 * handoffProgress
    : 1.5 + (
        motionTokens.typographyPoster.pastBlurMaximumPx - 1.5
      ) * exitProgress;
  const scale = departureElapsedMs <= handoffDurationMs
    ? 1 - 0.02 * handoffProgress
    : 0.98 - (reducedMotion ? 0.025 : 0.06) * exitProgress;
  const liftVh = reducedMotion ? linePlan.pastLiftVh * 0.24 : linePlan.pastLiftVh;
  return {
    state,
    role: isDeparting ? "departing" : "hidden",
    x,
    y: focusY - viewportHeight * (liftVh / 100) * motionProgress,
    depth: reducedMotion ? 0 : -linePlan.pastDepthPx * motionProgress,
    opacity: isDeparting ? opacity : 0,
    blur: isDeparting ? blur : 0,
    scale: isDeparting ? scale : reducedMotion ? 0.955 : 0.92,
    activeProtected: false,
    waitingRole,
  };
}

function createLyricNode(
  lines: LyricLine[],
  timings: LyricLineTiming[],
  posterPlan: TypographyPosterPlan,
  index: number,
  playbackTimeMs: number,
  viewportHeight: number,
  showOriginalLyrics: boolean,
  trackDurationMs: number,
  canonicalActiveIndex: number,
  layoutMetric: LyricLayoutMetric | undefined,
  reducedMotion: boolean,
): LyricNode {
  const line = lines[index];

  return {
    index,
    text: getPrimaryText(line, showOriginalLyrics),
    translation: line.translation,
    startTime: line.atMs,
    endTime: timings[index].endTime,
    ...getSpatialValues(
      lines,
      timings,
      posterPlan,
      index,
      playbackTimeMs,
      viewportHeight,
      layoutMetric,
      getPlaybackPhase(
        lines,
        timings,
        playbackTimeMs,
        trackDurationMs,
        canonicalActiveIndex,
      ),
      reducedMotion,
    ),
  };
}

function measureLyricLayouts(
  stage: HTMLElement,
  lines: LyricLine[],
  showOriginalLyrics: boolean,
  viewportHeight: number,
) {
  const measurements = new Map<number, LyricLayoutMetric>();
  if (lines.length === 0) {
    return measurements;
  }
  const probe = document.createElement("article");
  const content = document.createElement("div");
  probe.className = "scroll-lyric scroll-lyric--measurement";
  content.className = "scroll-lyric__content";
  probe.append(content);
  stage.append(probe);

  const paragraphs = lines.map((line) => {
    const paragraph = document.createElement("p");
    const text = getPrimaryText(line, showOriginalLyrics);
    const language = detectLyricLanguage(text);
    paragraph.lang = language;
    paragraph.dataset.language = language;
    paragraph.textContent = text;
    content.append(paragraph);
    return paragraph;
  });

  const maximumExtent = Math.max(
    120,
    Math.min(540, viewportHeight * 0.48),
  );
  const baseFontSizePx = Number.parseFloat(
    window.getComputedStyle(paragraphs[0]).fontSize,
  ) || 42;
  const naturalExtents = paragraphs.map((paragraph) => Math.max(
    24,
    paragraph.getBoundingClientRect().height,
  ));

  naturalExtents.forEach((naturalExtent, index) => {
    const columnCount: 1 | 2 = naturalExtent > maximumExtent * 1.04
      ? 2
      : 1;
    const fontScale = columnCount === 2
      ? clamp((maximumExtent * 2) / naturalExtent, 0.72, 1)
      : clamp(maximumExtent / naturalExtent, 0.78, 1);
    measurements.set(index, {
      extentPx: Math.min(
        maximumExtent,
        naturalExtent * fontScale / columnCount,
      ),
      columnCount,
      fontSizePx: baseFontSizePx * fontScale,
    });
  });

  probe.remove();
  return measurements;
}

function layoutMetricsMatch(
  left: Map<number, LyricLayoutMetric>,
  right: Map<number, LyricLayoutMetric>,
) {
  if (left.size !== right.size) {
    return false;
  }

  for (const [index, next] of right) {
    const current = left.get(index);
    if (
      !current
      || current.columnCount !== next.columnCount
      || Math.abs(current.extentPx - next.extentPx) > 0.5
      || Math.abs(current.fontSizePx - next.fontSizePx) > 0.1
    ) {
      return false;
    }
  }

  return true;
}

type PosterInterludePhase =
  | "live"
  | "afterimage"
  | "suspension"
  | "preview";

type TypographyLayerBankIndex = 0 | 1;

interface TypographyArchitectureTarget {
  signature: string;
  glyphs: TypographyMemoryGlyph[];
  template: TypographySceneTemplate;
}

interface TypographyArchitectureTransition {
  fromBank: TypographyLayerBankIndex;
  toBank: TypographyLayerBankIndex;
  target: TypographyArchitectureTarget;
  startedAt: number;
  durationMs: number;
}

interface TypographyArchitectureRuntime {
  activeBank: TypographyLayerBankIndex;
  activeSignature: string;
  transition: TypographyArchitectureTransition | null;
  queuedTarget: TypographyArchitectureTarget | null;
  banks: [HTMLElement, HTMLElement] | null;
}

interface TypographyContextTarget {
  signature: string;
  glyph: TypographyMemoryGlyph | null;
}

interface TypographyContextTransition {
  fromBuffer: TypographyLayerBankIndex;
  toBuffer: TypographyLayerBankIndex;
  target: TypographyContextTarget;
  startedAt: number;
  durationMs: number;
  fromOpacity: number;
}

interface TypographyContextRoleRuntime {
  activeBuffer: TypographyLayerBankIndex;
  activeSignature: string;
  transition: TypographyContextTransition | null;
  buffers: [HTMLElement, HTMLElement] | null;
  opacities: [number, number];
  visibility: number;
  lastUpdatedAt: number;
}

interface TypographyContextRuntime {
  roles: Record<TypographyContextRole, TypographyContextRoleRuntime>;
  committedOwnerIndex: number | null;
  lastPlaybackPosition: number;
}

interface TypographyPresenceRuntime {
  mode: TypographyPresenceMode;
}

function createTypographyArchitectureRuntime(): TypographyArchitectureRuntime {
  return {
    activeBank: 0,
    activeSignature: "",
    transition: null,
    queuedTarget: null,
    banks: null,
  };
}

function createTypographyContextRoleRuntime(): TypographyContextRoleRuntime {
  return {
    activeBuffer: 0,
    activeSignature: "",
    transition: null,
    buffers: null,
    opacities: [0, 0],
    visibility: 0,
    lastUpdatedAt: 0,
  };
}

function createTypographyContextRuntime(): TypographyContextRuntime {
  return {
    roles: {
      past: createTypographyContextRoleRuntime(),
      future: createTypographyContextRoleRuntime(),
    },
    committedOwnerIndex: null,
    lastPlaybackPosition: 0,
  };
}

function createTypographyPresenceRuntime(): TypographyPresenceRuntime {
  return {
    mode: "lyrics-unavailable",
  };
}

function getArchitectureBanks(
  layer: HTMLElement,
  runtime: TypographyArchitectureRuntime,
) {
  if (runtime.banks) {
    return runtime.banks;
  }
  const banks = Array.from(
    layer.querySelectorAll<HTMLElement>("[data-architecture-bank]"),
  );
  if (banks.length < 2) {
    return null;
  }
  runtime.banks = [banks[0], banks[1]];
  return runtime.banks;
}

function setArchitectureBankOpacity(
  bank: HTMLElement,
  opacity: number,
) {
  bank.style.setProperty(
    "--poster-architecture-bank-opacity",
    opacity.toFixed(4),
  );
}

function writeMemoryGlyph(
  element: HTMLElement,
  glyph: TypographyMemoryGlyph | undefined,
  reducedMotion: boolean,
) {
  if (!glyph) {
    element.textContent = "";
    delete element.dataset.memoryKind;
    delete element.dataset.memoryRank;
    element.style.setProperty("--poster-memory-opacity", "0");
    return;
  }

  element.textContent = glyph.text;
  element.dataset.memoryKind = glyph.kind;
  element.dataset.memoryRank = String(glyph.rank);
  element.style.setProperty("--poster-memory-x", `${glyph.xVw}vw`);
  element.style.setProperty(
    "--poster-memory-y",
    `${(glyph.yRatio * 100).toFixed(2)}vh`,
  );
  element.style.setProperty(
    "--poster-memory-depth",
    `${reducedMotion ? 0 : glyph.depth}px`,
  );
  element.style.setProperty("--poster-memory-scale", `${glyph.scale}`);
  element.style.setProperty(
    "--poster-memory-rotation",
    `${glyph.rotationDeg}deg`,
  );
  element.style.setProperty(
    "--poster-memory-opacity",
    glyph.opacity.toFixed(4),
  );
  element.style.setProperty("--poster-memory-blur", `${glyph.blur}px`);
}

function writeArchitectureBank(
  bank: HTMLElement,
  target: TypographyArchitectureTarget,
  reducedMotion: boolean,
) {
  const elements = Array.from(
    bank.querySelectorAll<HTMLElement>("[data-architecture-slot]"),
  );
  elements.forEach((element, slotIndex) => {
    writeMemoryGlyph(element, target.glyphs[slotIndex], reducedMotion);
  });
  bank.dataset.architectureSignature = target.signature;
  bank.dataset.architectureTemplate = target.template;
}

function syncTypographyAtriumMotion(
  layer: HTMLElement,
  now: number,
  isPlaying: boolean,
  reducedMotion: boolean,
) {
  if (reducedMotion) {
    layer.style.setProperty("--poster-context-motion-x", "0px");
    layer.style.setProperty("--poster-context-motion-y", "0px");
    layer.style.setProperty("--poster-architecture-motion-x", "0px");
    layer.style.setProperty("--poster-architecture-motion-y", "0px");
    layer.style.setProperty("--poster-memory-beat-scale", "0");
    layer.style.setProperty("--poster-memory-beat-opacity", "0");
    return;
  }

  const motionPresence = isPlaying ? 1 : 0.28;
  const driftPhase = now / 12_000;
  const sharedDriftX = Math.sin(driftPhase) * 2.6 * motionPresence;
  const contextRatio = motionTokens.typographyPoster.contextDriftRatio;
  const architectureRatio = motionTokens.typographyPoster
    .architecturalDriftRatio;

  layer.style.setProperty(
    "--poster-context-motion-x",
    (sharedDriftX * contextRatio).toFixed(3) + "px",
  );
  layer.style.setProperty("--poster-context-motion-y", "0px");
  layer.style.setProperty(
    "--poster-architecture-motion-x",
    (sharedDriftX * architectureRatio).toFixed(3) + "px",
  );
  layer.style.setProperty("--poster-architecture-motion-y", "0px");
  layer.style.setProperty("--poster-memory-beat-scale", "0");
  layer.style.setProperty("--poster-memory-beat-opacity", "0");
}

function beginArchitectureTransition(
  runtime: TypographyArchitectureRuntime,
  target: TypographyArchitectureTarget,
  now: number,
  reducedMotion: boolean,
) {
  const banks = runtime.banks;
  if (!banks) {
    return;
  }
  const hasActiveContent = runtime.activeSignature !== "";
  const toBank: TypographyLayerBankIndex = hasActiveContent
    ? runtime.activeBank === 0 ? 1 : 0
    : runtime.activeBank;
  const fromBank: TypographyLayerBankIndex = toBank === 0 ? 1 : 0;
  writeArchitectureBank(banks[toBank], target, reducedMotion);
  setArchitectureBankOpacity(banks[toBank], 0);
  runtime.transition = {
    fromBank,
    toBank,
    target,
    startedAt: now,
    durationMs: reducedMotion
      ? 180
      : motionTokens.typographyPoster.architectureCrossfadeMs,
  };
}

function syncTypographyArchitectureLayer(
  layer: HTMLElement,
  target: TypographyArchitectureTarget,
  reducedMotion: boolean,
  now: number,
  runtime: TypographyArchitectureRuntime,
) {
  const banks = getArchitectureBanks(layer, runtime);
  if (!banks) {
    return;
  }

  if (runtime.activeSignature === "" && runtime.transition === null) {
    writeArchitectureBank(banks[runtime.activeBank], target, reducedMotion);
    runtime.activeSignature = target.signature;
    layer.dataset.activeArchitectureBank = String(runtime.activeBank);
    layer.dataset.architectureSignature = target.signature;
    setArchitectureBankOpacity(
      banks[runtime.activeBank],
      target.glyphs.length > 0 ? 1 : 0,
    );
    setArchitectureBankOpacity(
      banks[runtime.activeBank === 0 ? 1 : 0],
      0,
    );
    return;
  }

  if (runtime.transition) {
    if (runtime.transition.target.signature !== target.signature) {
      runtime.queuedTarget = target;
    } else {
      runtime.queuedTarget = null;
    }
    const progress = clamp(
      (now - runtime.transition.startedAt)
        / Math.max(1, runtime.transition.durationMs),
      0,
      1,
    );
    const eased = smoothStep(progress);
    const { fromBank, toBank } = runtime.transition;
    setArchitectureBankOpacity(banks[fromBank], 1 - eased);
    setArchitectureBankOpacity(banks[toBank], eased);

    if (progress >= 1) {
      const completed = runtime.transition;
      setArchitectureBankOpacity(banks[completed.fromBank], 0);
      setArchitectureBankOpacity(banks[completed.toBank], 1);
      runtime.activeBank = completed.toBank;
      runtime.activeSignature = completed.target.signature;
      runtime.transition = null;
      layer.dataset.activeArchitectureBank = String(runtime.activeBank);
      layer.dataset.architectureSignature = runtime.activeSignature;
      const queuedTarget = runtime.queuedTarget;
      runtime.queuedTarget = null;
      if (
        queuedTarget
        && queuedTarget.signature !== runtime.activeSignature
      ) {
        beginArchitectureTransition(
          runtime,
          queuedTarget,
          now,
          reducedMotion,
        );
      }
    }
    return;
  }

  if (target.signature !== runtime.activeSignature) {
    beginArchitectureTransition(runtime, target, now, reducedMotion);
    return;
  }

  setArchitectureBankOpacity(banks[runtime.activeBank], 1);
  const inactiveBank = runtime.activeBank === 0 ? 1 : 0;
  setArchitectureBankOpacity(banks[inactiveBank], 0);
}

function getContextBuffers(
  layer: HTMLElement,
  role: TypographyContextRole,
  runtime: TypographyContextRoleRuntime,
) {
  if (runtime.buffers) {
    return runtime.buffers;
  }
  const buffers = Array.from(layer.querySelectorAll<HTMLElement>(
    `[data-context-role="${role}"][data-context-buffer]`,
  ));
  if (buffers.length < 2) {
    return null;
  }
  runtime.buffers = [buffers[0], buffers[1]];
  return runtime.buffers;
}

function setContextBufferVisual(
  buffer: HTMLElement,
  opacity: number,
  shiftPx: number,
) {
  buffer.style.setProperty(
    "--poster-context-buffer-opacity",
    opacity.toFixed(4),
  );
  buffer.style.setProperty(
    "--poster-context-buffer-shift-x",
    `${shiftPx.toFixed(2)}px`,
  );
}

function writeContextBuffer(
  buffer: HTMLElement,
  target: TypographyContextTarget,
  reducedMotion: boolean,
) {
  const element = buffer.querySelector<HTMLElement>("[data-context-glyph]");
  if (element) {
    writeMemoryGlyph(element, target.glyph ?? undefined, reducedMotion);
  }
  buffer.dataset.contextSignature = target.signature;
}

function getContextVisibility(
  role: TypographyContextRole,
  phase: PosterInterludePhase,
) {
  if (role === "past") {
    if (phase === "afterimage") return 0.68;
    if (phase === "suspension") return 0.22;
    if (phase === "preview") return 0.12;
    return 0.58;
  }
  if (phase === "preview") return 0.68;
  if (phase === "suspension") return 0.18;
  if (phase === "afterimage") return 0.12;
  return 0.18;
}

function beginContextTransition(
  runtime: TypographyContextRoleRuntime,
  target: TypographyContextTarget,
  now: number,
  reducedMotion: boolean,
) {
  const buffers = runtime.buffers;
  if (!buffers) {
    return;
  }
  const toBuffer: TypographyLayerBankIndex = runtime.activeBuffer === 0 ? 1 : 0;
  const fromBuffer = runtime.activeBuffer;
  writeContextBuffer(buffers[toBuffer], target, reducedMotion);
  runtime.opacities[toBuffer] = 0;
  setContextBufferVisual(buffers[toBuffer], 0, 0);
  runtime.transition = {
    fromBuffer,
    toBuffer,
    target,
    startedAt: now,
    durationMs: reducedMotion
      ? motionTokens.typographyPoster.contextReducedCrossfadeMs
      : motionTokens.typographyPoster.contextCrossfadeMs,
    fromOpacity: runtime.opacities[fromBuffer],
  };
}

function syncTypographyContextRole(
  layer: HTMLElement,
  role: TypographyContextRole,
  target: TypographyContextTarget,
  desiredVisibility: number,
  reducedMotion: boolean,
  now: number,
  runtime: TypographyContextRoleRuntime,
) {
  const buffers = getContextBuffers(layer, role, runtime);
  if (!buffers) {
    return;
  }

  const frameDelta = runtime.lastUpdatedAt <= 0
    ? 16.67
    : clamp(now - runtime.lastUpdatedAt, 0, 34);
  runtime.lastUpdatedAt = now;
  const visibilityMix = reducedMotion
    ? 1
    : 1 - Math.exp(-frameDelta / 260);
  runtime.visibility += (desiredVisibility - runtime.visibility) * visibilityMix;

  if (runtime.activeSignature === "" && runtime.transition === null) {
    writeContextBuffer(buffers[runtime.activeBuffer], target, reducedMotion);
    runtime.activeSignature = target.signature;
    runtime.opacities[runtime.activeBuffer] = target.glyph
      ? runtime.visibility
      : 0;
    setContextBufferVisual(
      buffers[runtime.activeBuffer],
      runtime.opacities[runtime.activeBuffer],
      0,
    );
    setContextBufferVisual(
      buffers[runtime.activeBuffer === 0 ? 1 : 0],
      0,
      0,
    );
    return;
  }

  if (runtime.transition) {
    const transition = runtime.transition;
    const progress = clamp(
      (now - transition.startedAt) / Math.max(1, transition.durationMs),
      0,
      1,
    );
    const eased = smoothStep(progress);
    const incomingOpacity = transition.target.glyph ? runtime.visibility : 0;
    runtime.opacities[transition.fromBuffer] =
      transition.fromOpacity * (1 - eased);
    runtime.opacities[transition.toBuffer] = incomingOpacity * eased;
    setContextBufferVisual(
      buffers[transition.fromBuffer],
      runtime.opacities[transition.fromBuffer],
      0,
    );
    setContextBufferVisual(
      buffers[transition.toBuffer],
      runtime.opacities[transition.toBuffer],
      0,
    );

    if (progress >= 1) {
      runtime.activeBuffer = transition.toBuffer;
      runtime.activeSignature = transition.target.signature;
      runtime.transition = null;
      setContextBufferVisual(buffers[transition.fromBuffer], 0, 0);
      setContextBufferVisual(
        buffers[transition.toBuffer],
        incomingOpacity,
        0,
      );
    }
  }

  const pendingSignature = runtime.transition?.target.signature
    ?? runtime.activeSignature;
  if (target.signature !== pendingSignature) {
    if (runtime.transition) {
      const sourceBuffer: TypographyLayerBankIndex =
        runtime.opacities[0] >= runtime.opacities[1] ? 0 : 1;
      const discardedBuffer: TypographyLayerBankIndex =
        sourceBuffer === 0 ? 1 : 0;
      runtime.activeBuffer = sourceBuffer;
      runtime.activeSignature =
        buffers[sourceBuffer].dataset.contextSignature ?? "";
      runtime.transition = null;
      runtime.opacities[discardedBuffer] = 0;
      setContextBufferVisual(buffers[discardedBuffer], 0, 0);
    }
    beginContextTransition(runtime, target, now, reducedMotion);
    return;
  }

  if (!runtime.transition) {
    const activeOpacity = target.glyph ? runtime.visibility : 0;
    runtime.opacities[runtime.activeBuffer] = activeOpacity;
    setContextBufferVisual(buffers[runtime.activeBuffer], activeOpacity, 0);
    setContextBufferVisual(
      buffers[runtime.activeBuffer === 0 ? 1 : 0],
      0,
      0,
    );
  }
}

function syncTypographyContextLayer(
  layer: HTMLElement,
  targets: Record<TypographyContextRole, TypographyContextTarget>,
  phase: PosterInterludePhase,
  reducedMotion: boolean,
  now: number,
  runtime: TypographyContextRuntime,
) {
  (["past", "future"] as const).forEach((role) => {
    syncTypographyContextRole(
      layer,
      role,
      targets[role],
      getContextVisibility(role, phase),
      reducedMotion,
      now,
      runtime.roles[role],
    );
  });
}

function syncTypographyPresence(
  root: HTMLElement,
  mode: TypographyPresenceMode,
  runtime: TypographyPresenceRuntime,
) {
  if (runtime.mode !== mode || root.dataset.presenceMode !== mode) {
    runtime.mode = mode;
    root.dataset.presenceMode = mode;
  }
}

function syncTypographySpatialBed(
  bed: HTMLElement,
  now: number,
  clockOrigin: number,
  isPlaying: boolean,
  reducedMotion: boolean,
) {
  if (reducedMotion) {
    bed.style.setProperty("--typography-bed-x", "0px");
    bed.style.setProperty("--typography-bed-y", "0px");
    bed.style.setProperty("--typography-bed-scale", "1");
    return;
  }
  const elapsed = Math.max(0, now - clockOrigin);
  const presence = isPlaying ? 1 : 0.7;
  const x = (
    Math.sin(elapsed / 21_000) * 2.4
    + Math.sin(elapsed / 27_000 + 1.7) * 1.2
  ) * presence;
  const y = (
    Math.sin(elapsed / 24_000 + 0.8) * 1.7
    + Math.cos(elapsed / 19_000) * 0.8
  ) * presence;
  const scale = 1 + Math.sin(elapsed / 26_000 + 0.35) * 0.005 * presence;
  bed.style.setProperty("--typography-bed-x", `${x.toFixed(3)}px`);
  bed.style.setProperty("--typography-bed-y", `${y.toFixed(3)}px`);
  bed.style.setProperty("--typography-bed-scale", scale.toFixed(5));
}

export const ScrollLyricsSpace = memo(function ScrollLyricsSpace({
  track,
  lyrics,
  activeIndex,
  elapsedMs,
  isPlaying,
  lyricsStatus,
  showOriginalLyrics,
  showTranslation,
}: ScrollLyricsSpaceProps) {
  const { t } = useLanguage();
  const hasReadyLyrics =
    lyricsStatus === "ready" && lyrics.lines.length > 0;
  const lines = useMemo(
    () => hasReadyLyrics ? lyrics.lines : [],
    [hasReadyLyrics, lyrics.lines],
  );
  const lineTimings = useMemo(
    () => createLineTimings(
      lines,
      track.durationMs,
      showOriginalLyrics,
    ),
    [lines, showOriginalLyrics, track.durationMs],
  );
  const posterPlan = useMemo(
    () => planTypographyScenes({
      trackId: track.id,
      trackDurationMs: track.durationMs,
      lines: lines.map((line, index) => {
        const text = getPrimaryText(line, showOriginalLyrics);
        return {
          index,
          text,
          startTime: line.atMs,
          endTime: lineTimings[index].endTime,
          glyphCount: lineTimings[index].glyphCount,
          language: detectLyricLanguage(text),
        };
      }),
    }),
    [lineTimings, lines, showOriginalLyrics, track.durationMs, track.id],
  );
  const safeActiveIndex = hasReadyLyrics && activeIndex >= 0
    ? getTimestampGroupOwnerIndex(
        lines,
        clamp(activeIndex, 0, lines.length - 1),
      )
    : -1;
  const prefersReducedMotion = useReducedMotion();
  const [, setLayoutVersion] = useState(0);
  const streamRef = useRef<HTMLDivElement>(null);
  const spatialBedRef = useRef<HTMLDivElement>(null);
  const memoryLayerRef = useRef<HTMLDivElement>(null);
  const architectureRuntimeRef = useRef(
    createTypographyArchitectureRuntime(),
  );
  const contextRuntimeRef = useRef(createTypographyContextRuntime());
  const presenceRuntimeRef = useRef(createTypographyPresenceRuntime());
  const spatialBedClockOriginRef = useRef(performance.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const lyricStageRef = useRef<HTMLElement>(null);
  const layoutMetricsRef = useRef(new Map<number, LyricLayoutMetric>());
  const playbackClockRef = useRef({
    elapsedMs,
    capturedAt: performance.now(),
  });
  const nodeVisualCacheRef = useRef(
    new WeakMap<HTMLElement, ScrollNodeVisual>(),
  );
  const endingStartedAtRef = useRef<number | null>(null);
  const viewportHeight =
    typeof window === "undefined" ? 800 : window.innerHeight;
  const currentLine = safeActiveIndex >= 0
    ? lines[safeActiveIndex]
    : undefined;
  const currentText = currentLine
    ? getPrimaryText(currentLine, showOriginalLyrics)
    : "";
  const currentTimingSource = safeActiveIndex >= 0
    ? lineTimings[safeActiveIndex]?.source ?? "line-estimated"
    : "unavailable";
  const revealNextLines = useMemo(
    () => lines.map((line, index) => {
      const nextOwnerIndex = getNextTimestampGroupOwnerIndex(lines, index);
      const nextLine = nextOwnerIndex === null
        ? undefined
        : lines[nextOwnerIndex];
      const revealEnd = lineTimings[index].endTime;
      if (nextLine && nextLine.atMs === revealEnd) {
        return nextLine;
      }

      return {
        atMs: revealEnd,
        text: "",
      } satisfies LyricLine;
    }),
    [lineTimings, lines],
  );
  const albumSpaceStyle: AlbumSpaceStyle = {
    "--album-space-cover": track.coverImage
      ? `url("${track.coverImage.replaceAll('"', "%22")}")`
      : "none",
    "--album-space-fallback": track.palette.background,
    "--album-space-accent": track.palette.accent,
    "--album-space-text": track.palette.text,
  };
  const albumCenterRatio = viewportHeight
      < motionTokens.typographyPoster.compactViewportHeightPx
    ? motionTokens.typographyPoster.albumCompactCenterRatio
    : motionTokens.typographyPoster.albumCenterRatio;
  const typographySpaceStyle: TypographySpaceStyle = {
    "--typography-gaze-y":
      (motionTokens.typographyPoster.focusYBaseRatio * 100) + "%",
    "--typography-album-y": (albumCenterRatio * 100) + "%",
    "--typography-stage-width":
      (motionTokens.typographyPoster.leftStageWidthRatio * 100) + "%",
    "--poster-quiet-center-alpha":
      motionTokens.typographyPoster.quietCenterAlpha.toFixed(3),
  };

  useEffect(() => {
    playbackClockRef.current = {
      elapsedMs,
      capturedAt: performance.now(),
    };
  }, [elapsedMs]);

  useLayoutEffect(() => {
    nodeVisualCacheRef.current =
      new WeakMap<HTMLElement, ScrollNodeVisual>();
    endingStartedAtRef.current = null;
    layoutMetricsRef.current = new Map<number, LyricLayoutMetric>();
  }, [hasReadyLyrics, lyricsStatus, track.id]);

  useLayoutEffect(() => {
    architectureRuntimeRef.current = createTypographyArchitectureRuntime();
    contextRuntimeRef.current = createTypographyContextRuntime();
    presenceRuntimeRef.current = createTypographyPresenceRuntime();
    spatialBedClockOriginRef.current = performance.now();
    memoryLayerRef.current
      ?.querySelectorAll<HTMLElement>("[data-architecture-bank]")
      .forEach((bank) => {
        setArchitectureBankOpacity(bank, 0);
        bank.querySelectorAll<HTMLElement>("[data-architecture-slot]")
          .forEach((element) => {
            element.textContent = "";
          });
      });
    memoryLayerRef.current
      ?.querySelectorAll<HTMLElement>("[data-context-buffer]")
      .forEach((buffer) => {
        setContextBufferVisual(buffer, 0, 0);
        const glyph = buffer.querySelector<HTMLElement>("[data-context-glyph]");
        if (glyph) {
          glyph.textContent = "";
        }
      });
  }, [track.id]);

  useLayoutEffect(() => {
    const stage = lyricStageRef.current;
    if (!stage) {
      return;
    }

    let disposed = false;
    let measureFrame: number | null = null;
    const measure = () => {
      measureFrame = null;
      if (disposed) {
        return;
      }
      const nextMetrics = measureLyricLayouts(
        stage,
        lines,
        showOriginalLyrics,
        window.innerHeight,
      );
      if (!layoutMetricsMatch(layoutMetricsRef.current, nextMetrics)) {
        layoutMetricsRef.current = nextMetrics;
        nodeVisualCacheRef.current =
          new WeakMap<HTMLElement, ScrollNodeVisual>();
        setLayoutVersion((version) => version + 1);
      }
    };
    const scheduleMeasure = () => {
      if (disposed || measureFrame !== null) {
        return;
      }
      measureFrame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    void document.fonts?.ready.then(scheduleMeasure);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(stage);
    window.addEventListener("resize", scheduleMeasure, { passive: true });

    return () => {
      disposed = true;
      if (measureFrame !== null) {
        window.cancelAnimationFrame(measureFrame);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [lines, showOriginalLyrics, track.id]);

  useLayoutEffect(() => {
    const stream = streamRef.current;
    const spatialBed = spatialBedRef.current;
    const memoryLayer = memoryLayerRef.current;
    const root = rootRef.current;
    if (!stream || !spatialBed || !memoryLayer || !root) {
      return;
    }

    const lyricElements = Array.from(
      stream.querySelectorAll<HTMLElement>(".scroll-lyric[data-pool-slot]"),
    );

    if (!hasReadyLyrics) {
      root.dataset.playbackPhase = "waiting";
      root.dataset.typographyScene = "interlude";
      root.dataset.posterTemplate = "monument";
      root.dataset.posterSceneId = "none";
      root.dataset.posterPhase = "suspension";
      root.dataset.gapKind = "interlude";
      root.dataset.interludeKind = "long";
      root.dataset.hasCurrentLyric = "false";
      root.style.setProperty("--poster-scene-density", "0.34");
      root.style.setProperty("--poster-depth-strength", "0.52");
      root.style.setProperty("--scroll-ending-progress", "0");
      root.style.setProperty("--scroll-interlude-strength", "1");
      lyricElements.forEach((element) => {
        element.style.setProperty("--scroll-opacity", "0");
      });
      const emptyContextTargets: Record<
        TypographyContextRole,
        TypographyContextTarget
      > = {
        past: {
          signature: createTypographyContextSignature(
            track.id,
            "past",
            null,
          ),
          glyph: null,
        },
        future: {
          signature: createTypographyContextSignature(
            track.id,
            "future",
            null,
          ),
          glyph: null,
        },
      };
      const updateUnavailableSpace = (now: number) => {
        syncTypographySpatialBed(
          spatialBed,
          now,
          spatialBedClockOriginRef.current,
          isPlaying,
          prefersReducedMotion,
        );
        syncTypographyAtriumMotion(
          memoryLayer,
          now,
          isPlaying,
          prefersReducedMotion,
        );
        syncTypographyContextLayer(
          memoryLayer,
          emptyContextTargets,
          "suspension",
          prefersReducedMotion,
          now,
          contextRuntimeRef.current,
        );
        syncTypographyPresence(
          root,
          "lyrics-unavailable",
          presenceRuntimeRef.current,
        );
      };
      updateUnavailableSpace(performance.now());
      return motionController.subscribeFrame(updateUnavailableSpace);
    }

    const updateVisuals = (now: number) => {
      const playbackPosition = isPlaying
        ? motionController.readPlaybackTime(now)
        : playbackClockRef.current.elapsedMs;
      const playbackPhase = getPlaybackPhase(
        lines,
        lineTimings,
        playbackPosition,
        track.durationMs,
        safeActiveIndex,
      );
      const interlude = getTypographyInterludeAtTime(
        posterPlan,
        playbackPosition,
      );
      const posterPhase: PosterInterludePhase = interlude
        ? playbackPosition < interlude.afterimageEndTime
          ? "afterimage"
          : playbackPosition >= interlude.previewStartTime
            ? "preview"
            : "suspension"
        : "live";
      const posterLineIndex =
        interlude?.nextLineIndex !== null && posterPhase === "preview"
          ? interlude?.nextLineIndex ?? playbackPhase.nextLineIndex ?? 0
          : playbackPhase.activeLineIndex
            ?? playbackPhase.nextLineIndex
            ?? 0;
      const posterScene = getTypographySceneAtLine(
        posterPlan,
        posterLineIndex,
      );
      const memoryArchitectureLineIndex = posterPhase === "preview"
        ? interlude?.nextLineIndex ?? playbackPhase.nextLineIndex ?? 0
        : playbackPhase.activeLineIndex
          ?? playbackPhase.nextLineIndex
          ?? 0;
      const memoryArchitectureScene = getTypographySceneAtLine(
        posterPlan,
        memoryArchitectureLineIndex,
      );
      const currentOwnerIndex = playbackPhase.waiting
        ? null
        : playbackPhase.activeLineIndex;
      if (
        root.dataset.hasCurrentLyric
        !== String(currentOwnerIndex !== null)
      ) {
        root.dataset.hasCurrentLyric = String(currentOwnerIndex !== null);
      }
      const contextRuntime = contextRuntimeRef.current;
      const playbackJumped = Math.abs(
        playbackPosition - contextRuntime.lastPlaybackPosition,
      ) > 1_200;
      contextRuntime.lastPlaybackPosition = playbackPosition;
      if (currentOwnerIndex !== null) {
        contextRuntime.committedOwnerIndex = currentOwnerIndex;
      } else if (
        playbackJumped
        && playbackPhase.activeLineIndex !== null
      ) {
        contextRuntime.committedOwnerIndex = playbackPhase.activeLineIndex;
      }

      const contextOwnerIndex = contextRuntime.committedOwnerIndex;
      const pastContextIndex = contextOwnerIndex === null
        ? null
        : getPreviousTimestampGroupOwnerIndex(lines, contextOwnerIndex);
      const futureContextIndex = contextOwnerIndex === null
        ? playbackPhase.nextLineIndex
        : getNextTimestampGroupOwnerIndex(lines, contextOwnerIndex);
      const pastContextPlan = pastContextIndex === null
          || pastContextIndex < 0
        ? null
        : posterPlan.linePlans[pastContextIndex] ?? null;
      const futureContextPlan = futureContextIndex === null
        ? null
        : posterPlan.linePlans[futureContextIndex] ?? null;
      const pastContextGlyph = pastContextPlan?.memoryGlyphs.find(
        (glyph) => glyph.kind === "context-past",
      ) ?? null;
      const futureContextGlyph = futureContextPlan?.memoryGlyphs.find(
        (glyph) => glyph.kind === "context-future",
      ) ?? null;
      const sceneArchitectureGlyphs =
        memoryArchitectureScene?.memoryGlyphs.filter(
          (glyph) => glyph.kind === "architectural",
        ) ?? [];
      const architectureTemplate = memoryArchitectureScene?.template
        ?? "monument";
      const architectureTarget: TypographyArchitectureTarget = {
        signature: createTypographyArchitectureSignature(
          track.id,
          memoryArchitectureScene?.id,
          architectureTemplate,
          prefersReducedMotion,
        ),
        glyphs: sceneArchitectureGlyphs.slice(0, typographyMemorySlotCount),
        template: architectureTemplate,
      };
      const contextTargets: Record<
        TypographyContextRole,
        TypographyContextTarget
      > = {
        past: {
          signature: createTypographyContextSignature(
            track.id,
            "past",
            pastContextIndex,
            pastContextIndex === null
              ? undefined
              : lines[pastContextIndex]?.atMs,
          ),
          glyph: pastContextGlyph,
        },
        future: {
          signature: createTypographyContextSignature(
            track.id,
            "future",
            futureContextIndex,
            futureContextIndex === null
              ? undefined
              : lines[futureContextIndex]?.atMs,
          ),
          glyph: futureContextGlyph,
        },
      };
      const atSongEnd =
        !isPlaying
        && track.durationMs > 0
        && playbackPosition >= track.durationMs - 16;

      if (atSongEnd) {
        endingStartedAtRef.current ??= now;
      } else {
        endingStartedAtRef.current = null;
      }

      const endingElapsed = endingStartedAtRef.current === null
        ? 0
        : now - endingStartedAtRef.current;
      const endingProgress = atSongEnd
        ? smoothStep(
            endingElapsed
              / motionTokens.typographyPoster.pastTransitionMaximumMs,
          )
        : 0;
      const playbackPhaseName = atSongEnd
        ? endingProgress >= 1
          ? "ended"
          : "ending"
        : playbackPhase.waiting
          ? "waiting"
          : "live";

      if (root.dataset.playbackPhase !== playbackPhaseName) {
        root.dataset.playbackPhase = playbackPhaseName;
      }
      if (root.dataset.typographyScene !== playbackPhase.scene) {
        root.dataset.typographyScene = playbackPhase.scene;
      }
      const posterTemplate = architectureTemplate;
      if (root.dataset.posterTemplate !== posterTemplate) {
        root.dataset.posterTemplate = posterTemplate;
      }
      if (
        root.dataset.posterSceneId !== posterScene?.id
        || !root.style.getPropertyValue("--poster-scene-density")
      ) {
        root.dataset.posterSceneId = posterScene?.id ?? "none";
        root.dataset.posterObjectCount = String(
          posterScene?.occupancy.backgroundObjectCount ?? 0,
        );
        root.dataset.posterOccupancy = (
          posterScene?.occupancy.visualOccupancy ?? 0
        ).toFixed(3);
        root.dataset.posterLargestGlyph = (
          posterScene?.occupancy.largestGlyphRatio ?? 0
        ).toFixed(3);
        root.dataset.posterBalance = (
          posterScene?.occupancy.sceneBalanceScore ?? 0
        ).toFixed(3);
        root.style.setProperty(
          "--poster-scene-density",
          (posterScene?.density ?? 0.4).toFixed(3),
        );
        root.style.setProperty(
          "--poster-depth-strength",
          (posterScene?.depthStrength ?? 0.6).toFixed(3),
        );
      }
      if (root.dataset.posterPhase !== posterPhase) {
        root.dataset.posterPhase = posterPhase;
      }
      if (root.dataset.gapKind !== playbackPhase.gapKind) {
        root.dataset.gapKind = playbackPhase.gapKind;
      }
      const interludeKind = interlude?.kind ?? "none";
      if (root.dataset.interludeKind !== interludeKind) {
        root.dataset.interludeKind = interludeKind;
      }
      root.style.setProperty(
        "--scroll-ending-progress",
        endingProgress.toFixed(4),
      );
      root.style.setProperty(
        "--scroll-interlude-strength",
        playbackPhase.interludeStrength.toFixed(4),
      );
      syncTypographySpatialBed(
        spatialBed,
        now,
        spatialBedClockOriginRef.current,
        isPlaying,
        prefersReducedMotion,
      );
      syncTypographyAtriumMotion(
        memoryLayer,
        now,
        isPlaying,
        prefersReducedMotion,
      );
      syncTypographyArchitectureLayer(
        memoryLayer,
        architectureTarget,
        prefersReducedMotion,
        now,
        architectureRuntimeRef.current,
      );
      syncTypographyContextLayer(
        memoryLayer,
        contextTargets,
        posterPhase,
        prefersReducedMotion,
        now,
        contextRuntime,
      );
      const presenceMode = resolveTypographyPresenceMode({
        lyricsStatus,
        hasReadyLyrics,
        hasCurrentLyric: currentOwnerIndex !== null,
        waiting: playbackPhase.waiting,
        playbackTimeMs: playbackPosition,
        gapStartMs: playbackPhase.gapStartMs,
        gapEndMs: playbackPhase.gapEndMs,
        gapDurationMs: playbackPhase.gapDurationMs,
      });
      syncTypographyPresence(
        root,
        presenceMode,
        presenceRuntimeRef.current,
      );

      const viewportHeight = window.innerHeight;
      const spatialPlaybackPosition = playbackPosition
        + (atSongEnd ? endingElapsed : 0);
      const candidates: Array<{
        element: HTMLElement;
        index: number;
        values: LyricSpatialValues;
      }> = [];
      lyricElements.forEach((element) => {
        if (element.dataset.nodeIndex === undefined) {
          if (element.style.getPropertyValue("--scroll-opacity") !== "0") {
            element.style.setProperty("--scroll-opacity", "0");
          }
          return;
        }
        const index = Number(element.dataset.nodeIndex);
        const values = getSpatialValues(
          lines,
          lineTimings,
          posterPlan,
          index,
          spatialPlaybackPosition,
          viewportHeight,
          layoutMetricsRef.current.get(index),
          playbackPhase,
          prefersReducedMotion,
        );
        candidates.push({
          element,
          index,
          values,
        });
      });

      candidates.forEach((candidate) => {
        const { element, index } = candidate;
        const values = candidate.values;
        const isEndingLine = atSongEnd && index === lines.length - 1;
        const layoutMetric = layoutMetricsRef.current.get(index);
        const preferredColumnCount = posterPlan.linePlans[index]
          ?.preferredColumns ?? 1;

        const nextVisual: ScrollNodeVisual = {
          index,
          state: values.state,
          role: values.role,
          activeProtected: values.activeProtected,
          waitingRole: values.waitingRole,
          ending: isEndingLine,
          x: `${values.x.toFixed(3)}vw`,
          y: `${values.y.toFixed(2)}px`,
          depth: `${values.depth.toFixed(2)}px`,
          opacity: values.opacity.toFixed(3),
          blur: `${values.blur.toFixed(2)}px`,
          scale: values.scale.toFixed(4),
          lineHeight: `${(
            layoutMetric?.extentPx
            ?? Math.min(viewportHeight * 0.58, viewportHeight * 0.22)
          ).toFixed(2)}px`,
          fontSize: layoutMetric
            ? `${layoutMetric.fontSizePx.toFixed(2)}px`
            : "",
          columnCount: Math.max(
            layoutMetric?.columnCount ?? 1,
            preferredColumnCount,
          ) as 1 | 2,
        };
        const previousVisual = nodeVisualCacheRef.current.get(element);

        if (previousVisual?.state !== nextVisual.state) {
          element.dataset.state = nextVisual.state;
        }
        if (previousVisual?.role !== nextVisual.role) {
          element.dataset.liveRole = nextVisual.role;
        }
        if (
          previousVisual?.activeProtected !== nextVisual.activeProtected
        ) {
          element.dataset.activeProtected = String(
            nextVisual.activeProtected,
          );
        }
        if (previousVisual?.waitingRole !== nextVisual.waitingRole) {
          element.dataset.waitingRole = nextVisual.waitingRole;
        }
        if (previousVisual?.ending !== nextVisual.ending) {
          element.dataset.ending = String(nextVisual.ending);
        }
        if (previousVisual?.x !== nextVisual.x) {
          element.style.setProperty("--scroll-x", nextVisual.x);
        }
        if (previousVisual?.y !== nextVisual.y) {
          element.style.setProperty("--scroll-y", nextVisual.y);
        }
        if (previousVisual?.depth !== nextVisual.depth) {
          element.style.setProperty("--scroll-depth", nextVisual.depth);
        }
        if (previousVisual?.opacity !== nextVisual.opacity) {
          element.style.setProperty(
            "--scroll-opacity",
            nextVisual.opacity,
          );
        }
        if (previousVisual?.blur !== nextVisual.blur) {
          element.style.setProperty("--scroll-blur", nextVisual.blur);
        }
        if (previousVisual?.scale !== nextVisual.scale) {
          element.style.setProperty("--scroll-scale", nextVisual.scale);
        }
        if (previousVisual?.lineHeight !== nextVisual.lineHeight) {
          element.style.setProperty(
            "--scroll-line-height",
            nextVisual.lineHeight,
          );
        }
        if (previousVisual?.fontSize !== nextVisual.fontSize) {
          element.style.setProperty(
            "--scroll-font-size",
            nextVisual.fontSize,
          );
        }
        if (previousVisual?.columnCount !== nextVisual.columnCount) {
          element.dataset.columnCount = String(nextVisual.columnCount);
        }
        nodeVisualCacheRef.current.set(element, nextVisual);
      });
    };

    updateVisuals(performance.now());
    return motionController.subscribeFrame(updateVisuals);
  }, [
    hasReadyLyrics,
    isPlaying,
    lineTimings,
    lines,
    lyricsStatus,
    posterPlan,
    prefersReducedMotion,
    safeActiveIndex,
    track.durationMs,
    track.id,
  ]);

  const renderCenterIndex = safeActiveIndex;
  const poolAssignments = useMemo(() => {
    const start = renderCenterIndex - visiblePastLines;
    const firstPoolSlot = positiveModulo(start, lyricPoolSize);

    return Array.from(
      { length: lyricPoolSize },
      (_, poolSlot) => {
        const index =
          start
          + positiveModulo(
            poolSlot - firstPoolSlot,
            lyricPoolSize,
          );

        return {
          poolSlot,
          index:
            index >= 0 && index < lines.length
              ? index
              : null,
        };
      },
    );
  }, [lines.length, renderCenterIndex]);
  const initialPlaybackTime = elapsedMs;
  const initialPlaybackPhase = hasReadyLyrics
    ? getPlaybackPhase(
        lines,
        lineTimings,
        initialPlaybackTime,
        track.durationMs,
        safeActiveIndex,
      )
    : null;
  const initialHasCurrentLyric = Boolean(
    initialPlaybackPhase
    && !initialPlaybackPhase.waiting
    && initialPlaybackPhase.activeLineIndex !== null
    && initialPlaybackPhase.activeLineIndex === safeActiveIndex,
  );
  return (
    <div
      className="immersive-player__lyrics scroll-lyrics-space"
      ref={rootRef}
      style={typographySpaceStyle}
      data-listening-space="typography"
      data-playback-phase={hasReadyLyrics ? "live" : "waiting"}
      data-typography-scene={hasReadyLyrics ? "origin" : "interlude"}
      data-poster-template={posterPlan.scenes[0]?.template ?? "monument"}
      data-poster-scene-id={posterPlan.scenes[0]?.id ?? "none"}
      data-poster-phase={hasReadyLyrics ? "live" : "suspension"}
      data-gap-kind={hasReadyLyrics ? "none" : "interlude"}
      data-interlude-kind={hasReadyLyrics ? "none" : "long"}
      data-has-current-lyric={initialHasCurrentLyric}
      data-presence-mode={hasReadyLyrics ? "lyrics" : "lyrics-unavailable"}
      data-lyrics-status={lyricsStatus}
      data-playing={isPlaying}
      data-timing-source={currentTimingSource}
      aria-label={
        !hasReadyLyrics
          ? t("space.typography.instrumental")
          : currentTimingSource !== "line-estimated"
          ? t("space.typography.exact")
          : t("space.typography.fallback")
      }
    >
      <div className="scroll-lyrics-space__ambient-field" aria-hidden="true" />
      <section
        className="scroll-lyrics-space__lyric-stage"
        ref={lyricStageRef}
        aria-label={t("space.typography.poster")}
      >
        <div
          className="typography-poster__spatial-bed"
          ref={spatialBedRef}
          aria-hidden="true"
        >
          <span className="typography-poster__bed-fog" />
          <span className="typography-poster__bed-line" data-line="primary" />
          <span className="typography-poster__bed-line" data-line="secondary" />
          <span className="typography-poster__bed-glyph" data-edge="left">（</span>
          <span className="typography-poster__bed-glyph" data-edge="right">—</span>
          <span className="typography-poster__bed-material" />
        </div>
        <div
          className="typography-poster__memory-layer"
          ref={memoryLayerRef}
          data-active-architecture-bank="0"
          aria-hidden="true"
        >
          {([0, 1] as const).map((bank) => (
            <div
              className="typography-poster__architecture-bank"
              data-architecture-bank={bank}
              key={`typography-architecture-bank-${bank}`}
            >
              {Array.from(
                { length: typographyMemorySlotCount },
                (_, slot) => (
                  <span
                    className="typography-poster__memory-glyph"
                    data-architecture-slot={slot}
                    key={`typography-architecture-${bank}-${slot}`}
                  />
                ),
              )}
            </div>
          ))}
          <div className="typography-poster__context-layer">
            {(["past", "future"] as const).flatMap((role) =>
              ([0, 1] as const).map((buffer) => (
                <div
                  className="typography-poster__context-buffer"
                  data-context-role={role}
                  data-context-buffer={buffer}
                  key={`typography-context-${role}-${buffer}`}
                >
                  <span
                    className="typography-poster__memory-glyph"
                    data-context-glyph
                  />
                </div>
              )),
            )}
          </div>
        </div>
        <div className="typography-poster__breath-presence" aria-hidden="true">
          <span className="typography-poster__breath-glyph">（</span>
          <span className="typography-poster__breath-line" data-line="primary" />
          <span className="typography-poster__breath-line" data-line="secondary" />
          <span className="typography-poster__breath-fog" />
          <span className="typography-poster__breath-mark">—</span>
        </div>
        <div
          className="scroll-lyrics-space__stream"
          ref={streamRef}
          aria-hidden="true"
        >
          {poolAssignments.map(({ index, poolSlot }) => {
            if (index === null) {
              return (
                <article
                  className="scroll-lyric"
                  data-pool-slot={poolSlot}
                  data-state="future"
                  data-live-role="hidden"
                  key={`lyric-pool-${poolSlot}`}
                  style={{
                    "--scroll-x": "0vw",
                    "--scroll-y": "0px",
                    "--scroll-depth": "-100px",
                    "--scroll-opacity": "0",
                    "--scroll-blur": "8px",
                    "--scroll-scale": "0.8",
                    "--scroll-line-height": "18vh",
                    "--scroll-font-size": "clamp(28px, 3.7vw, 56px)",
                  } as ScrollLyricStyle}
                />
              );
            }

            const line = lines[index];
            const primaryText = getPrimaryText(line, showOriginalLyrics);
            const language = detectLyricLanguage(primaryText);
            const layoutMetric = layoutMetricsRef.current.get(index);
            const columnCount: 1 | 2 =
              Math.max(
                layoutMetric?.columnCount
                  ?? (
                    lineTimings[index].glyphCount * 18
                      > viewportHeight * 0.58
                      ? 2
                      : 1
                  ),
                posterPlan.linePlans[index]?.preferredColumns ?? 1,
              ) as 1 | 2;
            const node = createLyricNode(
              lines,
              lineTimings,
              posterPlan,
              index,
              initialPlaybackTime,
              viewportHeight,
              showOriginalLyrics,
              track.durationMs,
              safeActiveIndex,
              layoutMetric,
              prefersReducedMotion,
            );

            return (
              <article
                className="scroll-lyric"
                data-node-index={index}
                data-pool-slot={poolSlot}
                data-state={node.state}
                data-live-role={node.role}
                data-active-protected={node.activeProtected}
                data-waiting-role={node.waitingRole}
                data-ending="false"
                data-column-count={columnCount}
                data-timing-source={lineTimings[index].source}
                key={`lyric-pool-${poolSlot}`}
                style={{
                  "--scroll-x": `${node.x}vw`,
                  "--scroll-y": `${node.y}px`,
                  "--scroll-depth": `${node.depth}px`,
                  "--scroll-opacity": `${node.opacity}`,
                  "--scroll-blur": `${node.blur}px`,
                  "--scroll-scale": `${node.scale}`,
                  "--scroll-line-height": `${
                    layoutMetric?.extentPx
                    ?? viewportHeight * 0.22
                  }px`,
                  "--scroll-font-size": layoutMetric
                    ? `${layoutMetric.fontSizePx}px`
                    : "clamp(28px, 3.7vw, 56px)",
                } as ScrollLyricStyle}
              >
                <div className="scroll-lyric__content">
                  <p data-language={language} lang={language}>
                    <LyricRevealEngine
                      active
                      columnCount={columnCount}
                      elapsedMs={elapsedMs}
                      isPlaying={isPlaying}
                      lang={language}
                      line={line}
                      lineEndMs={lineTimings[index].endTime}
                      lineState={
                        initialPlaybackTime < line.atMs
                          ? "future"
                          : initialPlaybackTime < lineTimings[index].endTime
                            ? "current"
                            : "past"
                      }
                      nextLine={revealNextLines[index]}
                      text={primaryText}
                      variant="scroll"
                    />
                  </p>
                  {showOriginalLyrics
                    && showTranslation
                    && line.translation && (
                    <span
                      className="scroll-lyric__translation"
                      lang="zh-CN"
                    >
                      {line.translation}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <aside
        className="scroll-album-space"
        style={albumSpaceStyle}
        aria-label={t("space.typography.album", { album: track.album })}
      >
        <div className="scroll-album-space__visual" aria-hidden="true">
          <span className="scroll-album-space__echo" data-echo="far" />
          <span className="scroll-album-space__echo" data-echo="near" />
          <div className="scroll-album-space__cover">
            <span className="scroll-album-space__fallback">
              <strong>{track.title}</strong>
              <small>{track.artist}</small>
              <em>{track.coverLabel}</em>
            </span>
            {track.coverImage && (
              <img
                alt=""
                draggable="false"
                src={track.coverImage}
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
              />
            )}
          </div>
        </div>
        <div className="scroll-album-space__copy">
          <span className="scroll-album-space__eyebrow">
            ALBUM SPACE / 03
          </span>
          <strong lang="ja">{track.title}</strong>
          {track.translatedTitle && (
            <span className="scroll-album-space__translation" lang="zh-CN">
              {track.translatedTitle}
            </span>
          )}
          <span className="scroll-album-space__artist">{track.artist}</span>
          <span className="scroll-album-space__album">{track.album}</span>
          {track.releaseInfo && (
            <span className="scroll-album-space__release">
              {track.releaseInfo}
            </span>
          )}
        </div>
      </aside>

      <p
        className="immersive-player__lyric-announcer"
        aria-live="polite"
        aria-atomic="true"
      >
        {initialHasCurrentLyric ? currentText : ""}
        {initialHasCurrentLyric
          && currentLine
          && showOriginalLyrics
          && showTranslation
          && currentLine.translation
          ? `，${currentLine.translation}`
          : ""}
      </p>
    </div>
  );
});
