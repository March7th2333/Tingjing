import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  LyricsStatus,
  LyricTimingQuality,
  LyricTimingSource,
  NormalizedLyricDocument,
  NormalizedLyricLine,
} from "../../types/music";
import { useLanguage } from "../../i18n/LanguageContext";
import type { MessageKey } from "../../i18n/messages";
import "./full-lyrics-overlay.css";

const rowGap = 10;
const overscanPx = 520;
const defaultViewportHeight = 640;
const closeDurationMs = 280;

const sourceLabels: Record<LyricTimingSource, string> = {
  provider: "PROVIDER",
  ttml: "TTML",
  qrc: "QRC",
  yrc: "YRC",
  krc: "KRC",
  lrc: "LRC",
  embedded: "EMBEDDED",
  sidecar: "SIDECAR",
  manual: "MANUAL",
  none: "NO SOURCE",
};

const qualityLabelKeys: Record<LyricTimingQuality, MessageKey> = {
  "word-exact": "lyrics.quality.wordExact",
  aligned: "lyrics.quality.aligned",
  "line-only": "lyrics.quality.lineOnly",
  estimated: "lyrics.quality.estimated",
  unavailable: "lyrics.quality.unavailable",
};

function formatClock(timeMs: number) {
  const seconds = Math.max(0, Math.floor(timeMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatOffset(offsetMs: number) {
  if (offsetMs === 0) return "0.00s";
  return `${offsetMs > 0 ? "+" : "−"}${(Math.abs(offsetMs) / 1_000).toFixed(2)}s`;
}

function estimateRowHeight(line: NormalizedLyricLine, showTranslation: boolean) {
  const textLines = Math.max(1, Math.ceil(Array.from(line.text).length / 28));
  const translationLines = showTranslation && line.translation
    ? Math.max(1, Math.ceil(Array.from(line.translation).length / 42))
    : 0;
  return 52 + textLines * 27 + translationLines * 20;
}

function findIndexForOffset(offsets: number[], target: number) {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  let candidate = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] <= target) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return candidate;
}

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("inert") && element.offsetParent !== null);
}

interface FullLyricsRowProps {
  line: NormalizedLyricLine;
  index: number;
  active: boolean;
  canSeek: boolean;
  showTranslation: boolean;
  top: number;
  onSeek: (index: number) => void;
}

const FullLyricsRow = memo(function FullLyricsRow({
  line,
  index,
  active,
  canSeek,
  showTranslation,
  top,
  onSeek,
}: FullLyricsRowProps) {
  const { t } = useLanguage();
  return (
    <button
      className="full-lyrics-overlay__line"
      type="button"
      data-active={active}
      data-lyric-row={index}
      disabled={!canSeek}
      style={{ transform: `translate3d(0, ${top}px, 0)` }}
      onClick={() => onSeek(index)}
      aria-current={active ? "true" : undefined}
      aria-label={canSeek
        ? t("lyrics.full.seek", {
            time: formatClock(line.startTimeMs),
            text: line.text,
          })
        : line.text}
    >
      <time dateTime={`PT${Math.max(0, line.startTimeMs / 1_000)}S`}>
        {formatClock(line.startTimeMs)}
      </time>
      <span className="full-lyrics-overlay__line-copy">
        <strong>{line.text}</strong>
        {showTranslation && line.translation ? <small>{line.translation}</small> : null}
      </span>
    </button>
  );
});

export interface FullLyricsOverlayProps {
  id?: string;
  open: boolean;
  lyrics: NormalizedLyricDocument;
  elapsedMs: number;
  activeIndex: number;
  showTranslation: boolean;
  canSeek: boolean;
  status?: LyricsStatus;
  errorMessage?: string | null;
  offsetStepMs?: number;
  canAdjustOffset?: boolean;
  onOffsetChange: (nextOffsetMs: number) => void;
  onSeek: (timeMs: number, lineIndex: number) => void;
  onRequestClose: () => void;
  onAfterClose?: () => void;
}

