import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { motionController } from "../../config/MotionController";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type {
  LyricLine,
  NormalizedLyricDocument,
  Track,
} from "../../types/music";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  detectLyricLanguage,
  LyricRevealEngine,
} from "./LyricRevealEngine";

type FlowLyricState = "past" | "current" | "future";

type FlowLineStyle = CSSProperties &
  Record<"--flow-node-y", string>;

interface FlowListeningSpaceProps {
  track: Track;
  lyrics: NormalizedLyricDocument;
  activeIndex: number;
  elapsedMs: number;
  isPlaying: boolean;
  showOriginalLyrics: boolean;
  showTranslation: boolean;
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

function getLineState(index: number, activeIndex: number): FlowLyricState {
  if (index < activeIndex) {
    return "past";
  }

  if (index === activeIndex) {
    return "current";
  }

  return "future";
}

const flowLineGapPx = 132;
const visiblePastLines = 5;
const visibleFutureLines = 5;

function getFixedLinePlacement(
  index: number,
): FlowLineStyle {
  // Each node keeps one immutable coordinate. The camera moves across those
  // coordinates, so the DOM order never changes. Time runs vertically with
  // future lines above the focus and past lines below it.
  return {
    "--flow-node-y": `${-index * flowLineGapPx}px`,
  };
}

interface FlowLyricNodeProps {
  index: number;
  line: LyricLine;
  nextLine?: LyricLine;
  state: FlowLyricState;
  near: boolean;
  elapsedMs: number;
  isPlaying: boolean;
  showOriginalLyrics: boolean;
  showTranslation: boolean;
}

const FlowLyricNode = memo(function FlowLyricNode({
  index,
  line,
  nextLine,
  state,
  near,
  elapsedMs,
  isPlaying,
  showOriginalLyrics,
  showTranslation,
}: FlowLyricNodeProps) {
  const text = getPrimaryText(line, showOriginalLyrics);
  const language = detectLyricLanguage(text);
  const placement = useMemo(
    () => getFixedLinePlacement(index),
    [index],
  );

  return (
    <div
      className="flow-lyric"
      data-state={state}
      data-near={near}
      data-node-index={index}
      style={placement}
    >
      <p data-language={language} lang={language}>
        <LyricRevealEngine
          active={state === "current"}
          className="flow-lyric__reveal"
          elapsedMs={elapsedMs}
          isPlaying={isPlaying}
          lang={language}
          line={line}
          lineState={state}
          nextLine={nextLine}
          text={text}
          variant="flow"
        />
      </p>
      {state === "current"
        && showOriginalLyrics
        && showTranslation
        && line.translation && (
        <span className="flow-lyric__translation" lang="zh-CN">
          {line.translation}
        </span>
      )}
    </div>
  );
});

export const FlowListeningSpace = memo(function FlowListeningSpace({
  track,
  lyrics,
  activeIndex,
  elapsedMs,
  isPlaying,
  showOriginalLyrics,
  showTranslation,
}: FlowListeningSpaceProps) {
  const { t } = useLanguage();
  const lines = lyrics.lines;
  const safeActiveIndex = activeIndex >= 0 && activeIndex < lines.length
    ? activeIndex
    : -1;
  const currentLine = safeActiveIndex >= 0
    ? lines[safeActiveIndex]
    : undefined;
  const currentText = currentLine
    ? getPrimaryText(currentLine, showOriginalLyrics)
    : "";
  const prefersReducedMotion = useReducedMotion();
  const fieldRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(safeActiveIndex * flowLineGapPx);
  const cameraTargetRef = useRef(cameraRef.current);
  const cameraTrackRef = useRef(track.id);
  cameraTargetRef.current = safeActiveIndex * flowLineGapPx;
  const visibleLineIndices = useMemo(() => {
    const start = safeActiveIndex - visiblePastLines;
    const end = safeActiveIndex + visibleFutureLines;

    return Array.from(
      { length: end - start + 1 },
      (_, offset) => start + offset,
    ).filter((index) => index >= 0 && index < lines.length);
  }, [lines.length, safeActiveIndex]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) {
      return;
    }

    if (cameraTrackRef.current !== track.id || prefersReducedMotion) {
      cameraTrackRef.current = track.id;
      cameraRef.current = cameraTargetRef.current;
      field.style.transform = `translate3d(0, ${cameraRef.current}px, 0)`;
      if (prefersReducedMotion) {
        return;
      }
    }

    let settledFrames = 0;
    let unsubscribe: () => void = () => undefined;
    const renderCamera = (_now: number, deltaMs = 16.67) => {
      const target = cameraTargetRef.current;
      const damping = 1 - Math.pow(0.9, Math.max(0, deltaMs) / 16.67);
      cameraRef.current += (target - cameraRef.current) * damping;

      if (Math.abs(target - cameraRef.current) < 0.05) {
        cameraRef.current = target;
        settledFrames += 1;
      } else {
        settledFrames = 0;
      }

      field.style.transform = `translate3d(0, ${cameraRef.current.toFixed(3)}px, 0)`;
      if (settledFrames >= 2) {
        unsubscribe();
      }
    };

    // Measure the new target during the layout phase without consuming part
    // of the camera movement before the next painted frame. This removes the
    // small but visible step that used to happen exactly when a line changed.
    renderCamera(performance.now(), 0);
    if (settledFrames < 2) {
      unsubscribe = motionController.subscribeFrame(renderCamera);
    }
    return unsubscribe;
  }, [prefersReducedMotion, safeActiveIndex, track.id]);

  return (
    <div
      className="immersive-player__lyrics flow-listening-space"
      data-listening-space="flow"
      aria-label={t("space.lyricsFlow.aria")}
    >
      <div
        className="flow-listening-space__field"
        ref={fieldRef}
        aria-hidden="true"
      >
        {visibleLineIndices.map((index) => {
          const line = lines[index];
          const state = getLineState(index, safeActiveIndex);
          const distance = Math.abs(index - safeActiveIndex);

          return (
            <FlowLyricNode
              elapsedMs={state === "current" ? elapsedMs : line.atMs}
              index={index}
              isPlaying={state === "current" && isPlaying}
              key={`flow-line-${index}`}
              line={line}
              near={distance <= 2}
              nextLine={lines[index + 1]}
              showOriginalLyrics={showOriginalLyrics}
              showTranslation={showTranslation}
              state={state}
            />
          );
        })}
      </div>

      <p
        className="immersive-player__lyric-announcer"
        aria-live="polite"
        aria-atomic="true"
      >
        {currentText}
        {showOriginalLyrics
          && showTranslation
          && currentLine?.translation
          ? `，${currentLine.translation}`
          : ""}
      </p>
    </div>
  );
});
