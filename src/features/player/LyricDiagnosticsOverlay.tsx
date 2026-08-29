import { memo, useEffect, useRef } from "react";
import {
  getNormalizedLyricIndex,
  getNormalizedLyricWordIndex,
} from "../lyrics/LyricTruth";
import type { NormalizedLyricDocument } from "../../types/music";
import "./lyric-diagnostics.css";

const diagnosticsStorageKey = "tingjing:lyric-diagnostics";

export interface LyricDiagnosticsOverlayProps {
  document: NormalizedLyricDocument;
  trackId: string;
  elapsedMs: number;
  activeIndex: number;
  wordIndex: number;
  playerTimeMs?: number;
  deviationMs?: number;
  readElapsedMs?: () => number;
  readPlayerTimeMs?: () => number;
  className?: string;
}

const formatMilliseconds = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  const sign = value < 0 ? "−" : "";
  const absolute = Math.abs(value);
  const minutes = Math.floor(absolute / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  const milliseconds = Math.floor(absolute % 1_000);
  return `${sign}${minutes}:${seconds.toString().padStart(2, "0")}.${milliseconds
    .toString()
    .padStart(3, "0")}`;
};

const isEnabledValue = (value: string | null) =>
  value === "1" || value === "true" || value === "on";

/**
 * Development-only switch. Query-string activation is intentionally checked
 * before local storage so a diagnostics URL is self-contained and shareable.
 */
export const isLyricDiagnosticsEnabled = () => {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  const queryValue = new URLSearchParams(window.location.search).get(
    "lyricDiagnostics",
  );
  if (isEnabledValue(queryValue)) {
    return true;
  }

  try {
    return isEnabledValue(window.localStorage.getItem(diagnosticsStorageKey));
  } catch {
    return false;
  }
};

