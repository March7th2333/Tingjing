import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { imageCache } from "../../config/ImageCache";
import { motionController } from "../../config/MotionController";
import { transitionManager } from "../../config/TransitionManager";
import { useLowPerformanceMode } from "../../hooks/useLowPerformanceMode";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useLanguage } from "../../i18n/LanguageContext";
import type { Track } from "../../types/music";
import type { NormalizedLyricDocument } from "../../types/music";
import {
  applyLyricOffset,
  createUnavailableLyricDocument,
  getNormalizedLyricIndex,
} from "../lyrics/LyricTruth";
import {
  lyricOffsetKey,
  lyricOffsetStore,
} from "../lyrics/LyricOffsetStore";
import { prewarmImmersivePlayback } from "../player/playbackEvents";
import type { PlaybackPrefetchService } from "../player/PlaybackPrefetchService";
import { isSilentProviderRequestError } from "../player/ProviderRequestCoordinator";
import { playbackSessionBridge } from "../player/PlaybackSessionBridge";
import { usePlayerPreferences } from "../settings/playerPreferences";
import { FullLyricsOverlay } from "./FullLyricsOverlay";
import type {
  ImmersivePlaybackCurrentTrack,
  ImmersivePlaybackReturnTransition,
  PlaybackOrigin,
  PlaybackSource,
} from "../player/playbackEvents";
import {
  playbackQueueController,
  type PlaybackCollectionContext,
  type PlaybackQueueSeed,
} from "../player/PlaybackQueueController";
import {
  homeWallTransitionMotionTokens as homeWallMotion,
  musicWallMotionTokens as wallMotion,
} from "./motionTokens";
import {
  activeHomeWallTransitionTraceId,
  homeWallDiagnosticsEnabled,
  markHomeWallTransitionPhase,
  noteHomeWallMusicWallCommit,
  noteHomeWallTransitionMetric,
} from "./HomeWallTransitionDiagnostics";
import {
  chooseClosestWallInstance,
  isExactWallCurrent,
  resolvePlaybackReturnForWall,
  wallMayAutoMove,
  type MusicWallInstanceCandidate,
  type MusicWallSelectionPhase,
} from "./MusicWallPlaybackReturn";
import { playbackReturnSnapshotKey } from "../player/PlaybackReturnSnapshot";
import { SpotifyAttribution } from "./SpotifyAttribution";

export type MusicWallMode = "playlist" | "radio" | "album" | "artist";
export type MusicWallState = "prepared" | "opening" | "detail" | "closing";

export interface MusicWallTrack extends Track {
  coverImage?: string;
}

export type WallMotionState = "auto" | "braking" | "stopped";
type SelectionPhase = MusicWallSelectionPhase;
type MusicWallLayoutMode = "editorial" | "gallery" | "wall";
type TrackCardPresentation = "cover" | "typography";

export interface WallLayout {
  rowCount: number;
  tileSize: number;
  gap: number;
  sequenceLength: number;
}

export interface MusicWallPreparation {
  layout: WallLayout;
  totalDurationMs: number;
  uniqueCoverRatio: number;
  initialOffset: number;
  initialColumnShift: number;
  portalRow: number;
  formationOrigin: {
    rowIndex: number;
    columnIndex: number;
    trackIndex: number;
  };
  decodedCoverSources: readonly string[];
  criticalCoverSources: readonly string[];
  deferredCoverSources: readonly string[];
  initialTrackIndexes: readonly (readonly number[])[];
  criticalTrackIndexes: readonly number[];
  portalParticipantSlots: readonly string[];
}

export interface MusicWallPreparationOptions {
  signal?: AbortSignal;
  criticalDecodeTimeoutMs?: number;
}

export interface MusicWallReturnPreparation {
  capturedAt: number;
  initialSpeed: number;
  currentSpeed: number;
  renderedOffset: number;
  targetOffset: number;
  resolvedOffset: number;
  wallTransform: string;
  wallColumnShift: number;
  pendingColumnRebase: {
    delta: number;
    nextShift: number;
  } | null;
  participantSlots: readonly string[];
  motionState: WallMotionState;
  automaticWasRunning: boolean;
}

interface HoveredTile {
  track: MusicWallTrack;
  instanceId: string;
  trackIndex: number;
}

interface PlaybackReturnSelectionBackup {
  key: string;
  track: MusicWallTrack | null;
  trackIndex: number;
  instanceId: string | null;
  phase: SelectionPhase;
}

interface PooledWallTrack {
  track: MusicWallTrack;
  trackIndex: number;
  isClone: boolean;
  isFormationOrigin: boolean;
  isImageCritical: boolean;
}

type CardStyle = CSSProperties &
  Record<
    | "--card-background"
    | "--card-ambient"
    | "--card-accent"
    | "--card-text"
    | "--card-depth"
    | "--card-distance-opacity",
    string
  >;

type PortalSlotStyle = CSSProperties &
  Record<"--portal-card-delay", string>;

type WallStyle = CSSProperties &
  Record<
    | "--wall-row-count"
    | "--card-size"
    | "--wall-gap"
    | "--wall-hover-scale"
    | "--wall-hover-depth"
    | "--wall-hover-duration"
    | "--wall-return-duration"
    | "--wall-selection-duration"
    | "--wall-panel-duration"
    | "--wall-easing"
    | "--wall-quiet-easing",
    string
  >;

interface MusicWallProps {
  state: MusicWallState;
  mode: MusicWallMode;
  number: string;
  title: string;
  subtitle?: string;
  tracks: MusicWallTrack[];
  albumCoverTrack: MusicWallTrack;
  currentPlaybackOccurrence: ImmersivePlaybackCurrentTrack | null;
  playbackReturnTransition: ImmersivePlaybackReturnTransition | null;
  isPlayerTransitioning: boolean;
  overlayRoot: HTMLElement | null;
  preparation?: MusicWallPreparation | null;
  queueContext: PlaybackCollectionContext;
  playbackPrefetchService: PlaybackPrefetchService;
  onExit: (
    preparation: MusicWallReturnPreparation,
    restoreKeyboardFocus?: boolean,
  ) => boolean;
  onExitControllerChange: (
    controller: ((restoreKeyboardFocus?: boolean) => boolean) | null,
  ) => void;
  onPanelStateChange: (isOpen: boolean) => void;
  onPlay: (
    track: Track,
    source: PlaybackSource,
    origin?: PlaybackOrigin,
    queueSeed?: PlaybackQueueSeed,
    startPositionMs?: number,
  ) => void;
}

interface TrackCardProps {
  instanceId: string;
  track: MusicWallTrack;
  coverTrack: MusicWallTrack;
  index: number;
  isClone: boolean;
  isFormationOrigin?: boolean;
  isImageCritical: boolean;
  isCurrent: boolean;
  presentation: TrackCardPresentation;
  prefersReducedMotion: boolean;
  setCardRef: (
    instanceId: string,
    element: HTMLButtonElement | null,
  ) => void;
  onHover: (tile: HoveredTile | null) => void;
  onSelect: (
    track: MusicWallTrack,
    instanceId: string,
    element: HTMLButtonElement,
    trackIndex: number,
  ) => void;
}

interface WallSurfaceProps {
  layoutMode: MusicWallLayoutMode;
  wallRows: PooledWallTrack[][];
  wallTracks: MusicWallTrack[];
  currentPlaybackOccurrence: ImmersivePlaybackCurrentTrack | null;
  queueContext: PlaybackCollectionContext;
  preparedInitialOffset: number;
  formationOrigin: MusicWallPreparation["formationOrigin"];
  portalParticipantSlots: ReadonlySet<string>;
  presentationForTrack: (
    trackIndex: number,
  ) => TrackCardPresentation;
  prefersReducedMotion: boolean;
  setWallElement: (element: HTMLDivElement | null) => void;
  setCardRef: (
    instanceId: string,
    element: HTMLButtonElement | null,
  ) => void;
  onHover: (tile: HoveredTile | null) => void;
  onSelect: (
    track: MusicWallTrack,
    instanceId: string,
    element: HTMLButtonElement,
    trackIndex: number,
  ) => void;
}

