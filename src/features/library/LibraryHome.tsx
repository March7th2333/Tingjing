import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { motionController } from "../../config/MotionController";
import { transitionManager } from "../../config/TransitionManager";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useLanguage } from "../../i18n/LanguageContext";
import type { MessageKey } from "../../i18n/messages";
import type {
  MusicProvider,
  MusicProviderId,
} from "../../providers/MusicProvider";
import {
  immersivePlaybackClosedEvent,
  immersivePlaybackCurrentTrackEvent,
  immersivePlaybackReturnEvent,
  prewarmImmersivePlayback,
  requestImmersivePlaybackImmediately,
  waitForImmersivePlaybackPhase,
} from "../player/playbackEvents";
import type {
  ImmersivePlaybackCurrentTrack,
  ImmersivePlaybackReturnTransition,
  PlaybackOrigin,
  PlaybackSource,
} from "../player/playbackEvents";
import type {
  PlaybackCollectionContext,
  PlaybackQueueSeed,
} from "../player/PlaybackQueueController";
import type { PlaybackPrefetchService } from "../player/PlaybackPrefetchService";
import type {
  MusicLibrary,
  Track,
  TrackPalette,
} from "../../types/music";
import {
  collectionsForSection,
  searchCurrentSection,
} from "./libraryCollections";
import type {
  LibraryCollectionKind,
  LibraryCollectionSummary,
  LibrarySection,
} from "./libraryCollections";
import { createLibraryContentStore } from "./libraryContentStore";
import {
  MusicWall,
  prepareMusicWall,
} from "./MusicWall";
import type {
  MusicWallPreparation,
  MusicWallReturnPreparation,
  MusicWallTrack,
} from "./MusicWall";
import { CoverAtmosphereRenderer } from "./CoverAtmosphereRenderer";
import { SpotifyAttribution } from "./SpotifyAttribution";
import {
  beginHomeWallTransitionTrace,
  captureHomeWallGeometrySample,
  captureHomeWallVisualSample,
  finishHomeWallTransitionTrace,
  homeWallDiagnosticsEnabled,
  incrementHomeWallTransitionCounter,
  markHomeWallTransitionPhase,
  noteHomeWallAnimationStart,
  noteHomeWallLayoutRead,
  noteHomeWallReactCommit,
  noteHomeWallTransitionMetric,
} from "./HomeWallTransitionDiagnostics";
import {
  beginCategoryTransitionTrace,
  finishCategoryTransitionTrace,
  markCategoryTransitionPhase,
  noteCategoryTransitionDomScan,
  noteCategoryTransitionEvidence,
  noteCategoryTransitionReactCommit,
} from "./CategoryTransitionDiagnostics";
import {
  advanceCarouselLogicalIndex,
  carouselLogicalItemKey,
  createCarouselSlotOffsets,
  normalizeCarouselTravel,
  positiveModulo,
} from "./HomeCarouselController";
import {
  homeCarouselMotionTokens as carouselMotion,
  homeCategoryMotionTokens as categoryMotion,
  homeWallTransitionMotionTokens as homeWallMotion,
} from "./motionTokens";
import "./library.css";
import "./music-wall.css";

export type JourneyPhase = "welcome" | "transitioning" | "library";

// Category state is a stable product identifier. Display labels belong to the
// language layer and must never participate in navigation, cache or snapshot
// identity.
type LibraryCategory = LibrarySection;
type CoverPosition =
  | "far-left"
  | "left"
  | "center"
  | "right"
  | "far-right";

function playbackCollectionContext(
  providerId: MusicProviderId,
  collection: LibraryCollectionSummary,
): PlaybackCollectionContext {
  return {
    providerId,
    collectionId: collection.id,
    collectionKind: collection.kind,
    collectionTitle: collection.title,
  };
}
type DetailView =
  | "browsing"
  | "prepared"
  | "opening"
  | "detail"
  | "closing";
type CarouselDirection = "previous" | "next";
type CategoryTransition = "idle" | "prepare" | "out" | "commit";
type ShelfPlaneId = "a" | "b";
type ShelfDirection = "forward" | "backward";
type CarouselMotionState = "idle" | "input" | "inertia" | "snapping";

interface CategoryNavIndicatorGeometry {
  x: number;
  width: number;
}

interface SharedCoverGeometry {
  translateX: number;
  translateY: number;
  scale: number;
}

interface CoverPortalGeometry {
  coverLeft: number;
  coverTop: number;
  coverWidth: number;
  coverHeight: number;
  centerX: number;
  centerY: number;
}

interface CarouselCard {
  instanceKey: string;
  logicalPosition: number;
  artIndex: number;
  track: Track;
  collection: LibraryCollectionSummary;
  issue: string;
  offset: number;
  position: CoverPosition;
}

interface PendingShelfPlane {
  requestId: number;
  planeId: ShelfPlaneId;
  category: LibraryCategory;
  section: LibrarySection;
  logicalDirection: ShelfDirection;
  motionVariant: ShelfDirection;
  cards: CarouselCard[];
  catalogLength: number;
  carouselIndex: number;
  collection: LibraryCollectionSummary | null;
  durationMs: number;
}

interface PreparedShelfTrackPose {
  planeId: ShelfPlaneId;
  contextKey: string;
  slots: HTMLElement[];
  covers: WeakMap<HTMLElement, HTMLElement>;
  visuals: WeakMap<HTMLElement, CarouselSlotVisual>;
}

interface PreparedCarouselCards {
  generation: number;
  contextKey: string;
  carouselIndex: number;
  cards: CarouselCard[];
}

interface CarouselSlotVisual {
  transform: string;
  opacity: string;
  dim: string;
  brightness: string;
  blur: string;
  focused: string;
  focusScore: string;
  focusLayer: string;
  position: CoverPosition;
  zone: "near" | "far-left" | "far-right";
}

interface HomeCardSnapshot {
  offset: string;
  transform: string;
  opacity: string;
  dim: string;
  brightness: string;
  blur: string;
  focused: string;
  focusScore: string;
  focusLayer: string;
}

interface HomeSnapshot {
  section: LibrarySection;
  collectionId: string;
  activeIndex: number;
  searchActive: boolean;
  trackOffset: number;
  targetIndex: number;
  snapTarget: number;
  gestureOrigin: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  cards: HomeCardSnapshot[];
}

interface PreparedWallState {
  collectionKey: string;
  collection: LibraryCollectionSummary;
  coverTrack: Track;
  coverArtIndex: number;
  tracks: MusicWallTrack[];
  preparation: MusicWallPreparation;
}

interface PendingWallOpenIntent {
  id: number;
  collectionKey: string;
  generation: number;
  collection: LibraryCollectionSummary;
  coverTrack: Track;
  coverBounds: DOMRect;
  portalGeometry: CoverPortalGeometry;
  cancelled: boolean;
  preparationPromise: Promise<PreparedWallState | null>;
  shellReadyPromise: Promise<PreparedWallState | null>;
}

function createPreparedWallTracks(
  collection: LibraryCollectionSummary,
  tracks: readonly Track[],
  coverTrack: Track,
): MusicWallTrack[] {
  if (collection.kind !== "album") {
    return [...tracks];
  }

  return tracks.map((track) => ({
    ...track,
    album: coverTrack.album,
    coverLabel: coverTrack.coverLabel,
    coverImage: coverTrack.coverImage,
    palette: { ...coverTrack.palette },
  }));
}

function collectionTrackCacheKey(collection: LibraryCollectionSummary) {
  return `${collection.kind}:${collection.id}`;
}

function wallPreparationKey(collection: LibraryCollectionSummary) {
  const viewport = typeof window === "undefined"
    ? "server"
    : `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}`;
  return `${collectionTrackCacheKey(collection)}:${viewport}`;
}