const LyricDiagnosticsOverlayComponent = ({
  document,
  trackId,
  elapsedMs,
  activeIndex,
  wordIndex,
  playerTimeMs,
  deviationMs,
  readElapsedMs,
  readPlayerTimeMs,
  className,
}: LyricDiagnosticsOverlayProps) => {
  const enabled = isLyricDiagnosticsEnabled();

  const activeLine = document.lines[activeIndex];
  const activeWord = activeLine?.words?.[wordIndex];
  const resolvedDeviationMs =
    deviationMs ??
    (playerTimeMs === undefined ? undefined : playerTimeMs - elapsedMs);
  const rejectionReasons = Object.entries(
    document.diagnostics.rejectedWordTimingReasons,
  )
    .filter(([, count]) => Boolean(count))
    .map(([reason, count]) => `${reason} ×${count}`)
    .join(", ");
  const invalidLineReasons = document.diagnostics.invalidLineReasons.join(", ");
  const wordTimingState = activeLine?.words?.length
    ? "accepted"
    : activeLine?.wordTimingRejection
      ? `rejected: ${activeLine.wordTimingRejection}`
      : document.diagnostics.providerWordTimingAvailable
        ? "not used"
        : "unavailable";
  const classes = ["lyric-diagnostics", className].filter(Boolean).join(" ");
  const lineValueRef = useRef<HTMLElement>(null);
  const wordValueRef = useRef<HTMLElement>(null);
  const elapsedValueRef = useRef<HTMLElement>(null);
  const playerValueRef = useRef<HTMLElement>(null);
  const deviationValueRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!enabled || (!readElapsedMs && !readPlayerTimeMs)) {
      return;
    }

    let frameId = 0;
    const paint = () => {
      const liveElapsedMs = readElapsedMs?.() ?? elapsedMs;
      const livePlayerTimeMs = readPlayerTimeMs?.() ?? playerTimeMs;
      const liveLineIndex = getNormalizedLyricIndex(
        document,
        liveElapsedMs,
      );
      const liveWordIndex = getNormalizedLyricWordIndex(
        document,
        liveLineIndex,
        liveElapsedMs,
      );
      const liveLine = document.lines[liveLineIndex];

      if (lineValueRef.current) {
        lineValueRef.current.textContent =
          (liveLineIndex >= 0 ? String(liveLineIndex) : "—")
          + " / "
          + document.lines.length;
      }
      if (wordValueRef.current) {
        wordValueRef.current.textContent =
          (liveWordIndex >= 0 ? String(liveWordIndex) : "—")
          + " / "
          + (liveLine?.words?.length ?? 0);
      }
      if (elapsedValueRef.current) {
        elapsedValueRef.current.textContent = formatMilliseconds(liveElapsedMs);
      }
      if (playerValueRef.current) {
        playerValueRef.current.textContent = formatMilliseconds(
          livePlayerTimeMs,
        );
      }
      if (deviationValueRef.current) {
        deviationValueRef.current.textContent = formatMilliseconds(
          livePlayerTimeMs === undefined
            ? undefined
            : livePlayerTimeMs - liveElapsedMs,
        );
      }
      frameId = window.requestAnimationFrame(paint);
    };

    frameId = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frameId);
  }, [
    document,
    elapsedMs,
    enabled,
    playerTimeMs,
    readElapsedMs,
    readPlayerTimeMs,
  ]);

  if (!enabled) {
    return null;
  }

  return (
    <aside
      aria-label="Lyric diagnostics"
      className={classes}
      data-lyric-quality={document.timingQuality}
      data-lyric-source={document.source}
    >
      <header className="lyric-diagnostics__header">
        <strong>LYRIC TRUTH</strong>
        <span>{document.timingQuality}</span>
      </header>

      <dl className="lyric-diagnostics__grid">
        <dt>Provider</dt>
        <dd>{document.provider}</dd>
        <dt>Track key</dt>
        <dd title={document.trackKey}>{document.trackKey}</dd>
        <dt>Track id</dt>
        <dd title={trackId}>{trackId}</dd>
        <dt>Source</dt>
        <dd>{document.source}</dd>
        <dt>Quality</dt>
        <dd>{document.timingQuality}</dd>
        <dt>Line</dt>
        <dd ref={lineValueRef}>
          {activeIndex >= 0 ? activeIndex : "—"} / {document.lines.length}
        </dd>
        <dt>Word</dt>
        <dd ref={wordValueRef}>
          {wordIndex >= 0 ? wordIndex : "—"} / {activeLine?.words?.length ?? 0}
        </dd>
        <dt>Line raw</dt>
        <dd>
          {formatMilliseconds(activeLine?.rawStartTimeMs)} →{" "}
          {formatMilliseconds(activeLine?.rawEndTimeMs)}
        </dd>
        <dt>Line applied</dt>
        <dd>
          {formatMilliseconds(activeLine?.startTimeMs)} →{" "}
          {formatMilliseconds(activeLine?.endTimeMs)}
        </dd>
        <dt>Word raw</dt>
        <dd>
          {formatMilliseconds(activeWord?.rawStartTimeMs)} →{" "}
          {formatMilliseconds(activeWord?.rawEndTimeMs)}
        </dd>
        <dt>Word applied</dt>
        <dd>
          {formatMilliseconds(activeWord?.startTimeMs)} →{" "}
          {formatMilliseconds(activeWord?.endTimeMs)}
        </dd>
        <dt>Word timing</dt>
        <dd>{wordTimingState}</dd>
        <dt>Offset</dt>
        <dd>{formatMilliseconds(document.offsetMs)}</dd>
        <dt>Elapsed</dt>
        <dd ref={elapsedValueRef}>{formatMilliseconds(elapsedMs)}</dd>
        <dt>Player</dt>
        <dd ref={playerValueRef}>{formatMilliseconds(playerTimeMs)}</dd>
        <dt>Deviation</dt>
        <dd ref={deviationValueRef}>{formatMilliseconds(resolvedDeviationMs)}</dd>
      </dl>

      <div className="lyric-diagnostics__summary">
        <p>
          lines {document.diagnostics.validLineCount}/
          {document.diagnostics.sourceLineCount} · word timed{" "}
          {document.diagnostics.wordTimedLineCount}
        </p>
        {activeLine ? (
          <p className="lyric-diagnostics__current" title={activeLine.text}>
            {activeLine.text}
          </p>
        ) : null}
        {activeWord ? (
          <p className="lyric-diagnostics__current" title={activeWord.text}>
            word: {activeWord.text}
          </p>
        ) : null}
        {rejectionReasons ? <p>rejected: {rejectionReasons}</p> : null}
        {invalidLineReasons ? <p>invalid: {invalidLineReasons}</p> : null}
      </div>
    </aside>
  );
};

export const LyricDiagnosticsOverlay = memo(
  LyricDiagnosticsOverlayComponent,
);