interface GlassDetailPanelProps {
  isOpen: boolean;
  track: MusicWallTrack;
  coverTrack: MusicWallTrack;
  trackIndex: number;
  status: string;
  isPlayerTransitioning: boolean;
  isPlaybackReturning: boolean;
  isObscured: boolean;
  isExternalPlayback: boolean;
  overlayStyle: WallStyle;
  closeButtonRef: (element: HTMLButtonElement | null) => void;
  lyricsButtonRef: (element: HTMLButtonElement | null) => void;
  onClose: () => void;
  onPlay: () => boolean;
  onPrewarm: () => void;
  onPrewarmCancel: () => void;
  onQueue: () => void;
  onQueueNext: () => void;
  onShowLyrics: () => void;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveModulo(value: number, length: number) {
  return ((value % length) + length) % length;
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function smoothStep(value: number) {
  return value * value * (3 - 2 * value);
}

function wallLayoutsEqual(left: WallLayout, right: WallLayout) {
  return left.rowCount === right.rowCount
    && left.tileSize === right.tileSize
    && left.gap === right.gap
    && left.sequenceLength === right.sequenceLength;
}

function readWallLayout(): WallLayout {
  const isUltraWide = window.innerWidth / Math.max(1, window.innerHeight) > 2.15;
  const rowCount =
    window.innerWidth >= 900
      && window.innerHeight >= 820
      && !isUltraWide
      ? 4
      : 3;
  const gap = Math.round(clamp(window.innerWidth * 0.014, 16, 24));
  const wallHeight = window.innerHeight * 0.82;
  const availableTileSize =
    (wallHeight - gap * (rowCount - 1)) / rowCount;
  const mobileMaximum =
    window.innerWidth < 720 ? window.innerWidth * 0.54 : 244;
  const tileSize = Math.round(
    Math.min(mobileMaximum, Math.max(132, availableTileSize)),
  );
  const visibleColumns = Math.ceil(window.innerWidth / (tileSize + gap));
  const maximumPoolColumns = Math.max(6, Math.floor(80 / rowCount));

  return {
    rowCount,
    tileSize,
    gap,
    sequenceLength: Math.min(
      maximumPoolColumns,
      Math.max(6, visibleColumns + 3),
    ),
  };
}

function wallRowOffset(rowIndex: number, step: number) {
  return rowIndex % 2 === 1 ? step * 0.5 : -step * 0.08;
}

function createInitialTrackIndexes(
  trackCount: number,
  layout: WallLayout,
  columnShift: number,
  portalRow: number,
) {
  if (trackCount <= 0) {
    return [];
  }

  return Array.from({ length: layout.rowCount }, (_, rowIndex) =>
    Array.from({ length: layout.sequenceLength }, (_, columnIndex) => {
      const linearIndex =
        (columnIndex - columnShift) * layout.rowCount + rowIndex;
      return positiveModulo(linearIndex - portalRow, trackCount);
    })
  );
}

function portalSlotKey(rowIndex: number, columnIndex: number) {
  return `${rowIndex}:${columnIndex}`;
}

function findPortalParticipants(
  trackIndexes: readonly (readonly number[])[],
  layout: WallLayout,
  initialOffset: number,
) {
  const step = layout.tileSize + layout.gap;
  const buffer = step * homeWallMotion.portalParticipantBufferColumns;
  const trackIndexSet = new Set<number>();
  const slotKeys: string[] = [];

  trackIndexes.forEach((row, rowIndex) => {
    const rowOffset = wallRowOffset(rowIndex, step);
    row.forEach((trackIndex, columnIndex) => {
      const left = initialOffset + rowOffset + columnIndex * step;
      const right = left + layout.tileSize;
      if (
        right >= -buffer
        && left <= window.innerWidth + buffer
      ) {
        trackIndexSet.add(trackIndex);
        slotKeys.push(portalSlotKey(rowIndex, columnIndex));
      }
    });
  });

  return {
    slotKeys,
    trackIndexes: [...trackIndexSet],
  };
}

function initialWallPresentation(layout: WallLayout) {
  const step = layout.tileSize + layout.gap;
  const portalRow = Math.floor(layout.rowCount / 2);
  const portalColumn = Math.max(
    3,
    Math.ceil(window.innerWidth / Math.max(1, step * 2)) + 2,
  );
  const rowOffset = portalRow % 2 === 1 ? step * 0.5 : -step * 0.08;

  let initialOffset =
    window.innerWidth / 2
    - portalColumn * step
    - layout.tileSize / 2
    - rowOffset;
  let initialColumnShift = portalColumn;

  // Start inside the same recycling window used by the RAF loop. Previously
  // the first detail frame immediately normalized the offset and committed a
  // new column assignment, making a prepared wall hitch as it began moving.
  while (initialOffset > -step * 1.45) {
    initialOffset -= step;
    initialColumnShift += 1;
  }
  while (initialOffset < -step * 3.45) {
    initialOffset += step;
    initialColumnShift -= 1;
  }

  return {
    initialOffset,
    initialColumnShift,
    portalRow,
  };
}

function uniqueCoverSources(
  sources: ReadonlyArray<string | null | undefined>,
) {
  return Array.from(
    new Set(sources.filter((source): source is string => Boolean(source))),
  );
}

function createMusicWallPreparation(
  tracks: readonly MusicWallTrack[],
  albumCoverTrack: MusicWallTrack,
  layout = readWallLayout(),
): MusicWallPreparation {
  let totalDurationMs = 0;
  const uniqueCovers = new Set<string>();
  tracks.forEach((track) => {
    totalDurationMs += track.durationMs;
    uniqueCovers.add(
      track.coverImage
      ?? track.albumId
      ?? `${track.album}:${track.artist}`,
    );
  });
  const presentation = initialWallPresentation(layout);
  const initialTrackIndexes = createInitialTrackIndexes(
    tracks.length,
    layout,
    presentation.initialColumnShift,
    presentation.portalRow,
  );
  const portalParticipants = findPortalParticipants(
    initialTrackIndexes,
    layout,
    presentation.initialOffset,
  );
  const criticalTrackIndexes = portalParticipants.trackIndexes;
  const portalTrackIndex =
    initialTrackIndexes[presentation.portalRow]
      ?.[presentation.initialColumnShift] ?? 0;
  const criticalCoverSources = uniqueCoverSources([
    albumCoverTrack.coverImage,
    tracks[portalTrackIndex]?.coverImage,
    ...criticalTrackIndexes.map(
      (trackIndex) => tracks[trackIndex]?.coverImage,
    ),
  ]);
  const poolTrackIndexes = new Set(initialTrackIndexes.flat());
  const deferredCoverSources = uniqueCoverSources(
    [...poolTrackIndexes]
      .filter((trackIndex) => !criticalTrackIndexes.includes(trackIndex))
      .map((trackIndex) => tracks[trackIndex]?.coverImage),
  );

  return {
    layout,
    totalDurationMs,
    uniqueCoverRatio: tracks.length > 0
      ? uniqueCovers.size / tracks.length
      : 1,
    ...presentation,
    formationOrigin: {
      rowIndex: presentation.portalRow,
      columnIndex: presentation.initialColumnShift,
      trackIndex: portalTrackIndex,
    },
    decodedCoverSources: [],
    criticalCoverSources,
    deferredCoverSources,
    initialTrackIndexes,
    criticalTrackIndexes,
    portalParticipantSlots: portalParticipants.slotKeys,
  };
}

export async function prepareMusicWall(
  tracks: readonly MusicWallTrack[],
  albumCoverTrack: MusicWallTrack,
  options: MusicWallPreparationOptions = {},
): Promise<MusicWallPreparation> {
  const preparation = createMusicWallPreparation(tracks, albumCoverTrack);
  const firstFrameCoverSources = preparation.criticalCoverSources;

  // Every cover intersecting the first viewport is decoded before the portal
  // timeline starts. Stable-focus prewarming normally completes this work
  // before the click; on a cold entry, the home cover keeps only its subtle
  // pressed response until this bounded preparation finishes, so decoding can
  // never freeze an already-expanded shared cover.
  await imageCache.preloadMany(firstFrameCoverSources, {
    concurrency: 4,
    signal: options.signal,
    timeoutMs: options.criticalDecodeTimeoutMs ?? 1_600,
  });
  imageCache.preloadDeferred(preparation.deferredCoverSources, {
    batchSize: 2,
    concurrency: 2,
  });

  return {
    ...preparation,
    decodedCoverSources: firstFrameCoverSources.filter((source) =>
      imageCache.has(source)
    ),
  };
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function wallModeLabel(mode: MusicWallMode) {
  if (mode === "album") return "ALBUM";
  if (mode === "artist") return "ARTIST";
  if (mode === "radio") return "RADIO";
  return "PLAYLIST";
}

function hideBrokenCover(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = true;
  event.currentTarget.parentElement?.setAttribute("data-cover-error", "true");
}

function showLoadedCover(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = false;
  event.currentTarget.parentElement?.setAttribute("data-cover-error", "false");
}

function setCardSelected(
  element: HTMLButtonElement | undefined,
  selected: boolean,
) {
  if (!element) {
    return;
  }
  if (selected) {
    element.setAttribute("data-selected", "true");
    element.setAttribute("aria-pressed", "true");
    return;
  }
  element.removeAttribute("data-selected");
  element.removeAttribute("aria-pressed");
}

const TrackCard = memo(function TrackCard({
  instanceId,
  track,
  coverTrack,
  index,
  isClone,
  isFormationOrigin = false,
  isImageCritical,
  isCurrent,
  presentation,
  prefersReducedMotion,
  setCardRef,
  onHover,
  onSelect,
}: TrackCardProps) {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5 });
  const pointerBoundsRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const pointerBoundsReadAtRef = useRef(0);
  const distanceStep = index % 4;
  const style: CardStyle = {
    "--card-background": coverTrack.palette.background,
    "--card-ambient": coverTrack.palette.ambient,
    "--card-accent": coverTrack.palette.accent,
    "--card-text": coverTrack.palette.text,
    "--card-depth": `${-distanceStep * 3}px`,
    "--card-distance-opacity": `${1 - distanceStep * 0.025}`,
  };

  const updateTilt = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (prefersReducedMotion || event.pointerType === "touch") {
      return;
    }

    const now = performance.now();
    if (
      !pointerBoundsRef.current
      || now - pointerBoundsReadAtRef.current > 120
    ) {
      const bounds = event.currentTarget.getBoundingClientRect();
      pointerBoundsRef.current = {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      pointerBoundsReadAtRef.current = now;
    }
    const bounds = pointerBoundsRef.current;
    if (!bounds || bounds.width === 0 || bounds.height === 0) {
      return;
    }
    pointerRef.current = {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };

    if (pointerFrameRef.current !== null) {
      return;
    }

    pointerFrameRef.current = window.requestAnimationFrame(() => {
      const card = cardRef.current;

      if (card) {
        const rotateY =
          (pointerRef.current.x - 0.5) * wallMotion.tiltAmount * 2;
        const rotateX =
          (0.5 - pointerRef.current.y) * wallMotion.tiltAmount * 2;

        card.style.setProperty("--card-rotate-x", `${rotateX}deg`);
        card.style.setProperty("--card-rotate-y", `${rotateY}deg`);
      }

      pointerFrameRef.current = null;
    });
  };

  const resetTilt = () => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }

    const card = cardRef.current;
    card?.style.setProperty("--card-rotate-x", "0deg");
    card?.style.setProperty("--card-rotate-y", "0deg");
    pointerBoundsRef.current = null;
    card?.setAttribute("data-hovered", "false");
    card
      ?.closest(".music-wall__track-grid, .music-wall__static-layout")
      ?.setAttribute("data-has-hover", "false");
    onHover(null);
  };

  const setHovered = (element: HTMLButtonElement) => {
    const card = cardRef.current;
    void motionController.preloadImage(coverTrack.coverImage);
    const bounds = element.getBoundingClientRect();
    pointerBoundsRef.current = {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
    pointerBoundsReadAtRef.current = performance.now();
    card?.setAttribute("data-hovered", "true");
    card
      ?.closest(".music-wall__track-grid, .music-wall__static-layout")
      ?.setAttribute("data-has-hover", "true");
    onHover({ track, instanceId, trackIndex: index });
  };

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current);
      }
    },
    [],
  );

  return (
    <button
      className="music-wall__card"
      type="button"
      ref={(element) => {
        cardRef.current = element;
        setCardRef(instanceId, element);
      }}
      style={style}
      data-track-id={track.id}
      data-source-index={index}
      data-instance-id={instanceId}
      data-hovered="false"
      data-presentation={presentation}
      data-current={isCurrent}
      data-clone={isClone}
      data-formation-origin={isFormationOrigin}
      tabIndex={isClone ? -1 : undefined}
      aria-hidden={isClone || undefined}
      aria-current={isCurrent ? "true" : undefined}
      aria-label={`${String(index + 1).padStart(2, "0")} ${track.title}${
        track.translatedTitle ? ` ${track.translatedTitle}` : ""
      } ${track.artist} ${track.album} ${formatDuration(track.durationMs)}`}
      onPointerEnter={(event) => setHovered(event.currentTarget)}
      onPointerMove={updateTilt}
      onPointerLeave={resetTilt}
      onFocus={(event) => setHovered(event.currentTarget)}
      onBlur={resetTilt}
      onClick={(event) =>
        onSelect(track, instanceId, event.currentTarget, index)
      }
    >
      <span className="music-wall__cover" aria-hidden="true">
        {coverTrack.coverImage && (
          <img
            src={coverTrack.coverImage}
            alt=""
            loading={isImageCritical ? "eager" : "lazy"}
            fetchPriority={isFormationOrigin ? "high" : "auto"}
            decoding="async"
            draggable="false"
            onLoad={showLoadedCover}
            onError={hideBrokenCover}
          />
        )}
      </span>

      <span className="music-wall__card-overlay">
        <span className="music-wall__card-index">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="music-wall__card-copy">
          <strong lang="ja">{track.title}</strong>
          {track.translatedTitle && (
            <small className="music-wall__card-translation">
              {track.translatedTitle}
            </small>
          )}
          <small className="music-wall__card-artist">{track.artist}</small>
        </span>
        <time>{formatDuration(track.durationMs)}</time>
      </span>

      {isCurrent && (
        <span className="music-wall__current-mark" aria-hidden="true" />
      )}
    </button>
  );
});