function withTimeout<Result>(
  promise: Promise<Result>,
  durationMs: number,
  message: string,
) {
  return new Promise<Result>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(message));
    }, durationMs);

    promise.then(
      (result) => {
        window.clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForPaint(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    });
    const handleAbort = () => {
      window.cancelAnimationFrame(frame);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function waitForDuration(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitForNamedAnimation(
  element: HTMLElement | null,
  animationName: string,
  fallbackDurationMs: number,
  signal: AbortSignal,
) {
  if (!element) {
    return waitForDuration(fallbackDurationMs, signal);
  }

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    let settled = false;
    const timer = window.setTimeout(
      () => settle(true),
      Math.max(1, fallbackDurationMs + 120),
    );
    const cleanup = () => {
      window.clearTimeout(timer);
      element.removeEventListener("animationend", handleAnimationEnd);
      signal.removeEventListener("abort", handleAbort);
    };
    const settle = (complete: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (complete) {
        resolve();
      } else {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }
    };
    const handleAnimationEnd = (event: AnimationEvent) => {
      if (event.target === element && event.animationName === animationName) {
        settle(true);
      }
    };
    const handleAbort = () => settle(false);

    element.addEventListener("animationend", handleAnimationEnd);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function waitForNamedAnimationStart(
  element: HTMLElement | null,
  animationName: string,
  signal: AbortSignal,
) {
  if (!element) {
    return waitForPaint(signal).then(() => 0);
  }

  return new Promise<number>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const runningAnimation = element.getAnimations().find((animation) =>
      "animationName" in animation
      && (animation as CSSAnimation).animationName === animationName
    );
    if (runningAnimation) {
      resolve(Number(runningAnimation.currentTime ?? 0));
      return;
    }

    let settled = false;
    const timer = window.setTimeout(() => settle(true, currentElapsed()), 80);
    const currentElapsed = () => {
      const animation = element.getAnimations().find((candidate) =>
        "animationName" in candidate
        && (candidate as CSSAnimation).animationName === animationName
      );
      return Number(animation?.currentTime ?? 0);
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      element.removeEventListener("animationstart", handleStart);
      signal.removeEventListener("abort", handleAbort);
    };
    const settle = (complete: boolean, elapsed = 0) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (complete) {
        resolve(elapsed);
      } else {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }
    };
    const handleStart = (event: AnimationEvent) => {
      if (event.target === element && event.animationName === animationName) {
        settle(true, currentElapsed());
      }
    };
    const handleAbort = () => settle(false);

    element.addEventListener("animationstart", handleStart);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

async function waitForShelfImagesReady(
  root: HTMLElement,
  signal: AbortSignal,
  timeoutMs = 180,
) {
  const images = Array.from(
    root.querySelectorAll<HTMLElement>(
      ".library-home__cover-slot[data-track-offset]",
    ),
  )
    .filter((slot) =>
      Math.abs(Number(slot.dataset.trackOffset ?? Number.POSITIVE_INFINITY))
        <= 1
    )
    .map((slot) =>
      slot.querySelector<HTMLImageElement>(".magazine-cover__image")
    )
    .filter((image): image is HTMLImageElement => image !== null);
  noteCategoryTransitionDomScan("ready-images", images.length);

  await Promise.all(images.map(async (image) => {
    const loaded = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const cleanup = () => {
        image.removeEventListener("load", handleLoad);
        image.removeEventListener("error", handleError);
        signal.removeEventListener("abort", handleAbort);
        if (timer !== 0) {
          window.clearTimeout(timer);
          timer = 0;
        }
      };
      const settle = (ready: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(ready);
      };
      const handleLoad = () => settle(image.naturalWidth > 0);
      const handleError = () => settle(false);
      const handleAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };

      if (signal.aborted) {
        handleAbort();
        return;
      }
      if (image.complete) {
        settle(image.naturalWidth > 0);
        return;
      }

      image.addEventListener("load", handleLoad, { once: true });
      image.addEventListener("error", handleError, { once: true });
      signal.addEventListener("abort", handleAbort, { once: true });
      timer = window.setTimeout(() => settle(false), timeoutMs);
    });

    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    if (loaded && image.naturalWidth > 0) {
      try {
        await Promise.race([
          image.decode(),
          new Promise<void>((resolve) =>
            window.setTimeout(resolve, Math.min(timeoutMs, 120))
          ),
        ]);
      } catch {
        // A decoded bitmap may already be available even when decode() rejects.
      }
      image.dataset.shelfImage = "ready";
      return;
    }

    image.dataset.shelfImage = "fallback";
  }));

  // One compositor frame is enough to establish the pending plane. Slow or
  // failed covers continue inside their own card without owning navigation.
  await waitForPaint(signal);
}

const categories: LibraryCategory[] = [
  "playlists",
  "radio",
  "albums",
  "artists",
];
const collectionFallbackPalette: TrackPalette = {
  background: "#1a1a1a",
  ambient: "#4c4c4c",
  accent: "#d8d8d8",
  text: "#f5f5f5",
};

type CoverStyle = CSSProperties &
  Record<
    | "--cover-background"
    | "--cover-ambient"
    | "--cover-accent"
    | "--cover-text"
    | "--detail-cover-x"
    | "--detail-cover-y"
    | "--detail-cover-scale",
    string
  >;

type CoverPortalStyle = CSSProperties &
  Record<
    | "--portal-cover-left"
    | "--portal-cover-top"
    | "--portal-cover-width"
    | "--portal-cover-height"
    | "--portal-center-x"
    | "--portal-center-y",
    string
  >;

const categoryKind: Record<LibraryCategory, LibraryCollectionKind> = {
  playlists: "playlist",
  radio: "radio",
  albums: "album",
  artists: "artist",
};
const categorySection: Record<LibraryCategory, LibrarySection> = {
  playlists: "playlists",
  radio: "radio",
  albums: "albums",
  artists: "artists",
};
const categoryLabelKey: Record<LibraryCategory, MessageKey> = {
  playlists: "home.category.playlists",
  radio: "home.category.radio",
  albums: "home.category.albums",
  artists: "home.category.artists",
};
const categoryEmptyKey: Record<LibraryCategory, MessageKey> = {
  playlists: "home.empty.playlists",
  radio: "home.empty.radio",
  albums: "home.empty.albums",
  artists: "home.empty.artists",
};
const collectionKindLabelKey: Record<LibraryCollectionKind, MessageKey> = {
  playlist: "home.kind.playlist",
  radio: "home.kind.radio",
  album: "home.kind.album",
  artist: "home.kind.artist",
};

function positionForOffset(offset: number): CoverPosition {
  if (offset <= -2) return "far-left";
  if (offset === -1) return "left";
  if (offset === 0) return "center";
  if (offset === 1) return "right";
  return "far-right";
}

function formatCarouselStatus(catalogLength: number, index: number) {
  if (catalogLength <= 0) {
    return "00 / 00";
  }
  return `${String(positiveModulo(index, catalogLength) + 1).padStart(
    2,
    "0",
  )} / ${String(catalogLength).padStart(2, "0")}`;
}

function createCarouselCards(
  catalog: readonly LibraryCollectionSummary[],
  logicalIndex: number,
  trackById: ReadonlyMap<string, Track>,
  identityScope = "catalog",
): CarouselCard[] {
  if (catalog.length === 0) {
    return [];
  }

  const maximumTravelSteps = Math.max(
    carouselMotion.mouseMaximumSteps,
    carouselMotion.trackpadMaximumSteps,
    carouselMotion.dragMaximumSteps,
  );

  return createCarouselSlotOffsets(
    catalog.length,
    maximumTravelSteps,
    carouselMotion.visibleBufferSteps,
  ).map((offset) => {
    const logicalPosition = logicalIndex + offset;
    const index = positiveModulo(logicalPosition, catalog.length);
    const collection = catalog[index];
    const firstTrackId = collection.trackIds.find((trackId) =>
      trackById.has(trackId)
    );
    const firstTrack = firstTrackId
      ? trackById.get(firstTrackId)
      : undefined;
    const track: Track = {
      id: firstTrack?.id ?? `collection-${collection.id}`,
      title: collection.title,
      translatedTitle: collection.subtitle,
      artist: collection.creator,
      album:
        collection.kind === "album"
          ? collection.title
          : collection.kind === "artist"
            ? "ARTIST COLLECTION"
            : collection.kind === "radio"
              ? "RADIO COLLECTION"
              : "PLAYLIST COLLECTION",
      albumId:
        collection.kind === "album"
          ? collection.id
          : firstTrack?.albumId,
      durationMs: firstTrack?.durationMs ?? 180_000,
      coverImage: collection.coverImage ?? firstTrack?.coverImage,
      coverLabel: "Original cover artwork",
      palette: firstTrack?.palette ?? collectionFallbackPalette,
      lyrics: firstTrack?.lyrics ?? [],
    };

    return {
      // The key belongs to the travelling collection instance, not to a
      // reusable viewport slot. During a rebase React therefore preserves the
      // exact cover that reached the centre and only recycles off-screen
      // instances at the ends of the bounded window.
      instanceKey: carouselLogicalItemKey(
        identityScope,
        logicalPosition,
        collection.id,
      ),
      logicalPosition,
      artIndex: index,
      track,
      collection,
      issue: collection.number,
      offset,
      position: positionForOffset(offset),
    };
  });
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function calculateCoverPortalGeometry({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): CoverPortalGeometry {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const coverLeft = Math.max(0, Math.min(viewportWidth, left));
  const coverTop = Math.max(0, Math.min(viewportHeight, top));
  const coverRight = Math.max(
    coverLeft + 1,
    Math.min(viewportWidth, left + Math.max(1, width)),
  );
  const coverBottom = Math.max(
    coverTop + 1,
    Math.min(viewportHeight, top + Math.max(1, height)),
  );

  return {
    coverLeft,
    coverTop,
    coverWidth: coverRight - coverLeft,
    coverHeight: coverBottom - coverTop,
    centerX: coverLeft + (coverRight - coverLeft) / 2,
    centerY: coverTop + (coverBottom - coverTop) / 2,
  };
}

function coverPortalGeometryMatches(
  current: CoverPortalGeometry | null,
  next: CoverPortalGeometry,
) {
  if (!current) {
    return false;
  }

  return Math.abs(current.coverLeft - next.coverLeft) < 0.5
    && Math.abs(current.coverTop - next.coverTop) < 0.5
    && Math.abs(current.coverWidth - next.coverWidth) < 0.5
    && Math.abs(current.coverHeight - next.coverHeight) < 0.5
    && Math.abs(current.centerX - next.centerX) < 0.5
    && Math.abs(current.centerY - next.centerY) < 0.5;
}

function applyHomeCardSnapshots(
  slots: readonly HTMLElement[],
  cards: readonly HomeCardSnapshot[],
) {
  let writeCount = 0;
  const cardSnapshots = new Map(
    cards.map((card) => [card.offset, card]),
  );
  const writeStyle = (
    slot: HTMLElement,
    property: string,
    value: string,
  ) => {
    if (slot.style.getPropertyValue(property) === value) {
      return;
    }
    slot.style.setProperty(property, value);
    writeCount += 1;
  };
  const writeDataset = (
    slot: HTMLElement,
    property: "focused" | "focusScore" | "focusLayer",
    value: string,
  ) => {
    if (slot.dataset[property] === value) {
      return;
    }
    slot.dataset[property] = value;
    writeCount += 1;
  };
  for (const slot of slots) {
    const card = cardSnapshots.get(slot.dataset.trackOffset ?? "");
    if (!card) {
      continue;
    }
    writeStyle(slot, "transform", card.transform);
    writeStyle(slot, "opacity", card.opacity);
    writeStyle(slot, "--track-dim", card.dim);
    writeStyle(slot, "--track-brightness", card.brightness);
    writeStyle(slot, "--track-blur", card.blur);
    writeDataset(slot, "focused", card.focused);
    writeDataset(slot, "focusScore", card.focusScore);
    writeDataset(slot, "focusLayer", card.focusLayer);
  }
  return writeCount;
}

const PlaylistCover = memo(function PlaylistCover({
  track,
  collectionKind,
  position,
  issue,
  index,
  geometry,
  coverRef,
  interactive,
  ariaLabel,
  onClick,
  onDoubleClick,
  onKeyDown,
  onPointerDown,
}: {
  track: Track;
  collectionKind: LibraryCollectionKind;
  position: CoverPosition;
  issue: string;
  index: number;
  geometry?: SharedCoverGeometry | null;
  coverRef?: RefObject<HTMLButtonElement | null>;
  interactive?: boolean;
  ariaLabel?: string;
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
  onDoubleClick?: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const style: CoverStyle = {
    "--cover-background": track.palette.background,
    "--cover-ambient": track.palette.ambient,
    "--cover-accent": track.palette.accent,
    "--cover-text": track.palette.text,
    "--detail-cover-x": `${geometry?.translateX ?? 0}px`,
    "--detail-cover-y": `${geometry?.translateY ?? 0}px`,
    "--detail-cover-scale": `${geometry?.scale ?? 1}`,
  };

  return (
    <button
      type="button"
      className="magazine-cover"
      data-position={position}
      data-art={index}
      data-interactive={interactive}
      style={style}
      ref={coverRef}
      tabIndex={interactive ? 0 : -1}
      disabled={!interactive}
      aria-label={
        interactive
          ? ariaLabel
          : `${track.title}，${track.artist}`
      }
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <div className="magazine-cover__handoff-surface">
        <div className="magazine-cover__art" aria-hidden="true">
          {track.coverImage && (
            <img
              className="magazine-cover__image"
              src={track.coverImage}
              alt=""
              decoding="async"
              loading={
                position === "center" || position === "left"
                  || position === "right"
                  ? "eager"
                  : "lazy"
              }
              fetchPriority={position === "center" ? "high" : "auto"}
              draggable="false"
              onLoad={(event) => {
                event.currentTarget.dataset.shelfImage = "ready";
              }}
              onError={(event) => {
                event.currentTarget.dataset.shelfImage = "fallback";
              }}
            />
          )}
          <span className="magazine-cover__shape magazine-cover__shape--one" />
          <span className="magazine-cover__shape magazine-cover__shape--two" />
          <span className="magazine-cover__line" />
        </div>
        <div className="magazine-cover__topline">
          <span>{collectionKind.toUpperCase()}</span>
          <span>{issue}</span>
        </div>
        <div className="magazine-cover__copy">
          <span className="magazine-cover__album">{track.album}</span>
          <h2>{track.title}</h2>
          {track.translatedTitle && (
            <span className="magazine-cover__translation">
              {track.translatedTitle}
            </span>
          )}
          <p className="magazine-cover__artist">{track.artist}</p>
        </div>
      </div>
      <span className="magazine-cover__handoff-veil" aria-hidden="true" />
    </button>
  );
});

interface AlbumMiniInfoModel {
  key: string;
  number: string;
  label: string;
}

function createAlbumMiniInfoModel(
  collection: LibraryCollectionSummary | null,
  durationMs: number,
): AlbumMiniInfoModel {
  if (!collection) {
    return {
      key: "empty",
      number: "COLLECTION",
      label: "",
    };
  }

  const durationLabel =
    durationMs > 0 ? ` / ${formatDuration(durationMs)}` : "";
  return {
    key: [
      collection.kind,
      collection.id,
      collection.number,
      collection.trackCount,
      durationMs,
    ].join(":"),
    number: collection.number,
    label:
      `${collection.title} / ${collection.trackCount} TRACKS${durationLabel}`,
  };
}

const AlbumMiniInfo = memo(function AlbumMiniInfo({
  collection,
  durationMs,
  incomingCollection = null,
  incomingDurationMs = 0,
  hasCategoryIncoming = false,
  categoryTransition = "idle",
  categoryMotionVariant = "backward",
  crossfadeEnabled = true,
  crossfadeDurationMs = 340,
}: {
  collection: LibraryCollectionSummary | null;
  durationMs: number;
  incomingCollection?: LibraryCollectionSummary | null;
  incomingDurationMs?: number;
  hasCategoryIncoming?: boolean;
  categoryTransition?: CategoryTransition;
  categoryMotionVariant?: ShelfDirection;
  crossfadeEnabled?: boolean;
  crossfadeDurationMs?: number;
}) {
  const nextModel = useMemo<AlbumMiniInfoModel>(
    () => createAlbumMiniInfoModel(collection, durationMs),
    [collection, durationMs],
  );
  const incomingModel = useMemo<AlbumMiniInfoModel | null>(
    () => hasCategoryIncoming
      ? createAlbumMiniInfoModel(incomingCollection, incomingDurationMs)
      : null,
    [hasCategoryIncoming, incomingCollection, incomingDurationMs],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const currentModelRef = useRef(nextModel);
  const afterPaintCleanupRef = useRef<(() => void) | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);
  const [layers, setLayers] = useState<{
    current: AlbumMiniInfoModel;
    previous: AlbumMiniInfoModel | null;
  }>(() => ({
    current: nextModel,
    previous: null,
  }));
  // Category changes and carousel changes share this mounted caption shell,
  // but they must never share an in-flight visual transaction.  A carousel
  // crossfade can still have `previous` in React state for one paint after a
  // category request.  Rendering the committed model directly while the
  // category master timeline owns the shell prevents that stale layer from
  // briefly hiding the caption during Prepare.
  const visibleLayers = crossfadeEnabled
    ? layers
    : { current: nextModel, previous: null };

  useEffect(() => {
    if (!crossfadeEnabled) {
      currentModelRef.current = nextModel;
      rootRef.current?.setAttribute("data-crossfading", "false");
      afterPaintCleanupRef.current?.();
      afterPaintCleanupRef.current = null;
      if (cleanupTimerRef.current !== null) {
        window.clearTimeout(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
      }
      setLayers((current) =>
        current.current.key === nextModel.key && current.previous === null
          ? current
          : { current: nextModel, previous: null }
      );
      return;
    }

    if (currentModelRef.current.key === nextModel.key) {
      return;
    }

    const previous = currentModelRef.current;
    const root = rootRef.current;
    currentModelRef.current = nextModel;
    setLayers({
      current: nextModel,
      previous,
    });

    afterPaintCleanupRef.current = motionController.afterPaint(() => {
      root?.setAttribute("data-crossfading", "true");
      afterPaintCleanupRef.current = null;
    }, 2);
    cleanupTimerRef.current = window.setTimeout(() => {
      root?.setAttribute("data-crossfading", "false");
      setLayers((current) => ({
        current: current.current,
        previous: null,
      }));
      cleanupTimerRef.current = null;
    }, crossfadeDurationMs + 40);

    return () => {
      root?.setAttribute("data-crossfading", "false");
      afterPaintCleanupRef.current?.();
      afterPaintCleanupRef.current = null;
      if (cleanupTimerRef.current !== null) {
        window.clearTimeout(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
      }
    };
  }, [crossfadeDurationMs, crossfadeEnabled, nextModel]);

  return (
    <div
      className="library-home__caption"
      ref={rootRef}
      data-crossfading="false"
      data-has-previous={Boolean(visibleLayers.previous)}
      data-category-transition={categoryTransition}
      data-category-direction={categoryMotionVariant}
      data-has-category-incoming={Boolean(incomingModel)}
      style={
        {
          "--caption-crossfade-duration": `${crossfadeDurationMs}ms`,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span className="library-home__caption-stack" data-field="number">
        {visibleLayers.previous && (
          <span data-layer="previous">{visibleLayers.previous.number}</span>
        )}
        <span data-layer="current">{visibleLayers.current.number}</span>
        {incomingModel && (
          <span data-layer="category-incoming">
            {incomingModel.number}
          </span>
        )}
      </span>
      <div className="library-home__caption-line" />
      <span className="library-home__caption-stack" data-field="copy">
        {visibleLayers.previous && (
          <span data-layer="previous">{visibleLayers.previous.label}</span>
        )}
        <span data-layer="current">{visibleLayers.current.label}</span>
        {incomingModel && (
          <span data-layer="category-incoming">
            {incomingModel.label}
          </span>
        )}
      </span>
    </div>
  );
});

interface LibraryHomeProps {
  phase: JourneyPhase;
  library: MusicLibrary | null;
  musicProvider: MusicProvider;
  providerId: MusicProviderId;
  playbackPrefetchService: PlaybackPrefetchService;
}

export function LibraryHome({
  phase,
  library,
  musicProvider,
  providerId,
  playbackPrefetchService,
}: LibraryHomeProps) {
  const { t } = useLanguage();
  const [activeCategory, setActiveCategory] =
    useState<LibraryCategory>("playlists");
  const [activeShelfPlaneId, setActiveShelfPlaneId] =
    useState<ShelfPlaneId>("a");
  const [detailView, setDetailView] = useState<DetailView>("browsing");
  const [overlayLayerElement, setOverlayLayerElement] =
    useState<HTMLDivElement | null>(null);
  const [carouselIndexes, setCarouselIndexes] = useState<
    Record<LibrarySection, number>
  >({
    playlists: 0,
    radio: 0,
    albums: 0,
    artists: 0,
  });
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchCarouselIndex, setSearchCarouselIndex] = useState(0);
  const [categoryTransition, setCategoryTransition] =
    useState<CategoryTransition>("idle");
  const [pendingShelfPlane, setPendingShelfPlane] =
    useState<PendingShelfPlane | null>(null);
  const [portalGeometry, setPortalGeometry] =
    useState<CoverPortalGeometry | null>(null);
  const [currentPlaybackOccurrence, setCurrentPlaybackOccurrence] = useState<
    ImmersivePlaybackCurrentTrack | null
  >(null);
  const [playbackReturnTransition, setPlaybackReturnTransition] = useState<
    ImmersivePlaybackReturnTransition | null
  >(null);
  const playbackReturnTransitionRef = useRef<
    ImmersivePlaybackReturnTransition | null
  >(null);
  const [isPlayerTransitioning, setIsPlayerTransitioning] =
    useState(false);
  const isCollectionLoadingRef = useRef(false);
  const [isWallLocking, setIsWallLocking] = useState(false);
  // Provider track payloads are preparation data, not visible UI state.
  // Keeping this cache in React state used to re-render the entire home as a
  // background request completed, often in the middle of the Home -> Wall
  // hand-off. The prepared wall and its metadata remain the only committed
  // React state for that transition.
  const collectionTrackCacheRef = useRef(new Map<string, Track[]>());
  const [preparedWall, setPreparedWall] =
    useState<PreparedWallState | null>(null);
  const [playbackNotice, setPlaybackNotice] = useState("");
  const libraryRootRef = useRef<HTMLElement>(null);
  const centralCoverRef = useRef<HTMLButtonElement>(null);
  const coversRef = useRef<HTMLDivElement>(null);
  const portalLayerRef = useRef<HTMLDivElement>(null);
  const portalGeometryRef = useRef<CoverPortalGeometry | null>(null);
  const preparedWallRef = useRef<PreparedWallState | null>(null);
  const detailViewRef = useRef<DetailView>(detailView);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const categoryNavRef = useRef<HTMLElement>(null);
  const categoryNavItemRefs = useRef(
    new Map<LibraryCategory, HTMLButtonElement>(),
  );
  const categoryNavGeometryRef = useRef(
    new Map<LibraryCategory, CategoryNavIndicatorGeometry>(),
  );
  const activeCategoryRef = useRef<LibraryCategory>(activeCategory);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const clickTimerRef = useRef<number | null>(null);
  const pendingPortalBoundsRef = useRef<DOMRect | null>(null);
  const categoryTransitionPhaseRef = useRef<CategoryTransition>("idle");
  const categoryTransitionAbortRef = useRef<AbortController | null>(null);
  const requestedCategoryRef = useRef<LibraryCategory>("playlists");
  const activeShelfPlaneIdRef = useRef<ShelfPlaneId>("a");
  const shelfPlaneRefs = useRef<Record<ShelfPlaneId, HTMLDivElement | null>>({
    a: null,
    b: null,
  });
  const shelfTrackRefs = useRef<Record<ShelfPlaneId, HTMLDivElement | null>>({
    a: null,
    b: null,
  });
  const preparedShelfPoseRef = useRef<PreparedShelfTrackPose | null>(null);
  const categoryCommitPoseRef = useRef<PreparedShelfTrackPose | null>(null);
  const preparedCarouselCardsRef = useRef<PreparedCarouselCards | null>(
    null,
  );
  const preparedCategorySectionsRef = useRef(new Set<LibrarySection>());
  const carouselFrameUnsubscribeRef = useRef<(() => void) | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const activeCollectionKeyRef = useRef<string | null>(null);
  const homeSnapshotRef = useRef<HomeSnapshot | null>(null);
  const restoreHomeSnapshotRef = useRef<() => boolean>(() => false);
  const returnSnapshotRestoredRef = useRef(false);
  const wallPreparationRequestRef = useRef(0);
  const libraryGenerationRef = useRef(0);
  const spaceTransitionAbortRef = useRef<AbortController | null>(null);
  const playerTransitionAbortRef = useRef<AbortController | null>(null);
  const isWallPanelOpenRef = useRef(false);
  const wallPreparationCacheRef = useRef(
    new Map<string, PreparedWallState>(),
  );
  const wallPreparationPromisesRef = useRef(
    new Map<string, Promise<PreparedWallState | null>>(),
  );
  const wallOpenIntentSequenceRef = useRef(0);
  const pendingWallOpenIntentRef = useRef<PendingWallOpenIntent | null>(
    null,
  );
  const playerTransitionPendingRef = useRef(false);
  const spaceTransitionPendingRef = useRef(false);
  const pendingCategoryRef = useRef<LibraryCategory | null>(null);
  const queuedCategoryRef = useRef<LibraryCategory | null>(null);
  const selectCategoryRef = useRef<(category: LibraryCategory) => void>(
    () => undefined,
  );
  const categoryRequestRef = useRef(0);
  const shiftCarouselRef = useRef<
    (direction: CarouselDirection) => boolean
  >(() => false);
  const closeDetailRef = useRef<(
    preparation: MusicWallReturnPreparation,
    restoreKeyboardFocus?: boolean,
  ) => boolean>(() => false);
  const wallExitControllerRef = useRef<
    ((restoreKeyboardFocus?: boolean) => boolean) | null
  >(null);
  const wallReturnCountRef = useRef(0);
  const lastWallPreparationWasCachedRef = useRef(false);
  const carouselMotionStateRef = useRef<CarouselMotionState>("idle");
  const trackOffsetRef = useRef(0);
  const carouselVelocityRef = useRef(0);
  const targetIndexRef = useRef(0);
  const isCarouselDraggingRef = useRef(false);
  const snapTargetRef = useRef(0);
  const pendingCarouselRebaseRef = useRef(false);
  const previousDetailViewRef = useRef<DetailView>("browsing");
  const gestureOriginRef = useRef(0);
  const gestureMaximumStepsRef = useRef<number>(
    carouselMotion.mouseMaximumSteps,
  );
  const lastWheelInputAtRef = useRef(0);
  const lastPrefetchedCarouselWindowRef = useRef<string | null>(null);
  const carouselMetricsRef = useRef({
    step: 460,
    // The collection shelf is deliberately level. Depth and focus carry the
    // spatial hierarchy without making neighbouring covers climb or drop.
    islandLift: 0,
    trackCenterX: 0,
    viewportCenterX: 0,
  });
  const carouselSlotsRef = useRef<HTMLElement[]>([]);
  const carouselCoverElementsRef = useRef(
    new WeakMap<HTMLElement, HTMLElement>(),
  );
  const renderedCarouselContextRef = useRef<string | null>(null);
  const carouselDragRef = useRef({
    pointerId: -1,
    startX: 0,
    currentX: 0,
    lastX: 0,
    lastTime: 0,
    velocity: 0,
    moved: false,
  });
  const renderCarouselRef = useRef<(offset: number) => void>(
    () => undefined,
  );
  const preloadCarouselDeltaRef = useRef<(
    delta: number,
    radius?: number,
  ) => void>(() => undefined);
  const startCarouselMotionRef = useRef<() => void>(() => undefined);
  const carouselSlotVisualsRef = useRef(
    new WeakMap<HTMLElement, CarouselSlotVisual>(),
  );
  const prefersReducedMotion = useReducedMotion();
  const activeSection = categorySection[activeCategory];
  detailViewRef.current = detailView;
  preparedWallRef.current = preparedWall;
  useLayoutEffect(() => {
    noteHomeWallReactCommit();
    noteCategoryTransitionReactCommit();
  });
  activeShelfPlaneIdRef.current = activeShelfPlaneId;
  activeCategoryRef.current = activeCategory;

  const assignShelfPlaneRef = useCallback((
    planeId: ShelfPlaneId,
    node: HTMLDivElement | null,
  ) => {
    shelfPlaneRefs.current[planeId] = node;
  }, []);

  const assignShelfTrackRef = useCallback((
    planeId: ShelfPlaneId,
    node: HTMLDivElement | null,
  ) => {
    shelfTrackRefs.current[planeId] = node;
    if (activeShelfPlaneIdRef.current === planeId) {
      coversRef.current = node;
    }
  }, []);

  const cacheCategoryNavGeometry = useCallback(() => {
    const nav = categoryNavRef.current;
    if (!nav) {
      return;
    }

    const navBounds = nav.getBoundingClientRect();
    const nextGeometry = new Map<
      LibraryCategory,
      CategoryNavIndicatorGeometry
    >();
    for (const category of categories) {
      const button = categoryNavItemRefs.current.get(category);
      if (!button) {
        continue;
      }
      const bounds = button.getBoundingClientRect();
      nextGeometry.set(category, {
        x: bounds.left - navBounds.left + bounds.width * 0.2,
        width: Math.max(1, bounds.width * 0.6),
      });
    }
    categoryNavGeometryRef.current = nextGeometry;
  }, []);

  const writeCategoryNavGeometry = useCallback((
    from: LibraryCategory,
    to: LibraryCategory,
  ) => {
    const nav = categoryNavRef.current;
    if (!nav) {
      return;
    }
    if (
      !categoryNavGeometryRef.current.has(from)
      || !categoryNavGeometryRef.current.has(to)
    ) {
      cacheCategoryNavGeometry();
    }
    const fromGeometry = categoryNavGeometryRef.current.get(from);
    const toGeometry = categoryNavGeometryRef.current.get(to);
    if (!fromGeometry || !toGeometry) {
      return;
    }
    nav.style.setProperty(
      "--category-nav-from-x",
      `${fromGeometry.x}px`,
    );
    nav.style.setProperty(
      "--category-nav-from-scale",
      `${fromGeometry.width}`,
    );
    nav.style.setProperty("--category-nav-to-x", `${toGeometry.x}px`);
    nav.style.setProperty(
      "--category-nav-to-scale",
      `${toGeometry.width}`,
    );
  }, [cacheCategoryNavGeometry]);

  const captureCategoryTransitionEvidence = useCallback((
    name: string,
    extra: Record<string, unknown> = {},
  ) => {
    noteCategoryTransitionEvidence(name, () => {
      const root = categoryNavRef.current?.closest<HTMLElement>(
        ".library-home",
      );
      const planes = (["a", "b"] as const).map((planeId) => {
        const plane = shelfPlaneRefs.current[planeId];
        const style = plane ? window.getComputedStyle(plane) : null;
        const images = plane
          ? Array.from(
              plane.querySelectorAll<HTMLImageElement>(
                ".magazine-cover__image",
              ),
            )
          : [];
        const cards = plane
          ? Array.from(
              plane.querySelectorAll<HTMLElement>(
                '.library-home__cover-slot[data-category-visible="true"]',
              ),
            ).map((slot) => {
              const shell = slot.querySelector<HTMLElement>(
                ".magazine-cover",
              );
              const artwork = slot.querySelector<HTMLElement>(
                ".magazine-cover__handoff-surface",
              );
              const veil = slot.querySelector<HTMLElement>(
                ".magazine-cover__handoff-veil",
              );
              const image = slot.querySelector<HTMLImageElement>(
                ".magazine-cover__image",
              );
              const shellStyle = shell
                ? window.getComputedStyle(shell)
                : null;
              const artworkStyle = artwork
                ? window.getComputedStyle(artwork)
                : null;
              const veilStyle = veil
                ? window.getComputedStyle(veil)
                : null;
              return {
                position: shell?.dataset.position ?? null,
                identity: slot.dataset.carouselIdentity ?? null,
                shellOpacity: shellStyle?.opacity ?? null,
                shellTransform: shellStyle?.transform ?? null,
                artworkTransform: artworkStyle?.transform ?? null,
                veilOpacity: veilStyle?.opacity ?? null,
                imageSource: image?.currentSrc || image?.src || null,
                connected: shell?.isConnected ?? false,
              };
            })
          : [];
        return {
          planeId,
          state: plane?.dataset.state ?? null,
          request: plane?.dataset.request ?? null,
          opacity: style?.opacity ?? null,
          animationName: style?.animationName ?? null,
          readyImages: images.filter(
            (image) => image.dataset.shelfImage === "ready",
          ).length,
          fallbackImages: images.filter(
            (image) => image.dataset.shelfImage === "fallback",
          ).length,
          cards,
        };
      });
      const nav = categoryNavRef.current;
      const indicator = nav?.querySelector<HTMLElement>(
        ".library-home__nav-indicator",
      );
      const status = root?.querySelector<HTMLElement>(
        ".library-home__carousel-status",
      );
      const caption = root?.querySelector<HTMLElement>(
        ".library-home__caption",
      );
      const empty = root?.querySelector<HTMLElement>(
        ".library-home__empty",
      );
      const readLayer = (
        container: HTMLElement | null | undefined,
        selector: string,
      ) => {
        const layer = container?.querySelector<HTMLElement>(selector);
        const style = layer ? window.getComputedStyle(layer) : null;
        return layer
          ? {
              text: layer.textContent?.replace(/\s+/g, " ").trim() ?? "",
              opacity: style?.opacity ?? null,
              clipPath: style?.clipPath ?? null,
            }
          : null;
      };
      return {
        ...extra,
        phase: categoryTransitionPhaseRef.current,
        activeCategory: activeCategoryRef.current,
        pendingCategory: pendingCategoryRef.current,
        queuedCategory: queuedCategoryRef.current,
        activeShelfPlaneId: activeShelfPlaneIdRef.current,
        planes,
        navIndicatorTransform: indicator
          ? window.getComputedStyle(indicator).transform
          : null,
        navActive: nav
          ?.querySelector<HTMLElement>('[data-active="true"]')
          ?.textContent?.trim() ?? null,
        navPending: nav
          ?.querySelector<HTMLElement>('[data-pending="true"]')
          ?.textContent?.trim() ?? null,
        pageCountCurrent: readLayer(
          status,
          '[data-category-layer="current"]',
        ),
        pageCountIncoming: readLayer(
          status,
          '[data-category-layer="incoming"]',
        ),
        captionCurrent: readLayer(caption, '[data-layer="current"]'),
        captionIncoming: readLayer(
          caption,
          '[data-layer="category-incoming"]',
        ),
        emptyCurrent: readLayer(empty, '[data-category-layer="current"]'),
        emptyIncoming: readLayer(empty, '[data-category-layer="incoming"]'),
      };
    });
  }, []);

  useLayoutEffect(() => {
    cacheCategoryNavGeometry();
    writeCategoryNavGeometry(
      activeCategoryRef.current,
      activeCategoryRef.current,
    );
    const nav = categoryNavRef.current;
    if (!nav || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      incrementHomeWallTransitionCounter("resize-observer-callbacks");
      cacheCategoryNavGeometry();
      const visualTarget = pendingCategoryRef.current
        ?? activeCategoryRef.current;
      writeCategoryNavGeometry(
        activeCategoryRef.current,
        visualTarget,
      );
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [cacheCategoryNavGeometry, writeCategoryNavGeometry]);

  const stopCarouselAnimation = useCallback(() => {
    carouselFrameUnsubscribeRef.current?.();
    carouselFrameUnsubscribeRef.current = null;
    carouselMotionStateRef.current = "idle";
    carouselVelocityRef.current = 0;
    isCarouselDraggingRef.current = false;
    carouselDragRef.current.pointerId = -1;
  }, []);

  const resetCarouselTrack = useCallback(() => {
    stopCarouselAnimation();
    trackOffsetRef.current = 0;
    targetIndexRef.current = 0;
    snapTargetRef.current = 0;
    gestureOriginRef.current = 0;
    pendingCarouselRebaseRef.current = false;
    lastWheelInputAtRef.current = 0;
    carouselSlotVisualsRef.current = new WeakMap();
    const covers = coversRef.current;
    if (covers) {
      covers.dataset.dragging = "false";
      covers.dataset.moving = "false";
      covers.style.setProperty("--carousel-drag-x", "0px");
    }
    renderCarouselRef.current(0);
  }, [stopCarouselAnimation]);

  const freezeCarouselTrack = useCallback(() => {
    stopCarouselAnimation();
    targetIndexRef.current = 0;
    snapTargetRef.current = 0;
    gestureOriginRef.current = trackOffsetRef.current;
    pendingCarouselRebaseRef.current = false;
    lastWheelInputAtRef.current = 0;
    const covers = coversRef.current;
    if (covers) {
      covers.dataset.dragging = "false";
      covers.dataset.moving = "false";
      covers.style.setProperty("--carousel-drag-x", "0px");
    }
  }, [stopCarouselAnimation]);

  useEffect(() => () => {
    categoryRequestRef.current += 1;
    pendingCategoryRef.current = null;
    queuedCategoryRef.current = null;
    categoryTransitionAbortRef.current?.abort("Library home unmounted");
    categoryTransitionAbortRef.current = null;
    stopCarouselAnimation();
  }, [stopCarouselAnimation]);

  const contentStore = useMemo(
    () => library ? createLibraryContentStore(library) : null,
    [library],
  );
  const collectionCatalog = contentStore?.catalog ?? null;
  const trackById = contentStore?.trackById
    ?? new Map<string, Track>();

  useEffect(() => {
    if (
      phase !== "library"
      || !collectionCatalog
      || !contentStore
    ) {
      return;
    }

    const sources = (
      Object.values(categorySection) as LibrarySection[]
    ).flatMap((section) => {
      const catalog = collectionsForSection(collectionCatalog, section);
      if (catalog.length === 0) {
        return [];
      }

      const index = 0;

      return createCarouselCards(
        catalog,
        index,
        contentStore.trackById,
        `${section}:catalog`,
      )
        .filter(({ offset }) => Math.abs(offset) <= 2)
        .map(({ track }) => track.coverImage);
    });

    const uniqueSources = Array.from(
      new Set(sources.filter((source): source is string => Boolean(source))),
    );
    let cancelled = false;
    let warmFrame = 0;
    let releaseWarmFrame: (() => void) | null = null;
    const warmTimer = window.setTimeout(() => {
      void (async () => {
        // Keep background category warming cooperative. Serial decoding avoids
        // the large completion burst that previously interrupted the final
        // Login -> Home frames.
        for (const source of uniqueSources) {
          if (cancelled) {
            return;
          }
          await motionController.preloadImage(source);
          if (cancelled) {
            return;
          }
          await new Promise<void>((resolve) => {
            releaseWarmFrame = resolve;
            warmFrame = window.requestAnimationFrame(() => {
              warmFrame = 0;
              releaseWarmFrame = null;
              resolve();
            });
          });
        }
      })();
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(warmTimer);
      if (warmFrame !== 0) {
        window.cancelAnimationFrame(warmFrame);
        warmFrame = 0;
        const release = releaseWarmFrame;
        releaseWarmFrame = null;
        release?.();
      }
    };
  }, [collectionCatalog, contentStore, phase]);

  const baseCarouselCatalog = useMemo<LibraryCollectionSummary[]>(() => {
    if (!collectionCatalog) {
      return [];
    }
    return collectionsForSection(collectionCatalog, activeSection);
  }, [activeSection, collectionCatalog]);
  const isSearchActive =
    isSearchOpen && debouncedSearchQuery.trim().length > 0;
  const carouselCatalog = useMemo<LibraryCollectionSummary[]>(() => {
    if (!collectionCatalog) {
      return [];
    }
    return isSearchActive
      ? searchCurrentSection(
          debouncedSearchQuery,
          activeSection,
          collectionCatalog,
        )
      : baseCarouselCatalog;
  }, [
    activeSection,
    baseCarouselCatalog,
    collectionCatalog,
    debouncedSearchQuery,
    isSearchActive,
  ]);
  const carouselIndex = isSearchActive
    ? searchCarouselIndex
    : carouselIndexes[activeSection];
  const carouselContextKey =
    `${activeSection}:`
    + (isSearchActive
      ? `search:${debouncedSearchQuery.trim()}`
      : "catalog");
  const normalizedCarouselIndex = carouselCatalog.length > 0
    ? positiveModulo(carouselIndex, carouselCatalog.length)
    : 0;
  const activeCollection =
    carouselCatalog[normalizedCarouselIndex] ?? null;
  const activeCollectionKey = activeCollection
    ? collectionTrackCacheKey(activeCollection)
    : null;
  useEffect(() => {
    activeCollectionKeyRef.current = activeCollectionKey;
  }, [activeCollectionKey]);
  const activeCachedTracks = activeCollection
    ? collectionTrackCacheRef.current.get(
        collectionTrackCacheKey(activeCollection),
      )
    : undefined;
  const playlistTracks = useMemo(() => {
    if (!activeCollection || !contentStore) {
      return [];
    }

    return activeCachedTracks ?? contentStore.tracksFor(activeCollection);
  }, [activeCachedTracks, activeCollection, contentStore]);
  const activeCollectionQueueSeed = useMemo<PlaybackQueueSeed | undefined>(
    () => {
      if (!activeCollection || playlistTracks.length === 0) {
        return undefined;
      }
      const context = playbackCollectionContext(providerId, activeCollection);
      return { context, tracks: playlistTracks, startIndex: 0 };
    }, [activeCollection, playlistTracks, providerId],
  );
  const carouselCards = useMemo(() => {
    if (carouselCatalog.length === 0 || !contentStore) {
      return [];
    }

    const preparedCards = preparedCarouselCardsRef.current;
    if (
      preparedCards
      && preparedCards.generation === libraryGenerationRef.current
      && preparedCards.contextKey === carouselContextKey
      && preparedCards.carouselIndex === carouselIndex
    ) {
      return preparedCards.cards;
    }

    return createCarouselCards(
      carouselCatalog,
      carouselIndex,
      contentStore.trackById,
      carouselContextKey,
    );
  }, [
    carouselIndex,
    carouselCatalog,
    carouselContextKey,
    contentStore,
  ]);
  const preloadCarouselWindow = useCallback(
    (logicalTargetIndex: number, radius = 2) => {
      const windowKey =
        `${activeSection}:${isSearchActive ? debouncedSearchQuery : "all"}:`
        + `${logicalTargetIndex}:r${radius}`;
      if (
        lastPrefetchedCarouselWindowRef.current === windowKey
        || carouselCards.length === 0
      ) {
        return;
      }

      lastPrefetchedCarouselWindowRef.current = windowKey;
      const sources = carouselCards
        .filter(({ logicalPosition }) =>
          Math.abs(logicalPosition - logicalTargetIndex) <= radius
        )
        .map(({ track }) => track.coverImage);
      void motionController.preloadImages(sources);
    },
    [
      activeSection,
      carouselCards,
      debouncedSearchQuery,
      isSearchActive,
    ],
  );
  useEffect(() => {
    if (phase === "welcome") {
      return;
    }
    preloadCarouselWindow(carouselIndex);
  }, [carouselIndex, phase, preloadCarouselWindow]);
  preloadCarouselDeltaRef.current = (delta, radius = 2) => {
    preloadCarouselWindow(carouselIndex + delta, radius);
  };
  const centralCarouselCard = carouselCards.find(
    ({ position }) => position === "center",
  );
  const centralTrack = centralCarouselCard?.track;
  const playlistDurationMs = useMemo(() => {
    if (!activeCollection || !contentStore) {
      return 0;
    }
    if (preparedWall?.collectionKey === activeCollectionKey) {
      return preparedWall.preparation.totalDurationMs;
    }
    if (activeCachedTracks) {
      return activeCachedTracks.reduce(
        (duration, track) => duration + track.durationMs,
        0,
      );
    }
    return contentStore.durationFor(activeCollection);
  }, [
    activeCachedTracks,
    activeCollection,
    activeCollectionKey,
    contentStore,
    preparedWall,
  ]);
  const preparedWallQueueContext = useMemo(
    () => preparedWall
      ? playbackCollectionContext(providerId, preparedWall.collection)
      : null,
    [preparedWall, providerId],
  );
  const detailCloseDuration = prefersReducedMotion
    ? homeWallMotion.reducedTransitionDuration
    : homeWallMotion.closeTransitionDuration;
  const wallOpenDuration = prefersReducedMotion
    ? homeWallMotion.reducedTransitionDuration
    : homeWallMotion.transitionDuration;

  const prepareWallCollection = useCallback(
    (
      collection: LibraryCollectionSummary,
      coverTrack: Track,
      fallbackTracks: readonly Track[],
      options: {
        signal?: AbortSignal;
        generation?: number;
        coverArtIndex?: number;
      } = {},
    ) => {
      const generation =
        options.generation ?? libraryGenerationRef.current;
      const isLibraryStale = () =>
        options.signal?.aborted === true
        || generation !== libraryGenerationRef.current;
      if (options.signal?.aborted || isLibraryStale()) {
        return Promise.resolve(null);
      }

      const cacheKey = wallPreparationKey(collection);
      const trackCacheKey = collectionTrackCacheKey(collection);
      const cached = wallPreparationCacheRef.current.get(cacheKey);
      if (cached) {
        const prepared = options.coverArtIndex === undefined
            || options.coverArtIndex === cached.coverArtIndex
          ? cached
          : { ...cached, coverArtIndex: options.coverArtIndex };
        wallPreparationCacheRef.current.delete(cacheKey);
        wallPreparationCacheRef.current.set(cacheKey, prepared);
        return Promise.resolve(prepared);
      }

      const pending =
        wallPreparationPromisesRef.current.get(cacheKey);
      if (pending) {
        return pending;
      }

      const preparation = (async (): Promise<PreparedWallState | null> => {
        let resolvedTracks =
          collectionTrackCacheRef.current.get(trackCacheKey)
          ?? [...fallbackTracks];
        const providerDisplayLimit = providerId === "spotify" ? 20 : 1_000;
        const needsRemoteTracks =
          library?.source !== "demo"
          && collection.kind !== "artist"
          && resolvedTracks.length < Math.min(
            collection.trackCount,
            providerDisplayLimit,
          );

        if (
          needsRemoteTracks
          && !collectionTrackCacheRef.current.has(trackCacheKey)
        ) {
          resolvedTracks = await withTimeout(
            musicProvider.getCollectionTracks(
              collection.kind === "album" ? "album" : "playlist",
              collection.id,
            ),
            12_000,
            t("home.error.trackTimeout"),
          );
          if (isLibraryStale()) {
            return null;
          }
          if (resolvedTracks.length > 0) {
            collectionTrackCacheRef.current.set(
              trackCacheKey,
              resolvedTracks,
            );
          }
        }

        if (resolvedTracks.length === 0) {
          return null;
        }

        // Spotify's design rules cap a single displayed content set at 20
        // items. Keep the provider cache intact, but prepare the wall from the
        // bounded display set so its pool indexes and decoded covers match the
        // cards that can actually be rendered.
        const displayTracks = providerId === "spotify"
          ? resolvedTracks.slice(0, 20)
          : resolvedTracks;
        const preparedTracks = createPreparedWallTracks(
          collection,
          displayTracks,
          coverTrack,
        );
        const wallPreparation = await prepareMusicWall(
          preparedTracks,
          coverTrack,
          { signal: options.signal },
        );
        if (isLibraryStale()) {
          return null;
        }
        const prepared: PreparedWallState = {
          collectionKey: trackCacheKey,
          collection,
          coverTrack,
          coverArtIndex: options.coverArtIndex ?? 0,
          tracks: preparedTracks,
          preparation: wallPreparation,
        };
        const cache = wallPreparationCacheRef.current;
        cache.set(cacheKey, prepared);
        while (cache.size > 8) {
          const oldestKey = cache.keys().next().value as string | undefined;
          if (!oldestKey) {
            break;
          }
          cache.delete(oldestKey);
        }
        return prepared;
      })().finally(() => {
        if (
          wallPreparationPromisesRef.current.get(cacheKey) === preparation
        ) {
          wallPreparationPromisesRef.current.delete(cacheKey);
        }
      });

      wallPreparationPromisesRef.current.set(cacheKey, preparation);
      return preparation;
    },
    [library?.source, musicProvider, providerId, t],
  );

  const stageWallOpenIntent = useCallback((
    collection: LibraryCollectionSummary,
    coverTrack: Track,
    coverArtIndex: number,
    fallbackTracks: readonly Track[],
    coverBounds: DOMRect,
  ) => {
    const generation = libraryGenerationRef.current;
    const collectionKey = collectionTrackCacheKey(collection);
    const intentId = wallOpenIntentSequenceRef.current + 1;
    wallOpenIntentSequenceRef.current = intentId;
    if (pendingWallOpenIntentRef.current) {
      pendingWallOpenIntentRef.current.cancelled = true;
    }

    const preparationPromise = prepareWallCollection(
      collection,
      coverTrack,
      fallbackTracks,
      { generation, coverArtIndex },
    );
    const intent: PendingWallOpenIntent = {
      id: intentId,
      collectionKey,
      generation,
      collection,
      coverTrack,
      coverBounds,
      portalGeometry: calculateCoverPortalGeometry(coverBounds),
      cancelled: false,
      preparationPromise,
      shellReadyPromise: Promise.resolve(null),
    };

    intent.shellReadyPromise = preparationPromise.then(async (prepared) => {
      if (
        !prepared
        || intent.cancelled
        || pendingWallOpenIntentRef.current !== intent
        || generation !== libraryGenerationRef.current
        || activeCollectionKeyRef.current !== collectionKey
        || detailViewRef.current !== "browsing"
      ) {
        return prepared;
      }

      const needsShellCommit = preparedWallRef.current !== prepared
        || !coverPortalGeometryMatches(
          portalGeometryRef.current,
          intent.portalGeometry,
        );
      if (!needsShellCommit) {
        markHomeWallTransitionPhase("portal-shell-reused");
        return prepared;
      }

      // A very fast click can beat stable-focus idle pre-mounting. Let the
      // pressed cover reach the screen before any fallback React mount; a
      // cached Promise resolves in a microtask and otherwise used to consume
      // the very frame that was meant to acknowledge the click.
      await new Promise<void>((resolve) => {
        motionController.afterPaint(resolve, 2);
      });
      if (
        intent.cancelled
        || pendingWallOpenIntentRef.current !== intent
        || generation !== libraryGenerationRef.current
        || activeCollectionKeyRef.current !== collectionKey
        || detailViewRef.current !== "browsing"
      ) {
        return prepared;
      }

      // Mount and lay out the isolated Portal shell while the focused Home
      // cover is still running its reversible compositor feedback. The shell
      // remains inactive and visually hidden, so double-click semantics stay
      // intact and WebKit cannot expose a complete Wall behind the Home shelf.
      let shellCommitRequested = false;
      if (preparedWallRef.current !== prepared) {
        preparedWallRef.current = prepared;
        setPreparedWall(prepared);
        shellCommitRequested = true;
      }
      if (!coverPortalGeometryMatches(
        portalGeometryRef.current,
        intent.portalGeometry,
      )) {
        portalGeometryRef.current = intent.portalGeometry;
        setPortalGeometry(intent.portalGeometry);
        shellCommitRequested = true;
      }

      if (!shellCommitRequested) {
        markHomeWallTransitionPhase("portal-shell-reused-after-feedback");
        return prepared;
      }
      markHomeWallTransitionPhase("portal-shell-commit-requested");

      return new Promise<PreparedWallState | null>((resolve) => {
        motionController.afterPaint(() => {
          if (
            !intent.cancelled
            && pendingWallOpenIntentRef.current === intent
            && generation === libraryGenerationRef.current
          ) {
            markHomeWallTransitionPhase("portal-shell-painted");
          }
          resolve(prepared);
        }, 2);
      });
    });
    pendingWallOpenIntentRef.current = intent;
    return intent;
  }, [prepareWallCollection]);

  useLayoutEffect(() => {
    libraryGenerationRef.current += 1;
    wallPreparationRequestRef.current += 1;
    categoryRequestRef.current += 1;
    spaceTransitionAbortRef.current?.abort("Music library changed");
    spaceTransitionAbortRef.current = null;
    playerTransitionAbortRef.current?.abort("Music library changed");
    playerTransitionAbortRef.current = null;
    resetCarouselTrack();
    renderedCarouselContextRef.current = null;
    lastPrefetchedCarouselWindowRef.current = null;
    previousDetailViewRef.current = "browsing";
    activeCollectionKeyRef.current = null;
    pendingCategoryRef.current = null;
    queuedCategoryRef.current = null;
    categoryTransitionAbortRef.current?.abort("Music library changed");
    categoryTransitionAbortRef.current = null;
    finishCategoryTransitionTrace("library-changed");
    preparedShelfPoseRef.current = null;
    categoryCommitPoseRef.current = null;
    preparedCategorySectionsRef.current.clear();
    preparedCategorySectionsRef.current.add("playlists");
    preparedCarouselCardsRef.current = null;
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    categoryTransitionPhaseRef.current = "idle";
    const covers = coversRef.current;
    if (covers) {
      covers.dataset.dragging = "false";
      covers.dataset.moving = "false";
      covers.dataset.clickPending = "false";
    }
    spaceTransitionPendingRef.current = false;
    playerTransitionPendingRef.current = false;
    isWallPanelOpenRef.current = false;
    homeSnapshotRef.current = null;
    pendingPortalBoundsRef.current = null;
    if (pendingWallOpenIntentRef.current) {
      pendingWallOpenIntentRef.current.cancelled = true;
    }
    pendingWallOpenIntentRef.current = null;
    wallPreparationCacheRef.current.clear();
    wallPreparationPromisesRef.current.clear();
    collectionTrackCacheRef.current.clear();
    setActiveCategory("playlists");
    requestedCategoryRef.current = "playlists";
    setActiveShelfPlaneId("a");
    activeShelfPlaneIdRef.current = "a";
    setPendingShelfPlane(null);
    setCarouselIndexes({
      playlists: 0,
      radio: 0,
      albums: 0,
      artists: 0,
    });
    setIsSearchOpen(false);
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setSearchCarouselIndex(0);
    setCategoryTransition("idle");
    setDetailView("browsing");
    setPortalGeometry(null);
    setPreparedWall(null);
    isCollectionLoadingRef.current = false;
    setIsWallLocking(false);
    setCurrentPlaybackOccurrence(null);
    setIsPlayerTransitioning(false);
    setPlaybackNotice("");
  }, [
    library?.source,
    library?.syncedAt,
    library?.user.id,
    resetCarouselTrack,
  ]);

  useEffect(() => {
    if (phase !== "library" || !centralTrack) {
      return;
    }

    return motionController.afterPaint(() => {
      void prewarmImmersivePlayback(centralTrack, {
        theme:
          document
              .querySelector<HTMLElement>(".welcome")
              ?.dataset.colorTheme === "light"
            ? "light"
            : "dark",
        space: "music",
      });
    }, 2);
  }, [centralTrack, phase]);

  useEffect(() => {
    if (
      phase !== "library"
      || detailView !== "browsing"
      || !activeCollection
      || !centralTrack
    ) {
      return;
    }

    const generation = libraryGenerationRef.current;
    const requestedCollectionKey = collectionTrackCacheKey(activeCollection);
    let cancelled = false;
    let preparationTimer: number | null = null;
    let idleCommitId: number | null = null;
    let fallbackCommitTimer: number | null = null;
    // Wait for a short stable-focus window so a fast shelf gesture does not
    // leave several obsolete provider/decode jobs competing on the main
    // thread. Once the collection is still focused, mount its bounded Wall
    // pool during browser idle time. The inactive Portal uses visibility:
    // hidden (not opacity alone), so WebKit cannot expose its compositor
    // surface while this render work is moved out of the click/animation path.
    const cancelAfterPaint = motionController.afterPaint(() => {
      preparationTimer = window.setTimeout(() => {
        preparationTimer = null;
        void prepareWallCollection(
          activeCollection,
          centralTrack,
          playlistTracks,
          {
            generation,
            coverArtIndex: centralCarouselCard?.artIndex ?? 0,
          },
        ).then((prepared) => {
          if (
            !prepared
            || cancelled
            || phase !== "library"
            || generation !== libraryGenerationRef.current
            || activeCollectionKeyRef.current !== requestedCollectionKey
          ) {
            return;
          }
          const commitPreparedShell = () => {
            idleCommitId = null;
            fallbackCommitTimer = null;
            if (
              cancelled
              || phase !== "library"
              || detailViewRef.current !== "browsing"
              || pendingWallOpenIntentRef.current !== null
              || clickTimerRef.current !== null
              || generation !== libraryGenerationRef.current
              || activeCollectionKeyRef.current !== requestedCollectionKey
            ) {
              return;
            }

            const coverBounds =
              centralCoverRef.current?.getBoundingClientRect();
            if (!coverBounds || coverBounds.width === 0) {
              return;
            }
            const nextGeometry = calculateCoverPortalGeometry(coverBounds);
            if (preparedWallRef.current !== prepared) {
              preparedWallRef.current = prepared;
              setPreparedWall(prepared);
            }
            if (!coverPortalGeometryMatches(
              portalGeometryRef.current,
              nextGeometry,
            )) {
              portalGeometryRef.current = nextGeometry;
              setPortalGeometry(nextGeometry);
            }
          };

          if (typeof window.requestIdleCallback === "function") {
            idleCommitId = window.requestIdleCallback(commitPreparedShell, {
              timeout: 900,
            });
          } else {
            fallbackCommitTimer = window.setTimeout(
              commitPreparedShell,
              72,
            );
          }
        }).catch(() => {
          // The explicit open path reports provider errors if selected.
        });
      }, 160);
    }, 1);

    return () => {
      cancelled = true;
      cancelAfterPaint();
      if (preparationTimer !== null) {
        window.clearTimeout(preparationTimer);
      }
      if (idleCommitId !== null) {
        window.cancelIdleCallback(idleCommitId);
      }
      if (fallbackCommitTimer !== null) {
        window.clearTimeout(fallbackCommitTimer);
      }
    };
  }, [
    activeCollection,
    centralTrack,
    detailView,
    phase,
    playlistTracks,
    prepareWallCollection,
    centralCarouselCard?.artIndex,
  ]);

  const closeSearch = useCallback(() => {
    resetCarouselTrack();
    setIsSearchOpen(false);
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setSearchCarouselIndex(0);
  }, [resetCarouselTrack]);

  const prepareShelfTrackPose = (
    root: HTMLElement,
    planeId: ShelfPlaneId,
    contextKey: string,
  ): PreparedShelfTrackPose => {
    const preparedSlots = Array.from(
      root.querySelectorAll<HTMLElement>(
        ".library-home__cover-slot[data-track-offset]",
      ),
    );
    noteCategoryTransitionDomScan("pose-slots", preparedSlots.length);
    const preparedCovers = new WeakMap<HTMLElement, HTMLElement>();
    for (const slot of preparedSlots) {
      const cover = slot.querySelector<HTMLElement>(".magazine-cover");
      if (cover) {
        preparedCovers.set(slot, cover);
        noteCategoryTransitionDomScan("pose-covers");
      }
    }

    const activeSlots = carouselSlotsRef.current;
    const activeCovers = carouselCoverElementsRef.current;
    const activeVisuals = carouselSlotVisualsRef.current;
    const preparedVisuals = new WeakMap<HTMLElement, CarouselSlotVisual>();
    carouselSlotsRef.current = preparedSlots;
    carouselCoverElementsRef.current = preparedCovers;
    carouselSlotVisualsRef.current = preparedVisuals;
    renderCarouselRef.current(0);
    noteCategoryTransitionDomScan("pose-visual-writes", preparedSlots.length);
    carouselSlotsRef.current = activeSlots;
    carouselCoverElementsRef.current = activeCovers;
    carouselSlotVisualsRef.current = activeVisuals;
    return {
      planeId,
      contextKey,
      slots: preparedSlots,
      covers: preparedCovers,
      visuals: preparedVisuals,
    };
  };

  const selectCategory = (category: LibraryCategory) => {
    if (
      spaceTransitionPendingRef.current
      || isCollectionLoadingRef.current
      || pendingCarouselRebaseRef.current
    ) {
      return;
    }

    const transitionPhase = categoryTransitionPhaseRef.current;
    const previousRequestedCategory = requestedCategoryRef.current;
    markCategoryTransitionPhase(`intent:${category}:${transitionPhase}`);
    // Record the user's latest intent before any transition-phase branch.
    // The queue is only an implementation detail of the current hand-off;
    // requestedCategoryRef remains the authoritative destination when several
    // nav clicks land across prepare/out/commit boundaries.
    requestedCategoryRef.current = category;

    // Once the compositor hand-off has started, preserve both mounted planes
    // until its final frame. Only the last user intent is queued; interrupting
    // CSS animation here used to restore default opacity and corrupt ownership.
    if (transitionPhase === "out" || transitionPhase === "commit") {
      queuedCategoryRef.current =
        category === pendingCategoryRef.current ? null : category;
      return;
    }

    if (
      category === previousRequestedCategory
      && transitionPhase !== "idle"
    ) {
      return;
    }

    if (transitionPhase === "prepare" && category === activeCategory) {
      categoryRequestRef.current += 1;
      pendingCategoryRef.current = null;
      queuedCategoryRef.current = null;
      requestedCategoryRef.current = activeCategory;
      writeCategoryNavGeometry(activeCategory, activeCategory);
      categoryTransitionAbortRef.current?.abort(
        "Category preparation returned to committed category",
      );
      categoryTransitionAbortRef.current = null;
      preparedShelfPoseRef.current = null;
      categoryCommitPoseRef.current = null;
      categoryTransitionPhaseRef.current = "idle";
      setCategoryTransition("idle");
      setPendingShelfPlane(null);
      finishCategoryTransitionTrace("cancelled");
      return;
    }

    if (category === activeCategory && transitionPhase === "idle") {
      queuedCategoryRef.current = null;
      requestedCategoryRef.current = activeCategory;
      return;
    }

    const requestId = categoryRequestRef.current + 1;
    categoryRequestRef.current = requestId;
    preparedShelfPoseRef.current = null;
    categoryCommitPoseRef.current = null;
    pendingCategoryRef.current = category;
    queuedCategoryRef.current = null;
    requestedCategoryRef.current = category;
    writeCategoryNavGeometry(activeCategory, category);

    categoryTransitionAbortRef.current?.abort(
      "Category transition superseded",
    );
    const transitionAbort = new AbortController();
    categoryTransitionAbortRef.current = transitionAbort;

    const outgoingSection = activeSection;
    const outgoingCatalogLength = carouselCatalog.length;
    const outgoingDelta =
      !isSearchActive
      && outgoingCatalogLength > 1
      && carouselMetricsRef.current.step > 0
        ? normalizeCarouselTravel(
            Math.round(
              -trackOffsetRef.current / carouselMetricsRef.current.step,
            ),
          )
        : 0;
    freezeCarouselTrack();

    const nextSection = categorySection[category];
    beginCategoryTransitionTrace(
      activeCategory,
      category,
      preparedCategorySectionsRef.current.has(nextSection),
      requestId,
    );
    const nextCatalog = collectionCatalog
      ? collectionsForSection(collectionCatalog, nextSection)
      : [];
    const storedNextIndex =
      nextSection === outgoingSection && outgoingDelta !== 0
        ? advanceCarouselLogicalIndex(
            carouselIndexes[nextSection],
            outgoingDelta,
          )
        : carouselIndexes[nextSection];
    const nextIndex = nextCatalog.length > 0 ? storedNextIndex : 0;
    const nextCards = createCarouselCards(
      nextCatalog,
      nextIndex,
      trackById,
      `${nextSection}:catalog`,
    );
    preparedCarouselCardsRef.current = {
      generation: libraryGenerationRef.current,
      contextKey: `${nextSection}:catalog`,
      carouselIndex: nextIndex,
      cards: nextCards,
    };
    const nextCollection = nextCatalog.length > 0
      ? nextCatalog[positiveModulo(nextIndex, nextCatalog.length)] ?? null
      : null;
    const nextDurationMs = nextCollection && contentStore
      ? contentStore.durationFor(nextCollection)
      : 0;
    const logicalDirection: ShelfDirection =
      categories.indexOf(category) >= categories.indexOf(activeCategory)
        ? "forward"
        : "backward";
    const motionVariant: ShelfDirection = "backward";
    const pendingPlaneId: ShelfPlaneId =
      activeShelfPlaneIdRef.current === "a" ? "b" : "a";
    const pendingPlane: PendingShelfPlane = {
      requestId,
      planeId: pendingPlaneId,
      category,
      section: nextSection,
      logicalDirection,
      motionVariant,
      cards: nextCards,
      catalogLength: nextCatalog.length,
      carouselIndex: nextIndex,
      collection: nextCollection,
      durationMs: nextDurationMs,
    };

    setPendingShelfPlane(pendingPlane);
    categoryTransitionPhaseRef.current = "prepare";
    setCategoryTransition("prepare");
    markCategoryTransitionPhase("prepare-requested");

    const transitionDuration = prefersReducedMotion
      ? categoryMotion.reducedTransitionDuration
      : categoryMotion.transitionDuration;

    void (async () => {
      const preparationStartedAt = performance.now();
      const preparationBudgetMs = 180;
      const criticalSources = nextCards
        .filter(({ offset }) => Math.abs(offset) <= 1)
        .map(({ track }) => track.coverImage);
      const deferredSources = nextCards
        .filter(({ offset }) => Math.abs(offset) > 1)
        .map(({ track }) => track.coverImage);
      await motionController.preloadImages(criticalSources, {
        signal: transitionAbort.signal,
        timeoutMs: 150,
        concurrency: 3,
      });
      preparedCategorySectionsRef.current.add(nextSection);
      markCategoryTransitionPhase("critical-preload-done");
      await waitForPaint(transitionAbort.signal);
      markCategoryTransitionPhase("pending-mounted");
      captureCategoryTransitionEvidence("preparing-hidden", { requestId });
      const pendingRoot = shelfPlaneRefs.current[pendingPlaneId];
      if (!pendingRoot) {
        throw new Error("Pending shelf plane was not mounted");
      }
      preparedShelfPoseRef.current = prepareShelfTrackPose(
        pendingRoot,
        pendingPlaneId,
        `${nextSection}:catalog`,
      );
      markCategoryTransitionPhase("pose-written");
      const remainingPreparationMs = Math.max(
        1,
        preparationBudgetMs - (performance.now() - preparationStartedAt),
      );
      await waitForShelfImagesReady(
        pendingRoot,
        transitionAbort.signal,
        remainingPreparationMs,
      );
      markCategoryTransitionPhase("dom-images-ready");
      captureCategoryTransitionEvidence("images-ready", { requestId });

      if (
        transitionAbort.signal.aborted
        || categoryRequestRef.current !== requestId
        || pendingCategoryRef.current !== category
      ) {
        return;
      }

      categoryTransitionPhaseRef.current = "out";
      setCategoryTransition("out");
      markCategoryTransitionPhase("animate-requested");
      await waitForPaint(transitionAbort.signal);
      markCategoryTransitionPhase("animate-first-paint");
      captureCategoryTransitionEvidence("animate-start", { requestId });

      if (
        transitionAbort.signal.aborted
        || categoryRequestRef.current !== requestId
        || pendingCategoryRef.current !== category
      ) {
        return;
      }
      const incomingAnimationName = prefersReducedMotion
        ? "category-shelf-in-reduced"
        : pendingPlane.motionVariant === "forward"
          ? "category-shelf-in-forward"
          : "category-shelf-in-backward";
      const centerHandoffTimer = window.setTimeout(() => {
        if (
          !transitionAbort.signal.aborted
          && categoryRequestRef.current === requestId
          && pendingCategoryRef.current === category
        ) {
          markCategoryTransitionPhase("visual-owner-handoff");
          markCategoryTransitionPhase("nav-handoff");
          markCategoryTransitionPhase("caption-handoff");
          markCategoryTransitionPhase("page-count-handoff");
          captureCategoryTransitionEvidence("visual-owner-handoff", {
            requestId,
          });
        }
      }, transitionDuration * categoryMotion.handoffProgress);
      const sideHandoffProgress = prefersReducedMotion
        ? categoryMotion.handoffProgress
        : categoryMotion.sideHandoffProgress;
      const sideHandoffTimer = window.setTimeout(() => {
        if (
          !transitionAbort.signal.aborted
          && categoryRequestRef.current === requestId
          && pendingCategoryRef.current === category
        ) {
          markCategoryTransitionPhase("side-visual-owner-handoff");
          captureCategoryTransitionEvidence("side-visual-owner-handoff", {
            requestId,
          });
        }
      }, transitionDuration * sideHandoffProgress);
      try {
        await waitForNamedAnimation(
          shelfPlaneRefs.current[pendingPlaneId],
          incomingAnimationName,
          transitionDuration,
          transitionAbort.signal,
        );
      } finally {
        window.clearTimeout(centerHandoffTimer);
        window.clearTimeout(sideHandoffTimer);
      }
      markCategoryTransitionPhase("animation-ended");
      captureCategoryTransitionEvidence("animation-ended", { requestId });

      if (
        transitionAbort.signal.aborted
        || categoryRequestRef.current !== requestId
        || pendingCategoryRef.current !== category
      ) {
        return;
      }

      if (outgoingDelta !== 0) {
        setCarouselIndexes((currentIndexes) => ({
          ...currentIndexes,
          [outgoingSection]: advanceCarouselLogicalIndex(
            currentIndexes[outgoingSection],
            outgoingDelta,
          ),
        }));
      }
      setIsSearchOpen(false);
      setSearchQuery("");
      setDebouncedSearchQuery("");
      setSearchCarouselIndex(0);
      trackOffsetRef.current = 0;
      targetIndexRef.current = 0;
      snapTargetRef.current = 0;
      gestureOriginRef.current = 0;
      pendingCarouselRebaseRef.current = false;
      const preparedPose = preparedShelfPoseRef.current;
      if (
        preparedPose?.planeId === pendingPlaneId
        && preparedPose.contextKey === `${nextSection}:catalog`
      ) {
        coversRef.current = shelfTrackRefs.current[pendingPlaneId];
        carouselSlotsRef.current = preparedPose.slots;
        carouselCoverElementsRef.current = preparedPose.covers;
        carouselSlotVisualsRef.current = preparedPose.visuals;
        renderedCarouselContextRef.current = preparedPose.contextKey;
        categoryCommitPoseRef.current = preparedPose;
      }
      activeShelfPlaneIdRef.current = pendingPlaneId;
      categoryTransitionPhaseRef.current = "commit";
      markCategoryTransitionPhase("commit-requested");
      captureCategoryTransitionEvidence("commit-requested", { requestId });
      writeCategoryNavGeometry(category, category);
      markCategoryTransitionPhase("commit-flush-start");
      flushSync(() => {
        setActiveShelfPlaneId(pendingPlaneId);
        setActiveCategory(category);
        setCategoryTransition("commit");
      });

      // The first RAF adopts the exact prepared pose. A second RAF guarantees
      // that pose has reached a presented frame before the reserve plane is
      // released back to idle; a single RAF callback still runs before paint.
      await waitForPaint(transitionAbort.signal);
      await waitForPaint(transitionAbort.signal);
      markCategoryTransitionPhase("commit-stable-paint");
      captureCategoryTransitionEvidence("stable-paint", { requestId });
      coversRef.current = shelfTrackRefs.current[pendingPlaneId];
      categoryCommitPoseRef.current = null;

      if (
        transitionAbort.signal.aborted
        || categoryRequestRef.current !== requestId
      ) {
        return;
      }
      pendingCategoryRef.current = null;
      preparedShelfPoseRef.current = null;
      categoryTransitionPhaseRef.current = "idle";
      setCategoryTransition("idle");
      setPendingShelfPlane((plane) =>
        plane?.requestId === requestId ? null : plane
      );
      markCategoryTransitionPhase("idle-requested");
      await waitForPaint(transitionAbort.signal);
      finishCategoryTransitionTrace("stable-paint");

      queuedCategoryRef.current = null;
      // Read the latest intent inside the RAF rather than capturing it before
      // the frame is scheduled. A reverse click in that one-frame window used
      // to be overwritten by the stale destination from the completed handoff.
      window.requestAnimationFrame(() => {
        if (
          categoryTransitionPhaseRef.current !== "idle"
          || categoryRequestRef.current !== requestId
        ) {
          return;
        }

        const latestCategory = requestedCategoryRef.current;
        if (latestCategory !== activeCategoryRef.current) {
          selectCategoryRef.current(latestCategory);
          return;
        }

        // Non-visible buffer covers are deliberately decoded only after the
        // ownership animation and commit have both settled. Starting this
        // idle queue during the category hand-off can make image decode contend
        // with the compositor on WebKit even though the cards are off-screen.
        motionController.preloadImagesDeferred(deferredSources, {
          batchSize: 1,
          concurrency: 1,
        });
        requestedCategoryRef.current = activeCategoryRef.current;
        writeCategoryNavGeometry(
          activeCategoryRef.current,
          activeCategoryRef.current,
        );
      });
    })().catch((error) => {
      if (
        transitionAbort.signal.aborted
        || categoryRequestRef.current !== requestId
      ) {
        return;
      }
      pendingCategoryRef.current = null;
      preparedShelfPoseRef.current = null;
      categoryCommitPoseRef.current = null;
      queuedCategoryRef.current = null;
      requestedCategoryRef.current = activeCategory;
      writeCategoryNavGeometry(activeCategory, activeCategory);
      categoryTransitionPhaseRef.current = "idle";
      setCategoryTransition("idle");
      setPendingShelfPlane((plane) =>
        plane?.requestId === requestId ? null : plane
      );
      setPlaybackNotice(
        error instanceof Error ? error.message : String(error),
      );
      finishCategoryTransitionTrace("failed");
    }).finally(() => {
      if (categoryTransitionAbortRef.current === transitionAbort) {
        categoryTransitionAbortRef.current = null;
      }
    });
  };
  selectCategoryRef.current = selectCategory;

  const handleSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }

    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (searchQuery.trim()) {
        resetCarouselTrack();
        setDebouncedSearchQuery(searchQuery);
      }
      setSearchCarouselIndex(0);
      centralCoverRef.current?.focus();
    }
  };

  const clearCarouselTimers = useCallback(() => {
    resetCarouselTrack();
  }, [resetCarouselTrack]);

  const captureHomeSnapshot = () => {
    const covers = coversRef.current;
    if (!covers || !activeCollection) {
      return null;
    }

    const snapshot: HomeSnapshot = {
      section: activeSection,
      collectionId: activeCollection.id,
      activeIndex: carouselIndex,
      searchActive: isSearchActive,
      trackOffset: 0,
      targetIndex: 0,
      snapTarget: 0,
      gestureOrigin: 0,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      cards: carouselSlotsRef.current.map((slot) => {
        const visual = carouselSlotVisualsRef.current.get(slot);
        return {
          offset: slot.dataset.trackOffset ?? "",
          transform: slot.style.transform,
          opacity: slot.style.opacity,
          dim: slot.style.getPropertyValue("--track-dim"),
          brightness: slot.style.getPropertyValue("--track-brightness"),
          blur: slot.style.getPropertyValue("--track-blur"),
          focused: slot.dataset.focused ?? "false",
          focusScore: visual?.focusScore ?? slot.dataset.focusScore ?? "0",
          focusLayer: slot.dataset.focusLayer ?? "0",
        };
      }),
    };

    stopCarouselAnimation();
    pendingCarouselRebaseRef.current = false;
    covers.dataset.dragging = "false";
    covers.dataset.moving = "false";
    homeSnapshotRef.current = snapshot;
    returnSnapshotRestoredRef.current = false;

    return snapshot;
  };

  restoreHomeSnapshotRef.current = () => {
    const snapshot = homeSnapshotRef.current;
    if (
      !snapshot
      || snapshot.section !== activeSection
      || snapshot.collectionId !== activeCollection?.id
    ) {
      return false;
    }

    pendingCarouselRebaseRef.current = false;
    trackOffsetRef.current = snapshot.trackOffset;
    targetIndexRef.current = snapshot.targetIndex;
    snapTargetRef.current = snapshot.snapTarget;
    gestureOriginRef.current = snapshot.gestureOrigin;
    carouselVelocityRef.current = 0;
    carouselMotionStateRef.current = "idle";
    carouselSlotVisualsRef.current = new WeakMap();
    const covers = coversRef.current;
    if (covers) {
      covers.dataset.dragging = "false";
      covers.dataset.moving = "false";
      covers.style.setProperty("--carousel-drag-x", "0px");
    }

    const viewportIsUnchanged =
      Math.abs(window.innerWidth - snapshot.viewportWidth) <= 1
      && Math.abs(window.innerHeight - snapshot.viewportHeight) <= 1;
    if (viewportIsUnchanged) {
      noteHomeWallTransitionMetric(
        "home-snapshot-dom-writes",
        applyHomeCardSnapshots(carouselSlotsRef.current, snapshot.cards),
      );
    } else {
      renderCarouselRef.current(snapshot.trackOffset);
      noteHomeWallTransitionMetric("home-snapshot-layout-recalculated", true);
    }
    const scrollNeedsRestore =
      Math.abs(window.scrollX - snapshot.scrollX) > 0.5
      || Math.abs(window.scrollY - snapshot.scrollY) > 0.5;
    noteHomeWallTransitionMetric(
      "home-snapshot-scroll-restored",
      scrollNeedsRestore,
    );
    if (scrollNeedsRestore) {
      window.scrollTo(snapshot.scrollX, snapshot.scrollY);
    }
    return true;
  };

  const shiftCarousel = (direction: CarouselDirection) => {
    if (
      phase !== "library" ||
      detailView !== "browsing" ||
      categoryTransitionPhaseRef.current !== "idle" ||
      carouselMotionStateRef.current !== "idle" ||
      pendingCarouselRebaseRef.current ||
      carouselCatalog.length < 2 ||
      isCollectionLoadingRef.current
    ) {
      return false;
    }

    const delta = direction === "next" ? 1 : -1;
    preloadCarouselWindow(carouselIndex + delta);
    targetIndexRef.current = delta;
    snapTargetRef.current = -delta * carouselMetricsRef.current.step;
    carouselVelocityRef.current = 0;
    carouselMotionStateRef.current = "snapping";
    coversRef.current?.setAttribute("data-moving", "true");
    startCarouselMotionRef.current();

    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }

    return true;
  };
  useEffect(() => {
    shiftCarouselRef.current = shiftCarousel;
  });

  const requestPlayback = useCallback((
    track: Track,
    source: PlaybackSource,
    requestedOrigin?: PlaybackOrigin,
    queueSeed?: PlaybackQueueSeed,
    startPositionMs?: number,
  ) => {
    if (providerId === "spotify") {
      if (!musicProvider.openExternalPlayback) {
        setPlaybackNotice(t("spotify.openFailed", {
          message: t("spotify.externalOnly"),
        }));
        return;
      }

      setPlaybackNotice(t("spotify.opening", { title: track.title }));
      void musicProvider.openExternalPlayback(track).then(() => {
        setPlaybackNotice(t("spotify.opened"));
        if (noticeTimerRef.current !== null) {
          window.clearTimeout(noticeTimerRef.current);
        }
        noticeTimerRef.current = window.setTimeout(() => {
          setPlaybackNotice("");
        }, 1_800);
      }).catch(() => {
        setPlaybackNotice(t("spotify.openFailed", {
          message: t("spotify.externalUnavailable"),
        }));
      });
      return;
    }

    if (isPlayerTransitioning || playerTransitionPendingRef.current) {
      return;
    }
    playerTransitionPendingRef.current = true;
    void playbackPrefetchService.prefetchTrack(track);
    if (playbackReturnTransitionRef.current?.phase !== "prepare") {
      playbackReturnTransitionRef.current = null;
      setPlaybackReturnTransition(null);
    }

    const coverBounds =
      pendingPortalBoundsRef.current
      ?? centralCoverRef.current?.getBoundingClientRect();
    const origin =
      requestedOrigin
      ?? (coverBounds && coverBounds.width > 0
        ? {
            left: coverBounds.left,
            top: coverBounds.top,
            width: coverBounds.width,
            height: coverBounds.height,
          }
        : undefined);
    const immediateTrack = track;
    const theme =
      document
          .querySelector<HTMLElement>(".welcome")
          ?.dataset.colorTheme === "light"
        ? "light"
        : "dark";
    playerTransitionAbortRef.current?.abort(
      "Playback transition superseded",
    );
    const transitionAbort = new AbortController();
    playerTransitionAbortRef.current = transitionAbort;

    void transitionManager.run("detail-player", {
      prepare: async (transition) => {
        setPlaybackNotice(t("home.status.preparingPlayer", {
          title: track.title,
        }));
        await Promise.race([
          prewarmImmersivePlayback(track, {
            theme,
            space: "music",
          }),
          transition.wait(1_200),
        ]);
        if (transition.signal.aborted) {
          return;
        }
      },
      animate: async (transition) => {
        // Dispatch the prepared player and yield the source surface in the
        // same React batch. The former ordering hid the wall card before the
        // TransitionManager paint boundary and could expose an empty source
        // frame before SharpCoverPlane mounted.
        const request = requestImmersivePlaybackImmediately(
          immediateTrack,
          source,
          origin,
          track.lyrics.length > 0 ? "ready" : "loading",
          queueSeed,
          providerId,
          startPositionMs,
        );
        setIsPlayerTransitioning(true);
        setPlaybackNotice(t("home.status.enteringPlayer", {
          title: track.title,
        }));

        if (noticeTimerRef.current !== null) {
          window.clearTimeout(noticeTimerRef.current);
        }
        noticeTimerRef.current = window.setTimeout(() => {
          setPlaybackNotice("");
        }, 1_800);

        await waitForImmersivePlaybackPhase(
          request.requestId,
          "active",
          transition.signal,
        );
      },
      complete: () => {
        setPlaybackNotice("");
      },
    }, {
      signal: transitionAbort.signal,
    }).then((result) => {
      if (playerTransitionAbortRef.current !== transitionAbort) {
        return;
      }
      playerTransitionAbortRef.current = null;
      if (result.status === "cancelled") {
        const playerIsPresent = Boolean(
          document.querySelector(
            '.immersive-player[data-presence="open"]',
          ),
        );
        if (!playerIsPresent) {
          playerTransitionPendingRef.current = false;
          setIsPlayerTransitioning(false);
        }
      }
    }).catch((error) => {
      if (playerTransitionAbortRef.current !== transitionAbort) {
        return;
      }
      playerTransitionAbortRef.current = null;
      playerTransitionPendingRef.current = false;
      setIsPlayerTransitioning(false);
      setPlaybackNotice(
        error instanceof Error ? error.message : String(error),
      );
    });
  }, [
    isPlayerTransitioning,
    musicProvider,
    playbackPrefetchService,
    providerId,
    t,
  ]);

  const openDetail = async () => {
    const centralSlot = centralCoverRef.current?.closest<HTMLElement>(
      ".library-home__cover-slot[data-track-offset]",
    );
    const centralFocusScore = Number(
      centralSlot
        ? carouselSlotVisualsRef.current.get(centralSlot)?.focusScore
          ?? centralSlot.dataset.focusScore
          ?? 0
        : 0,
    );
    if (
      phase !== "library"
      || detailViewRef.current !== "browsing"
      || isCollectionLoadingRef.current
      || spaceTransitionPendingRef.current
      || carouselMotionStateRef.current !== "idle"
      || pendingCarouselRebaseRef.current
      || Math.abs(trackOffsetRef.current) > 0.01
      || targetIndexRef.current !== 0
      || snapTargetRef.current !== 0
      || centralFocusScore < 0.985
    ) {
      return;
    }

    const activeKey = activeCollection
      ? collectionTrackCacheKey(activeCollection)
      : null;
    const pendingIntent = pendingWallOpenIntentRef.current;
    const stagedIntent = pendingIntent
        && !pendingIntent.cancelled
        && pendingIntent.generation === libraryGenerationRef.current
        && pendingIntent.collectionKey === activeKey
      ? pendingIntent
      : null;
    const requestedCollection = stagedIntent?.collection ?? activeCollection;
    const requestedCoverTrack = stagedIntent?.coverTrack ?? centralTrack;
    const pendingCoverBounds =
      stagedIntent?.coverBounds ?? pendingPortalBoundsRef.current;
    if (!pendingCoverBounds) {
      noteHomeWallLayoutRead("central-cover-bounds");
    }
    const coverBounds =
      pendingCoverBounds
      ?? centralCoverRef.current?.getBoundingClientRect();

    if (
      !requestedCollection
      || !requestedCoverTrack
      || !coverBounds
      || coverBounds.width === 0
    ) {
      return;
    }

    const requestId = wallPreparationRequestRef.current + 1;
    wallPreparationRequestRef.current = requestId;
    const generation = libraryGenerationRef.current;
    spaceTransitionAbortRef.current?.abort("Space transition superseded");
    const transitionAbort = new AbortController();
    spaceTransitionAbortRef.current = transitionAbort;
    spaceTransitionPendingRef.current = true;
    const preparationWasCached = wallPreparationCacheRef.current.has(
      wallPreparationKey(requestedCollection),
    );
    lastWallPreparationWasCachedRef.current = preparationWasCached;
    beginHomeWallTransitionTrace("home-wall", preparationWasCached);
    markHomeWallTransitionPhase("prepare-start");
    // Keep the shelf's compositor state intact while an uncached collection
    // finishes preparing. Locking and dimming it here made a normal async wait
    // look like a dropped frame; the actual spatial lock now begins only with
    // the already-painted prepared frame.
    isCollectionLoadingRef.current = true;

    try {
      const result = await transitionManager.run("home-wall", {
        prepare: async (transition) => {
          const prepared = await (
            stagedIntent?.shellReadyPromise
            ?? prepareWallCollection(
              requestedCollection,
              requestedCoverTrack,
              playlistTracks,
              {
                signal: transition.signal,
                generation,
                coverArtIndex: centralCarouselCard?.artIndex ?? 0,
              },
            )
          );
          if (
            transition.signal.aborted
            || generation !== libraryGenerationRef.current
          ) {
            return;
          }
          if (!prepared) {
            throw new Error(t("home.error.emptyCollection"));
          }

          if (
            wallPreparationRequestRef.current !== requestId
            || activeCollectionKeyRef.current
              !== collectionTrackCacheKey(requestedCollection)
            || detailViewRef.current !== "browsing"
          ) {
            transitionAbort.abort("Wall preparation became stale");
            return;
          }

          if (!captureHomeSnapshot()) {
            throw new Error(t("home.error.snapshot"));
          }
          markHomeWallTransitionPhase("home-snapshot-captured");

          centralCoverRef.current?.blur();
          setPlaybackNotice("");
          isWallPanelOpenRef.current = false;
          const nextPortalGeometry = stagedIntent?.portalGeometry
            ?? calculateCoverPortalGeometry(coverBounds);
          if (preparedWallRef.current !== prepared) {
            preparedWallRef.current = prepared;
            setPreparedWall(prepared);
          }
          if (!coverPortalGeometryMatches(
            portalGeometryRef.current,
            nextPortalGeometry,
          )) {
            portalGeometryRef.current = nextPortalGeometry;
            setPortalGeometry(nextPortalGeometry);
          }
          setDetailView("prepared");
          markHomeWallTransitionPhase("prepared-state-committed");
        },
        animate: async (transition) => {
          // The collection cover dissolves into an ambient/directory medium.
          // Track cards form independently at their final wall coordinates;
          // no track owns or receives the collection artwork.
          markHomeWallTransitionPhase("ambient-medium-ready");
          // Keep the compositor-authored click lock until the Portal has
          // covered Home. Releasing it here made the 420ms press response run
          // backwards underneath the first 200ms of the opening timeline.
          pendingPortalBoundsRef.current = null;
          setDetailView("opening");
          const openingStartedAt = performance.now();
          markHomeWallTransitionPhase("opening-state-requested");
          // The TransitionManager has already presented the prepared frame.
          // Attach the master-clock listener immediately after dispatching the
          // opening state so the reversible press pose keeps its momentum; a
          // second paint barrier here used to create a visible restart.
          markHomeWallTransitionPhase("animate-start");
          if (homeWallDiagnosticsEnabled()) {
            noteHomeWallTransitionMetric(
              "portal-participant-count",
              portalLayerRef.current?.querySelectorAll(
                '.music-wall__card-slot[data-portal-participant="true"]',
              ).length ?? 0,
            );
            noteHomeWallTransitionMetric(
              "portal-pool-count",
              portalLayerRef.current?.querySelectorAll(
                ".music-wall__card-slot",
              ).length ?? 0,
            );
          }
          const visualSampleTasks = homeWallDiagnosticsEnabled()
            ? ([
                0.1,
                homeWallMotion.mediumOwnsViewportProgress,
                0.36,
                homeWallMotion.wallReadableProgress,
                0.52,
                0.72,
                homeWallMotion.stableCommitProgress,
              ] as const).map(
                (progress) => transition.wait(
                  Math.max(
                    0,
                    openingStartedAt + wallOpenDuration * progress
                      - performance.now(),
                  ),
                ).then(() => {
                  captureHomeWallVisualSample(
                    `opening-${Math.round(progress * 100)}-percent`,
                    libraryRootRef.current,
                  );
                }).catch(() => undefined),
              )
            : [];
          await waitForNamedAnimation(
            portalLayerRef.current,
            "cover-portal-expand",
            wallOpenDuration,
            transition.signal,
          );
          await Promise.all(visualSampleTasks);
          // Hold the composited final pose for two paints before replacing the
          // coarse portal phase. The detail commit is therefore state-only and
          // cannot become a second visual step.
          await transition.afterPaint(2);
          if (homeWallDiagnosticsEnabled()) {
            captureHomeWallVisualSample(
              "opening-stable-before-commit",
              libraryRootRef.current,
            );
          }
          markHomeWallTransitionPhase("master-animation-ended");
        },
        complete: () => {
          setDetailView("detail");
          markHomeWallTransitionPhase("detail-state-committed");
          motionController.afterPaint(() => {
            markHomeWallTransitionPhase("detail-painted");
            finishHomeWallTransitionTrace();
          }, 2);
        },
      }, {
        signal: transitionAbort.signal,
      });

      if (
        result.status === "cancelled"
        && generation === libraryGenerationRef.current
        && spaceTransitionAbortRef.current === transitionAbort
      ) {
        setDetailView("browsing");
        setIsWallLocking(false);
        isWallPanelOpenRef.current = false;
        finishHomeWallTransitionTrace("cancelled");
      }
    } catch (error) {
      if (spaceTransitionAbortRef.current === transitionAbort) {
        setIsWallLocking(false);
        setPlaybackNotice(
          error instanceof Error ? error.message : String(error),
        );
        finishHomeWallTransitionTrace("error");
      }
    } finally {
      if (spaceTransitionAbortRef.current === transitionAbort) {
        spaceTransitionAbortRef.current = null;
        spaceTransitionPendingRef.current = false;
      }
      if (
        wallPreparationRequestRef.current === requestId
        && generation === libraryGenerationRef.current
      ) {
        isCollectionLoadingRef.current = false;
        coversRef.current?.setAttribute("data-click-pending", "false");
        pendingPortalBoundsRef.current = null;
      }
      if (pendingWallOpenIntentRef.current === stagedIntent) {
        pendingWallOpenIntentRef.current = null;
      }
    }
  };

  const closeDetail = (
    wallReturnPreparation: MusicWallReturnPreparation,
    restoreKeyboardFocus = false,
  ) => {
    if (detailView !== "detail" || spaceTransitionPendingRef.current) {
      return false;
    }
    const snapshot = homeSnapshotRef.current;
    if (
      !snapshot
      || snapshot.section !== activeSection
      || snapshot.collectionId !== activeCollection?.id
    ) {
      setPlaybackNotice(t("home.error.restore"));
      return false;
    }

    spaceTransitionAbortRef.current?.abort("Space transition superseded");
    const transitionAbort = new AbortController();
    spaceTransitionAbortRef.current = transitionAbort;
    spaceTransitionPendingRef.current = true;
    const returnOrdinal = ++wallReturnCountRef.current;
    beginHomeWallTransitionTrace(
      "wall-home",
      lastWallPreparationWasCachedRef.current,
    );
    noteHomeWallTransitionMetric("wall-return-ordinal", returnOrdinal);
    noteHomeWallTransitionMetric(
      "wall-return-capture-lead-ms",
      performance.now() - wallReturnPreparation.capturedAt,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-before-home-restore",
      true,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-offset",
      wallReturnPreparation.renderedOffset,
    );
    noteHomeWallTransitionMetric(
      "wall-return-resolved-offset",
      wallReturnPreparation.resolvedOffset,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-transform",
      wallReturnPreparation.wallTransform,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-column-shift",
      wallReturnPreparation.wallColumnShift,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-speed",
      wallReturnPreparation.initialSpeed,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-participant-count",
      wallReturnPreparation.participantSlots.length,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-motion-state",
      wallReturnPreparation.motionState,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-auto-running",
      wallReturnPreparation.automaticWasRunning,
    );
    noteHomeWallTransitionMetric(
      "wall-return-captured-pending-rebase",
      Boolean(wallReturnPreparation.pendingColumnRebase),
    );
    markHomeWallTransitionPhase("prepare-start");
    let closingStartedAt = 0;
    const setReturnVisualOwner = (
      owner: "wall" | "medium" | "home",
    ) => {
      if (libraryRootRef.current) {
        libraryRootRef.current.dataset.returnVisualOwner = owner;
      }
      markHomeWallTransitionPhase(`return-visual-owner-${owner}`);
    };
    void transitionManager.run("wall-home", {
      prepare: () => {
        isWallPanelOpenRef.current = false;
        setReturnVisualOwner("wall");
        markHomeWallTransitionPhase("ambient-return-ready");
        // Any index correction is committed while the opaque Wall still owns
        // the frame. Snapshot application then targets the final shelf DOM,
        // leaving the eventual browsing commit free of geometry work.
        let indexCorrected = false;
        flushSync(() => {
          if (snapshot.searchActive) {
            if (searchCarouselIndex !== snapshot.activeIndex) {
              setSearchCarouselIndex(snapshot.activeIndex);
              indexCorrected = true;
            }
          } else if (
            carouselIndexes[snapshot.section] !== snapshot.activeIndex
          ) {
            setCarouselIndexes((current) => ({
              ...current,
              [snapshot.section]: snapshot.activeIndex,
            }));
            indexCorrected = true;
          }
        });
        noteHomeWallTransitionMetric(
          "wall-return-index-corrected-in-prepare",
          indexCorrected,
        );
        // Restore the exact shelf pose while it is still fully covered by the
        // portal. The first pixel revealed by the shrinking shell therefore
        // already has the saved focus, luminance and transform.
        returnSnapshotRestoredRef.current =
          restoreHomeSnapshotRef.current();
        markHomeWallTransitionPhase(
          returnSnapshotRestoredRef.current
            ? "home-snapshot-restored"
            : "home-snapshot-missing",
        );
        if (!returnSnapshotRestoredRef.current) {
          throw new Error("Home snapshot could not be restored");
        }
        // Capture, hidden Home restoration and the closing coarse-state commit
        // live in one input task. MusicWall has already started braking from
        // the captured speed; this flush only exposes the matching compositor
        // timeline and never samples or restarts wall motion.
        flushSync(() => setDetailView("closing"));
        markHomeWallTransitionPhase("closing-state-committed");
      },
      animate: async (transition) => {
        const closingAnimationElapsed = await waitForNamedAnimationStart(
          portalLayerRef.current,
          "cover-portal-collapse",
          transition.signal,
        );
        closingStartedAt = performance.now() - closingAnimationElapsed;
        markHomeWallTransitionPhase("animate-start");
        const ownerTask = (async () => {
          await transition.wait(Math.max(
            0,
            closingStartedAt
              + detailCloseDuration
                * homeWallMotion.wallHiddenOnReturnProgress
              - performance.now(),
          ));
          setReturnVisualOwner("medium");
          await transition.wait(Math.max(
            0,
            closingStartedAt
              + detailCloseDuration
                * homeWallMotion.sharedCoverHandoffProgress
              - performance.now(),
          ));
          setReturnVisualOwner("home");
        })();
        const visualSampleTasks = homeWallDiagnosticsEnabled()
          ? ([
              { progress: 0.02, name: "closing-2-percent" },
              { progress: 0.12, name: "closing-12-percent" },
              {
                progress: homeWallMotion.wallHiddenOnReturnProgress,
                name: "closing-46-percent",
              },
              {
                progress: homeWallMotion.homeRevealProgress,
                name: "closing-52-percent",
              },
              { progress: 0.82, name: "closing-82-percent" },
              { progress: 0.935, name: "closing-93-5-percent" },
              {
                progress: homeWallMotion.sharedCoverHandoffProgress,
                name: "closing-94-percent",
              },
              { progress: 0.941, name: "closing-94-1-percent" },
              {
                progress: homeWallMotion.stableCommitProgress,
                name: "closing-97-percent",
              },
            ] as const).map(({ progress, name }) => {
              const targetAt = closingStartedAt
                + detailCloseDuration * progress;
              return transition.wait(
                Math.max(0, targetAt - performance.now()),
              ).then(() => {
                captureHomeWallVisualSample(
                  name,
                  libraryRootRef.current,
                );
                captureHomeWallGeometrySample(
                  name,
                  libraryRootRef.current,
                );
              }).catch(() => undefined);
            })
          : [];
        if (homeWallDiagnosticsEnabled()) {
          captureHomeWallVisualSample(
            "closing-0-percent",
            libraryRootRef.current,
          );
          captureHomeWallGeometrySample(
            "closing-0-percent",
            libraryRootRef.current,
          );
        }
        await waitForNamedAnimation(
          portalLayerRef.current,
          "cover-portal-collapse",
          detailCloseDuration,
          transition.signal,
        );
        await Promise.all([ownerTask, ...visualSampleTasks]);
        // The shared cover has already handed ownership to the restored Home
        // cover. Keep that exact final pose for two paints before browsing is
        // committed so no residual Wall layer disappears on the commit frame.
        await transition.afterPaint(1);
        if (homeWallDiagnosticsEnabled()) {
          captureHomeWallVisualSample(
            "visual-home-settled-paint-1",
            libraryRootRef.current,
          );
          captureHomeWallGeometrySample(
            "visual-home-settled-paint-1",
            libraryRootRef.current,
          );
        }
        await transition.afterPaint(1);
        if (homeWallDiagnosticsEnabled()) {
          captureHomeWallVisualSample(
            "visual-home-settled-paint-2",
            libraryRootRef.current,
          );
          captureHomeWallGeometrySample(
            "visual-home-settled-paint-2",
            libraryRootRef.current,
          );
        }
        markHomeWallTransitionPhase("master-animation-ended");
      },
      complete: () => {
        const finalFlushStartedAt = performance.now();
        flushSync(() => {
          setDetailView("browsing");
        });
        noteHomeWallTransitionMetric(
          "final-flush-sync-ms",
          performance.now() - finalFlushStartedAt,
        );
        markHomeWallTransitionPhase("browsing-state-committed");
        if (homeWallDiagnosticsEnabled()) {
          captureHomeWallVisualSample(
            "browsing-commit",
            libraryRootRef.current,
          );
          captureHomeWallGeometrySample(
            "browsing-commit",
            libraryRootRef.current,
          );
        }
        motionController.afterPaint(() => {
          if (homeWallDiagnosticsEnabled()) {
            captureHomeWallVisualSample(
              "browsing-paint-1",
              libraryRootRef.current,
            );
            captureHomeWallGeometrySample(
              "browsing-paint-1",
              libraryRootRef.current,
            );
          }
          motionController.afterPaint(() => {
            if (homeWallDiagnosticsEnabled()) {
              captureHomeWallVisualSample(
                "browsing-paint-2",
                libraryRootRef.current,
              );
              captureHomeWallGeometrySample(
                "browsing-paint-2",
                libraryRootRef.current,
              );
            }
            libraryRootRef.current?.removeAttribute(
              "data-return-visual-owner",
            );
            finishHomeWallTransitionTrace();
          }, 1);
        }, 1);

        if (restoreKeyboardFocus) {
          motionController.afterPaint(() => {
            centralCoverRef.current?.focus();
          });
        }
      },
    }, {
      signal: transitionAbort.signal,
    }).then((result) => {
      if (
        result.status === "cancelled"
        && spaceTransitionAbortRef.current === transitionAbort
      ) {
        libraryRootRef.current?.removeAttribute(
          "data-return-visual-owner",
        );
        returnSnapshotRestoredRef.current = false;
        setDetailView("detail");
        finishHomeWallTransitionTrace("cancelled");
      }
    }).catch((error) => {
      if (spaceTransitionAbortRef.current === transitionAbort) {
        libraryRootRef.current?.removeAttribute(
          "data-return-visual-owner",
        );
        returnSnapshotRestoredRef.current = false;
        setDetailView("detail");
        setPlaybackNotice(
          error instanceof Error ? error.message : String(error),
        );
        finishHomeWallTransitionTrace("error");
      }
    }).finally(() => {
      if (spaceTransitionAbortRef.current === transitionAbort) {
        spaceTransitionAbortRef.current = null;
        spaceTransitionPendingRef.current = false;
      }
    });
    return true;
  };
  useLayoutEffect(() => {
    closeDetailRef.current = closeDetail;
  });
  const handleWallExit = useCallback((
    preparation: MusicWallReturnPreparation,
    restoreKeyboardFocus = false,
  ) => {
    return closeDetailRef.current(preparation, restoreKeyboardFocus);
  }, []);
  const handleWallExitControllerChange = useCallback((
    controller: ((restoreKeyboardFocus?: boolean) => boolean) | null,
  ) => {
    wallExitControllerRef.current = controller;
  }, []);
  const requestWallExit = useCallback((restoreKeyboardFocus = false) => {
    const controller = wallExitControllerRef.current;
    if (controller) {
      return controller(restoreKeyboardFocus);
    }
    // A return without a mounted Wall controller cannot capture the live
    // offset, speed and participant pool. Refuse it instead of restoring Home
    // first and manufacturing a stale closing pose.
    return false;
  }, []);
  const handleWallPanelStateChange = useCallback((isOpen: boolean) => {
    isWallPanelOpenRef.current = isOpen;
  }, []);

  const handleCentralClick = (
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    if (event.detail === 0) {
      return;
    }
    if (event.detail > 1) {
      return;
    }

    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
    }
    if (pendingWallOpenIntentRef.current) {
      pendingWallOpenIntentRef.current.cancelled = true;
    }
    pendingWallOpenIntentRef.current = null;

    beginHomeWallTransitionTrace(
      "home-wall",
      Boolean(
        activeCollection
        && wallPreparationCacheRef.current.has(
          wallPreparationKey(activeCollection),
        )
      ),
    );
    noteHomeWallTransitionMetric(
      "portal-shell-mounted-at-click",
      Boolean(portalLayerRef.current),
    );
    noteHomeWallTransitionMetric(
      "portal-shell-matches-collection-at-click",
      preparedWallRef.current?.collectionKey
        === activeCollectionKeyRef.current,
    );

    // Read the stable browsing geometry before click feedback scales the
    // focused cover. Measuring afterwards made the Portal wrapper 1.8% larger
    // than the Home cover and forced a size jump on the closing commit.
    noteHomeWallLayoutRead("central-cover-bounds");
    pendingPortalBoundsRef.current =
      centralCoverRef.current?.getBoundingClientRect() ?? null;

    // Give the focused surface compositor feedback immediately without
    // disabling pointer events; the second click must still be able to form a
    // double-click. React state remains untouched until the action is known.
    coversRef.current?.setAttribute("data-click-pending", "true");
    markHomeWallTransitionPhase("click-feedback");
    const pendingBounds = pendingPortalBoundsRef.current;
    if (activeCollection && centralTrack && pendingBounds) {
      const intent = stageWallOpenIntent(
        activeCollection,
        centralTrack,
        centralCarouselCard?.artIndex ?? 0,
        playlistTracks,
        pendingBounds,
      );
      void intent.shellReadyPromise.catch(() => {
        // The disambiguated single-click path reports provider errors.
      });
    }

    clickTimerRef.current = window.setTimeout(() => {
      void openDetail().finally(() => {
        coversRef.current?.removeAttribute("data-click-pending");
        pendingPortalBoundsRef.current = null;
      });
      clickTimerRef.current = null;
    }, homeWallMotion.clickDecisionDuration);
  };

  const handleCentralDoubleClick = (
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();

    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      event.currentTarget.dataset.clickPending = "false";
      pendingPortalBoundsRef.current = null;
      finishHomeWallTransitionTrace("double-click-playback");
    }
    if (pendingWallOpenIntentRef.current) {
      pendingWallOpenIntentRef.current.cancelled = true;
    }
    pendingWallOpenIntentRef.current = null;
    coversRef.current?.removeAttribute("data-click-pending");
    pendingPortalBoundsRef.current = null;

    const firstTrack = playlistTracks[0];
    if (firstTrack) {
      requestPlayback(
        firstTrack,
        "cover-double-click",
        undefined,
        activeCollectionQueueSeed,
      );
    }
  };

  const handleCentralKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void openDetail();
    }

    if (
      event.code === "Space" ||
      event.key === " " ||
      event.key === "Spacebar"
    ) {
      event.preventDefault();
      const firstTrack = playlistTracks[0];
      if (firstTrack) {
        requestPlayback(
          firstTrack,
          "cover-space",
          undefined,
          activeCollectionQueueSeed,
        );
      }
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      shiftCarousel("previous");
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      shiftCarousel("next");
    }
  };

  const handleSideKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    direction: CarouselDirection,
  ) => {
    if (
      event.key === "Enter" ||
      event.code === "Space" ||
      event.key === " "
    ) {
      event.preventDefault();
      shiftCarousel(direction);
    }
  };

  const handleCarouselClick = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const slot = target.closest<HTMLElement>(
      ".library-home__cover-slot[data-track-offset]",
    );
    if (!slot || !event.currentTarget.contains(slot)) {
      return;
    }

    const offset = Number(slot.dataset.trackOffset);
    if (offset === -1 || offset === 1) {
      shiftCarousel(offset === -1 ? "previous" : "next");
    }
  };

  const commitCarouselIndex = useCallback(
    (delta: number) => {
      const travelDelta = normalizeCarouselTravel(delta);
      if (travelDelta === 0) {
        return false;
      }

      if (isSearchActive) {
        setSearchCarouselIndex((currentIndex) =>
          advanceCarouselLogicalIndex(
            currentIndex,
            travelDelta,
          )
        );
      } else {
        setCarouselIndexes((currentIndexes) => ({
          ...currentIndexes,
          [activeSection]: advanceCarouselLogicalIndex(
            currentIndexes[activeSection],
            travelDelta,
          ),
        }));
      }
      return true;
    },
    [
      activeSection,
      isSearchActive,
    ],
  );

  const renderCarousel = useCallback((offset: number) => {
    incrementHomeWallTransitionCounter("render-carousel-calls");
    const {
      step,
      trackCenterX,
      viewportCenterX,
    } = carouselMetricsRef.current;
    if (step <= 0) {
      return;
    }

    for (const slot of carouselSlotsRef.current) {
      const slotOffset = Number(slot.dataset.trackOffset ?? 0);
      const relative = slotOffset + offset / step;
      const distance = Math.abs(relative);
      const zone =
        distance > 2.45
          ? relative < 0 ? "far-left" : "far-right"
          : "near";
      // Keep buffered cards at their real off-screen positions. Clamping all
      // far cards onto the same edge stacked dozens of transparent images on
      // one compositor tile and encouraged their lazy images to decode at
      // once during a gesture.
      const visualRelative = relative;
      const visualDistance = Math.abs(visualRelative);
      // Focus is a continuous spatial measurement rather than a React index.
      // The track's center is cached on resize, so no layout reads occur here.
      const cardCenterX = trackCenterX + relative * step;
      const y = 0;
      const centerDistance = Math.abs(cardCenterX - viewportCenterX);
      const focusScore = Math.max(
        0,
        Math.min(1, 1 - centerDistance / step),
      );
      const scale = 0.78 + focusScore * 0.22;
      const focusOpacity = 0.52 + focusScore * 0.48;
      const edgeEnvelope =
        zone === "near"
          ? visualDistance <= 1.35
            ? 1
            : Math.max(0, 1 - (visualDistance - 1.35) / 1.1)
          : 0;
      const opacity = focusOpacity * edgeEnvelope;
      const x = visualRelative * step;
      const depth = -Math.min(120, visualDistance * 54);
      const semanticPosition = positionForOffset(Math.round(relative));
      const nextVisual = {
        transform:
          `translate3d(calc(-50% + ${x.toFixed(2)}px), `
          + `calc(-50% + ${y.toFixed(2)}px), ${depth.toFixed(2)}px) `
          + `scale(${scale.toFixed(4)})`,
        opacity: opacity.toFixed(3),
        // Opacity already supplies the focus falloff. Keep the additional
        // luminance veil restrained so an adjacent cover still reads at
        // roughly half brightness instead of being dimmed twice.
        dim: (0.08 * (1 - focusScore)).toFixed(3),
        // Image filters are deliberately static. The grayscale hierarchy is
        // expressed by compositor-friendly slot opacity plus the art veil.
        brightness: "1",
        blur: "0px",
        focused: focusScore >= 0.985 ? "true" : "false",
        focusScore: focusScore.toFixed(3),
        focusLayer:
          focusScore >= 0.75
            ? "3"
            : focusScore >= 0.35
              ? "2"
              : edgeEnvelope > 0
                ? "1"
                : "0",
        position: semanticPosition,
        zone,
      } as const;
      const previousVisual = carouselSlotVisualsRef.current.get(slot);

      if (previousVisual?.transform !== nextVisual.transform) {
        slot.style.transform = nextVisual.transform;
      }
      if (previousVisual?.opacity !== nextVisual.opacity) {
        slot.style.opacity = nextVisual.opacity;
      }
      if (previousVisual?.dim !== nextVisual.dim) {
        slot.style.setProperty("--track-dim", nextVisual.dim);
      }
      if (previousVisual?.brightness !== nextVisual.brightness) {
        slot.style.setProperty(
          "--track-brightness",
          nextVisual.brightness,
        );
      }
      if (previousVisual?.blur !== nextVisual.blur) {
        slot.style.setProperty("--track-blur", nextVisual.blur);
      }
      if (previousVisual?.focused !== nextVisual.focused) {
        slot.dataset.focused = nextVisual.focused;
      }
      if (previousVisual?.focusLayer !== nextVisual.focusLayer) {
        slot.dataset.focusLayer = nextVisual.focusLayer;
      }
      if (previousVisual?.focusScore !== nextVisual.focusScore) {
        slot.dataset.focusScore = nextVisual.focusScore;
      }
      if (previousVisual?.position !== nextVisual.position) {
        slot.dataset.position = nextVisual.position;
        const cover = carouselCoverElementsRef.current.get(slot);
        if (cover) {
          cover.dataset.position = nextVisual.position;
        }
      }
      carouselSlotVisualsRef.current.set(slot, nextVisual);
    }
  }, []);

  useLayoutEffect(() => {
    coversRef.current = shelfTrackRefs.current[activeShelfPlaneId];
  }, [activeShelfPlaneId]);

  useLayoutEffect(() => {
    const covers = coversRef.current;
    if (!covers) {
      return;
    }

    const committedPose = categoryCommitPoseRef.current;
    if (
      committedPose?.planeId === activeShelfPlaneId
      && committedPose.contextKey === carouselContextKey
    ) {
      carouselSlotsRef.current = committedPose.slots;
      carouselCoverElementsRef.current = committedPose.covers;
      carouselSlotVisualsRef.current = committedPose.visuals;
      renderCarouselRef.current = renderCarousel;
      renderedCarouselContextRef.current = carouselContextKey;
      pendingCarouselRebaseRef.current = false;
      covers.dataset.dragging = "false";
      covers.dataset.moving = "false";
      covers.style.setProperty("--carousel-drag-x", "0px");
      categoryCommitPoseRef.current = null;
      markCategoryTransitionPhase("commit-pose-adopted");
      return;
    }

    const contextChanged =
      renderedCarouselContextRef.current !== carouselContextKey;
    const mustRebase =
      contextChanged || pendingCarouselRebaseRef.current;
    if (contextChanged) {
      renderedCarouselContextRef.current = carouselContextKey;
    }

    carouselSlotsRef.current = Array.from(
      covers.querySelectorAll<HTMLElement>(
        ".library-home__cover-slot[data-track-offset]",
      ),
    );
    if (categoryTransitionPhaseRef.current === "commit") {
      markCategoryTransitionPhase("commit-pose-fallback");
      noteCategoryTransitionDomScan(
        "commit-fallback-slots",
        carouselSlotsRef.current.length,
      );
    }
    carouselCoverElementsRef.current = new WeakMap();
    for (const slot of carouselSlotsRef.current) {
      const cover = slot.querySelector<HTMLElement>(".magazine-cover");
      if (cover) {
        carouselCoverElementsRef.current.set(slot, cover);
      }
    }
    carouselSlotVisualsRef.current = new WeakMap();
    renderCarouselRef.current = renderCarousel;
    if (mustRebase) {
      stopCarouselAnimation();
      pendingCarouselRebaseRef.current = false;
      trackOffsetRef.current = 0;
      targetIndexRef.current = 0;
      snapTargetRef.current = 0;
      gestureOriginRef.current = 0;
      lastWheelInputAtRef.current = 0;
      covers.dataset.dragging = "false";
      covers.dataset.moving = "false";
      covers.style.setProperty("--carousel-drag-x", "0px");
      renderCarousel(0);
      return;
    }

    renderCarousel(trackOffsetRef.current);
  }, [
    carouselCards,
    carouselContextKey,
    activeShelfPlaneId,
    renderCarousel,
    stopCarouselAnimation,
    playbackPrefetchService,
  ]);

  useLayoutEffect(() => {
    const returnedToBrowsing =
      previousDetailViewRef.current !== "browsing"
      && detailView === "browsing";
    previousDetailViewRef.current = detailView;

    if (returnedToBrowsing) {
      const snapshotAlreadyRestored = returnSnapshotRestoredRef.current;
      returnSnapshotRestoredRef.current = false;
      if (
        snapshotAlreadyRestored
        || restoreHomeSnapshotRef.current()
      ) {
        const snapshot = homeSnapshotRef.current;
        motionController.afterPaint(() => {
          if (homeSnapshotRef.current === snapshot) {
            homeSnapshotRef.current = null;
          }
        }, 2);
        return;
      }
    }

  }, [
    activeCollection?.id,
    activeSection,
    carouselCards,
    detailView,
    renderCarousel,
  ]);

  const handleCarouselPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (
      event.pointerType !== "mouse"
      || event.button !== 1
      || phase !== "library"
      || detailView !== "browsing"
      || categoryTransitionPhaseRef.current !== "idle"
      || pendingCarouselRebaseRef.current
      || carouselCatalog.length < 2
      || isCollectionLoadingRef.current
      || isPlayerTransitioning
    ) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    carouselMotionStateRef.current = "input";
    isCarouselDraggingRef.current = true;
    gestureOriginRef.current = trackOffsetRef.current;
    gestureMaximumStepsRef.current = carouselMotion.dragMaximumSteps;
    carouselDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      currentX: event.clientX,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
      moved: false,
    };
    event.currentTarget.dataset.dragging = "true";
    event.currentTarget.dataset.moving = "true";
    startCarouselMotionRef.current();

    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      event.currentTarget.dataset.clickPending = "false";
      pendingPortalBoundsRef.current = null;
    }
  };

  const finishCarouselDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const drag = carouselDragRef.current;
    if (drag.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    carouselDragRef.current.pointerId = -1;
    isCarouselDraggingRef.current = false;
    event.currentTarget.dataset.dragging = "false";
    carouselVelocityRef.current =
      cancelled || prefersReducedMotion ? 0 : drag.velocity;
    carouselMotionStateRef.current =
      Math.abs(carouselVelocityRef.current) > carouselMotion.settleVelocity
        ? "inertia"
        : "snapping";
    if (carouselMotionStateRef.current === "snapping") {
      targetIndexRef.current = Math.round(
        -trackOffsetRef.current / carouselMetricsRef.current.step,
      );
      snapTargetRef.current =
        -targetIndexRef.current * carouselMetricsRef.current.step;
    }
  };

  useEffect(() => {
    const covers = coversRef.current;
    if (!covers) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const drag = carouselDragRef.current;
      if (drag.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
      const movement = event.clientX - drag.lastX;
      drag.currentX = event.clientX;
      drag.velocity =
        drag.velocity * 0.58 + movement / elapsed * 1_000 * 0.42;
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
      drag.moved ||= Math.abs(event.clientX - drag.startX) > 4;
      const maximum =
        carouselMetricsRef.current.step * carouselMotion.dragMaximumSteps;
      trackOffsetRef.current = Math.max(
        -maximum,
        Math.min(
          maximum,
          gestureOriginRef.current + event.clientX - drag.startX,
        ),
      );
      preloadCarouselDeltaRef.current(
        Math.round(
          -trackOffsetRef.current / carouselMetricsRef.current.step,
        ),
        3,
      );
    };

    covers.addEventListener("pointermove", handlePointerMove, {
      passive: false,
    });
    return () => covers.removeEventListener("pointermove", handlePointerMove);
  }, [activeShelfPlaneId]);

  useLayoutEffect(() => {
    // Both A/B tracks share the same fixed geometry. Observe plane A as a
    // stable measurement surface instead of reading layout and rebuilding a
    // ResizeObserver every time visual ownership changes planes.
    const metricSurface = shelfTrackRefs.current.a ?? coversRef.current;
    if (!metricSurface) {
      return;
    }

    let resizeFrame = 0;
    const updateCarouselMetrics = () => {
      const bounds = metricSurface.getBoundingClientRect();
      carouselMetricsRef.current.step = Math.round(
        Math.max(330, Math.min(window.innerWidth * 0.36, 520)),
      );
      carouselMetricsRef.current.islandLift = 0;
      carouselMetricsRef.current.trackCenterX =
        bounds.left + bounds.width / 2;
      carouselMetricsRef.current.viewportCenterX = window.innerWidth / 2;
      renderCarouselRef.current(trackOffsetRef.current);
    };
    const measureCarousel = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(updateCarouselMetrics);
    };

    // Establish the final track geometry before the browser's first paint.
    updateCarouselMetrics();
    const resizeObserver = new ResizeObserver(() => {
      incrementHomeWallTransitionCounter("resize-observer-callbacks");
      measureCarousel();
    });
    resizeObserver.observe(metricSurface);
    window.addEventListener("resize", measureCarousel);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureCarousel);
      window.cancelAnimationFrame(resizeFrame);
    };
  }, [library]);

  useEffect(() => {
    const covers = coversRef.current;
    if (!covers) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (
        phase !== "library"
        || detailView !== "browsing"
        || categoryTransitionPhaseRef.current !== "idle"
        || pendingCarouselRebaseRef.current
        || carouselCatalog.length < 2
        || isCollectionLoadingRef.current
        || isPlayerTransitioning
      ) {
        return;
      }

      const rawDelta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? window.innerWidth
            : 1;
      const delta = rawDelta * unit;

      if (Math.abs(delta) < 0.5) {
        return;
      }

      event.preventDefault();
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
        covers.dataset.clickPending = "false";
        pendingPortalBoundsRef.current = null;
      }
      const now = performance.now();
      const timeSinceInput = now - lastWheelInputAtRef.current;
      const looksLikeTrackpad =
        event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        && (
          Math.abs(delta) < 56
          || Math.abs(delta % 1) > 0.01
        );
      if (carouselMotionStateRef.current === "idle") {
        gestureOriginRef.current = trackOffsetRef.current;
        gestureMaximumStepsRef.current = looksLikeTrackpad
          ? carouselMotion.trackpadMaximumSteps
          : carouselMotion.mouseMaximumSteps;
      }
      const pixelScale = looksLikeTrackpad
        ? carouselMotion.trackpadPixelScale
        : carouselMotion.wheelPixelScale;
      const maximumEventDelta = looksLikeTrackpad
        ? 140
        : carouselMetricsRef.current.step * 3.8 / pixelScale;
      const inputDelta =
        -Math.sign(delta)
        * Math.min(Math.abs(delta), maximumEventDelta)
        * pixelScale;
      const elapsed = Math.max(12, Math.min(80, timeSinceInput || 16));
      const instantVelocity = inputDelta / elapsed * 1_000;
      if (
        carouselVelocityRef.current !== 0
        && Math.sign(carouselVelocityRef.current)
          !== Math.sign(instantVelocity)
      ) {
        carouselVelocityRef.current *= 0.18;
      }
      carouselVelocityRef.current =
        carouselVelocityRef.current
          * (1 - carouselMotion.wheelVelocityGain)
        + instantVelocity * carouselMotion.wheelVelocityGain;
      const maximum =
        carouselMetricsRef.current.step * gestureMaximumStepsRef.current;
      trackOffsetRef.current = Math.max(
        -maximum,
        Math.min(
          maximum,
          trackOffsetRef.current + inputDelta,
        ),
      );
      const predictedDelta = Math.round(
        -trackOffsetRef.current / carouselMetricsRef.current.step,
      );
      preloadCarouselWindow(carouselIndex + predictedDelta, 3);
      lastWheelInputAtRef.current = now;
      carouselMotionStateRef.current = "input";
      covers.dataset.moving = "true";
      startCarouselMotionRef.current();
    };

    covers.addEventListener("wheel", handleWheel, { passive: false });
    return () => covers.removeEventListener("wheel", handleWheel);
  }, [
    carouselCatalog.length,
    activeShelfPlaneId,
    categoryTransition,
    detailView,
    isPlayerTransitioning,
    phase,
    carouselIndex,
    preloadCarouselWindow,
  ]);

  useEffect(() => {
    const renderFrame = (now: number, controllerDeltaMs: number) => {
      const elapsed = Math.min(40, Math.max(1, controllerDeltaMs));
      const frameScale = elapsed / 16.67;
      const motionState = carouselMotionStateRef.current;

      if (
        motionState === "input"
        && !isCarouselDraggingRef.current
        && now - lastWheelInputAtRef.current
          > carouselMotion.inputIdleMs
      ) {
        if (prefersReducedMotion) {
          targetIndexRef.current = Math.round(
            -trackOffsetRef.current / carouselMetricsRef.current.step,
          );
          snapTargetRef.current =
            -targetIndexRef.current * carouselMetricsRef.current.step;
          carouselMotionStateRef.current = "snapping";
        } else {
          carouselMotionStateRef.current = "inertia";
        }
      }

      if (carouselMotionStateRef.current === "inertia") {
        trackOffsetRef.current +=
          carouselVelocityRef.current * elapsed / 1_000;
        carouselVelocityRef.current *= Math.pow(
          carouselMotion.inertiaFriction,
          frameScale,
        );
        const maximum =
          carouselMetricsRef.current.step * gestureMaximumStepsRef.current;
        const minimumOffset = -maximum;
        const maximumOffset = maximum;
        if (trackOffsetRef.current < minimumOffset) {
          trackOffsetRef.current = minimumOffset;
          carouselVelocityRef.current = 0;
        } else if (trackOffsetRef.current > maximumOffset) {
          trackOffsetRef.current = maximumOffset;
          carouselVelocityRef.current = 0;
        }

        if (
          Math.abs(carouselVelocityRef.current)
            <= carouselMotion.settleVelocity
        ) {
          targetIndexRef.current = Math.round(
            -trackOffsetRef.current / carouselMetricsRef.current.step,
          );
          snapTargetRef.current =
            -targetIndexRef.current * carouselMetricsRef.current.step;
          carouselMotionStateRef.current = "snapping";
        }
      }

      if (carouselMotionStateRef.current === "snapping") {
        const distance =
          snapTargetRef.current - trackOffsetRef.current;
        const strength =
          1
          - Math.pow(
            1
              - carouselMotion.snapStrength
                * (1 - carouselMotion.snapDamping * 0.28),
            frameScale,
          );
        trackOffsetRef.current += distance * strength;
        carouselVelocityRef.current = 0;

        if (
          Math.abs(distance) <= carouselMotion.settleDistance
        ) {
          const committedDelta = targetIndexRef.current;
          const travelDelta = normalizeCarouselTravel(committedDelta);
          snapTargetRef.current = 0;
          targetIndexRef.current = 0;
          carouselVelocityRef.current = 0;
          carouselMotionStateRef.current = "idle";
          if (travelDelta === 0) {
            trackOffsetRef.current = 0;
            gestureOriginRef.current = 0;
            pendingCarouselRebaseRef.current = false;
            coversRef.current?.setAttribute("data-moving", "false");
          } else {
            // Paint the exact snap coordinate before React rebases the
            // logical window. The centred item's key survives that commit, so
            // both coordinate systems describe the same visible entity.
            trackOffsetRef.current = snapTargetRef.current
              || -travelDelta * carouselMetricsRef.current.step;
            pendingCarouselRebaseRef.current = true;
            if (!commitCarouselIndex(travelDelta)) {
              pendingCarouselRebaseRef.current = false;
              trackOffsetRef.current = 0;
              gestureOriginRef.current = 0;
              coversRef.current?.setAttribute("data-moving", "false");
            }
          }
        }
      }

      if (
        carouselMotionStateRef.current === "inertia"
        || carouselMotionStateRef.current === "snapping"
      ) {
        preloadCarouselDeltaRef.current(
          Math.round(
            -trackOffsetRef.current / carouselMetricsRef.current.step,
          ),
          3,
        );
      }
      renderCarouselRef.current(trackOffsetRef.current);
      if (carouselMotionStateRef.current === "idle") {
        const unsubscribe = carouselFrameUnsubscribeRef.current;
        carouselFrameUnsubscribeRef.current = null;
        unsubscribe?.();
      }
    };

    startCarouselMotionRef.current = () => {
      if (carouselFrameUnsubscribeRef.current !== null) {
        return;
      }
      carouselFrameUnsubscribeRef.current =
        motionController.subscribeFrame(renderFrame);
    };

    return () => {
      carouselFrameUnsubscribeRef.current?.();
      carouselFrameUnsubscribeRef.current = null;
      startCarouselMotionRef.current = () => undefined;
    };
  }, [
    carouselCatalog.length,
    commitCarouselIndex,
    prefersReducedMotion,
  ]);

  useEffect(() => {
    const handlePlaybackClosed = (event: Event) => {
      const returnSnapshot = (
        event as CustomEvent<{
          returnSnapshot?: ImmersivePlaybackCurrentTrack | null;
        }>
      ).detail?.returnSnapshot;
      if (returnSnapshot) {
        setCurrentPlaybackOccurrence(returnSnapshot);
      }
      playerTransitionPendingRef.current = false;
      setIsPlayerTransitioning(false);
      setIsWallLocking(false);
    };
    const handleCurrentTrack = (event: Event) => {
      const identity = (
        event as CustomEvent<ImmersivePlaybackCurrentTrack>
      ).detail;
      setCurrentPlaybackOccurrence(identity);
    };
    const handlePlaybackReturn = (event: Event) => {
      const transition = (
        event as CustomEvent<ImmersivePlaybackReturnTransition>
      ).detail;

      const prepared = playbackReturnTransitionRef.current;
      const canCommit = transition.phase === "prepare" || Boolean(
        prepared
        && prepared.requestId === transition.requestId
        && prepared.snapshot?.queueItemId
          === transition.snapshot?.queueItemId,
      );
      if (!canCommit) {
        return;
      }
      playbackReturnTransitionRef.current = transition;
      setPlaybackReturnTransition(transition);

      if (transition.phase !== "cancel" && transition.snapshot) {
        setCurrentPlaybackOccurrence(transition.snapshot);
      }
    };

    window.addEventListener(
      immersivePlaybackClosedEvent,
      handlePlaybackClosed,
    );
    window.addEventListener(
      immersivePlaybackCurrentTrackEvent,
      handleCurrentTrack,
    );
    window.addEventListener(
      immersivePlaybackReturnEvent,
      handlePlaybackReturn,
    );
    return () => {
      window.removeEventListener(
        immersivePlaybackClosedEvent,
        handlePlaybackClosed,
      );
      window.removeEventListener(
        immersivePlaybackCurrentTrackEvent,
        handleCurrentTrack,
      );
      window.removeEventListener(
        immersivePlaybackReturnEvent,
        handlePlaybackReturn,
      );
    };
  }, []);

  useEffect(() => {
    if (!isSearchOpen) {
      return;
    }

    return motionController.afterPaint(() => {
      searchInputRef.current?.focus();
    });
  }, [isSearchOpen]);

  useEffect(() => {
    if (searchQuery === debouncedSearchQuery) {
      return;
    }

    const debounceTimer = window.setTimeout(() => {
      if (categoryTransitionPhaseRef.current !== "idle") {
        return;
      }
      resetCarouselTrack();
      setDebouncedSearchQuery(searchQuery);
      setSearchCarouselIndex(0);
    }, 200);

    return () => window.clearTimeout(debounceTimer);
  }, [debouncedSearchQuery, resetCarouselTrack, searchQuery]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      if (
        detailView === "detail"
        && !isPlayerTransitioning
        && !isWallPanelOpenRef.current
        && !document.querySelector(
          '.immersive-player[data-presence="open"]',
        )
      ) {
        event.preventDefault();
        requestWallExit(true);
        return;
      }

      if (isSearchOpen && detailView === "browsing") {
        event.preventDefault();
        closeSearch();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    closeSearch,
    detailView,
    isPlayerTransitioning,
    isSearchOpen,
    requestWallExit,
  ]);

  useEffect(() => {
    if (detailView !== "detail" || !portalGeometry) {
      return;
    }

    let resizeFrame = 0;

    const handleResize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        const coverBounds =
          centralCoverRef.current?.getBoundingClientRect();

        if (!coverBounds || coverBounds.width === 0) {
          return;
        }
        const nextPortalGeometry =
          calculateCoverPortalGeometry(coverBounds);
        portalGeometryRef.current = nextPortalGeometry;
        setPortalGeometry(nextPortalGeometry);
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(resizeFrame);
    };
  }, [detailView, portalGeometry]);

  useEffect(
    () => () => {
      categoryRequestRef.current += 1;
      wallPreparationRequestRef.current += 1;
      libraryGenerationRef.current += 1;
      spaceTransitionAbortRef.current?.abort("Library home unmounted");
      spaceTransitionAbortRef.current = null;
      playerTransitionAbortRef.current?.abort("Library home unmounted");
      playerTransitionAbortRef.current = null;
      playerTransitionPendingRef.current = false;
      spaceTransitionPendingRef.current = false;
      homeSnapshotRef.current = null;
      portalGeometryRef.current = null;
      preparedWallRef.current = null;
      if (pendingWallOpenIntentRef.current) {
        pendingWallOpenIntentRef.current.cancelled = true;
      }
      pendingWallOpenIntentRef.current = null;
      clearCarouselTimers();

      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
      }

      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }

    },
    [clearCarouselTimers],
  );

  if (!library) {
    return null;
  }

  const isPortalActive =
    preparedWall?.collectionKey === activeCollectionKey
    && detailView !== "browsing";
  const keepHiddenWallSettled =
    !isPortalActive
    && detailView === "browsing"
    && libraryRootRef.current?.dataset.returnVisualOwner === "home";
  const portalState: DetailView =
    isPortalActive
      ? detailView
      : keepHiddenWallSettled
        ? "closing"
        : "prepared";
  // The underline belongs to the committed collection. During preparation it
  // only exposes a quiet pending state, then changes once the incoming shelf
  // has actually finished taking visual ownership.
  const visualCategory = activeCategory;
  const activeCategoryLabel = t(categoryLabelKey[activeCategory]);
  const captionCollection = activeCollection;
  const captionDurationMs = playlistDurationMs;
  const categoryMotionVariant =
    pendingShelfPlane?.motionVariant ?? "backward";
  const currentCarouselStatus = formatCarouselStatus(
    carouselCatalog.length,
    normalizedCarouselIndex,
  );
  const incomingCarouselStatus = pendingShelfPlane
    ? formatCarouselStatus(
        pendingShelfPlane.catalogLength,
        pendingShelfPlane.carouselIndex,
      )
    : null;
  const currentEmptyLabel = carouselCatalog.length === 0
    ? isSearchActive
      ? t("home.empty.search")
      : t(categoryEmptyKey[activeCategory])
    : null;
  const incomingEmptyLabel = pendingShelfPlane?.catalogLength === 0
    ? t(categoryEmptyKey[pendingShelfPlane.category])
    : null;
  const portalStyle: CoverPortalStyle | undefined = portalGeometry
    ? {
        "--portal-cover-left": `${portalGeometry.coverLeft}px`,
        "--portal-cover-top": `${portalGeometry.coverTop}px`,
        "--portal-cover-width": `${portalGeometry.coverWidth}px`,
        "--portal-cover-height": `${portalGeometry.coverHeight}px`,
        "--portal-center-x": `${portalGeometry.centerX}px`,
        "--portal-center-y": `${portalGeometry.centerY}px`,
      }
    : undefined;

  const renderShelfPlane = (planeId: ShelfPlaneId) => {
    const pendingPlane = pendingShelfPlane?.planeId === planeId
      ? pendingShelfPlane
      : null;
    const isCurrentPlane = activeShelfPlaneId === planeId;
    const planeCards = isCurrentPlane
      ? carouselCards
      : pendingPlane?.cards ?? [];
    const planeState = isCurrentPlane
      ? categoryTransition === "out"
        ? "outgoing"
        : "current"
      : pendingPlane
        ? categoryTransition === "out"
          ? "incoming"
          : "preparing"
        : "reserve";
    const planeDirection = pendingPlane?.motionVariant
      ?? pendingShelfPlane?.motionVariant
      ?? "backward";
    const logicalDirection = pendingPlane?.logicalDirection
      ?? pendingShelfPlane?.logicalDirection
      ?? "forward";

    return (
      <div
        className="library-home__shelf-plane"
        data-plane={planeId}
        data-state={planeState}
        data-direction={planeDirection}
        data-logical-direction={logicalDirection}
        data-empty={planeCards.length === 0}
        data-target-empty={Boolean(
          isCurrentPlane
          && categoryTransition === "out"
          && pendingShelfPlane?.catalogLength === 0
        )}
        data-request={pendingPlane?.requestId ?? ""}
        ref={(node) => assignShelfPlaneRef(planeId, node)}
        onAnimationStart={(event) => {
          if (
            event.target === event.currentTarget
            && event.animationName.startsWith("category-shelf-in-")
          ) {
            captureCategoryTransitionEvidence("animation-start", {
              planeId,
              animationName: event.animationName,
            });
          }
        }}
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget
            && event.animationName.startsWith("category-shelf-in-")
          ) {
            captureCategoryTransitionEvidence("animation-end-event", {
              planeId,
              animationName: event.animationName,
            });
          }
        }}
        aria-hidden={!isCurrentPlane}
        key={planeId}
      >
        <div
          className="library-home__covers"
          ref={(node) => assignShelfTrackRef(planeId, node)}
          role={isCurrentPlane ? "list" : undefined}
          data-dragging="false"
          data-moving="false"
          onClick={isCurrentPlane ? handleCarouselClick : undefined}
          onPointerDown={
            isCurrentPlane ? handleCarouselPointerDown : undefined
          }
          onPointerUp={
            isCurrentPlane
              ? (event) => finishCarouselDrag(event)
              : undefined
          }
          onPointerCancel={
            isCurrentPlane
              ? (event) => finishCarouselDrag(event, true)
              : undefined
          }
          onAuxClick={
            isCurrentPlane ? (event) => event.preventDefault() : undefined
          }
        >
          <div
            className="library-home__track-hit-surface"
            aria-hidden="true"
          />
          {planeCards.map(({
            instanceKey,
            logicalPosition,
            artIndex,
            track,
            collection,
            position,
            issue,
            offset,
          }) => (
            <div
              className="library-home__cover-slot"
              data-position={position}
              data-track-offset={offset}
              data-logical-position={logicalPosition}
              data-carousel-identity={instanceKey}
              data-focused="false"
              data-focus-score="0"
              data-focus-layer="0"
              data-category-visible={Math.abs(offset) <= 2}
              role={isCurrentPlane ? "listitem" : undefined}
              aria-hidden={!isCurrentPlane || Math.abs(offset) > 1}
              key={instanceKey}
            >
              <PlaylistCover
                track={track}
                collectionKind={collection.kind}
                position={position}
                issue={issue}
                index={artIndex}
                geometry={null}
                coverRef={
                  isCurrentPlane && position === "center"
                    ? centralCoverRef
                    : undefined
                }
                interactive={
                  isCurrentPlane
                  && (
                    offset === -1
                    || offset === 0
                    || offset === 1
                  )
                  && detailView === "browsing"
                  && categoryTransition === "idle"
                  && !isPlayerTransitioning
                }
                ariaLabel={
                  offset === 0
                      ? t("home.cover.open", {
                          kind: t(collectionKindLabelKey[collection.kind]),
                          collection: collection.title,
                          track: track.title,
                        })
                    : offset === -1
                      ? t("home.cover.previous", { title: track.title })
                      : t("home.cover.next", { title: track.title })
                }
                onClick={
                  isCurrentPlane && offset === 0
                    ? handleCentralClick
                    : isCurrentPlane && (offset === -1 || offset === 1)
                      ? () => shiftCarousel(
                          offset === -1 ? "previous" : "next",
                        )
                      : undefined
                }
                onDoubleClick={
                  isCurrentPlane && offset === 0
                    ? handleCentralDoubleClick
                    : undefined
                }
                onPointerDown={
                  isCurrentPlane && (offset === -1 || offset === 1)
                    ? (event) => {
                        if (event.button === 0) {
                          shiftCarousel(
                            offset === -1 ? "previous" : "next",
                          );
                        }
                      }
                    : undefined
                }
                onKeyDown={
                  isCurrentPlane && offset === 0
                    ? handleCentralKeyDown
                    : isCurrentPlane && (offset === -1 || offset === 1)
                      ? (event) => handleSideKeyDown(
                          event,
                          offset === -1 ? "previous" : "next",
                        )
                      : undefined
                }
              />
            </div>
          ))}
        </div>

      </div>
    );
  };

  return (
    <section
      className="library-home"
      ref={libraryRootRef}
      aria-label={
        detailView === "browsing"
          ? t("home.aria")
          : `${activeCollection?.title ?? activeCategoryLabel} ${activeCategoryLabel}`
      }
      aria-hidden={phase !== "library"}
      data-visible={phase === "library"}
      data-provider-id={providerId}
      data-view={detailView}
      data-category-transition={categoryTransition}
      data-search-open={isSearchOpen}
      data-wall-locking={isWallLocking}
      data-player-transition={isPlayerTransitioning}
      data-space-transition="cover-portal"
      style={
        {
          "--library-category-duration":
            `${
              prefersReducedMotion
                ? categoryMotion.reducedTransitionDuration
                : categoryMotion.transitionDuration
            }ms`,
          "--library-category-easing": categoryMotion.easing,
          "--library-category-quiet-easing": categoryMotion.quietEasing,
          "--library-category-shell-mid-depth":
            `${categoryMotion.sideShellMidDepth}px`,
          "--library-category-shell-mid-scale":
            `${categoryMotion.sideShellMidScale}`,
          "--library-category-center-shell-mid-depth":
            `${categoryMotion.centerShellMidDepth}px`,
          "--library-category-center-shell-mid-scale":
            `${categoryMotion.centerShellMidScale}`,
          "--library-category-artwork-shift":
            `${categoryMotion.sideArtworkShift}px`,
          "--library-category-center-artwork-shift":
            `${categoryMotion.centerArtworkShift}px`,
          "--home-wall-duration": `${wallOpenDuration}ms`,
          "--home-wall-close-duration": `${detailCloseDuration}ms`,
          "--home-wall-lock-duration":
            `${homeWallMotion.lockDuration}ms`,
          "--home-wall-lock-scale": `${homeWallMotion.lockScale}`,
          "--home-wall-lock-inverse": `${1 / homeWallMotion.lockScale}`,
          "--home-wall-lock-side-opacity":
            `${homeWallMotion.lockSideOpacity}`,
          "--home-wall-artwork-max-scale":
            `${homeWallMotion.artworkMaxScale}`,
          "--home-wall-artwork-return-scale":
            `${homeWallMotion.artworkReturnScale}`,
          "--home-wall-side-opacity": `${homeWallMotion.sideOpacity}`,
          "--home-wall-start-scale": `${homeWallMotion.wallStartScale}`,
          "--home-wall-card-form-duration":
            `${wallOpenDuration * homeWallMotion.cardFormDurationProgress}ms`,
          "--home-wall-card-form-start":
            `${wallOpenDuration * homeWallMotion.wallMotionStartProgress}ms`,
          "--home-wall-card-exit-duration":
            `${
              detailCloseDuration * homeWallMotion.returnCardExitProgress
            }ms`,
          "--home-wall-card-exit-start":
            "0ms",
          "--home-wall-easing": homeWallMotion.easing,
          "--home-wall-quiet-easing": homeWallMotion.quietEasing,
        } as CSSProperties
      }
    >
      <header className="library-home__topbar">
        <div className="library-home__identity" aria-hidden="true">
          <span>TINGJING</span>
          <small>NEW MUSIC EDIT</small>
        </div>

        <button
          className="library-home__back"
          type="button"
          ref={backButtonRef}
          disabled={detailView !== "detail" || isPlayerTransitioning}
          aria-hidden={detailView === "browsing"}
          onClick={() => requestWallExit(false)}
        >
          <span aria-hidden="true">←</span>
          {t("common.back")}
        </button>

        <nav
          className="library-home__nav"
          aria-label={t("home.categories.aria")}
          ref={categoryNavRef}
        >
          {categories.map((category) => (
            <button
              className="library-home__nav-item"
              data-active={visualCategory === category}
              data-pending={
                pendingShelfPlane?.category === category
                && visualCategory !== category
              }
              data-kind={categoryKind[category]}
              aria-current={activeCategory === category ? "page" : undefined}
              type="button"
              disabled={
                detailView !== "browsing" || isPlayerTransitioning
              }
              key={category}
              ref={(node) => {
                if (node) {
                  categoryNavItemRefs.current.set(category, node);
                } else {
                  categoryNavItemRefs.current.delete(category);
                }
              }}
              onClick={() => selectCategory(category)}
            >
              {t(categoryLabelKey[category])}
            </button>
          ))}
          <span className="library-home__nav-indicator" aria-hidden="true" />
        </nav>

        <div className="library-home__search-shell" data-open={isSearchOpen}>
          <button
            className="library-home__search"
            type="button"
            aria-label={t("home.search.open", {
              category: activeCategoryLabel,
            })}
            aria-expanded={isSearchOpen}
            disabled={detailView !== "browsing" || isPlayerTransitioning}
            onClick={() => {
              if (
                !spaceTransitionPendingRef.current
                && !isCollectionLoadingRef.current
                && categoryTransitionPhaseRef.current === "idle"
              ) {
                setIsSearchOpen(true);
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.8" cy="10.8" r="6.4" />
              <path d="m15.6 15.6 4 4" />
            </svg>
            <span>{t("home.search.label")}</span>
          </button>
          <input
            ref={searchInputRef}
            type="search"
            aria-label={t("home.search.within", {
              category: activeCategoryLabel,
            })}
            aria-hidden={!isSearchOpen}
            placeholder={t("home.search.open", {
              category: activeCategoryLabel,
            })}
            value={searchQuery}
            disabled={
              !isSearchOpen || categoryTransition !== "idle"
            }
            tabIndex={isSearchOpen ? 0 : -1}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <button
            className="library-home__search-close"
            type="button"
            aria-label={t("home.search.close")}
            aria-hidden={!isSearchOpen}
            disabled={
              !isSearchOpen || categoryTransition !== "idle"
            }
            tabIndex={isSearchOpen ? 0 : -1}
            onClick={closeSearch}
          >
            ×
          </button>
        </div>
        {providerId === "spotify" && centralTrack && (
          <div className="library-home__spotify-attribution">
            <SpotifyAttribution
              actionLabel={t("spotify.open") as "OPEN SPOTIFY"}
              compact
              onOpen={() => {
                requestPlayback(centralTrack, "cover-space");
              }}
            />
          </div>
        )}
      </header>

      <span
        className="library-home__carousel-status"
        data-category-transition={categoryTransition}
        data-category-direction={categoryMotionVariant}
        data-has-category-incoming={Boolean(incomingCarouselStatus)}
        aria-hidden="true"
      >
        <span data-category-layer="current">
          {currentCarouselStatus}
        </span>
        {incomingCarouselStatus && (
          <span data-category-layer="incoming">
            {incomingCarouselStatus}
          </span>
        )}
      </span>

      <div className="library-home__edge-control" data-side="left">
        <button
          type="button"
          aria-label={t("home.cover.previousControl")}
          disabled={
            detailView !== "browsing"
            || categoryTransition !== "idle"
            || carouselCatalog.length < 2
            || isPlayerTransitioning
          }
          onClick={() => shiftCarousel("previous")}
        >
          ←
        </button>
      </div>

      <div className="library-home__edge-control" data-side="right">
        <button
          type="button"
          aria-label={t("home.cover.nextControl")}
          disabled={
            detailView !== "browsing"
            || categoryTransition !== "idle"
            || carouselCatalog.length < 2
            || isPlayerTransitioning
          }
          onClick={() => shiftCarousel("next")}
        >
          →
        </button>
      </div>

      {(["a", "b"] as const).map(renderShelfPlane)}

      <AlbumMiniInfo
        collection={captionCollection}
        durationMs={captionDurationMs}
        incomingCollection={pendingShelfPlane?.collection ?? null}
        incomingDurationMs={pendingShelfPlane?.durationMs ?? 0}
        hasCategoryIncoming={Boolean(pendingShelfPlane)}
        categoryTransition={categoryTransition}
        categoryMotionVariant={categoryMotionVariant}
        crossfadeEnabled={categoryTransition === "idle"}
        crossfadeDurationMs={
          prefersReducedMotion
            ? categoryMotion.reducedTransitionDuration
            : categoryMotion.transitionDuration
        }
      />

      <p
        className="library-home__empty"
        data-category-transition={categoryTransition}
        data-category-direction={categoryMotionVariant}
        data-has-current={Boolean(currentEmptyLabel)}
        data-has-category-incoming={Boolean(incomingEmptyLabel)}
        role="status"
      >
        {currentEmptyLabel && (
          <span data-category-layer="current">{currentEmptyLabel}</span>
        )}
        {incomingEmptyLabel && (
          <span data-category-layer="incoming">{incomingEmptyLabel}</span>
        )}
      </p>

      {preparedWall && portalGeometry && (
        <div
          className="library-home__portal-layer"
          ref={portalLayerRef}
          data-state={portalState}
          data-active={isPortalActive}
          style={portalStyle}
          aria-hidden={portalState !== "detail"}
          onAnimationStart={(event) => {
            if (
              !homeWallDiagnosticsEnabled()
              || !event.animationName.startsWith("cover-portal-")
            ) {
              return;
            }
            const target = event.target as HTMLElement;
            const portalSlot = target.closest<HTMLElement>(
              ".music-wall__card-slot[data-portal-row][data-portal-column]",
            );
            noteHomeWallAnimationStart(
              event.animationName,
              portalSlot
                ? `${target.className}:r${portalSlot.dataset.portalRow}`
                  + `c${portalSlot.dataset.portalColumn}`
                : target.className || target.tagName.toLowerCase(),
            );
          }}
        >
          <div
            className="library-home__portal-medium"
            data-state={portalState}
            aria-hidden="true"
          >
            <div className="library-home__portal-medium-field">
              <CoverAtmosphereRenderer
                coverImage={
                  providerId === "spotify"
                    ? undefined
                    : preparedWall.coverTrack.coverImage
                }
                palette={preparedWall.coverTrack.palette}
                state={portalState}
              />
            </div>
            <div
              className="library-home__portal-directory"
              data-state={portalState}
            >
              <span className="library-home__portal-directory-label">
                {preparedWall.collection.kind === "album"
                  ? "ALBUM"
                  : preparedWall.collection.kind === "artist"
                    ? "ARTIST"
                    : "PLAYLIST"}
                {" / "}{preparedWall.collection.number}
              </span>
              <strong>
                {String(preparedWall.tracks.length).padStart(2, "0")} TRACKS
              </strong>
              <i data-axis="primary" />
              <i data-axis="secondary" />
            </div>
          </div>
          <div className="library-home__portal-surface">
            <MusicWall
              state={portalState}
              mode={preparedWall.collection.kind}
              number={preparedWall.collection.number}
              title={preparedWall.collection.title}
              subtitle={preparedWall.collection.subtitle}
              tracks={preparedWall.tracks}
              albumCoverTrack={preparedWall.coverTrack}
              currentPlaybackOccurrence={currentPlaybackOccurrence}
              playbackReturnTransition={playbackReturnTransition}
              isPlayerTransitioning={isPlayerTransitioning}
              overlayRoot={overlayLayerElement}
              preparation={preparedWall.preparation}
              queueContext={preparedWallQueueContext!}
              playbackPrefetchService={playbackPrefetchService}
              onExit={handleWallExit}
              onExitControllerChange={handleWallExitControllerChange}
              onPanelStateChange={handleWallPanelStateChange}
              onPlay={requestPlayback}
            />
          </div>
          <div
            className="library-home__portal-artwork"
            data-state={portalState}
            data-active={isPortalActive}
            aria-hidden="true"
          >
            <div className="library-home__portal-shared-cover">
              <PlaylistCover
                track={preparedWall.coverTrack}
                collectionKind={preparedWall.collection.kind}
                position="center"
                issue={preparedWall.collection.number}
                index={preparedWall.coverArtIndex}
                geometry={null}
                interactive={false}
              />
            </div>
          </div>
        </div>
      )}

      <div
        className="library-home__overlay-layer"
        ref={setOverlayLayerElement}
      />

      <p
        className="library-home__playback-notice"
        data-visible={Boolean(playbackNotice)}
        role="status"
        aria-live="polite"
      >
        {playbackNotice || "\u00A0"}
      </p>
    </section>
  );
}