export const FullLyricsOverlay = memo(function FullLyricsOverlay({
  id = "full-lyrics-overlay",
  open,
  lyrics,
  elapsedMs,
  activeIndex,
  showTranslation,
  canSeek,
  status,
  errorMessage,
  offsetStepMs = 100,
  canAdjustOffset = true,
  onOffsetChange,
  onSeek,
  onRequestClose,
  onAfterClose,
}: FullLyricsOverlayProps) {
  const { t } = useLanguage();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const measuredHeightsRef = useRef(new Map<string, number>());
  const measurementFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const wasOpenRef = useRef(open);
  const focusedForOpenRef = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(defaultViewportHeight);
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const [followingCurrent, setFollowingCurrent] = useState(true);

  const lines = lyrics.lines;
  const resolvedStatus = status ?? (lines.length > 0 ? "ready" : "empty");
  const resolvedActiveIndex = activeIndex >= 0 && activeIndex < lines.length
    ? activeIndex
    : -1;

  const layout = useMemo(() => {
    void measurementVersion;
    const offsets = new Array<number>(lines.length + 1).fill(0);
    const heights = lines.map((line) => (
      measuredHeightsRef.current.get(line.id)
        ?? estimateRowHeight(line, showTranslation)
    ));

    for (let index = 0; index < lines.length; index += 1) {
      offsets[index + 1] = offsets[index] + heights[index] + rowGap;
    }

    return {
      heights,
      offsets,
      totalHeight: Math.max(0, offsets[lines.length] - rowGap),
    };
  }, [lines, measurementVersion, showTranslation]);

  const visibleRange = useMemo(() => {
    if (lines.length === 0) return { start: 0, end: 0 };
    const start = Math.max(
      0,
      findIndexForOffset(layout.offsets, Math.max(0, scrollTop - overscanPx)) - 1,
    );
    const end = Math.min(
      lines.length,
      findIndexForOffset(
        layout.offsets,
        scrollTop + viewportHeight + overscanPx,
      ) + 2,
    );
    return { start, end };
  }, [layout.offsets, lines.length, scrollTop, viewportHeight]);

  const visibleLines = useMemo(
    () => lines.slice(visibleRange.start, visibleRange.end),
    [lines, visibleRange.end, visibleRange.start],
  );

  const scrollToLine = useCallback((index: number, behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    if (!viewport || index < 0 || index >= lines.length) return;
    const top = layout.offsets[index];
    const height = layout.heights[index];
    const destination = Math.max(0, top - (viewport.clientHeight - height) * 0.46);
    viewport.scrollTo({ top: destination, behavior });
  }, [layout.heights, layout.offsets, lines.length]);

  const returnToCurrent = useCallback(() => {
    setFollowingCurrent(true);
    scrollToLine(
      resolvedActiveIndex,
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    );
  }, [resolvedActiveIndex, scrollToLine]);

  const handleSeek = useCallback((index: number) => {
    const line = lines[index];
    if (!line || !canSeek) return;
    setFollowingCurrent(true);
    onSeek(line.startTimeMs, index);
    scrollToLine(index, "auto");
  }, [canSeek, lines, onSeek, scrollToLine]);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const viewport = viewportRef.current;
      if (viewport) setScrollTop(viewport.scrollTop);
    });
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onRequestClose();
      return;
    }

    if (event.key !== "Tab" || !rootRef.current) return;
    const elements = focusableElements(rootRef.current);
    if (elements.length === 0) {
      event.preventDefault();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onRequestClose]);

  useEffect(() => {
    if (!open) {
      focusedForOpenRef.current = false;
      return;
    }
    if (focusedForOpenRef.current) return;
    focusedForOpenRef.current = true;
    setFollowingCurrent(true);
    const frame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus({ preventScroll: true });
      scrollToLine(resolvedActiveIndex, "auto");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, resolvedActiveIndex, scrollToLine]);

  useEffect(() => {
    if (!open || !followingCurrent) return;
    scrollToLine(
      resolvedActiveIndex,
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    );
  }, [followingCurrent, open, resolvedActiveIndex, scrollToLine]);

  useEffect(() => {
    if (wasOpenRef.current && !open && onAfterClose) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const timer = window.setTimeout(onAfterClose, reduced ? 0 : closeDurationMs);
      wasOpenRef.current = open;
      return () => window.clearTimeout(timer);
    }
    wasOpenRef.current = open;
  }, [onAfterClose, open]);

  useEffect(() => {
    measuredHeightsRef.current.clear();
    setMeasurementVersion((version) => version + 1);
  }, [lyrics.trackKey, showTranslation]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateViewportHeight = () => {
      setViewportHeight(viewport.clientHeight || defaultViewportHeight);
    };
    updateViewportHeight();

    const resizeObserver = new ResizeObserver((entries) => {
      let changed = false;
      entries.forEach((entry) => {
        if (entry.target === viewport) {
          const nextViewportHeight = entry.contentRect.height || defaultViewportHeight;
          setViewportHeight((current) => (
            Math.abs(current - nextViewportHeight) > 0.5 ? nextViewportHeight : current
          ));
          return;
        }
        const row = entry.target as HTMLElement;
        const index = Number(row.dataset.lyricRow);
        const line = lines[index];
        if (!line) return;
        const nextHeight = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        const previousHeight = measuredHeightsRef.current.get(line.id);
        if (previousHeight === undefined || Math.abs(previousHeight - nextHeight) > 0.5) {
          measuredHeightsRef.current.set(line.id, nextHeight);
          changed = true;
        }
      });
      if (!changed || measurementFrameRef.current !== null) return;
      measurementFrameRef.current = window.requestAnimationFrame(() => {
        measurementFrameRef.current = null;
        setMeasurementVersion((version) => version + 1);
      });
    });

    resizeObserver.observe(viewport);
    viewport.querySelectorAll<HTMLElement>("[data-lyric-row]").forEach((row) => {
      resizeObserver.observe(row);
    });

    return () => resizeObserver.disconnect();
  }, [lines, visibleRange.end, visibleRange.start]);

  useEffect(() => () => {
    if (measurementFrameRef.current !== null) {
      window.cancelAnimationFrame(measurementFrameRef.current);
    }
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  const activeIsVisible = resolvedActiveIndex >= visibleRange.start
    && resolvedActiveIndex < visibleRange.end;

  return (
    <div
      className="full-lyrics-overlay"
      ref={rootRef}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      onKeyDown={handleKeyDown}
    >
      <button
        className="full-lyrics-overlay__scrim"
        type="button"
        tabIndex={-1}
        aria-label={t("lyrics.full.close")}
        onClick={onRequestClose}
      />

      <section
        className="full-lyrics-overlay__surface"
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-meta`}
      >
        <header className="full-lyrics-overlay__header">
          <div>
            <span className="full-lyrics-overlay__eyebrow">FULL LYRICS</span>
            <h2 id={`${id}-title`}>{t("lyrics.full.title")}</h2>
          </div>
          <button
            className="full-lyrics-overlay__close"
            ref={closeButtonRef}
            type="button"
            onClick={onRequestClose}
          >
            CLOSE <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="full-lyrics-overlay__toolbar" id={`${id}-meta`}>
          <div className="full-lyrics-overlay__truth">
            <span>{lyrics.provider.toUpperCase()}</span>
            <span>{sourceLabels[lyrics.source]}</span>
            <span data-quality={lyrics.timingQuality}>{t(qualityLabelKeys[lyrics.timingQuality])}</span>
          </div>
          <div className="full-lyrics-overlay__offset" aria-label={t("lyrics.offset.aria", {
            offset: formatOffset(lyrics.offsetMs),
          })}>
            <span>OFFSET {formatOffset(lyrics.offsetMs)}</span>
            <button
              type="button"
              disabled={!canAdjustOffset}
              onClick={() => onOffsetChange(lyrics.offsetMs - offsetStepMs)}
              aria-label={t("lyrics.offset.earlier", {
                milliseconds: offsetStepMs,
              })}
            >
              −
            </button>
            <button
              type="button"
              disabled={!canAdjustOffset || lyrics.offsetMs === 0}
              onClick={() => onOffsetChange(0)}
            >
              RESET
            </button>
            <button
              type="button"
              disabled={!canAdjustOffset}
              onClick={() => onOffsetChange(lyrics.offsetMs + offsetStepMs)}
              aria-label={t("lyrics.offset.later", {
                milliseconds: offsetStepMs,
              })}
            >
              +
            </button>
          </div>
        </div>

        <div className="full-lyrics-overlay__body">
          {resolvedStatus === "loading" ? (
            <div className="full-lyrics-overlay__status" role="status">{t("lyrics.full.loading")}</div>
          ) : null}
          {resolvedStatus === "error" ? (
            <div className="full-lyrics-overlay__status" role="alert">
              {errorMessage || t("lyrics.full.error")}
            </div>
          ) : null}
          {resolvedStatus === "empty" ? (
            <div className="full-lyrics-overlay__status" role="status">{t("lyrics.full.empty")}</div>
          ) : null}
          {resolvedStatus === "ready" ? (
            <div
              className="full-lyrics-overlay__viewport"
              ref={viewportRef}
              onScroll={handleScroll}
              onWheel={() => setFollowingCurrent(false)}
              onPointerDown={() => setFollowingCurrent(false)}
              tabIndex={0}
              role="region"
              aria-label={t("lyrics.full.list")}
            >
              <div
                className="full-lyrics-overlay__virtual-space"
                style={{ height: `${layout.totalHeight}px` }}
              >
                {visibleLines.map((line, localIndex) => {
                  const index = visibleRange.start + localIndex;
                  return (
                    <FullLyricsRow
                      key={line.id}
                      line={line}
                      index={index}
                      active={index === resolvedActiveIndex}
                      canSeek={canSeek}
                      showTranslation={showTranslation}
                      top={layout.offsets[index]}
                      onSeek={handleSeek}
                    />
                  );
                })}
              </div>
            </div>
          ) : null}

          {resolvedStatus === "ready" && (!followingCurrent || !activeIsVisible) ? (
            <button
              className="full-lyrics-overlay__return"
              type="button"
              disabled={resolvedActiveIndex < 0}
              onClick={returnToCurrent}
            >
              ↓ {t("lyrics.full.returnCurrent")} <span>{formatClock(elapsedMs)}</span>
            </button>
          ) : null}
        </div>

        <p className="full-lyrics-overlay__live" aria-live="polite">
          {resolvedActiveIndex >= 0
            ? t("lyrics.full.current", {
                text: lines[resolvedActiveIndex]?.text ?? "",
              })
            : ""}
        </p>
      </section>
    </div>
  );
});

export default FullLyricsOverlay;