const WallSurface = memo(function WallSurface({
  layoutMode,
  wallRows,
  wallTracks,
  currentPlaybackOccurrence,
  queueContext,
  preparedInitialOffset,
  formationOrigin,
  portalParticipantSlots,
  presentationForTrack,
  prefersReducedMotion,
  setWallElement,
  setCardRef,
  onHover,
  onSelect,
}: WallSurfaceProps) {
  if (layoutMode === "wall") {
    return (
      <div
        className="music-wall__track-grid"
        ref={setWallElement}
        role="list"
        style={{
          transform:
            `translate3d(${preparedInitialOffset}px, 0, 0)`,
        }}
        data-has-hover="false"
        data-has-selection="false"
      >
        {wallRows.map((row, rowIndex) => (
          <div
            className="music-wall__track-row"
            data-row={rowIndex}
            key={`row-${rowIndex}`}
          >
            <div
              className="music-wall__sequence"
              data-copy="pool"
              key={`row-${rowIndex}-pool`}
            >
              {row.map(({
                track,
                trackIndex,
                isClone,
                isFormationOrigin,
                isImageCritical,
              }, columnIndex) => {
                const instanceId = `pool-${rowIndex}-${columnIndex}`;
                const formationDistance = Math.min(
                  7,
                  Math.abs(rowIndex - formationOrigin.rowIndex)
                    + Math.abs(columnIndex - formationOrigin.columnIndex),
                );
                const portalSlotStyle: PortalSlotStyle = {
                  "--portal-card-delay":
                    `${formationDistance * homeWallMotion.cardStaggerMs}ms`,
                };

                return (
                  <div
                    className="music-wall__card-slot"
                    role={isClone ? "presentation" : "listitem"}
                    aria-hidden={isClone || undefined}
                    data-portal-row={rowIndex}
                    data-portal-column={columnIndex}
                    data-image-critical={isImageCritical}
                    data-formation-origin={isFormationOrigin}
                    data-portal-participant={portalParticipantSlots.has(
                      portalSlotKey(rowIndex, columnIndex),
                    )}
                    data-formation-distance={formationDistance}
                    style={portalSlotStyle}
                    key={instanceId}
                  >
                    <TrackCard
                      instanceId={instanceId}
                      track={track}
                      coverTrack={track}
                      index={trackIndex}
                      isClone={isClone}
                      isFormationOrigin={isFormationOrigin}
                      isImageCritical={isImageCritical}
                      isCurrent={isExactWallCurrent(
                        currentPlaybackOccurrence,
                        queueContext,
                        track,
                        trackIndex,
                      )}
                      presentation={presentationForTrack(trackIndex)}
                      prefersReducedMotion={prefersReducedMotion}
                      setCardRef={setCardRef}
                      onHover={onHover}
                      onSelect={onSelect}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="music-wall__static-layout"
      ref={setWallElement}
      role="list"
      data-layout={layoutMode}
      data-count={wallTracks.length}
      data-has-hover="false"
      data-has-selection="false"
    >
      {wallTracks.map((track, trackIndex) => {
        const instanceId = `static-${trackIndex}-${track.id}`;
        const portalSlotStyle: PortalSlotStyle = {
          "--portal-card-delay":
            `${Math.min(trackIndex, 7) * homeWallMotion.cardStaggerMs}ms`,
        };
        return (
          <div
            className="music-wall__card-slot"
            role="listitem"
            data-image-critical="true"
            data-formation-origin={trackIndex === 0}
            data-portal-participant="true"
            data-formation-distance={Math.min(trackIndex, 7)}
            style={portalSlotStyle}
            key={instanceId}
          >
            <TrackCard
              instanceId={instanceId}
              track={track}
              coverTrack={track}
              index={trackIndex}
              isClone={false}
              isFormationOrigin={trackIndex === 0}
              isImageCritical={true}
              isCurrent={isExactWallCurrent(
                currentPlaybackOccurrence,
                queueContext,
                track,
                trackIndex,
              )}
              presentation={presentationForTrack(trackIndex)}
              prefersReducedMotion={prefersReducedMotion}
              setCardRef={setCardRef}
              onHover={onHover}
              onSelect={onSelect}
            />
          </div>
        );
      })}
    </div>
  );
});

const GlassDetailPanel = memo(function GlassDetailPanel({
  isOpen,
  track,
  coverTrack,
  trackIndex,
  status,
  isPlayerTransitioning,
  isPlaybackReturning,
  isObscured,
  isExternalPlayback,
  overlayStyle,
  closeButtonRef,
  lyricsButtonRef,
  onClose,
  onPlay,
  onPrewarm,
  onPrewarmCancel,
  onQueue,
  onQueueNext,
  onShowLyrics,
}: GlassDetailPanelProps) {
  const { t } = useLanguage();
  const coverSource = coverTrack.coverImage;
  const playButtonRef = useRef<HTMLButtonElement>(null);
  const isInteractive = isOpen && !isPlayerTransitioning && !isObscured;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const button = playButtonRef.current;
    button?.removeAttribute("data-transitioning");
    button?.removeAttribute("aria-busy");
  }, [isOpen, track.id]);

  return (
    <div
      className="music-wall__detail-overlay"
      data-open={isOpen}
      data-playing={isPlayerTransitioning}
      data-returning={isPlaybackReturning}
      aria-hidden={!isInteractive}
      inert={!isInteractive ? true : undefined}
      style={overlayStyle}
    >
      <button
        className="music-wall__panel-scrim"
        type="button"
        tabIndex={-1}
        aria-label={t("wall.detail.close")}
        disabled={!isInteractive}
        onClick={onClose}
      />

      <aside
        className="music-wall__panel"
        role="dialog"
        aria-modal={isInteractive || undefined}
        aria-label={t("wall.detail.aria", { title: track.title })}
      >
        <div className="music-wall__panel-topline">
          <span>TRACK DETAIL</span>
          <button
            type="button"
            ref={closeButtonRef}
            tabIndex={isInteractive ? 0 : -1}
            aria-label={t("wall.detail.close")}
            onClick={onClose}
          >
            CLOSE ×
          </button>
        </div>

        <div
          className="music-wall__panel-cover"
          data-cover-error={!coverSource}
          style={
            {
              "--panel-cover-background":
                coverTrack.palette.background
                ?? track.palette.background,
              "--panel-cover-ambient":
                coverTrack.palette.ambient
                ?? track.palette.ambient,
            } as CSSProperties
          }
        >
          <img
            src={coverSource}
            alt=""
            hidden={!coverSource}
            loading="eager"
            decoding="async"
            draggable="false"
            onLoad={showLoadedCover}
            onError={hideBrokenCover}
          />
          <span>
            {String(trackIndex + 1).padStart(2, "0")}
          </span>
        </div>

        <div className="music-wall__panel-title">
          <h2 lang="ja">{track.title}</h2>
          <p data-visible={Boolean(track.translatedTitle)}>
            {track.translatedTitle || "\u00A0"}
          </p>
        </div>

        <dl className="music-wall__details">
          <div>
            <dt>ARTIST</dt>
            <dd>{track.artist}</dd>
          </div>
          <div>
            <dt>ALBUM</dt>
            <dd>{track.album}</dd>
          </div>
          <div>
            <dt>DURATION</dt>
            <dd>{formatDuration(track.durationMs)}</dd>
          </div>
        </dl>

        {isExternalPlayback ? (
          <div className="music-wall__spotify-playback">
            <SpotifyAttribution
              actionLabel={t("spotify.playOn") as "PLAY ON SPOTIFY"}
              disabled={!isInteractive}
              onOpen={() => {
                onPlay();
              }}
            />
            <p>{t("spotify.externalOnly")}</p>
          </div>
        ) : (
          <>
            <button
              className="music-wall__panel-play"
              type="button"
              ref={playButtonRef}
              tabIndex={isInteractive ? 0 : -1}
              disabled={!isInteractive}
              aria-label={t("wall.playTrack", { title: track.title })}
              onPointerEnter={onPrewarm}
              onPointerLeave={onPrewarmCancel}
              onFocus={onPrewarm}
              onBlur={onPrewarmCancel}
              onClick={(event) => {
                const button = event.currentTarget;
                if (button.dataset.transitioning === "true") {
                  return;
                }

                button.dataset.transitioning = "true";
                button.setAttribute("aria-busy", "true");
                button.disabled = true;

                if (!onPlay()) {
                  button.disabled = false;
                  button.removeAttribute("data-transitioning");
                  button.removeAttribute("aria-busy");
                }
              }}
            >
              <span aria-hidden="true">▶</span>
              <span className="music-wall__panel-play-label">
                PLAY TRACK
              </span>
            </button>

            <div className="music-wall__panel-actions">
              <button
                type="button"
                tabIndex={isInteractive ? 0 : -1}
                onClick={onQueue}
              >
                {t("wall.queue.add")}
              </button>
              <button
                type="button"
                tabIndex={isInteractive ? 0 : -1}
                onClick={onQueueNext}
              >
                {t("wall.queue.next")}
              </button>
              <button
                type="button"
                ref={lyricsButtonRef}
                tabIndex={isInteractive ? 0 : -1}
                onClick={onShowLyrics}
              >
                {t("wall.lyrics.open")}
              </button>
            </div>
          </>
        )}

        <p className="music-wall__panel-status" role="status">
          {status || (isExternalPlayback
            ? t("spotify.open")
            : "SPACE PLAY / ESC CLOSE")}
        </p>
      </aside>
    </div>
  );
});

export const MusicWall = memo(function MusicWall({
  state,
  mode,
  number,
  title,
  subtitle,
  tracks,
  albumCoverTrack,
  currentPlaybackOccurrence,
  playbackReturnTransition,
  isPlayerTransitioning,
  overlayRoot,
  preparation,
  queueContext,
  playbackPrefetchService,
  onExit,
  onExitControllerChange,
  onPanelStateChange,
  onPlay,
}: MusicWallProps) {
  const { t } = useLanguage();
  const isExternalPlayback = queueContext.providerId === "spotify";
  const wallTracks = useMemo(
    () => isExternalPlayback ? tracks.slice(0, 20) : tracks,
    [isExternalPlayback, tracks],
  );
  const wallAlbumCoverTrack = albumCoverTrack;
  const [wallLayout, setWallLayout] = useState<WallLayout>(
    () => preparation?.layout ?? readWallLayout(),
  );
  const initialPresentation = useMemo<MusicWallPreparation>(
    () => preparation && wallLayoutsEqual(preparation.layout, wallLayout)
      ? preparation
      : createMusicWallPreparation(
          wallTracks,
          wallAlbumCoverTrack,
          wallLayout,
        ),
    [preparation, wallAlbumCoverTrack, wallLayout, wallTracks],
  );
  const [wallColumnShift, setWallColumnShift] = useState(
    initialPresentation.initialColumnShift,
  );
  const [selectedTrack, setSelectedTrack] =
    useState<MusicWallTrack | null>(null);
  const [selectedTrackIndex, setSelectedTrackIndex] = useState(0);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(
    null,
  );
  const [selectionPhase, setSelectionPhase] =
    useState<SelectionPhase>("idle");
  const [isReturnPanelPrepared, setIsReturnPanelPrepared] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [panelStatus, setPanelStatus] = useState("");
  const [lyricsOverlayOpen, setLyricsOverlayOpen] = useState(false);
  const [lyricsOverlayStatus, setLyricsOverlayStatus] =
    useState<"loading" | "ready" | "empty" | "error">("empty");
  const [lyricsOverlayError, setLyricsOverlayError] = useState("");
  const [lyricsOverlayTrackId, setLyricsOverlayTrackId] = useState(
    tracks[0]?.id ?? "idle",
  );
  const [lyricsDocumentBase, setLyricsDocumentBase] =
    useState<NormalizedLyricDocument>(() =>
      createUnavailableLyricDocument(
        queueContext.providerId,
        tracks[0]?.id ?? "idle",
      ));
  const lyricsRequestConsumer = useMemo(
    () => playbackPrefetchService.createLyricsConsumer(),
    [playbackPrefetchService],
  );
  const lyricsTriggerRef = useRef<HTMLButtonElement>(null);
  const [playerPreferences] = usePlayerPreferences();
  const playbackSession = useSyncExternalStore(
    lyricsOverlayOpen ? playbackSessionBridge.subscribe : () => () => undefined,
    playbackSessionBridge.getSnapshot,
    playbackSessionBridge.getSnapshot,
  );
  const lyricsOffsetStorageKey = useMemo(
    () => lyricOffsetKey(
      lyricsDocumentBase.provider,
      lyricsOverlayTrackId,
      lyricsDocumentBase.source,
    ),
    [lyricsDocumentBase.provider, lyricsDocumentBase.source, lyricsOverlayTrackId],
  );
  const lyricsOffsetMs = useSyncExternalStore(
    lyricOffsetStore.subscribe,
    () => lyricOffsetStore.get(lyricsOffsetStorageKey),
    () => lyricOffsetStore.get(lyricsOffsetStorageKey),
  );
  const lyricsDocument = useMemo(
    () => applyLyricOffset(lyricsDocumentBase, lyricsOffsetMs),
    [lyricsDocumentBase, lyricsOffsetMs],
  );
  const wallRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rootSectionRef = useRef<HTMLElement>(null);
  const panelCloseRef = useRef<HTMLButtonElement>(null);
  const panelPrefetchCancelRef = useRef<(() => void) | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const preparedInitialOffset = initialPresentation.initialOffset;
  const portalRow = initialPresentation.portalRow;
  const targetOffsetRef = useRef(preparedInitialOffset);
  const renderedOffsetRef = useRef(preparedInitialOffset);
  const wallColumnShiftRef = useRef(
    initialPresentation.initialColumnShift,
  );
  const pendingColumnRebaseRef = useRef<{
    delta: number;
    nextShift: number;
  } | null>(null);
  const currentSpeedRef = useRef(0);
  const interactionVelocityRef = useRef(0);
  const interactionActiveUntilRef = useRef(0);
  const motionStateRef = useRef<WallMotionState>("stopped");
  const hoveredTileRef = useRef<HoveredTile | null>(null);
  const pendingSelectionRef = useRef<HoveredTile | null>(null);
  const selectedTrackRef = useRef<MusicWallTrack | null>(null);
  const selectedTrackIndexRef = useRef(0);
  const selectedInstanceIdRef = useRef<string | null>(null);
  const selectionPhaseRef = useRef<SelectionPhase>("idle");
  const playbackReturnBackupRef =
    useRef<PlaybackReturnSelectionBackup | null>(null);
  const playbackReturnStageRef = useRef<string | null>(null);
  const selectionTransitionPendingRef = useRef(false);
  const selectionTransitionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const stateRef = useRef(state);
  const playerTransitioningRef = useRef(isPlayerTransitioning);
  const layoutModeRef = useRef<MusicWallLayoutMode>("wall");
  const modeRef = useRef(mode);
  const albumCoverTrackRef = useRef(wallAlbumCoverTrack);
  const brakingStartedAtRef = useRef(0);
  const brakingInitialSpeedRef = useRef<number>(wallMotion.wallSpeed);
  const brakingEndedReportedRef = useRef(false);
  const closingParticipantSlotsRef = useRef<ReadonlySet<string> | null>(null);
  const closingMotionPreparationRef =
    useRef<MusicWallReturnPreparation | null>(null);
  const returnRequestPendingRef = useRef(false);
  const closingSpeedTimersRef = useRef<number[]>([]);
  const closingTraceIdRef = useRef<string | null>(null);
  const previousWallStateRef = useRef<MusicWallState>(state);
  const openingStartedAtRef = useRef(0);
  const openingReadableSampledRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragReleaseTimerRef = useRef<number | null>(null);
  const dragRef = useRef({
    pointerId: -1,
    startX: 0,
    startOffset: 0,
    lastX: 0,
    lastAt: 0,
    velocity: 0,
    moved: false,
  });
  const prefersReducedMotion = useReducedMotion();
  const isLowPerformance = useLowPerformanceMode();
  const layoutMode: MusicWallLayoutMode =
    wallTracks.length <= 5
      ? "editorial"
      : wallTracks.length <= 12
        ? "gallery"
        : "wall";
  stateRef.current = state;
  playerTransitioningRef.current = isPlayerTransitioning;
  selectedTrackRef.current = selectedTrack;
  selectedTrackIndexRef.current = selectedTrackIndex;
  selectedInstanceIdRef.current = selectedInstanceId;
  selectionPhaseRef.current = selectionPhase;
  layoutModeRef.current = layoutMode;
  modeRef.current = mode;
  albumCoverTrackRef.current = wallAlbumCoverTrack;
  const uniqueCoverRatio = initialPresentation.uniqueCoverRatio;
  const coverStrategy =
    uniqueCoverRatio >= 0.6
      ? "cover"
      : uniqueCoverRatio >= 0.25
        ? "mixed"
        : "typography";
  const presentationForTrack = useCallback(
    (trackIndex: number): TrackCardPresentation => {
      if (isExternalPlayback) {
        return "cover";
      }
      if (coverStrategy === "cover") {
        return "cover";
      }
      if (coverStrategy === "mixed") {
        return trackIndex % 3 === 1 ? "typography" : "cover";
      }
      return trackIndex === 0 ? "cover" : "typography";
    },
    [coverStrategy, isExternalPlayback],
  );

  const wallStyle = useMemo<WallStyle>(() => ({
    "--wall-row-count": `${wallLayout.rowCount}`,
    "--card-size": `${wallLayout.tileSize}px`,
    "--wall-gap": `${wallLayout.gap}px`,
    "--wall-hover-scale": `${wallMotion.hoverScale}`,
    "--wall-hover-depth": `${wallMotion.hoverDepth}px`,
    "--wall-hover-duration": `${wallMotion.hoverDuration}ms`,
    "--wall-return-duration": `${wallMotion.returnDuration}ms`,
    "--wall-selection-duration": `${wallMotion.transitionDuration}ms`,
    "--wall-panel-duration": `${wallMotion.panelDuration}ms`,
    "--wall-easing": wallMotion.easing,
    "--wall-quiet-easing": wallMotion.quietEasing,
  }), [wallLayout]);
  const initialCriticalTrackIndexes = useMemo(
    () => new Set(initialPresentation.criticalTrackIndexes),
    [initialPresentation.criticalTrackIndexes],
  );
  const initialPortalParticipantSlots = useMemo(
    () => new Set(initialPresentation.portalParticipantSlots),
    [initialPresentation.portalParticipantSlots],
  );
  const portalParticipantSlots = state === "closing"
    ? closingParticipantSlotsRef.current ?? initialPortalParticipantSlots
    : initialPortalParticipantSlots;
  const wallRows = useMemo<PooledWallTrack[][]>(() => {
    if (wallTracks.length === 0) {
      return [];
    }

    const seenTrackIndexes = new Set<number>();

    const preparedIndexes =
      wallColumnShift === initialPresentation.initialColumnShift
        && initialPresentation.initialTrackIndexes.length
          === wallLayout.rowCount
        ? initialPresentation.initialTrackIndexes
        : null;

    return Array.from({ length: wallLayout.rowCount }, (_, rowIndex) =>
      Array.from(
        { length: wallLayout.sequenceLength },
        (_, columnIndex) => {
          const preparedTrackIndex =
            preparedIndexes?.[rowIndex]?.[columnIndex];
          const trackIndex = preparedTrackIndex ?? positiveModulo(
            (columnIndex - wallColumnShift) * wallLayout.rowCount
              + rowIndex
              - portalRow,
            wallTracks.length,
          );
          const isClone = seenTrackIndexes.has(trackIndex);
          seenTrackIndexes.add(trackIndex);

          return {
            track: wallTracks[trackIndex],
            trackIndex,
            isClone,
            isFormationOrigin:
              columnIndex === initialPresentation.formationOrigin.columnIndex
              && rowIndex === initialPresentation.formationOrigin.rowIndex,
            isImageCritical:
              initialCriticalTrackIndexes.has(trackIndex),
          };
        },
      )
    );
  }, [
    wallLayout.rowCount,
    wallLayout.sequenceLength,
    wallColumnShift,
    wallTracks,
    portalRow,
    initialPresentation.initialTrackIndexes,
    initialPresentation.initialColumnShift,
    initialPresentation.formationOrigin.columnIndex,
    initialPresentation.formationOrigin.rowIndex,
    initialCriticalTrackIndexes,
  ]);

  const totalDurationMs = initialPresentation.totalDurationMs;
  const panelTrack =
    selectedTrack ?? wallTracks[0] ?? wallAlbumCoverTrack;
  const panelCoverTrack =
    mode === "album" ? wallAlbumCoverTrack : panelTrack;
  const isPlaybackReturning =
    isReturnPanelPrepared
    && (
      playbackReturnTransition?.phase === "prepare"
      || playbackReturnTransition?.phase === "commit"
    );
  const isPanelVisible =
    state === "detail"
    && selectionPhase === "open"
    && (!isPlayerTransitioning || isReturnPanelPrepared);
  const panelTrackIndex = selectedTrack ? selectedTrackIndex : 0;

  const setCardRef = useCallback(
    (instanceId: string, element: HTMLButtonElement | null) => {
      if (element) {
        cardRefs.current.set(instanceId, element);
      } else {
        cardRefs.current.delete(instanceId);
      }
    },
    [],
  );
  const setWallElement = useCallback((element: HTMLDivElement | null) => {
    wallRef.current = element;
  }, []);

  const freezeWallMotion = useCallback(() => {
    currentSpeedRef.current = 0;
    interactionVelocityRef.current = 0;
    interactionActiveUntilRef.current = 0;
    motionStateRef.current = "stopped";
    targetOffsetRef.current = renderedOffsetRef.current;
    const wall = wallRef.current;
    if (wall) {
      wall.style.transform =
        `translate3d(${renderedOffsetRef.current}px, 0, 0)`;
      wall.dataset.motionState = "stopped";
    }
    const root = rootSectionRef.current;
    if (root) {
      root.dataset.motionState = "stopped";
      root.dataset.currentSpeed = "0";
      root.dataset.targetOffset = String(targetOffsetRef.current);
      root.dataset.renderedOffset = String(renderedOffsetRef.current);
    }
  }, []);

  const resumeWallMotion = useCallback(() => {
    motionStateRef.current = "auto";
    const root = rootSectionRef.current;
    if (root) {
      root.dataset.motionState = "auto";
      root.dataset.currentSpeed = String(currentSpeedRef.current);
      root.dataset.targetOffset = String(targetOffsetRef.current);
      root.dataset.renderedOffset = String(renderedOffsetRef.current);
    }
  }, []);

  const clearCardSelectionOwnership = useCallback(() => {
    cardRefs.current.forEach((element) => setCardSelected(element, false));
    wallRef.current?.setAttribute("data-has-selection", "false");
  }, []);

  const assignSelectionState = useCallback((
    track: MusicWallTrack | null,
    trackIndex: number,
    instanceId: string | null,
    phase: SelectionPhase,
  ) => {
    selectedTrackRef.current = track;
    selectedTrackIndexRef.current = trackIndex;
    selectedInstanceIdRef.current = instanceId;
    selectionPhaseRef.current = phase;
    setSelectedTrack(track);
    setSelectedTrackIndex(trackIndex);
    setSelectedInstanceId(instanceId);
    setSelectionPhase(phase);
  }, []);

  const findReturnCardInstance = useCallback((
    sourceIndex: number,
    trackId: string,
  ) => {
    const viewportBounds = viewportRef.current?.getBoundingClientRect();
    const viewportCenter = viewportBounds
      ? {
          x: viewportBounds.left + viewportBounds.width / 2,
          y: viewportBounds.top + viewportBounds.height / 2,
        }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const candidates: MusicWallInstanceCandidate[] = [];

    cardRefs.current.forEach((element, instanceId) => {
      const bounds = element.getBoundingClientRect();
      const intersectsViewport = viewportBounds
        ? bounds.right > viewportBounds.left
          && bounds.left < viewportBounds.right
          && bounds.bottom > viewportBounds.top
          && bounds.top < viewportBounds.bottom
        : bounds.right > 0
          && bounds.left < window.innerWidth
          && bounds.bottom > 0
          && bounds.top < window.innerHeight;
      candidates.push({
        instanceId,
        sourceIndex: Number(element.dataset.sourceIndex),
        trackId: element.dataset.trackId ?? "",
        isClone: element.dataset.clone === "true",
        isHidden: element.hidden
          || element.getAttribute("aria-hidden") === "true"
          || bounds.width <= 0
          || bounds.height <= 0
          || !intersectsViewport,
        centerX: bounds.left + bounds.width / 2,
        centerY: bounds.top + bounds.height / 2,
      });
    });

    return chooseClosestWallInstance(
      sourceIndex,
      trackId,
      candidates,
      viewportCenter,
    );
  }, []);

  useLayoutEffect(() => {
    const transition = playbackReturnTransition;
    if (!transition) {
      if (isPlayerTransitioning && isReturnPanelPrepared) {
        playbackReturnBackupRef.current = null;
        playbackReturnStageRef.current = null;
        setIsReturnPanelPrepared(false);
      }
      return;
    }

    const key = playbackReturnSnapshotKey(
      transition.snapshot,
      transition.requestId,
    );
    const stageKey = `${transition.phase}:${key}`;
    if (playbackReturnStageRef.current === stageKey) {
      return;
    }
    playbackReturnStageRef.current = stageKey;

    if (transition.phase === "prepare") {
      playbackReturnBackupRef.current = {
        key,
        track: selectedTrackRef.current,
        trackIndex: selectedTrackIndexRef.current,
        instanceId: selectedInstanceIdRef.current,
        phase: selectionPhaseRef.current,
      };
      selectionTransitionAbortRef.current?.abort(
        "Player return superseded wall detail transition",
      );
      selectionTransitionAbortRef.current = null;
      selectionTransitionPendingRef.current = false;
      pendingSelectionRef.current = null;
      hoveredTileRef.current = null;
      wallRef.current?.setAttribute("data-has-hover", "false");
      freezeWallMotion();
      clearCardSelectionOwnership();

      const resolution = resolvePlaybackReturnForWall(
        transition.snapshot,
        queueContext,
        wallTracks,
      );
      if (resolution.kind === "select") {
        const candidate = findReturnCardInstance(
          resolution.sourceIndex,
          resolution.track.id,
        );
        if (candidate) {
          const targetElement = cardRefs.current.get(candidate.instanceId);
          setCardSelected(targetElement, true);
          wallRef.current?.setAttribute("data-has-selection", "true");
          assignSelectionState(
            resolution.track as MusicWallTrack,
            resolution.sourceIndex,
            candidate.instanceId,
            "open",
          );
          setPanelStatus("");
          setIsReturnPanelPrepared(true);
          return;
        }
      }

      // A manual/cross-collection item (or a source index outside the current
      // fixed pool) must never fall back to an old card with the same track id.
      assignSelectionState(null, 0, null, "idle");
      setPanelStatus("");
      setIsReturnPanelPrepared(false);
      return;
    }

    const backup = playbackReturnBackupRef.current;
    if (!backup || backup.key !== key) {
      return;
    }

    if (transition.phase === "cancel") {
      freezeWallMotion();
      clearCardSelectionOwnership();
      const backupElement = backup.instanceId
        ? cardRefs.current.get(backup.instanceId)
        : undefined;
      const backupStillOwnsTrack = Boolean(
        backupElement
        && Number(backupElement.dataset.sourceIndex) === backup.trackIndex
        && backupElement.dataset.trackId === backup.track?.id
        && backupElement.dataset.clone !== "true",
      );
      if (backup.phase === "open" && backup.track && backupStillOwnsTrack) {
        setCardSelected(backupElement, true);
        wallRef.current?.setAttribute("data-has-selection", "true");
        assignSelectionState(
          backup.track,
          backup.trackIndex,
          backup.instanceId,
          "open",
        );
      } else {
        assignSelectionState(null, 0, null, "idle");
      }
      setIsReturnPanelPrepared(false);
    }

    if (transition.phase === "commit") {
      // Keep the exact target card and panel in their final, transition-free
      // pose across the player unmount. The attribute is released only after
      // two presented frames, when normal Wall styles are visually identical.
      motionController.afterPaint(() => {
        if (playbackReturnStageRef.current === stageKey) {
          setIsReturnPanelPrepared(false);
        }
      }, 2);
    }

    playbackReturnBackupRef.current = null;
  }, [
    assignSelectionState,
    clearCardSelectionOwnership,
    findReturnCardInstance,
    freezeWallMotion,
    isPlayerTransitioning,
    isReturnPanelPrepared,
    playbackReturnTransition,
    queueContext,
    wallTracks,
  ]);

  const prepareWallReturn = useCallback(() => {
    if (
      stateRef.current !== "detail"
      || returnRequestPendingRef.current
    ) {
      return null;
    }

    const capturedAt = performance.now();
    const hasActiveDrag =
      dragRef.current.pointerId !== -1
      && dragRef.current.moved
      && Math.abs(dragRef.current.velocity) > 3;
    const hasInteractionMomentum =
      hasActiveDrag
      || capturedAt < interactionActiveUntilRef.current
      || Math.abs(interactionVelocityRef.current) > 3;
    const initialSpeed = prefersReducedMotion
      ? 0
      : hasActiveDrag
        ? dragRef.current.velocity
        : hasInteractionMomentum
          ? interactionVelocityRef.current
        : currentSpeedRef.current;
    const pendingColumnRebase = pendingColumnRebaseRef.current
      ? { ...pendingColumnRebaseRef.current }
      : null;
    const cardStep = wallLayout.tileSize + wallLayout.gap;
    const resolvedOffset = pendingColumnRebase
      ? renderedOffsetRef.current - pendingColumnRebase.delta * cardStep
      : renderedOffsetRef.current;
    let participantSlots: readonly string[];

    if (layoutMode === "wall") {
      const calculationStartedAt = performance.now();
      const participantTrackIndexes = pendingColumnRebase
        ? Array.from({ length: wallLayout.rowCount }, (_, rowIndex) =>
            Array.from(
              { length: wallLayout.sequenceLength },
              (_, columnIndex) => positiveModulo(
                (columnIndex - pendingColumnRebase.nextShift)
                  * wallLayout.rowCount
                  + rowIndex
                  - portalRow,
                wallTracks.length,
              ),
            )
          )
        : wallRows.map((row) => row.map(({ trackIndex }) => trackIndex));
      const participants = findPortalParticipants(
        participantTrackIndexes,
        wallLayout,
        resolvedOffset,
      );
      participantSlots = participants.slotKeys;
      noteHomeWallTransitionMetric(
        "wall-closing-participant-prepare-ms",
        performance.now() - calculationStartedAt,
      );
      noteHomeWallTransitionMetric(
        "wall-closing-participant-count",
        participants.slotKeys.length,
      );
    } else {
      participantSlots = [...initialPortalParticipantSlots];
      noteHomeWallTransitionMetric(
        "wall-closing-participant-count",
        wallTracks.length,
      );
    }

    const preparation: MusicWallReturnPreparation = {
      capturedAt,
      initialSpeed,
      currentSpeed: currentSpeedRef.current,
      renderedOffset: renderedOffsetRef.current,
      targetOffset: targetOffsetRef.current,
      resolvedOffset,
      wallTransform: wallRef.current?.style.transform
        ?? `translate3d(${renderedOffsetRef.current}px, 0, 0)`,
      wallColumnShift:
        pendingColumnRebase?.nextShift ?? wallColumnShiftRef.current,
      pendingColumnRebase,
      participantSlots,
      motionState: motionStateRef.current,
      automaticWasRunning: motionStateRef.current === "auto",
    };
    closingMotionPreparationRef.current = preparation;
    closingParticipantSlotsRef.current = new Set(participantSlots);
    returnRequestPendingRef.current = true;

    // Braking begins from the real wall velocity in the same input task as
    // the return request. The parent will commit `closing` synchronously after
    // restoring the still-covered Home snapshot; that commit must continue
    // this motion rather than sampling and restarting it on a later frame.
    brakingStartedAtRef.current = capturedAt;
    brakingInitialSpeedRef.current = initialSpeed;
    currentSpeedRef.current = initialSpeed;
    brakingEndedReportedRef.current = false;
    motionStateRef.current = prefersReducedMotion ? "stopped" : "braking";

    noteHomeWallTransitionMetric("wall-return-prepared-offset", renderedOffsetRef.current);
    noteHomeWallTransitionMetric("wall-return-prepared-speed", initialSpeed);
    noteHomeWallTransitionMetric(
      "wall-return-used-interaction-velocity",
      hasInteractionMomentum,
    );
    noteHomeWallTransitionMetric(
      "wall-return-used-active-drag-velocity",
      hasActiveDrag,
    );
    return preparation;
  }, [
    initialPortalParticipantSlots,
    layoutMode,
    prefersReducedMotion,
    portalRow,
    wallLayout,
    wallRows,
    wallTracks.length,
  ]);

  const exitToHome = useCallback((restoreKeyboardFocus = false) => {
    const preparation = prepareWallReturn();
    if (!preparation) {
      return false;
    }
    const rollbackPreparation = () => {
      if (closingMotionPreparationRef.current !== preparation) {
        return;
      }
      returnRequestPendingRef.current = false;
      closingMotionPreparationRef.current = null;
      closingParticipantSlotsRef.current = null;
      brakingStartedAtRef.current = 0;
      brakingInitialSpeedRef.current = preparation.currentSpeed;
      currentSpeedRef.current = preparation.currentSpeed;
      motionStateRef.current = preparation.motionState;
    };
    if (!onExit(preparation, restoreKeyboardFocus)) {
      rollbackPreparation();
      return false;
    }
    // TransitionManager.prepare is synchronous on the accepted path and
    // commits `closing` before this task returns. If snapshot restoration
    // throws before that commit, release the guard on the next task so a
    // recoverable failure cannot permanently disable Back/Escape.
    window.setTimeout(() => {
      if (
        returnRequestPendingRef.current
        && stateRef.current === "detail"
      ) {
        rollbackPreparation();
      }
    }, 0);
    return true;
  }, [onExit, prepareWallReturn]);

  useLayoutEffect(() => {
    onExitControllerChange(exitToHome);
    return () => onExitControllerChange(null);
  }, [exitToHome, onExitControllerChange]);

  const prefetchIncomingColumns = useCallback((
    baseColumnShift: number,
    direction: -1 | 1,
  ) => {
    if (
      layoutModeRef.current !== "wall"
      || wallTracks.length === 0
    ) {
      return;
    }

    const edgeColumn = direction > 0
      ? 0
      : Math.max(0, wallLayout.sequenceLength - 1);
    const sources = new Set<string>();

    // The fixed pool keeps every DOM/card key stable. Only the leading edge
    // introduces an uncached image as the pool is rebased, so warming the next
    // two edge columns is enough to avoid a source/decode flash without
    // decoding the whole collection.
    for (let step = 1; step <= 2; step += 1) {
      const upcomingShift = baseColumnShift + direction * step;
      for (let rowIndex = 0; rowIndex < wallLayout.rowCount; rowIndex += 1) {
        const trackIndex = positiveModulo(
          (edgeColumn - upcomingShift) * wallLayout.rowCount
            + rowIndex
            - portalRow,
          wallTracks.length,
        );
        const coverTrack = modeRef.current === "album"
          ? albumCoverTrackRef.current
          : wallTracks[trackIndex];
        if (coverTrack?.coverImage) {
          sources.add(coverTrack.coverImage);
        }
      }
    }

    if (sources.size > 0) {
      imageCache.preloadDeferred([...sources], {
        batchSize: 2,
        concurrency: 2,
      });
    }
  }, [
    portalRow,
    wallLayout.rowCount,
    wallLayout.sequenceLength,
    wallTracks,
  ]);

  const getPlaybackOrigin = useCallback((instanceId: string | null) => {
    if (!instanceId) {
      return undefined;
    }

    const bounds = cardRefs.current.get(instanceId)?.getBoundingClientRect();

    if (!bounds || bounds.width === 0) {
      return undefined;
    }

    return {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
  }, []);

  const commitPendingSelection = useCallback(() => {
    const pendingSelection = pendingSelectionRef.current;
    if (!pendingSelection) {
      return;
    }

    pendingSelectionRef.current = null;
    freezeWallMotion();
    selectionPhaseRef.current = "open";
    setSelectionPhase("open");
  }, [freezeWallMotion]);

  const beginSelection = useCallback(
    (
      track: MusicWallTrack,
      instanceId: string,
      element?: HTMLButtonElement,
      trackIndex = 0,
    ) => {
      if (
        stateRef.current !== "detail"
        || playerTransitioningRef.current
        || motionStateRef.current !== "auto"
        || selectionTransitionPendingRef.current
      ) {
        return;
      }

      selectionTransitionPendingRef.current = true;
      selectionTransitionAbortRef.current?.abort(
        "Wall detail transition superseded",
      );
      const transitionAbort = new AbortController();
      selectionTransitionAbortRef.current = transitionAbort;
      void transitionManager.run("wall-detail", {
        prepare: () => {
          pendingSelectionRef.current = { track, instanceId, trackIndex };
          assignSelectionState(track, trackIndex, instanceId, "braking");
          setPanelStatus("");
          if (layoutModeRef.current === "wall") {
            motionStateRef.current = "braking";
            brakingStartedAtRef.current = performance.now();
            brakingInitialSpeedRef.current = currentSpeedRef.current;
          } else {
            freezeWallMotion();
          }
          const hoveredInstanceId = hoveredTileRef.current?.instanceId;
          if (hoveredInstanceId) {
            cardRefs.current
              .get(hoveredInstanceId)
              ?.setAttribute("data-hovered", "false");
          }
          wallRef.current?.setAttribute("data-has-hover", "false");
          wallRef.current?.setAttribute("data-has-selection", "true");
          setCardSelected(element, true);
          hoveredTileRef.current = null;
          const panelCoverSource =
            modeRef.current === "album"
              ? albumCoverTrackRef.current.coverImage
              : track.coverImage;
          void motionController.preloadImage(panelCoverSource);
          if (!isExternalPlayback) {
            void playbackPrefetchService.prefetchTrack(track);
            void prewarmImmersivePlayback(track, {
              theme:
                document
                    .querySelector<HTMLElement>(".welcome")
                    ?.dataset.colorTheme === "light"
                  ? "light"
                  : "dark",
              space: "music",
              tier: isLowPerformance ? "low" : "standard",
            });
          }
        },
        animate: async (transition) => {
          await transition.wait(
            prefersReducedMotion
              ? 1
              : layoutModeRef.current === "wall"
                ? wallMotion.transitionDuration
                : 80,
          );
        },
        complete: commitPendingSelection,
      }, {
        signal: transitionAbort.signal,
      }).then((result) => {
        if (
          result.status === "cancelled"
          && mountedRef.current
          && selectionTransitionAbortRef.current === transitionAbort
        ) {
          const pendingInstanceId =
            pendingSelectionRef.current?.instanceId;
          if (pendingInstanceId) {
            setCardSelected(
              cardRefs.current.get(pendingInstanceId),
              false,
            );
          }
          pendingSelectionRef.current = null;
          wallRef.current?.setAttribute("data-has-selection", "false");
          selectionPhaseRef.current = "idle";
          setSelectionPhase("idle");
          if (wallMayAutoMove(
            stateRef.current,
            "idle",
            playerTransitioningRef.current,
          )) {
            resumeWallMotion();
          }
        }
      }).catch(() => {
        if (
          mountedRef.current
          && selectionTransitionAbortRef.current === transitionAbort
        ) {
          pendingSelectionRef.current = null;
          wallRef.current?.setAttribute("data-has-selection", "false");
          selectionPhaseRef.current = "idle";
          setSelectionPhase("idle");
          if (wallMayAutoMove(
            stateRef.current,
            "idle",
            playerTransitioningRef.current,
          )) {
            resumeWallMotion();
          }
        }
      }).finally(() => {
        if (selectionTransitionAbortRef.current === transitionAbort) {
          selectionTransitionAbortRef.current = null;
          selectionTransitionPendingRef.current = false;
        }
      });
    },
    [
      commitPendingSelection,
      assignSelectionState,
      freezeWallMotion,
      isLowPerformance,
      isExternalPlayback,
      playbackPrefetchService,
      prefersReducedMotion,
      resumeWallMotion,
    ],
  );

  const closePanel = useCallback(() => {
    panelPrefetchCancelRef.current?.();
    panelPrefetchCancelRef.current = null;
    lyricsRequestConsumer.cancel("Music wall detail closed");
    setLyricsOverlayOpen(false);
    if (selectionTransitionPendingRef.current) {
      return;
    }
    selectionTransitionPendingRef.current = true;
    selectionTransitionAbortRef.current?.abort(
      "Wall detail transition superseded",
    );
    const transitionAbort = new AbortController();
    selectionTransitionAbortRef.current = transitionAbort;
    const pendingInstanceId = pendingSelectionRef.current?.instanceId;
    void transitionManager.run("wall-detail", {
      prepare: () => {
        if (pendingInstanceId) {
          setCardSelected(
            cardRefs.current.get(pendingInstanceId),
            false,
          );
        }
        pendingSelectionRef.current = null;
      },
      animate: async (transition) => {
        selectionPhaseRef.current = "closing";
        setSelectionPhase("closing");
        await transition.wait(
          prefersReducedMotion ? 1 : wallMotion.panelDuration,
        );
      },
      complete: () => {
        if (selectedInstanceId) {
          setCardSelected(
            cardRefs.current.get(selectedInstanceId),
            false,
          );
        }
        hoveredTileRef.current = null;
        wallRef.current?.setAttribute("data-has-hover", "false");
        wallRef.current?.setAttribute("data-has-selection", "false");
        assignSelectionState(null, 0, null, "idle");
        setPanelStatus("");
        freezeWallMotion();
        resumeWallMotion();
      },
    }, {
      signal: transitionAbort.signal,
    }).catch(() => {
      if (
        mountedRef.current
        && stateRef.current === "detail"
        && selectionTransitionAbortRef.current === transitionAbort
      ) {
        selectionPhaseRef.current = "open";
        setSelectionPhase("open");
      }
    }).finally(() => {
      if (selectionTransitionAbortRef.current === transitionAbort) {
        selectionTransitionAbortRef.current = null;
        selectionTransitionPendingRef.current = false;
      }
    });
  }, [
    assignSelectionState,
    freezeWallMotion,
    lyricsRequestConsumer,
    prefersReducedMotion,
    resumeWallMotion,
    selectedInstanceId,
  ]);

  const enterPlayer = useCallback(
    (
      track: MusicWallTrack,
      trackIndex: number,
      startPositionMs?: number,
    ) => {
      if (
        selectionPhase !== "open"
        || isPlayerTransitioning
        || state !== "detail"
      ) {
        return false;
      }

      if (isExternalPlayback) {
        onPlay(track, "music-wall");
        return true;
      }

      onPlay(
        track,
        "music-wall",
        getPlaybackOrigin(selectedInstanceId),
        {
          context: queueContext,
          tracks: wallTracks,
          startIndex: trackIndex,
        },
        startPositionMs,
      );
      return true;
    },
    [
      getPlaybackOrigin,
      isExternalPlayback,
      isPlayerTransitioning,
      onPlay,
      queueContext,
      selectedInstanceId,
      selectionPhase,
      state,
      wallTracks,
    ],
  );

  const setPanelCloseElement = useCallback(
    (element: HTMLButtonElement | null) => {
      panelCloseRef.current = element;
    },
    [],
  );
  const setLyricsTriggerElement = useCallback(
    (element: HTMLButtonElement | null) => {
      lyricsTriggerRef.current = element;
    },
    [],
  );
  const playPanelTrack = useCallback(
    () => enterPlayer(panelTrack, panelTrackIndex),
    [enterPlayer, panelTrack, panelTrackIndex],
  );
  const prewarmPanelTrack = useCallback(() => {
    if (isExternalPlayback) {
      return;
    }
    void prewarmImmersivePlayback(panelTrack, {
      theme:
        document
            .querySelector<HTMLElement>(".welcome")
            ?.dataset.colorTheme === "light"
          ? "light"
          : "dark",
      space: "music",
      tier: isLowPerformance ? "low" : "standard",
    });
    panelPrefetchCancelRef.current?.();
    panelPrefetchCancelRef.current = playbackPrefetchService.schedulePrefetch(
      panelTrack,
      { delayMs: 150 },
    );
  }, [
    isExternalPlayback,
    isLowPerformance,
    panelTrack,
    playbackPrefetchService,
  ]);
  const cancelPanelTrackPrewarm = useCallback(() => {
    panelPrefetchCancelRef.current?.();
    panelPrefetchCancelRef.current = null;
  }, []);
  const queuePanelTrack = useCallback(() => {
    const queueSeed: PlaybackQueueSeed = {
      context: queueContext,
      tracks: wallTracks,
      startIndex: panelTrackIndex,
    };
    const snapshot = playbackQueueController.getSnapshot();
    if (snapshot.current) {
      const item = playbackQueueController.append(
        panelTrack,
        queueContext.providerId,
      );
      setPanelStatus(item
        ? t("wall.status.queued")
        : t("wall.status.queueFailed"));
      return;
    }
    playbackQueueController.stage(queueSeed);
    setPanelStatus(t("wall.status.queueCreated"));
  }, [panelTrack, panelTrackIndex, queueContext, t, wallTracks]);
  const queuePanelTrackNext = useCallback(() => {
    const snapshot = playbackQueueController.getSnapshot();
    if (!snapshot.current) {
      playbackQueueController.stage({
        context: queueContext,
        tracks: wallTracks,
        startIndex: panelTrackIndex,
      });
      setPanelStatus(t("wall.status.queueCreated"));
      return;
    }
    const item = playbackQueueController.playNext(
      panelTrack,
      queueContext.providerId,
    );
    setPanelStatus(item
      ? t("wall.status.next")
      : t("wall.status.nextFailed"));
  }, [panelTrack, panelTrackIndex, queueContext, t, wallTracks]);
  const closeLyricsOverlay = useCallback(() => {
    lyricsRequestConsumer.cancel("Full lyrics overlay closed");
    setLyricsOverlayOpen(false);
  }, [lyricsRequestConsumer]);
  const showPanelLyrics = useCallback(() => {
    setLyricsOverlayTrackId(panelTrack.id);
    setLyricsOverlayOpen(true);
    setLyricsOverlayStatus("loading");
    setLyricsOverlayError("");
    void lyricsRequestConsumer.resolve(panelTrack).then(({ document }) => {
      setLyricsDocumentBase(document);
      setLyricsOverlayStatus(document.lines.length > 0 ? "ready" : "empty");
    }).catch((error) => {
      if (isSilentProviderRequestError(error)) {
        return;
      }
      setLyricsOverlayStatus("error");
      setLyricsOverlayError(error instanceof Error ? error.message : String(error));
    });
  }, [lyricsRequestConsumer, panelTrack]);
  const seekFromLyricsOverlay = useCallback((positionMs: number) => {
    closeLyricsOverlay();
    if (playbackSessionBridge.requestSeek(panelTrack.id, positionMs)) {
      return;
    }
    enterPlayer(panelTrack, panelTrackIndex, positionMs);
  }, [closeLyricsOverlay, enterPlayer, panelTrack, panelTrackIndex]);

  useLayoutEffect(() => {
    onPanelStateChange(selectionPhase !== "idle");
  }, [onPanelStateChange, selectionPhase]);

  useEffect(() => {
    if (selectionPhase === "open" && !isPlayerTransitioning) {
      const focusFrame = window.requestAnimationFrame(() => {
        panelCloseRef.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(focusFrame);
    }
  }, [isPlayerTransitioning, selectionPhase]);

  useEffect(() => {
    if (state === "closing") {
      selectionTransitionAbortRef.current?.abort("Music wall is closing");
      selectionTransitionAbortRef.current = null;
      selectionTransitionPendingRef.current = false;
      const pendingInstanceId = pendingSelectionRef.current?.instanceId;
      if (pendingInstanceId) {
        setCardSelected(
          cardRefs.current.get(pendingInstanceId),
          false,
        );
      }
      pendingSelectionRef.current = null;
      if (selectedInstanceId) {
        setCardSelected(
          cardRefs.current.get(selectedInstanceId),
          false,
        );
      }
      hoveredTileRef.current = null;
      dragRef.current.pointerId = -1;
      dragRef.current.moved = false;
      dragRef.current.velocity = 0;
      suppressClickRef.current = false;
      setIsDragging(false);
      wallRef.current?.setAttribute("data-has-hover", "false");
      wallRef.current?.setAttribute("data-has-selection", "false");
      selectionPhaseRef.current = "idle";
      setSelectionPhase("idle");
      interactionVelocityRef.current = 0;
      interactionActiveUntilRef.current = 0;
    }
  }, [selectedInstanceId, state]);

  useEffect(() => {
    if (isPlayerTransitioning) {
      freezeWallMotion();
    }
  }, [freezeWallMotion, isPlayerTransitioning]);

  useLayoutEffect(() => {
    let resizeFrame = 0;

    const commitLayout = (nextLayout: WallLayout) => {
      setWallLayout((current) =>
        current.rowCount === nextLayout.rowCount
        && current.tileSize === nextLayout.tileSize
        && current.gap === nextLayout.gap
        && current.sequenceLength === nextLayout.sequenceLength
          ? current
          : nextLayout
      );
    };
    const updateLayout = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        commitLayout(readWallLayout());
      });
    };

    // A prepared wall already carries the viewport-derived layout. Re-reading
    // and scheduling that state during its first layout pass adds work to the
    // portal's critical frame even when React ultimately bails out.
    if (!preparation) {
      commitLayout(readWallLayout());
    }
    window.addEventListener("resize", updateLayout);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.cancelAnimationFrame(resizeFrame);
    };
  }, [preparation]);

  useLayoutEffect(() => {
    if (layoutMode !== "wall") {
      return;
    }

    const wall = wallRef.current;
    if (!wall) {
      return;
    }

    const presentation = initialPresentation;
    const initialOffset = presentation.initialOffset;
    targetOffsetRef.current = initialOffset;
    renderedOffsetRef.current = initialOffset;
    pendingColumnRebaseRef.current = null;
    if (
      wallColumnShiftRef.current !== presentation.initialColumnShift
    ) {
      wallColumnShiftRef.current = presentation.initialColumnShift;
      // A newly prepared collection must own its final pool assignment before
      // the TransitionManager paint boundary. Deferring this reset allowed the
      // previous collection's column shift to survive into the first opening
      // frame and then visibly snap when the transition update committed.
      setWallColumnShift(presentation.initialColumnShift);
    }
    // Opening is painted at the final geometry. Its own layout phase starts
    // the shared RAF before the wall becomes visible.
    currentSpeedRef.current = 0;
    interactionVelocityRef.current = 0;
    interactionActiveUntilRef.current = 0;
    motionStateRef.current = "stopped";
    wall.style.transform = `translate3d(${initialOffset}px, 0, 0)`;

    const automaticDirection: -1 | 1 = wallMotion.wallSpeed < 0 ? -1 : 1;
    prefetchIncomingColumns(
      presentation.initialColumnShift,
      automaticDirection,
    );
  }, [
    layoutMode,
    initialPresentation,
    prefetchIncomingColumns,
    wallLayout,
  ]);

  useLayoutEffect(() => {
    if (layoutMode !== "wall") {
      pendingColumnRebaseRef.current = null;
      return;
    }

    const pendingRebase = pendingColumnRebaseRef.current;
    const wall = wallRef.current;
    if (
      !pendingRebase
      || pendingRebase.nextShift !== wallColumnShift
      || !wall
    ) {
      return;
    }

    // React has now committed the recycled card data. Compensate the pool's
    // transform in the same layout phase, before the browser can paint either
    // half of the rebase. Previously the transform jumped in the RAF and the
    // card data arrived in a later transition commit, producing a one-frame
    // wall flash on both slow and fast movement.
    const cardStep = wallLayout.tileSize + wallLayout.gap;
    const offsetCompensation = pendingRebase.delta * cardStep;
    targetOffsetRef.current -= offsetCompensation;
    renderedOffsetRef.current -= offsetCompensation;
    wall.style.transform =
      `translate3d(${renderedOffsetRef.current}px, 0, 0)`;
    pendingColumnRebaseRef.current = null;
  }, [
    layoutMode,
    wallColumnShift,
    wallLayout.gap,
    wallLayout.tileSize,
  ]);

  useLayoutEffect(() => {
    if (layoutMode !== "wall") {
      freezeWallMotion();
      return;
    }

    if (
      isPlayerTransitioning
      || selectionPhase === "open"
      || selectionPhase === "closing"
    ) {
      freezeWallMotion();
      return;
    }

    if (state === "detail" && selectionPhase === "braking") {
      // beginSelection owns the one allowed deceleration. Do not overwrite it
      // with a new automatic speed while React commits the braking phase.
      return;
    }

    const openingSpeed =
      wallMotion.wallSpeed * homeWallMotion.openingInitialSpeedRatio;
    if (prefersReducedMotion) {
      freezeWallMotion();
    } else if (state === "opening") {
      // The RAF subscription, safe-loop offset and opening velocity are all
      // ready before cards begin forming. Releasing motion on the old 16%
      // timer made the first wall transform land in the same frame as the
      // largest card-animation batch. A bounded initial velocity now ramps to
      // the normal cruise target before the owner gate makes cards readable;
      // detail keeps that same target instead of starting a second acceleration.
      openingStartedAtRef.current = performance.now();
      openingReadableSampledRef.current = false;
      currentSpeedRef.current = openingSpeed;
      resumeWallMotion();
      noteHomeWallTransitionMetric(
        "wall-opening-initial-speed",
        currentSpeedRef.current,
      );
    } else if (state === "detail") {
      // Returning from an open panel reaches this branch only after
      // closePanel() commits idle. Keep speed zero and let the RAF ease back to
      // wallSpeed instead of injecting an opening-speed jump.
      resumeWallMotion();
      noteHomeWallTransitionMetric(
        "wall-detail-commit-speed",
        currentSpeedRef.current,
      );
    } else if (state === "closing") {
      const closingPreparation = closingMotionPreparationRef.current;
      const now = performance.now();
      const initialSpeed = closingPreparation?.initialSpeed
        ?? (prefersReducedMotion ? 0 : currentSpeedRef.current);
      const traceId = activeHomeWallTransitionTraceId();
      closingTraceIdRef.current = traceId;
      if (!closingPreparation) {
        // Defensive fallback for non-visual callers. Normal Home returns are
        // accepted only through exitToHome(), which captures and begins the
        // brake before the parent can restore Home.
        brakingStartedAtRef.current = now;
        brakingInitialSpeedRef.current = initialSpeed;
        currentSpeedRef.current = initialSpeed;
        brakingEndedReportedRef.current = false;
        motionStateRef.current = prefersReducedMotion
          ? "stopped"
          : "braking";
      }
      interactionVelocityRef.current = 0;
      interactionActiveUntilRef.current = 0;
      markHomeWallTransitionPhase("wall-brake-start", traceId);
      noteHomeWallTransitionMetric(
        "wall-speed-0",
        currentSpeedRef.current,
        traceId,
      );
      noteHomeWallTransitionMetric(
        "wall-offset-0",
        renderedOffsetRef.current,
        traceId,
      );
      noteHomeWallTransitionMetric(
        "wall-speed-prepare-to-start-delta",
        currentSpeedRef.current - initialSpeed,
        traceId,
      );
      noteHomeWallTransitionMetric(
        "wall-offset-prepare-to-start-delta",
        renderedOffsetRef.current
          - (closingPreparation?.resolvedOffset
            ?? renderedOffsetRef.current),
        traceId,
      );
      noteHomeWallTransitionMetric(
        "wall-return-capture-to-closing-ms",
        closingPreparation ? now - closingPreparation.capturedAt : -1,
        traceId,
      );

      if (homeWallDiagnosticsEnabled()) {
        const renderedParticipantSlots = wallRef.current?.querySelectorAll(
          '.music-wall__card-slot[data-portal-participant="true"]',
        );
        noteHomeWallTransitionMetric(
          "wall-closing-rendered-participant-count",
          renderedParticipantSlots?.length ?? 0,
          traceId,
        );
      }

      closingSpeedTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      const returnVisualDuration = prefersReducedMotion
        ? homeWallMotion.reducedTransitionDuration
        : homeWallMotion.closeTransitionDuration;
      closingSpeedTimersRef.current = [0.38, 0.46, 0.64, 0.88].map(
        (progress) => window.setTimeout(() => {
          if (
            stateRef.current !== "closing"
            || activeHomeWallTransitionTraceId() !== traceId
          ) {
            return;
          }
          noteHomeWallTransitionMetric(
            `wall-speed-${Math.round(progress * 100)}`,
            currentSpeedRef.current,
            traceId,
          );
          noteHomeWallTransitionMetric(
            `wall-offset-${Math.round(progress * 100)}`,
            renderedOffsetRef.current,
            traceId,
          );
        }, returnVisualDuration * progress),
      );
    } else {
      freezeWallMotion();
    }
  }, [
    freezeWallMotion,
    isPlayerTransitioning,
    layoutMode,
    prefersReducedMotion,
    resumeWallMotion,
    selectionPhase,
    state,
  ]);

  useLayoutEffect(() => {
    if (layoutMode !== "wall") {
      return;
    }

    const viewport = viewportRef.current;
    const wall = wallRef.current;

    if (!viewport || !wall) {
      return;
    }

    const cardStep = wallLayout.tileSize + wallLayout.gap;

    const normalizeOffset = () => {
      if (
        motionStateRef.current !== "auto"
        || cardStep <= 0
        || pendingColumnRebaseRef.current
      ) {
        return;
      }

      let normalizedTarget = targetOffsetRef.current;
      let columnDelta = 0;
      while (normalizedTarget > -cardStep * 1.45) {
        normalizedTarget -= cardStep;
        columnDelta += 1;
      }

      while (normalizedTarget < -cardStep * 3.45) {
        normalizedTarget += cardStep;
        columnDelta -= 1;
      }

      if (columnDelta !== 0) {
        const nextColumnShift =
          wallColumnShiftRef.current + columnDelta;
        wallColumnShiftRef.current = nextColumnShift;
        pendingColumnRebaseRef.current = {
          delta: columnDelta,
          nextShift: nextColumnShift,
        };
        prefetchIncomingColumns(
          nextColumnShift,
          columnDelta > 0 ? 1 : -1,
        );
        // The pool has spare off-screen columns, so it can keep its current
        // transform until React commits the recycled data. The layout effect
        // above applies data + transform compensation atomically.
        setWallColumnShift(nextColumnShift);
      }
    };

    const render = (now: number, deltaMs: number) => {
      const currentState = stateRef.current;
      const currentSelectionPhase = selectionPhaseRef.current;
      if (
        playerTransitioningRef.current
        || currentSelectionPhase === "open"
        || currentSelectionPhase === "closing"
      ) {
        if (
          motionStateRef.current !== "stopped"
          || currentSpeedRef.current !== 0
          || targetOffsetRef.current !== renderedOffsetRef.current
        ) {
          freezeWallMotion();
        }
        return;
      }
      if (
        currentState !== "opening"
        && currentState !== "detail"
        && currentState !== "closing"
      ) {
        return;
      }

      const elapsed = Math.min(48, deltaMs);
      const seconds = elapsed / 1_000;
      const motionState = motionStateRef.current;

      if (
        motionState === "auto"
        && wallMayAutoMove(
          currentState,
          currentSelectionPhase,
          playerTransitioningRef.current,
        )
        && dragRef.current.pointerId === -1
        && !prefersReducedMotion
      ) {
        const hasInteractionMomentum =
          now < interactionActiveUntilRef.current
          || Math.abs(interactionVelocityRef.current) > 3;

        if (hasInteractionMomentum) {
          const quieting = 1 - Math.pow(0.7, elapsed / 16.67);
          currentSpeedRef.current +=
            (0 - currentSpeedRef.current) * quieting;
          targetOffsetRef.current +=
            interactionVelocityRef.current * seconds;
          interactionVelocityRef.current *=
            Math.pow(0.86, elapsed / 16.67);

          if (
            now >= interactionActiveUntilRef.current
            && Math.abs(interactionVelocityRef.current) <= 3
          ) {
            interactionVelocityRef.current = 0;
          }
        } else {
          const acceleration = 1 - Math.pow(0.82, elapsed / 16.67);
          const automaticSpeed = wallMotion.wallSpeed;
          currentSpeedRef.current +=
            (automaticSpeed - currentSpeedRef.current) * acceleration;
          targetOffsetRef.current += currentSpeedRef.current * seconds;

          if (
            stateRef.current === "opening"
            && !openingReadableSampledRef.current
            && now - openingStartedAtRef.current
              >= homeWallMotion.transitionDuration
                * homeWallMotion.firstReadableProgress
          ) {
            openingReadableSampledRef.current = true;
            noteHomeWallTransitionMetric(
              "wall-first-readable-speed",
              currentSpeedRef.current,
            );
          }
        }
      } else if (motionState === "braking") {
        const duration = prefersReducedMotion
          ? 1
          : currentState === "closing"
            ? homeWallMotion.returnBrakeDuration
            : wallMotion.transitionDuration;
        const progress = clamp(
          (now - brakingStartedAtRef.current) / duration,
          0,
          1,
        );
        const brakingProgress = currentState === "closing"
          ? smoothStep(progress)
          : easeOutCubic(progress);
        currentSpeedRef.current =
          brakingInitialSpeedRef.current * (1 - brakingProgress);
        targetOffsetRef.current += currentSpeedRef.current * seconds;

        if (progress >= 1) {
          currentSpeedRef.current = 0;
          motionStateRef.current = "stopped";
          if (!brakingEndedReportedRef.current) {
            brakingEndedReportedRef.current = true;
            const traceId = closingTraceIdRef.current;
            markHomeWallTransitionPhase("wall-brake-ended", traceId);
            noteHomeWallTransitionMetric(
              "wall-brake-ended-at-progress",
              homeWallMotion.returnBrakeDuration
                / homeWallMotion.closeTransitionDuration,
              traceId,
            );
          }
        }
      }

      if (motionStateRef.current === "stopped") {
        return;
      }

      normalizeOffset();

      const smoothing =
        prefersReducedMotion || dragRef.current.moved
          ? 1
          : wallMotion.dragSmoothing;
      if (
        prefersReducedMotion
        && Math.abs(
          targetOffsetRef.current - renderedOffsetRef.current,
        ) < 0.01
      ) {
        return;
      }
      renderedOffsetRef.current +=
        (targetOffsetRef.current - renderedOffsetRef.current) * smoothing;
      wall.style.transform =
        `translate3d(${renderedOffsetRef.current}px, 0, 0)`;
      const root = rootSectionRef.current;
      if (root) {
        root.dataset.motionState = motionStateRef.current;
        root.dataset.currentSpeed = String(currentSpeedRef.current);
        root.dataset.targetOffset = String(targetOffsetRef.current);
        root.dataset.renderedOffset = String(renderedOffsetRef.current);
      }
    };

    const handleWheel = (event: WheelEvent) => {
      if (
        !wallMayAutoMove(
          stateRef.current,
          selectionPhaseRef.current,
          playerTransitioningRef.current,
        )
        || motionStateRef.current !== "auto"
      ) {
        return;
      }

      event.preventDefault();
      const rawDelta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const deltaUnit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(1, viewport.clientWidth)
          : 1;
      const normalizedDelta = clamp(
        rawDelta * deltaUnit,
        -Math.min(160, cardStep * 0.7),
        Math.min(160, cardStep * 0.7),
      );
      const direction: -1 | 1 = normalizedDelta > 0 ? -1 : 1;
      const maximumVelocity = cardStep * 7;

      if (prefersReducedMotion) {
        targetOffsetRef.current -= normalizedDelta;
        interactionVelocityRef.current = 0;
        interactionActiveUntilRef.current = 0;
        prefetchIncomingColumns(wallColumnShiftRef.current, direction);
        return;
      }

      interactionVelocityRef.current = clamp(
        interactionVelocityRef.current
          - normalizedDelta * wallMotion.wheelStrength * 18,
        -maximumVelocity,
        maximumVelocity,
      );
      interactionActiveUntilRef.current = performance.now() + 110;
      prefetchIncomingColumns(wallColumnShiftRef.current, direction);
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    const unsubscribeFrame = motionController.subscribeFrame(render);

    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      unsubscribeFrame();
    };
  }, [
    freezeWallMotion,
    layoutMode,
    prefetchIncomingColumns,
    prefersReducedMotion,
    wallLayout.gap,
    wallLayout.tileSize,
  ]);

  useEffect(() => {
    if (state !== "detail" || isPlayerTransitioning) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "Escape" && lyricsOverlayOpen) {
        event.preventDefault();
        closeLyricsOverlay();
        return;
      }

      if (event.key === "Escape" && selectionPhase === "open") {
        event.preventDefault();
        closePanel();
        return;
      }

      const hoveredTile = hoveredTileRef.current;

      if (event.key === "Enter" && hoveredTile) {
        event.preventDefault();
        beginSelection(
          hoveredTile.track,
          hoveredTile.instanceId,
          undefined,
          hoveredTile.trackIndex,
        );
        return;
      }

      if (
        (
          event.code === "Space"
          || event.key === " "
          || event.key === "Spacebar"
        )
        && selectedTrack
        && selectionPhase === "open"
      ) {
        event.preventDefault();
        enterPlayer(selectedTrack, selectedTrackIndex);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    beginSelection,
    closePanel,
    closeLyricsOverlay,
    enterPlayer,
    isPlayerTransitioning,
    lyricsOverlayOpen,
    selectedTrack,
    selectedTrackIndex,
    selectionPhase,
    state,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      panelPrefetchCancelRef.current?.();
      panelPrefetchCancelRef.current = null;
      lyricsRequestConsumer.cancel("Music wall unmounted");
      selectionTransitionAbortRef.current?.abort("Music wall unmounted");
      selectionTransitionAbortRef.current = null;
      selectionTransitionPendingRef.current = false;
      if (dragReleaseTimerRef.current !== null) {
        window.clearTimeout(dragReleaseTimerRef.current);
        dragReleaseTimerRef.current = null;
      }
      closingSpeedTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      closingSpeedTimersRef.current = [];
    };
  }, [lyricsRequestConsumer]);

  useLayoutEffect(() => {
    noteHomeWallMusicWallCommit();
  });

  useEffect(() => {
    if (state === "closing") {
      return;
    }
    returnRequestPendingRef.current = false;
    closingSpeedTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    closingSpeedTimersRef.current = [];
    if (state === "prepared" || state === "detail") {
      closingParticipantSlotsRef.current = null;
      closingMotionPreparationRef.current = null;
    }
  }, [state]);

  useLayoutEffect(() => {
    const previousState = previousWallStateRef.current;
    previousWallStateRef.current = state;
    if (previousState !== "closing" || state === "closing") {
      return;
    }
    const traceId = closingTraceIdRef.current;
    noteHomeWallTransitionMetric("wall-speed-100", 0, traceId);
    noteHomeWallTransitionMetric(
      "wall-offset-100",
      renderedOffsetRef.current,
      traceId,
    );
  }, [state]);

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      layoutMode !== "wall"
      || !wallMayAutoMove(
        stateRef.current,
        selectionPhaseRef.current,
        playerTransitioningRef.current,
      )
      ||
      motionStateRef.current !== "auto"
      || event.pointerType === "mouse" && event.button !== 0
    ) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startOffset: targetOffsetRef.current,
      lastX: event.clientX,
      lastAt: performance.now(),
      velocity: 0,
      moved: false,
    };
    interactionVelocityRef.current = 0;
    interactionActiveUntilRef.current = Number.POSITIVE_INFINITY;
  };

  const handleDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current.pointerId !== event.pointerId) {
      return;
    }

    const movement = event.clientX - dragRef.current.startX;

    if (Math.abs(movement) > 4) {
      if (!dragRef.current.moved) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsDragging(true);
      }

      dragRef.current.moved = true;
      suppressClickRef.current = true;
    }

    const now = performance.now();
    const deltaX = event.clientX - dragRef.current.lastX;
    const deltaMs = Math.max(8, now - dragRef.current.lastAt);
    const instantaneousVelocity = deltaX / deltaMs * 1_000;
    dragRef.current.velocity =
      dragRef.current.velocity * 0.72 + instantaneousVelocity * 0.28;
    dragRef.current.lastX = event.clientX;
    dragRef.current.lastAt = now;

    targetOffsetRef.current = dragRef.current.startOffset + movement;
    if (Math.abs(deltaX) > 0.01) {
      prefetchIncomingColumns(
        wallColumnShiftRef.current,
        deltaX > 0 ? 1 : -1,
      );
    }
  };

  const handleDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const releasedVelocity = dragRef.current.moved
      ? clamp(
          dragRef.current.velocity,
          -(wallLayout.tileSize + wallLayout.gap) * 7,
          (wallLayout.tileSize + wallLayout.gap) * 7,
        )
      : 0;
    dragRef.current.pointerId = -1;
    dragRef.current.moved = false;
    dragRef.current.velocity = 0;
    interactionVelocityRef.current = releasedVelocity;
    interactionActiveUntilRef.current = performance.now() + 80;
    setIsDragging(false);
    if (dragReleaseTimerRef.current !== null) {
      window.clearTimeout(dragReleaseTimerRef.current);
    }
    dragReleaseTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      dragReleaseTimerRef.current = null;
    }, 0);
  };

  const handleTrackHover = useCallback((nextTile: HoveredTile | null) => {
    hoveredTileRef.current = nextTile;
  }, []);

  const handleCardSelection = useCallback(
    (
      track: MusicWallTrack,
      instanceId: string,
      element: HTMLButtonElement,
      trackIndex: number,
    ) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }

      beginSelection(track, instanceId, element, trackIndex);
    },
    [beginSelection],
  );

  const detailPanel = (
    <GlassDetailPanel
      isOpen={isPanelVisible}
      track={panelTrack}
      coverTrack={panelCoverTrack}
      trackIndex={panelTrackIndex}
      status={panelStatus}
      isPlayerTransitioning={isPlayerTransitioning}
      isPlaybackReturning={isPlaybackReturning}
      isObscured={lyricsOverlayOpen}
      isExternalPlayback={isExternalPlayback}
      overlayStyle={wallStyle}
      closeButtonRef={setPanelCloseElement}
      lyricsButtonRef={setLyricsTriggerElement}
      onClose={closePanel}
      onPlay={playPanelTrack}
      onPrewarm={prewarmPanelTrack}
      onPrewarmCancel={cancelPanelTrackPrewarm}
      onQueue={queuePanelTrack}
      onQueueNext={queuePanelTrackNext}
      onShowLyrics={showPanelLyrics}
    />
  );
  const overlaySessionMatches = playbackSession.trackId === panelTrack.id
    && playbackSession.canSeek;
  const overlayElapsedMs = overlaySessionMatches
    ? playbackSession.elapsedMs
    : 0;
  const overlayActiveIndex = overlaySessionMatches
    ? getNormalizedLyricIndex(lyricsDocument, overlayElapsedMs)
    : -1;
  const overlayPanels = (
    <>
      {detailPanel}
      <FullLyricsOverlay
        open={lyricsOverlayOpen}
        lyrics={lyricsDocument}
        elapsedMs={overlayElapsedMs}
        activeIndex={overlayActiveIndex}
        showTranslation={playerPreferences.showTranslation}
        canSeek={selectionPhase === "open" && !isPlayerTransitioning}
        status={lyricsOverlayStatus}
        errorMessage={lyricsOverlayError}
        onOffsetChange={(nextOffsetMs) => {
          lyricOffsetStore.set(lyricsOffsetStorageKey, nextOffsetMs);
        }}
        onSeek={seekFromLyricsOverlay}
        onRequestClose={closeLyricsOverlay}
        onAfterClose={() => {
          lyricsTriggerRef.current?.focus({ preventScroll: true });
        }}
      />
    </>
  );

  return (
    <>
      <section
        ref={rootSectionRef}
        className="music-wall"
        style={wallStyle}
        data-state={state}
        data-mode={mode}
        data-layout={layoutMode}
        data-cover-strategy={coverStrategy}
        data-provider-id={queueContext.providerId}
        data-collection-id={queueContext.collectionId}
        data-unique-cover-ratio={uniqueCoverRatio.toFixed(2)}
        data-row-count={wallLayout.rowCount}
        data-selection-phase={selectionPhase}
        data-panel-open={isPanelVisible}
        data-playing={isPlayerTransitioning}
        data-returning={isPlaybackReturning}
        data-motion-state={motionStateRef.current}
        data-current-speed={currentSpeedRef.current}
        data-target-offset={targetOffsetRef.current}
        data-rendered-offset={renderedOffsetRef.current}
        data-dragging={isDragging}
        data-low-performance={isLowPerformance}
        data-interaction-locked={
          state !== "detail"
          || isPlayerTransitioning
          || selectionPhase !== "idle"
        }
        aria-hidden={state !== "detail"}
        inert={
          state !== "detail" || isPlayerTransitioning || lyricsOverlayOpen
            ? true
            : undefined
        }
        aria-label={t("wall.aria", {
          title,
          kind: t(
            mode === "album"
              ? "home.kind.album"
              : mode === "artist"
                ? "home.kind.artist"
                : mode === "radio"
                  ? "home.kind.radio"
                  : "home.kind.playlist",
          ),
        })}
      >
        <header className="music-wall__header">
        <button
          className="music-wall__back"
          type="button"
          disabled={state !== "detail" || isPlayerTransitioning}
          onClick={() => exitToHome(false)}
        >
          <span aria-hidden="true">←</span>
          BACK
        </button>

        <div className="music-wall__collection">
          <span>
            {wallModeLabel(mode)} / {number}
          </span>
          <strong>{title}</strong>
          {subtitle && <small lang="ja">{subtitle}</small>}
        </div>

        <div className="music-wall__meta">
          <span>{String(wallTracks.length).padStart(2, "0")} TRACKS</span>
          <span>{formatDuration(totalDurationMs)}</span>
          {isExternalPlayback && wallTracks.length >= 20 && (
            <span className="music-wall__spotify-limit">
              {t("spotify.displayLimit", { count: 20 })}
            </span>
          )}
          {isExternalPlayback && wallTracks[0] && (
            <SpotifyAttribution
              actionLabel={t("spotify.open") as "OPEN SPOTIFY"}
              compact
              onOpen={() => {
                onPlay(wallTracks[0], "music-wall");
              }}
            />
          )}
        </div>
        </header>

        <div
          className="music-wall__viewport"
          ref={viewportRef}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <WallSurface
          layoutMode={layoutMode}
          wallRows={wallRows}
          wallTracks={wallTracks}
          currentPlaybackOccurrence={currentPlaybackOccurrence}
          queueContext={queueContext}
          preparedInitialOffset={preparedInitialOffset}
          formationOrigin={initialPresentation.formationOrigin}
          portalParticipantSlots={portalParticipantSlots}
          presentationForTrack={presentationForTrack}
          prefersReducedMotion={
            prefersReducedMotion || isExternalPlayback
          }
          setWallElement={setWallElement}
          setCardRef={setCardRef}
          onHover={handleTrackHover}
          onSelect={handleCardSelection}
          />
        </div>

      </section>
      {overlayRoot ? createPortal(overlayPanels, overlayRoot) : overlayPanels}
    </>
  );
});
