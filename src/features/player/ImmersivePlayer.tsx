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
import type { CSSProperties } from "react";
import { motion } from "../../config/motion";
import { motionController } from "../../config/MotionController";
import { transitionManager } from "../../config/TransitionManager";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useLanguage } from "../../i18n/LanguageContext";
import { useColorTheme } from "../../theme/ColorThemeContext";
import {
  getListeningSpaceDefinition,
  ListeningSpaceRenderer,
} from "../../listening-spaces/ListeningSpaceRegistry";
import type { ListeningSpaceId } from "../../listening-spaces/types";
import type { MusicProviderId } from "../../providers/MusicProvider";
import type {
  AudioSource,
  NormalizedLyricDocument,
  Track,
  User,
} from "../../types/music";
import {
  applyLyricOffset,
  createUnavailableLyricDocument,
  getNormalizedLyricIndex,
  getNormalizedLyricWordIndex,
  normalizeLyricDocument,
} from "../lyrics/LyricTruth";
import {
  lyricOffsetKey,
  lyricOffsetStore,
} from "../lyrics/LyricOffsetStore";
import {
  usePlayerPreferences,
  type PlayerPreferences,
} from "../settings/playerPreferences";
import {
  immersivePlaybackEvent,
  immersivePlaybackResetEvent,
  immersivePlaybackTrackUpdateEvent,
  notifyImmersivePlaybackActive,
  notifyImmersivePlaybackClosed,
  notifyImmersivePlaybackCurrentTrack,
  notifyImmersivePlaybackLifecycleClosed,
  notifyImmersivePlaybackReturn,
  type ImmersivePlaybackRequest,
  type ImmersivePlaybackReturnSnapshot,
  type ImmersivePlaybackTrackUpdate,
  type PlaybackOrigin,
} from "./playbackEvents";
import {
  playbackQueueController,
  type PlaybackQueueItem,
} from "./PlaybackQueueController";
import { PlaybackRequestGeneration } from "./PlaybackRequestGeneration";
import { playbackSessionBridge } from "./PlaybackSessionBridge";
import { playbackSessionStore } from "./PlaybackSessionStore";
import { LyricDiagnosticsOverlay } from "./LyricDiagnosticsOverlay";
import {
  isSilentProviderRequestError,
  type ProviderRequestLease,
} from "./ProviderRequestCoordinator";
import type { PlaybackPrefetchService } from "./PlaybackPrefetchService";
import { captureImmersivePlaybackReturnSnapshot } from "./PlaybackReturnSnapshot";
import { resolvePlaybackVolume } from "./playbackVolume";
import {
  WebMediaSessionController,
  type WebMediaSessionBinding,
} from "./WebMediaSessionController";
import { AtmosphereEngine } from "./AtmosphereEngine";
import { dailyListeningStore } from "./DailyListeningStore";
import {
  PlayerControlPanel,
  type PlayerPanelRoute,
} from "./PlayerControlPanel";
import { motionTokens } from "./motionTokens";
import "./immersive-player.css";

type PlayerPhase = "entering" | "active" | "exiting";
type PlayerEntryVisualOwner =
  | "wall-card"
  | "sharp-cover"
  | "cover-medium"
  | "atmosphere"
  | "listening-space";
type PlayerReturnTarget = "wall-card" | "neutral";
type ListeningSpaceTransitionPhase =
  | "stable"
  | "exiting"
  | "preparing"
  | "entering";

type PlayerVisualStyle = CSSProperties &
  Record<
    | "--player-cover-left"
    | "--player-cover-top"
    | "--player-cover-width"
    | "--player-cover-height"
    | "--player-cover-shift-x"
    | "--player-cover-shift-y"
    | "--player-cover-scale",
    string
  >;

const seekStepMs = 5_000;
type AudioState = "idle" | "loading" | "ready" | "error";

function formatTime(durationMs: number) {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function createCoverGeometryStyle(
  requestedOrigin?: PlaybackOrigin,
): PlayerVisualStyle {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const fallbackSize = Math.min(viewportWidth * 0.3, 380);
  const origin = requestedOrigin ?? {
    left: (viewportWidth - fallbackSize) / 2,
    top: (viewportHeight - fallbackSize) / 2,
    width: fallbackSize,
    height: fallbackSize,
  };
  const safeOriginWidth = Math.max(1, origin.width);
  const safeOriginHeight = Math.max(1, origin.height);
  const targetScale = Math.max(
    1,
    Math.min(
      (viewportWidth * 0.56) / safeOriginWidth,
      (viewportHeight * 0.66) / safeOriginHeight,
    ),
  );
  const targetCenterX = viewportWidth * 0.52;
  const targetCenterY = viewportHeight * 0.5;

  return {
    "--player-cover-left": `${origin.left}px`,
    "--player-cover-top": `${origin.top}px`,
    "--player-cover-width": `${origin.width}px`,
    "--player-cover-height": `${origin.height}px`,
    "--player-cover-shift-x": `${
      targetCenterX - (origin.left + origin.width / 2)
    }px`,
    "--player-cover-shift-y": `${
      targetCenterY - (origin.top + origin.height / 2)
    }px`,
    "--player-cover-scale": `${targetScale}`,
  };
}

function createPlayerVisualStyle(
  request: ImmersivePlaybackRequest,
): PlayerVisualStyle {
  return createCoverGeometryStyle(request.origin);
}

function applyCoverGeometryStyle(
  element: HTMLElement | null,
  origin?: PlaybackOrigin,
) {
  if (!element) {
    return;
  }
  const geometry = createCoverGeometryStyle(origin);
  Object.entries(geometry).forEach(([property, value]) => {
    element.style.setProperty(property, String(value));
  });
}

function setPlayerVisualOwner(
  element: HTMLElement | null,
  owner: PlayerEntryVisualOwner,
) {
  element?.setAttribute("data-entry-visual-owner", owner);
}

function resolvePlayerReturnTarget(
  snapshot: ImmersivePlaybackReturnSnapshot | null,
): { origin?: PlaybackOrigin; target: PlayerReturnTarget } {
  if (
    !snapshot
    || snapshot.providerId === null
    || snapshot.collectionId === null
    || snapshot.sourceIndex === null
  ) {
    return { target: "neutral" };
  }

  const wall = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.music-wall[data-state="detail"]',
    ),
  ).find((candidate) =>
    candidate.dataset.providerId === snapshot.providerId
    && candidate.dataset.collectionId === snapshot.collectionId
  );
  if (!wall) {
    return { target: "neutral" };
  }

  const viewportCenter = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  };
  let bestBounds: DOMRect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  wall.querySelectorAll<HTMLElement>(".music-wall__card").forEach((card) => {
    if (
      card.dataset.clone === "true"
      || card.dataset.selected !== "true"
      || Number(card.dataset.sourceIndex) !== snapshot.sourceIndex
      || card.dataset.trackId !== snapshot.trackId
    ) {
      return;
    }
    const bounds = card.getBoundingClientRect();
    const intersectsViewport = bounds.right > 0
      && bounds.left < window.innerWidth
      && bounds.bottom > 0
      && bounds.top < window.innerHeight;
    if (
      bounds.width <= 0
      || bounds.height <= 0
      || !intersectsViewport
    ) {
      return;
    }
    const distance = Math.hypot(
      bounds.left + bounds.width / 2 - viewportCenter.x,
      bounds.top + bounds.height / 2 - viewportCenter.y,
    );
    if (distance < bestDistance) {
      bestBounds = bounds;
      bestDistance = distance;
    }
  });

  const returnBounds = bestBounds as DOMRect | null;
  if (!returnBounds) {
    return { target: "neutral" };
  }
  return {
    target: "wall-card",
    origin: {
      left: returnBounds.left,
      top: returnBounds.top,
      width: returnBounds.width,
      height: returnBounds.height,
    },
  };
}

interface ImmersivePlayerProps {
  user?: User;
  providerId: MusicProviderId;
  providerName: string;
  onLogout?: () => Promise<void>;
  playbackPrefetchService: PlaybackPrefetchService;
}

const TransitionLayer = memo(function TransitionLayer({
  track,
}: {
  track: Track;
}) {
  return (
    <div className="immersive-player__cover-passage" aria-hidden="true">
      <div className="immersive-player__neutral-medium">
        <span />
        <span />
        <span />
      </div>
      <div className="immersive-player__cover-texture-plane">
        {track.coverImage ? (
          <img
            src={track.coverImage}
            alt=""
            decoding="async"
            draggable="false"
            onError={(event) => {
              event.currentTarget.hidden = true;
              event.currentTarget.parentElement?.setAttribute(
                "data-cover-error",
                "true",
              );
            }}
          />
        ) : null}
      </div>
      <div className="immersive-player__sharp-cover-plane">
        <span className="immersive-player__passage-cover-fallback">
          <small>TRACK</small>
          <strong lang="ja">{track.title}</strong>
          <span>{track.artist}</span>
        </span>
        {track.coverImage ? (
          <img
            src={track.coverImage}
            alt=""
            decoding="async"
            draggable="false"
            onError={(event) => {
              event.currentTarget.hidden = true;
              event.currentTarget.parentElement?.setAttribute(
                "data-cover-error",
                "true",
              );
            }}
          />
        ) : null}
      </div>
    </div>
  );
}, (previous, next) =>
  previous.track.id === next.track.id
  && previous.track.coverImage === next.track.coverImage
  && previous.track.title === next.track.title
  && previous.track.artist === next.track.artist
);

export function ImmersivePlayer({
  user,
  providerId,
  providerName,
  onLogout,
  playbackPrefetchService,
}: ImmersivePlayerProps) {
  const { t } = useLanguage();
  const [activeRequest, setActiveRequest] =
    useState<ImmersivePlaybackRequest | null>(null);
  const [phase, setPhase] = useState<PlayerPhase>("entering");
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lyricIndex, setLyricIndex] = useState(-1);
  const [baseLyricDocument, setBaseLyricDocument] =
    useState<NormalizedLyricDocument | null>(null);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const [resolvedAudioSource, setResolvedAudioSource] =
    useState<AudioSource | null>(null);
  const [audioState, setAudioState] = useState<AudioState>("idle");
  const [playbackError, setPlaybackError] = useState("");
  const [controlsVisible, setControlsVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelRoute, setPanelRoute] = useState<PlayerPanelRoute>("root");
  const [, setSettingsStatus] = useState("");
  const [trackSessionId, setTrackSessionId] = useState("idle");
  const [trackSwitching, setTrackSwitching] = useState(false);
  const [preferences, setPreferences] = usePlayerPreferences();
  const queueSnapshot = useSyncExternalStore(
    playbackQueueController.subscribe,
    playbackQueueController.getSnapshot,
    playbackQueueController.getSnapshot,
  );
  const [renderedListeningSpace, setRenderedListeningSpace] =
    useState<ListeningSpaceId>(() => preferences.listeningSpace);
  const [spaceTransitionPhase, setSpaceTransitionPhase] =
    useState<ListeningSpaceTransitionPhase>("stable");
  const playerRef = useRef<HTMLElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRequestRef = useRef<ImmersivePlaybackRequest | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  const controlsTimerRef = useRef<number | null>(null);
  const controlsVisibleRef = useRef(false);
  const settingsOpenRef = useRef(false);
  const panelRouteRef = useRef<PlayerPanelRoute>("root");
  const panelResetTimerRef = useRef<number | null>(null);
  const requestGenerationRef = useRef(new PlaybackRequestGeneration());
  const playbackLeaseRef = useRef<ProviderRequestLease | null>(null);
  const queuePrefetchCancelRef = useRef<(() => void) | null>(null);
  const trackSessionSequenceRef = useRef(0);
  const trackSwitchTimerRef = useRef<number | null>(null);
  const shouldAutoplayRef = useRef(false);
  const pendingStartPositionRef = useRef(0);
  const audioFadeTimerRef = useRef<number | null>(null);
  const audioFadeFrameRef = useRef<number | null>(null);
  const audioFadeGainRef = useRef(1);
  const mediaSessionControllerRef = useRef<WebMediaSessionController | null>(
    null,
  );
  const mediaSessionBindingRef = useRef<WebMediaSessionBinding | null>(null);
  const transitionTimelineCancelRef = useRef<(() => void) | null>(null);
  const playerExitAbortRef = useRef<AbortController | null>(null);
  const spaceTransitionAbortRef = useRef<AbortController | null>(null);
  const preferredListeningSpaceRef = useRef(preferences.listeningSpace);
  const preferencesRef = useRef(preferences);
  const renderedListeningSpaceRef = useRef(renderedListeningSpace);
  const audioStateRef = useRef<AudioState>(audioState);
  const audioSourceUrlRef = useRef("");
  const elapsedMsRef = useRef(0);
  const lyricIndexRef = useRef(-1);
  const lyricDocumentRef = useRef<NormalizedLyricDocument | null>(null);
  const elapsedLabelRef = useRef<HTMLSpanElement>(null);
  const progressInputRef = useRef<HTMLInputElement>(null);
  const lastProgressPaintAtRef = useRef(0);
  const lastProgressValueRef = useRef(-1);
  const lastSessionPersistAtRef = useRef(0);
  const prefersReducedMotion = useReducedMotion();
  const { preference, resolvedThemeId, setPreference } = useColorTheme();
  const activeRequestId = activeRequest?.requestId ?? null;
  const playbackAccountId = user?.id ?? null;
  const activeTrackDurationMs = activeRequest?.track.durationMs ?? 0;
  const audioSourceUrl = resolvedAudioSource?.url ?? "";
  activeRequestRef.current = activeRequest;
  preferencesRef.current = preferences;
  panelRouteRef.current = panelRoute;
  preferredListeningSpaceRef.current = preferences.listeningSpace;
  renderedListeningSpaceRef.current = renderedListeningSpace;
  audioStateRef.current = audioState;
  audioSourceUrlRef.current = audioSourceUrl;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const lyricDocumentBase = useMemo(
    () => baseLyricDocument
      ?? createUnavailableLyricDocument(
        providerId,
        activeRequest?.track.id ?? "idle",
      ),
    [activeRequest?.track.id, baseLyricDocument, providerId],
  );
  const activeLyricOffsetKey = useMemo(
    () => lyricOffsetKey(
      lyricDocumentBase.provider,
      activeRequest?.track.id ?? "idle",
      lyricDocumentBase.source,
    ),
    [activeRequest?.track.id, lyricDocumentBase],
  );
  const lyricOffsetMs = useSyncExternalStore(
    lyricOffsetStore.subscribe,
    () => lyricOffsetStore.get(activeLyricOffsetKey),
    () => lyricOffsetStore.get(activeLyricOffsetKey),
  );
  const lyricDocument = useMemo(
    () => applyLyricOffset(lyricDocumentBase, lyricOffsetMs),
    [lyricDocumentBase, lyricOffsetMs],
  );
  const listeningTrack = useMemo(
    () => activeRequest
      ? { ...activeRequest.track, lyrics: lyricDocument.lines }
      : null,
    [activeRequest, lyricDocument.lines],
  );
  lyricDocumentRef.current = lyricDocument;

  useLayoutEffect(() => {
    const nextIndex = getNormalizedLyricIndex(
      lyricDocument,
      elapsedMsRef.current,
    );
    if (nextIndex !== lyricIndexRef.current) {
      lyricIndexRef.current = nextIndex;
      setLyricIndex(nextIndex);
      setElapsedMs(elapsedMsRef.current);
    }
  }, [lyricDocument]);

  const beginDailyListening = useCallback(() => {
    if (user?.id && document.visibilityState !== "hidden") {
      dailyListeningStore.start(providerId, user.id);
    }
  }, [providerId, user]);

  const pauseDailyListening = useCallback(() => {
    dailyListeningStore.pause();
  }, []);

  const prefetchQueueWindow = useCallback(
    (snapshot: typeof queueSnapshot) => {
      queuePrefetchCancelRef.current?.();
      queuePrefetchCancelRef.current =
        playbackPrefetchService.prefetchQueueWindow(snapshot);
    },
    [playbackPrefetchService],
  );

  const readDiagnosticsElapsedMs = useCallback(
    () => motionController.readPlaybackTime(performance.now()),
    [],
  );
  const readDiagnosticsPlayerTimeMs = useCallback(() => {
    const audio = audioRef.current;
    return audio && Number.isFinite(audio.currentTime)
      ? Math.max(0, audio.currentTime * 1_000)
      : elapsedMsRef.current;
  }, []);

  const clearControlsTimer = useCallback(() => {
    if (controlsTimerRef.current !== null) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = null;
    }
  }, []);

  const clearAudioFade = useCallback(() => {
    if (audioFadeTimerRef.current !== null) {
      window.clearTimeout(audioFadeTimerRef.current);
      audioFadeTimerRef.current = null;
    }
    if (audioFadeFrameRef.current !== null) {
      window.cancelAnimationFrame(audioFadeFrameRef.current);
      audioFadeFrameRef.current = null;
    }
  }, []);

  const applyAudioOutput = useCallback((fadeGain?: number) => {
    if (fadeGain !== undefined) {
      audioFadeGainRef.current = fadeGain;
    }
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.muted = preferencesRef.current.muted;
    audio.volume = resolvePlaybackVolume(
      preferencesRef.current.volume,
      audioFadeGainRef.current,
    );
  }, []);

  const clearTrackSwitchTimer = useCallback(() => {
    if (trackSwitchTimerRef.current !== null) {
      window.clearTimeout(trackSwitchTimerRef.current);
      trackSwitchTimerRef.current = null;
    }
  }, []);

  const paintPlaybackProgress = useCallback(
    (positionMs: number, durationMs: number) => {
      const roundedPosition = Math.max(0, Math.round(positionMs));
      if (
        roundedPosition === lastProgressValueRef.current
        && durationMs > 0
      ) {
        return;
      }

      lastProgressValueRef.current = roundedPosition;
      if (elapsedLabelRef.current) {
        elapsedLabelRef.current.textContent = formatTime(roundedPosition);
      }
      if (progressInputRef.current) {
        progressInputRef.current.max = `${Math.max(0, durationMs)}`;
        progressInputRef.current.value = `${Math.min(
          roundedPosition,
          Math.max(0, durationMs),
        )}`;
      }
    },
    [],
  );

  const persistPlaybackSession = useCallback((
    positionMs: number,
    force = false,
  ) => {
    if (!playbackAccountId || !activeRequestRef.current) {
      return;
    }
    const now = performance.now();
    if (!force && now - lastSessionPersistAtRef.current < 1_000) {
      return;
    }
    const queue = playbackQueueController.exportState();
    if (
      !queue.snapshot.current
      || queue.snapshot.providerId !== providerId
    ) {
      return;
    }
    lastSessionPersistAtRef.current = now;
    playbackSessionStore.scheduleSave({
      providerId,
      accountId: playbackAccountId,
      queue,
      positionMs,
      listeningSpace: preferredListeningSpaceRef.current,
      volume: preferencesRef.current.volume,
      muted: preferencesRef.current.muted,
      lyricOffsetKey: activeLyricOffsetKey,
    });
  }, [activeLyricOffsetKey, playbackAccountId, providerId]);

  const commitPlaybackPosition = useCallback(
    (
      positionMs: number,
      playing: boolean,
      durationMs: number,
      forceReactSync = false,
    ) => {
      const nextPosition = Math.max(0, positionMs);
      elapsedMsRef.current = nextPosition;
      motionController.setPlaybackClock(nextPosition, playing);
      paintPlaybackProgress(nextPosition, durationMs);
      const queueCurrent = playbackQueueController.getSnapshot().current;
      playbackSessionBridge.publish({
        requestId: activeRequestRef.current?.requestId ?? null,
        queueItemId: queueCurrent?.queueItemId ?? null,
        trackId: activeRequestRef.current?.track.id ?? null,
        elapsedMs: nextPosition,
        durationMs,
        isPlaying: playing,
        canSeek: Boolean(activeRequestRef.current && audioRef.current),
      });
      mediaSessionBindingRef.current?.updatePlayback({
        playbackState: playing ? "playing" : "paused",
        position: durationMs > 0
          ? {
              positionMs: Math.min(nextPosition, durationMs),
              durationMs,
              playbackRate: audioRef.current?.playbackRate ?? 1,
            }
          : null,
      });
      persistPlaybackSession(nextPosition, forceReactSync);

      const document = lyricDocumentRef.current;
      const nextLyricIndex = document
        ? getNormalizedLyricIndex(document, nextPosition)
        : -1;
      if (
        forceReactSync
        || nextLyricIndex !== lyricIndexRef.current
      ) {
        lyricIndexRef.current = nextLyricIndex;
        setLyricIndex(nextLyricIndex);
        setElapsedMs(nextPosition);
      }
    },
    [paintPlaybackProgress, persistPlaybackSession],
  );

  const scheduleControlsHide = useCallback(() => {
    clearControlsTimer();
    controlsTimerRef.current = window.setTimeout(() => {
      if (!settingsOpenRef.current) {
        controlsVisibleRef.current = false;
        setControlsVisible(false);
      }
      controlsTimerRef.current = null;
    }, motion.playerControlsHideMs);
  }, [clearControlsTimer]);

  const revealControls = useCallback(() => {
    if (phase !== "active") {
      return;
    }

    if (!controlsVisibleRef.current) {
      controlsVisibleRef.current = true;
      setControlsVisible(true);
    }
    scheduleControlsHide();
  }, [phase, scheduleControlsHide]);

  const revealInterface = useCallback(() => {
    revealControls();
  }, [revealControls]);

  const closeSettings = useCallback(() => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    setSettingsStatus("");
    if (panelResetTimerRef.current !== null) {
      window.clearTimeout(panelResetTimerRef.current);
    }
    panelResetTimerRef.current = window.setTimeout(() => {
      panelRouteRef.current = "root";
      setPanelRoute("root");
      panelResetTimerRef.current = null;
    }, prefersReducedMotion ? 0 : 220);
    motionController.afterPaint(() => avatarRef.current?.focus());

    if (phase === "active") {
      scheduleControlsHide();
    }
  }, [phase, prefersReducedMotion, scheduleControlsHide]);

  const toggleSettings = useCallback(() => {
    const nextOpen = !settingsOpenRef.current;
    if (panelResetTimerRef.current !== null) {
      window.clearTimeout(panelResetTimerRef.current);
      panelResetTimerRef.current = null;
    }
    if (nextOpen) {
      panelRouteRef.current = "root";
      setPanelRoute("root");
    }
    settingsOpenRef.current = nextOpen;
    setSettingsOpen(nextOpen);
    setSettingsStatus("");
    if (!controlsVisibleRef.current) {
      controlsVisibleRef.current = true;
      setControlsVisible(true);
    }

    if (nextOpen) {
      clearControlsTimer();
    } else {
      scheduleControlsHide();
      panelResetTimerRef.current = window.setTimeout(() => {
        panelRouteRef.current = "root";
        setPanelRoute("root");
        panelResetTimerRef.current = null;
      }, prefersReducedMotion ? 0 : 220);
      motionController.afterPaint(() => avatarRef.current?.focus());
    }
  }, [clearControlsTimer, prefersReducedMotion, scheduleControlsHide]);

  const updatePreference = useCallback(
    <Key extends keyof PlayerPreferences,>(
      key: Key,
      value: PlayerPreferences[Key],
    ) => {
      setPreferences(() => {
        if (key === "showTranslation" || key === "scrollShowTranslation") {
          const showTranslation = Boolean(value);
          return {
            showTranslation,
            scrollShowTranslation: showTranslation,
            showOriginalLyrics: true,
          };
        }

        if (key === "showOriginalLyrics") {
          return { showOriginalLyrics: true };
        }

        return { [key]: value, showOriginalLyrics: true };
      });
    },
    [setPreferences],
  );

  const loadAudioSource = useCallback(
    async (track: Track, requestedLease?: ProviderRequestLease | null) => {
      const requestId = requestGenerationRef.current.beginAudio();
      const lease = requestedLease ?? playbackLeaseRef.current;
      setResolvedAudioSource(null);
      setAudioState("loading");
      setPlaybackError("");

      if (!lease || lease.trackId !== track.id) {
        setAudioState("error");
        setPlaybackError(t("player.error.identity"));
        return;
      }

      try {
        const source = await playbackPrefetchService.resolveAudioForPlayback(
          lease,
        );
        if (!requestGenerationRef.current.isCurrentAudio(requestId)) {
          return;
        }
        setResolvedAudioSource(source);
      } catch (error) {
        if (!requestGenerationRef.current.isCurrentAudio(requestId)) {
          return;
        }
        if (isSilentProviderRequestError(error)) {
          return;
        }
        shouldAutoplayRef.current = false;
        setAudioState("error");
        setPlaybackError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [playbackPrefetchService, t],
  );

  const loadLyrics = useCallback(
    async (
      track: Track,
      playerRequestId: string,
      requestedLease?: ProviderRequestLease | null,
    ) => {
      const requestId = requestGenerationRef.current.beginLyrics();
      const lease = requestedLease ?? playbackLeaseRef.current;
      if (!lease || lease.trackId !== track.id) {
        return;
      }

      try {
        const { document } =
          await playbackPrefetchService.resolveLyricsForPlayback(lease, track);
        if (!requestGenerationRef.current.isCurrentLyrics(requestId)) {
          return;
        }
        setActiveRequest((current) => {
          if (
            !requestGenerationRef.current.isCurrentLyrics(requestId)
            || !current
            || current.requestId !== playerRequestId
            || current.track.id !== track.id
          ) {
            return current;
          }
          const hasLyrics = document.lines.length > 0;
          const next = {
            ...current,
            track: { ...track, lyrics: document.lines },
            lyricsStatus: hasLyrics ? "ready" as const : "empty" as const,
          };
          setBaseLyricDocument(document);
          const currentPosition = audioRef.current
            ? Math.max(0, audioRef.current.currentTime * 1_000)
            : elapsedMsRef.current;
          const nextIndex = getNormalizedLyricIndex(document, currentPosition);
          elapsedMsRef.current = currentPosition;
          lyricIndexRef.current = nextIndex;
          setElapsedMs(currentPosition);
          setLyricIndex(nextIndex);
          activeRequestRef.current = next;
          return next;
        });
      } catch (error) {
        if (!requestGenerationRef.current.isCurrentLyrics(requestId)) {
          return;
        }
        if (isSilentProviderRequestError(error)) {
          return;
        }
        setActiveRequest((current) => {
          if (
            !requestGenerationRef.current.isCurrentLyrics(requestId)
            || !current
            || current.requestId !== playerRequestId
            || current.track.id !== track.id
          ) {
            return current;
          }
          const next = { ...current, track, lyricsStatus: "error" as const };
          activeRequestRef.current = next;
          return next;
        });
      }
    },
    [playbackPrefetchService],
  );

  const playAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    try {
      await audio.play();
      setPlaybackError("");
    } catch (error) {
      setIsPlaying(false);
      setPlaybackError(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? t("player.error.ready")
          : t("player.error.start"),
      );
    }
  }, [t]);

  const activateQueueItem = useCallback((
    item: PlaybackQueueItem,
    options: { autoplay: boolean },
  ) => {
    const playerRequest = activeRequestRef.current;
    if (
      !playerRequest
      || phaseRef.current !== "active"
      || playerExitAbortRef.current
    ) {
      return false;
    }

    clearAudioFade();
    clearTrackSwitchTimer();
    requestGenerationRef.current.invalidateAll();
    const queueSnapshot = playbackQueueController.getSnapshot();
    const playbackLease = playbackPrefetchService.beginPlayback(
      item,
      queueSnapshot,
    );
    playbackLeaseRef.current = playbackLease;
    shouldAutoplayRef.current = options.autoplay;
    pendingStartPositionRef.current = 0;

    const audio = audioRef.current;
    pauseDailyListening();
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    applyAudioOutput(1);

    elapsedMsRef.current = 0;
    lyricIndexRef.current = -1;
    lastProgressValueRef.current = -1;
    motionController.setPlaybackClock(0, false);
    paintPlaybackProgress(0, item.track.durationMs);

    const nextRequest: ImmersivePlaybackRequest = {
      ...playerRequest,
      track: item.track,
      lyricsStatus: item.track.lyrics.length > 0 ? "ready" : "loading",
    };
    activeRequestRef.current = nextRequest;
    setActiveRequest(nextRequest);
    setElapsedMs(0);
    setLyricIndex(-1);
    setBaseLyricDocument(null);
    setMediaDurationMs(item.track.durationMs);
    setResolvedAudioSource(null);
    setAudioState("loading");
    setPlaybackError("");
    setIsPlaying(false);

    trackSessionSequenceRef.current += 1;
    setTrackSessionId(
      `${playerRequest.requestId}:track:${trackSessionSequenceRef.current}`,
    );
    setTrackSwitching(true);
    trackSwitchTimerRef.current = window.setTimeout(() => {
      setTrackSwitching(false);
      trackSwitchTimerRef.current = null;
    }, prefersReducedMotion ? 0 : 240);

    void motionController.preloadImage(item.track.coverImage);
    void loadAudioSource(item.track, playbackLease);
    void loadLyrics(item.track, playerRequest.requestId, playbackLease);
    prefetchQueueWindow(queueSnapshot);
    notifyImmersivePlaybackCurrentTrack(
      playerRequest.requestId,
      item,
      playbackQueueController.getSnapshot(),
    );
    return true;
  }, [
    applyAudioOutput,
    clearAudioFade,
    clearTrackSwitchTimer,
    loadAudioSource,
    loadLyrics,
    paintPlaybackProgress,
    pauseDailyListening,
    playbackPrefetchService,
    prefetchQueueWindow,
    prefersReducedMotion,
  ]);

  const requestPlaybackStart = useCallback(() => {
    const audio = audioRef.current;
    const request = activeRequestRef.current;
    if (!request || !audio) {
      return;
    }

    if (audioStateRef.current === "loading") {
      shouldAutoplayRef.current = request.autoplay !== false;
      return;
    }

    if (audioStateRef.current === "error" || !audioSourceUrlRef.current) {
      shouldAutoplayRef.current = true;
      void loadAudioSource(request.track);
      return;
    }

    if (audio.paused) {
      void playAudio();
    }
  }, [loadAudioSource, playAudio]);

  const requestPlaybackPause = useCallback(() => {
    shouldAutoplayRef.current = false;
    audioRef.current?.pause();
  }, []);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!activeRequestRef.current || !audio) {
      return;
    }
    if (audio.paused) {
      requestPlaybackStart();
    } else {
      requestPlaybackPause();
    }
  }, [requestPlaybackPause, requestPlaybackStart]);

  const seekToMs = useCallback((nextMs: number) => {
    const audio = audioRef.current;
    const maximum = Number.isFinite(audio?.duration)
      ? (audio?.duration ?? 0) * 1_000
      : mediaDurationMs;
    const next = Math.max(0, Math.min(nextMs, maximum));

    if (audio && Number.isFinite(audio.duration)) {
      audio.currentTime = next / 1_000;
    }
    if (activeRequest) {
      commitPlaybackPosition(
        next,
        Boolean(audio && !audio.paused),
        maximum,
        true,
      );
    }
  }, [activeRequest, commitPlaybackPosition, mediaDurationMs]);

  useEffect(() => playbackSessionBridge.bindSeek((trackId, positionMs) => {
    if (
      phaseRef.current !== "active"
      || activeRequestRef.current?.track.id !== trackId
    ) {
      return false;
    }
    seekToMs(positionMs);
    return true;
  }), [seekToMs]);

  const playNextQueueItem = useCallback((reason: "user" | "ended") => {
    if (phaseRef.current !== "active" || playerExitAbortRef.current) {
      return false;
    }
    const snapshot = playbackQueueController.getSnapshot();
    if (
      reason === "ended"
      && snapshot.repeatMode === "one"
      && snapshot.current
    ) {
      const audio = audioRef.current;
      if (!audio) {
        return false;
      }
      audio.currentTime = 0;
      pendingStartPositionRef.current = 0;
      commitPlaybackPosition(0, true, mediaDurationMs, true);
      void playAudio();
      return true;
    }
    const nextItem = playbackQueueController.next(reason);
    return nextItem
      ? activateQueueItem(nextItem, { autoplay: true })
      : false;
  }, [activateQueueItem, commitPlaybackPosition, mediaDurationMs, playAudio]);

  const playPreviousQueueItem = useCallback(() => {
    if (phaseRef.current !== "active" || playerExitAbortRef.current) {
      return false;
    }
    if (elapsedMsRef.current > 3_000) {
      seekToMs(0);
      return true;
    }
    const previousItem = playbackQueueController.previous();
    if (!previousItem) {
      seekToMs(0);
      return false;
    }
    return activateQueueItem(previousItem, { autoplay: true });
  }, [activateQueueItem, seekToMs]);

  useEffect(() => {
    const track = activeRequestRef.current?.track;
    if (!activeRequestId || !track) {
      mediaSessionBindingRef.current?.cleanup();
      mediaSessionBindingRef.current = null;
      return;
    }

    mediaSessionControllerRef.current ??= new WebMediaSessionController();
    const binding = mediaSessionControllerRef.current.bind({
      metadata: {
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.coverImage
          ? [{ src: track.coverImage }]
          : undefined,
      },
      playback: {
        playbackState: "paused",
        position: track.durationMs > 0
          ? {
              positionMs: Math.min(
                elapsedMsRef.current,
                track.durationMs,
              ),
              durationMs: track.durationMs,
              playbackRate: audioRef.current?.playbackRate ?? 1,
            }
          : null,
      },
      handlers: {
        play: requestPlaybackStart,
        pause: requestPlaybackPause,
        previousTrack: () => {
          playPreviousQueueItem();
        },
        nextTrack: () => {
          playNextQueueItem("user");
        },
        seekTo: (positionMs) => seekToMs(positionMs),
        seekForward: (offsetMs) => {
          seekToMs(elapsedMsRef.current + offsetMs);
        },
        seekBackward: (offsetMs) => {
          seekToMs(elapsedMsRef.current - offsetMs);
        },
      },
    });
    mediaSessionBindingRef.current = binding;

    return () => {
      binding.cleanup();
      if (mediaSessionBindingRef.current === binding) {
        mediaSessionBindingRef.current = null;
      }
    };
  }, [
    activeRequest?.track.album,
    activeRequest?.track.artist,
    activeRequest?.track.coverImage,
    activeRequest?.track.id,
    activeRequest?.track.title,
    activeRequestId,
    playNextQueueItem,
    playPreviousQueueItem,
    requestPlaybackPause,
    requestPlaybackStart,
    seekToMs,
  ]);

  useEffect(() => {
    if (!activeRequestId) return;
    const durationMs = mediaDurationMs > 0
      ? mediaDurationMs
      : activeRequest?.track.durationMs ?? 0;
    mediaSessionBindingRef.current?.updatePlayback({
      playbackState: isPlaying ? "playing" : "paused",
      position: durationMs > 0
        ? {
            positionMs: Math.min(elapsedMsRef.current, durationMs),
            durationMs,
            playbackRate: audioRef.current?.playbackRate ?? 1,
          }
        : null,
    });
  }, [
    activeRequest?.track.durationMs,
    activeRequestId,
    isPlaying,
    mediaDurationMs,
  ]);

  const closePlayer = useCallback((afterClose?: () => void) => {
    const closingRequest = activeRequestRef.current;
    if (
      !closingRequest
      || phaseRef.current === "exiting"
      || playerExitAbortRef.current
    ) {
      return;
    }

    const transitionAbort = new AbortController();
    playerExitAbortRef.current = transitionAbort;
    const closingTrackId = closingRequest.track.id;
    const closingRequestId = closingRequest.requestId;
    let returnSnapshot: ImmersivePlaybackReturnSnapshot | null = null;
    let cancelExitOwnerTimeline: (() => void) | null = null;

    void transitionManager.run("player-detail", {
      prepare: async (transition) => {
        // The queue occurrence is the authoritative return identity. Capture it
        // once, before any exit frame can run, so delayed ended/audio/lyrics
        // callbacks cannot move the wall to a different song.
        returnSnapshot = captureImmersivePlaybackReturnSnapshot(
          closingRequestId,
          playbackQueueController.getSnapshot(),
        );
        playbackPrefetchService.invalidatePlayback("Player exit prepared");
        queuePrefetchCancelRef.current?.();
        queuePrefetchCancelRef.current = null;
        playbackLeaseRef.current = null;
        notifyImmersivePlaybackReturn(
          "prepare",
          closingRequestId,
          returnSnapshot,
        );
        persistPlaybackSession(elapsedMsRef.current, true);
        playbackSessionStore.flush();
        pauseDailyListening();
        spaceTransitionAbortRef.current?.abort(
          "Player exit superseded listening space switch",
        );
        spaceTransitionAbortRef.current = null;
        clearControlsTimer();
        clearAudioFade();
        clearTrackSwitchTimer();
        transitionTimelineCancelRef.current?.();
        transitionTimelineCancelRef.current = null;
        shouldAutoplayRef.current = false;
        settingsOpenRef.current = false;
        panelRouteRef.current = "root";
        controlsVisibleRef.current = false;
        setControlsVisible(false);
        setSettingsOpen(false);
        setPanelRoute("root");
        setSettingsStatus("");
        setSpaceTransitionPhase("stable");

        // MusicWall resolves provider + collection + sourceIndex to one exact,
        // non-clone card in its layout effect. Wait until that prepared pose is
        // painted before sampling the one exit DOMRect; no geometry is read
        // during the animation itself.
        await transition.afterPaint(1);
        const returnTarget = resolvePlayerReturnTarget(returnSnapshot);
        applyCoverGeometryStyle(playerRef.current, returnTarget.origin);
        playerRef.current?.setAttribute(
          "data-return-target",
          returnTarget.target,
        );
        phaseRef.current = "exiting";
        setPhase("exiting");
        playerRef.current?.setAttribute("data-transition-stage", "exit");
        setPlayerVisualOwner(playerRef.current, "atmosphere");
      },
      animate: async (transition) => {
        cancelExitOwnerTimeline = motionController.runStages(
          [
            { name: "atmosphere", atMs: 0 },
            {
              name: "cover-medium",
              atMs: motionTokens.playerExitStages.medium,
            },
            {
              name: "sharp-cover",
              atMs: motionTokens.playerExitStages.sharp,
            },
            {
              name: "wall-card",
              atMs: motionTokens.playerExitStages.wall,
            },
          ],
          (stage) => {
            setPlayerVisualOwner(
              playerRef.current,
              stage.name as PlayerEntryVisualOwner,
            );
          },
        );
        await transition.wait(
          prefersReducedMotion
            ? motion.playerExitReducedMs
            : motion.playerExitMs,
        );
        cancelExitOwnerTimeline?.();
        cancelExitOwnerTimeline = null;
      },
      complete: () => {
        requestGenerationRef.current.invalidateAll();
        const audio = audioRef.current;
        audio?.pause();
        audio?.removeAttribute("src");
        audio?.load();
        elapsedMsRef.current = 0;
        lyricIndexRef.current = -1;
        motionController.setPlaybackClock(0, false);
        setIsPlaying(false);
        setResolvedAudioSource(null);
        setBaseLyricDocument(null);
        setAudioState("idle");
        setPlaybackError("");
        setTrackSwitching(false);
        setMediaDurationMs(0);
        playerRef.current?.setAttribute("data-transition-stage", "idle");
        playerRef.current?.setAttribute("data-return-target", "neutral");
        setPlayerVisualOwner(playerRef.current, "wall-card");
        setActiveRequest(null);
        playbackSessionBridge.clear();
        notifyImmersivePlaybackReturn(
          "commit",
          closingRequestId,
          returnSnapshot,
        );
        notifyImmersivePlaybackLifecycleClosed(closingRequestId);
        notifyImmersivePlaybackClosed(
          returnSnapshot?.trackId ?? closingTrackId,
          returnSnapshot,
        );
        afterClose?.();
      },
    }, {
      signal: transitionAbort.signal,
    }).then((result) => {
      if (result.status === "cancelled") {
        cancelExitOwnerTimeline?.();
        cancelExitOwnerTimeline = null;
        notifyImmersivePlaybackReturn(
          "cancel",
          closingRequestId,
          returnSnapshot,
        );
        if (
          playerExitAbortRef.current === transitionAbort
          && activeRequestRef.current?.requestId === closingRequestId
        ) {
          const restoredQueue = playbackQueueController.getSnapshot();
          if (restoredQueue.current) {
            playbackLeaseRef.current = playbackPrefetchService.beginPlayback(
              restoredQueue.current,
              restoredQueue,
            );
          }
          setPhase("active");
          playerRef.current?.setAttribute("data-transition-stage", "active");
          playerRef.current?.setAttribute("data-return-target", "neutral");
          setPlayerVisualOwner(playerRef.current, "listening-space");
        }
      }
    }).finally(() => {
      cancelExitOwnerTimeline?.();
      if (playerExitAbortRef.current === transitionAbort) {
        playerExitAbortRef.current = null;
      }
    });
  }, [
    clearAudioFade,
    clearControlsTimer,
    clearTrackSwitchTimer,
    pauseDailyListening,
    persistPlaybackSession,
    playbackPrefetchService,
    prefersReducedMotion,
  ]);

  useEffect(() => {
    const handlePlaybackReset = () => closePlayer();
    window.addEventListener(
      immersivePlaybackResetEvent,
      handlePlaybackReset,
    );
    return () => window.removeEventListener(
      immersivePlaybackResetEvent,
      handlePlaybackReset,
    );
  }, [closePlayer]);

  useEffect(() => {
    const handlePlaybackRequest = (event: Event) => {
      const request = (event as CustomEvent<ImmersivePlaybackRequest>).detail;
      if (
        (request.providerId && request.providerId !== providerId)
        || (
          request.queueSeed
          && request.queueSeed.context.providerId !== providerId
        )
      ) {
        return;
      }

      playerExitAbortRef.current?.abort("New playback request superseded exit");
      playerExitAbortRef.current = null;
      spaceTransitionAbortRef.current?.abort(
        "New playback request superseded listening space switch",
      );
      spaceTransitionAbortRef.current = null;
      clearControlsTimer();
      clearAudioFade();
      clearTrackSwitchTimer();
      transitionTimelineCancelRef.current?.();
      transitionTimelineCancelRef.current = null;
      requestGenerationRef.current.invalidateAll();
      playbackPrefetchService.invalidatePlayback("New playback requested");
      playbackLeaseRef.current = null;
      playbackSessionBridge.clear();
      shouldAutoplayRef.current = true;
      pendingStartPositionRef.current = Math.max(
        0,
        request.startPositionMs ?? 0,
      );
      const audio = audioRef.current;
      pauseDailyListening();
      audio?.pause();
      applyAudioOutput(request.autoplay === false ? 1 : 0);
      audio?.removeAttribute("src");
      audio?.load();
      settingsOpenRef.current = false;
      panelRouteRef.current = "root";
      controlsVisibleRef.current = false;
      elapsedMsRef.current = 0;
      lyricIndexRef.current = -1;
      motionController.setPlaybackClock(0, false);
      const initialListeningSpace = request.restoredListeningSpace
        ?? preferredListeningSpaceRef.current;
      renderedListeningSpaceRef.current = initialListeningSpace;
      setRenderedListeningSpace(initialListeningSpace);
      setSpaceTransitionPhase("stable");
      playbackQueueController.setOrder(
        preferencesRef.current.playbackOrder,
      );
      playbackQueueController.setRepeatMode(
        preferencesRef.current.repeatMode,
      );
      if (request.restoredQueue) {
        const restored = playbackQueueController.restoreState(
          request.restoredQueue,
        );
        if (!restored) {
          playbackQueueController.initializeSingle(providerId, request.track);
        }
      } else if (request.queueSeed) {
        playbackQueueController.initialize(request.queueSeed);
      } else {
        playbackQueueController.initializeSingle(providerId, request.track);
      }
      const initialQueueSnapshot = playbackQueueController.getSnapshot();
      const initialItem = initialQueueSnapshot.current;
      const initialTrack = initialItem?.track ?? request.track;
      const initialLease = initialItem
        ? playbackPrefetchService.beginPlayback(
            initialItem,
            initialQueueSnapshot,
          )
        : playbackPrefetchService.beginSinglePlayback(initialTrack.id);
      playbackLeaseRef.current = initialLease;
      const initialRequest: ImmersivePlaybackRequest = {
        ...request,
        track: initialTrack,
        lyricsStatus: initialTrack.lyrics.length > 0 ? "ready" : "loading",
      };
      activeRequestRef.current = initialRequest;
      void motionController.preloadImage(initialTrack.coverImage);
      setActiveRequest(initialRequest);
      phaseRef.current = "entering";
      setPhase("entering");
      setElapsedMs(0);
      setLyricIndex(-1);
      setBaseLyricDocument(null);
      setMediaDurationMs(initialTrack.durationMs);
      setResolvedAudioSource(null);
      setAudioState("loading");
      setPlaybackError("");
      setIsPlaying(false);
      setControlsVisible(false);
      setSettingsOpen(false);
      setPanelRoute("root");
      setSettingsStatus("");
      trackSessionSequenceRef.current += 1;
      setTrackSessionId(
        `${request.requestId}:track:${trackSessionSequenceRef.current}`,
      );
      setTrackSwitching(false);
      playerRef.current?.setAttribute("data-transition-stage", "lock");
      playerRef.current?.setAttribute("data-return-target", "neutral");
      setPlayerVisualOwner(playerRef.current, "sharp-cover");
      void loadAudioSource(initialTrack, initialLease);
      void loadLyrics(initialTrack, request.requestId, initialLease);
      prefetchQueueWindow(initialQueueSnapshot);
      if (initialItem) {
        notifyImmersivePlaybackCurrentTrack(
          request.requestId,
          initialItem,
          playbackQueueController.getSnapshot(),
        );
      }
    };
    const handleTrackUpdate = (event: Event) => {
      const update = (
        event as CustomEvent<ImmersivePlaybackTrackUpdate>
      ).detail;

      const current = activeRequestRef.current;
      if (
        !current
        || current.requestId !== update.requestId
        || current.track.id !== update.track.id
      ) {
        return;
      }

      const audio = audioRef.current;
      const currentPosition =
        audio && Number.isFinite(audio.currentTime)
          ? Math.max(0, audio.currentTime * 1_000)
          : elapsedMsRef.current;
      const updateDocument = normalizeLyricDocument({
        provider: providerId,
        trackId: update.track.id,
        durationMs: update.track.durationMs,
        lyrics: {
          trackId: update.track.id,
          lines: update.track.lyrics,
          hasTranslation: update.track.lyrics.some(
            (line) => Boolean(line.translation),
          ),
          source: lyricDocumentRef.current?.source ?? "embedded",
        },
      });
      setBaseLyricDocument(updateDocument);
      const nextLyricIndex = getNormalizedLyricIndex(
        updateDocument,
        currentPosition,
      );
      elapsedMsRef.current = currentPosition;
      lyricIndexRef.current = nextLyricIndex;
      setElapsedMs(currentPosition);
      setLyricIndex(nextLyricIndex);
      setActiveRequest({
        ...current,
        track: update.track,
        lyricsStatus: update.lyricsStatus,
      });
    };

    window.addEventListener(immersivePlaybackEvent, handlePlaybackRequest);
    window.addEventListener(
      immersivePlaybackTrackUpdateEvent,
      handleTrackUpdate,
    );
    return () => {
      window.removeEventListener(
        immersivePlaybackEvent,
        handlePlaybackRequest,
      );
      window.removeEventListener(
        immersivePlaybackTrackUpdateEvent,
        handleTrackUpdate,
      );
    };
  }, [
    applyAudioOutput,
    clearAudioFade,
    clearControlsTimer,
    clearTrackSwitchTimer,
    loadAudioSource,
    loadLyrics,
    pauseDailyListening,
    playbackPrefetchService,
    prefetchQueueWindow,
    providerId,
  ]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const audio = audioRef.current;
      if (document.visibilityState === "hidden") {
        pauseDailyListening();
      } else if (
        audio
        && !audio.paused
        && !audio.seeking
        && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
      ) {
        beginDailyListening();
      }
    };
    const handlePageExit = () => pauseDailyListening();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageExit);
    window.addEventListener("beforeunload", handlePageExit);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageExit);
      window.removeEventListener("beforeunload", handlePageExit);
      pauseDailyListening();
    };
  }, [beginDailyListening, pauseDailyListening]);

  useEffect(() => {
    if (!activeRequestId || phase !== "entering") {
      return;
    }

    const player = playerRef.current;
    const stageScale = prefersReducedMotion
      ? motion.playerEnterReducedMs / motion.playerEnterMs
      : 1;
    const stages = [
      {
        name: "lock",
        atMs: motionTokens.playerTransitionStages.lock,
      },
      {
        name: "detach",
        atMs: motionTokens.playerTransitionStages.detach * stageScale,
      },
      {
        name: "cover-medium",
        atMs: motionTokens.playerTransitionStages.medium * stageScale,
      },
      {
        name: "atmosphere",
        atMs: motionTokens.playerTransitionStages.atmosphere * stageScale,
      },
      {
        name: "sound",
        atMs: motionTokens.playerTransitionStages.sound * stageScale,
      },
      {
        name: "active",
        atMs: motionTokens.playerTransitionStages.active * stageScale,
      },
    ] as const;

    transitionTimelineCancelRef.current = motionController.runStages(
      stages,
      (stage) => {
        player?.setAttribute("data-transition-stage", stage.name);
        const owner: PlayerEntryVisualOwner =
          stage.name === "lock" || stage.name === "detach"
            ? "sharp-cover"
            : stage.name === "cover-medium"
              ? "cover-medium"
              : stage.name === "atmosphere" || stage.name === "sound"
                ? "atmosphere"
                : "listening-space";
        setPlayerVisualOwner(player, owner);
        if (stage.name === "active") {
          setPhase("active");
          motionController.afterPaint(() => {
            if (
              activeRequestRef.current?.requestId === activeRequestId
              && phaseRef.current === "active"
            ) {
              notifyImmersivePlaybackActive(activeRequestId);
            }
          }, 2);
        }
      },
    );

    return () => {
      transitionTimelineCancelRef.current?.();
      transitionTimelineCancelRef.current = null;
    };
  }, [activeRequestId, phase, prefersReducedMotion]);

  useLayoutEffect(() => {
    if (activeRequestId && phase === "active") {
      playerRef.current?.setAttribute("data-transition-stage", "active");
    }
  }, [activeRequestId, phase]);

  useLayoutEffect(() => {
    if (activeRequestId) {
      return;
    }

    spaceTransitionAbortRef.current?.abort(
      "Listening space synchronized while player is idle",
    );
    spaceTransitionAbortRef.current = null;
    renderedListeningSpaceRef.current = preferences.listeningSpace;
    setRenderedListeningSpace(preferences.listeningSpace);
    setSpaceTransitionPhase("stable");
  }, [activeRequestId, preferences.listeningSpace]);

  useEffect(() => {
    playbackQueueController.setOrder(preferences.playbackOrder);
  }, [preferences.playbackOrder]);

  useEffect(() => {
    playbackQueueController.setRepeatMode(preferences.repeatMode);
  }, [preferences.repeatMode]);

  useEffect(() => {
    applyAudioOutput();
  }, [applyAudioOutput, preferences.muted, preferences.volume]);

  useEffect(() => {
    if (activeRequestId && queueSnapshot.current) {
      persistPlaybackSession(elapsedMsRef.current, true);
    }
  }, [
    activeRequestId,
    persistPlaybackSession,
    preferences.listeningSpace,
    preferences.muted,
    preferences.playbackOrder,
    preferences.repeatMode,
    preferences.volume,
    queueSnapshot,
  ]);

  useEffect(() => {
    const flushSession = () => playbackSessionStore.flush();
    window.addEventListener("pagehide", flushSession);
    document.addEventListener("visibilitychange", flushSession);
    return () => {
      window.removeEventListener("pagehide", flushSession);
      document.removeEventListener("visibilitychange", flushSession);
    };
  }, []);

  useEffect(() => {
    if (!activeRequestId || phase !== "active") {
      return;
    }

    const targetSpace = preferences.listeningSpace;
    if (targetSpace === renderedListeningSpaceRef.current) {
      setSpaceTransitionPhase("stable");
      return;
    }

    const transitionAbort = new AbortController();
    spaceTransitionAbortRef.current?.abort(
      "Listening space selection superseded",
    );
    spaceTransitionAbortRef.current = transitionAbort;

    void transitionManager.run(
      "listening-space",
      {
        prepare: () => {
          setSpaceTransitionPhase("exiting");
        },
        animate: async (transition) => {
          await transition.wait(
            prefersReducedMotion
              ? motionTokens.listeningSpaceSwitch.reducedExitMs
              : motionTokens.listeningSpaceSwitch.exitMs,
          );

          renderedListeningSpaceRef.current = targetSpace;
          setRenderedListeningSpace(targetSpace);
          setSpaceTransitionPhase("preparing");
          await transition.afterPaint(1);

          setSpaceTransitionPhase("entering");
          await transition.wait(
            prefersReducedMotion
              ? motionTokens.listeningSpaceSwitch.reducedEnterMs
              : motionTokens.listeningSpaceSwitch.enterMs,
          );
        },
        complete: () => {
          setSpaceTransitionPhase("stable");
        },
      },
      { signal: transitionAbort.signal },
    ).then((result) => {
      if (
        result.status === "cancelled"
        && spaceTransitionAbortRef.current === transitionAbort
        && phaseRef.current === "active"
      ) {
        setSpaceTransitionPhase("stable");
      }
    }).finally(() => {
      if (spaceTransitionAbortRef.current === transitionAbort) {
        spaceTransitionAbortRef.current = null;
      }
    });

    return () => {
      transitionAbort.abort("Listening space effect cleaned up");
    };
  }, [
    activeRequestId,
    phase,
    preferences.listeningSpace,
    prefersReducedMotion,
  ]);

  useEffect(() => {
    if (
      !activeRequestId
      || phaseRef.current !== "entering"
      || !audioSourceUrl
      || !shouldAutoplayRef.current
    ) {
      return;
    }

    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const requestId = activeRequestId;
    const startFade = () => {
      if (
        activeRequestRef.current?.requestId !== requestId
        || !shouldAutoplayRef.current
      ) {
        audioFadeTimerRef.current = null;
        return;
      }
      shouldAutoplayRef.current = false;
      const fadeStartedAt = performance.now();
      void playAudio();
      const renderFade = (now: number) => {
        const progress = Math.min(
          1,
          (now - fadeStartedAt) / motion.playerAudioFadeMs,
        );
        applyAudioOutput(progress * progress * (3 - 2 * progress));
        if (progress < 1) {
          audioFadeFrameRef.current =
            window.requestAnimationFrame(renderFade);
        } else {
          audioFadeFrameRef.current = null;
        }
      };
      audioFadeFrameRef.current = window.requestAnimationFrame(renderFade);
      audioFadeTimerRef.current = null;
    };

    audioFadeTimerRef.current = window.setTimeout(
      startFade,
      prefersReducedMotion ? 0 : motion.playerAudioFadeDelayMs,
    );
    return clearAudioFade;
  }, [
    activeRequestId,
    applyAudioOutput,
    audioSourceUrl,
    clearAudioFade,
    playAudio,
    prefersReducedMotion,
  ]);

  useEffect(() => {
    if (!activeRequestId || phase !== "active") {
      return;
    }

    playerRef.current?.focus();
    controlsVisibleRef.current = true;
    setControlsVisible(true);
    scheduleControlsHide();
  }, [activeRequestId, phase, scheduleControlsHide]);

  useEffect(() => {
    if (
      !activeRequestId
      || phase !== "active"
      || !audioSourceUrl
      || !shouldAutoplayRef.current
    ) {
      return;
    }

    shouldAutoplayRef.current = false;
    applyAudioOutput(1);
    void playAudio();
  }, [
    activeRequestId,
    applyAudioOutput,
    audioSourceUrl,
    phase,
    playAudio,
  ]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !settingsRef.current?.contains(event.target)
      ) {
        closeSettings();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [closeSettings, settingsOpen]);

  useEffect(() => {
    if (!activeRequestId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();

        if (settingsOpenRef.current) {
          if (panelRouteRef.current !== "root") {
            panelRouteRef.current = "root";
            setPanelRoute("root");
            return;
          }
          closeSettings();
          return;
        }

        closePlayer();
        return;
      }

      if (phase !== "active") {
        return;
      }

      revealInterface();
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLButtonElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        togglePlayback();
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        if (event.shiftKey) {
          if (event.key === "ArrowRight") {
            playNextQueueItem("user");
          } else {
            playPreviousQueueItem();
          }
          return;
        }
        const direction = event.key === "ArrowRight" ? 1 : -1;
        seekToMs(elapsedMsRef.current + direction * seekStepMs);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeRequestId,
    closePlayer,
    closeSettings,
    phase,
    playNextQueueItem,
    playPreviousQueueItem,
    revealInterface,
    seekToMs,
    togglePlayback,
  ]);

  useEffect(() => {
    if (activeRequestId && queueSnapshot.current) {
      prefetchQueueWindow(queueSnapshot);
    }
  }, [activeRequestId, prefetchQueueWindow, queueSnapshot]);

  useEffect(
    () => () => {
      clearControlsTimer();
      clearAudioFade();
      clearTrackSwitchTimer();
      if (panelResetTimerRef.current !== null) {
        window.clearTimeout(panelResetTimerRef.current);
        panelResetTimerRef.current = null;
      }
      transitionTimelineCancelRef.current?.();
      transitionTimelineCancelRef.current = null;
      playerExitAbortRef.current?.abort("Immersive player unmounted");
      playerExitAbortRef.current = null;
      spaceTransitionAbortRef.current?.abort(
        "Immersive player unmounted",
      );
      spaceTransitionAbortRef.current = null;
      requestGenerationRef.current.invalidateAll();
      queuePrefetchCancelRef.current?.();
      queuePrefetchCancelRef.current = null;
      playbackPrefetchService.invalidatePlayback("Player unmounted");
      playbackLeaseRef.current = null;
      playbackSessionBridge.clear();
      playbackSessionStore.flush();
      mediaSessionBindingRef.current?.cleanup();
      mediaSessionBindingRef.current = null;
      mediaSessionControllerRef.current?.cleanup();
      pauseDailyListening();
      audioRef.current?.pause();
      motionController.setPlaybackClock(0, false);
    },
    [
      clearAudioFade,
      clearControlsTimer,
      clearTrackSwitchTimer,
      pauseDailyListening,
      playbackPrefetchService,
    ],
  );

  useEffect(() => {
    if (!activeRequestId) {
      return;
    }

    const durationMs =
      mediaDurationMs > 0
        ? mediaDurationMs
        : activeTrackDurationMs;
    paintPlaybackProgress(elapsedMsRef.current, durationMs);

    return motionController.subscribeFrame((now) => {
      if (now - lastProgressPaintAtRef.current < 80) {
        return;
      }
      lastProgressPaintAtRef.current = now;
      paintPlaybackProgress(
        motionController.readPlaybackTime(now),
        durationMs,
      );
    });
  }, [
    activeRequestId,
    activeTrackDurationMs,
    mediaDurationMs,
    paintPlaybackProgress,
  ]);

  const responseScale =
    preferences.animationIntensity === "low"
      ? 0.45
      : preferences.animationIntensity === "high"
        ? 1.18
        : 1;
  const responseEnabled = preferences.audioResponseEnabled;
  const listeningSpaceDefinition = getListeningSpaceDefinition(
    renderedListeningSpace,
  );
  const atmosphereSpace = listeningSpaceDefinition.atmosphereSpace;

  if (!activeRequest) {
    return (
      <section
        className="immersive-player"
        ref={playerRef}
        tabIndex={-1}
        data-presence="idle"
        data-phase="idle"
        data-player-theme={resolvedThemeId}
        data-animation-intensity={preferences.animationIntensity}
        data-particles-enabled={preferences.particlesEnabled}
        data-audio-response-enabled={preferences.audioResponseEnabled}
        data-listening-space={renderedListeningSpace}
        data-cover-transition={
          listeningSpaceDefinition.metadata.coverTransition
        }
        data-space-transition={spaceTransitionPhase}
        aria-hidden="true"
        inert
      >
        <audio
          className="immersive-player__audio"
          ref={audioRef}
          preload="metadata"
          playsInline
        />
        <div className="immersive-player__blackout" aria-hidden="true" />
        {atmosphereSpace ? (
          <AtmosphereEngine
            active={false}
            intensity={preferences.animationIntensity}
            particlesEnabled={preferences.particlesEnabled}
            quality={preferences.particleQuality}
            space={atmosphereSpace}
            theme={resolvedThemeId}
            responseEnabled={responseEnabled}
            responseScale={responseScale}
            soundResponseActive={false}
          />
        ) : null}
      </section>
    );
  }

  const activeTrack = activeRequest.track;
  const playbackDurationMs =
    mediaDurationMs > 0 ? mediaDurationMs : activeTrack.durationMs;
  const visualStyle = createPlayerVisualStyle(activeRequest);

  return (
    <section
      className="immersive-player"
      ref={playerRef}
      tabIndex={-1}
      style={visualStyle}
      data-presence="open"
      data-phase={phase}
      data-controls-visible={controlsVisible}
      data-player-theme={resolvedThemeId}
      data-settings-open={settingsOpen}
      data-animation-intensity={preferences.animationIntensity}
      data-particles-enabled={preferences.particlesEnabled}
      data-audio-response-enabled={preferences.audioResponseEnabled}
      data-listening-space={renderedListeningSpace}
      data-listening-space-target={preferences.listeningSpace}
      data-cover-transition={
        listeningSpaceDefinition.metadata.coverTransition
      }
      data-space-transition={spaceTransitionPhase}
      data-track-switching={trackSwitching}
      aria-label={t("player.aria", { title: activeTrack.title })}
      onPointerMove={revealInterface}
      onPointerDown={revealInterface}
    >
      <audio
        className="immersive-player__audio"
        key={trackSessionId}
        ref={audioRef}
        src={audioSourceUrl || undefined}
        preload="metadata"
        playsInline
        onCanPlay={(event) => {
          if (event.currentTarget !== audioRef.current) return;
          applyAudioOutput();
          const audio = audioRef.current;
          if (audio && pendingStartPositionRef.current > 0) {
            const maximum = Number.isFinite(audio.duration)
              ? audio.duration * 1_000
              : playbackDurationMs;
            const startMs = Math.min(
              pendingStartPositionRef.current,
              Math.max(0, maximum),
            );
            audio.currentTime = startMs / 1_000;
            pendingStartPositionRef.current = 0;
            commitPlaybackPosition(startMs, false, maximum, true);
          }
          setAudioState("ready");
          setPlaybackError("");
        }}
        onPlay={(event) => {
          if (event.currentTarget !== audioRef.current) return;
          setAudioState("ready");
          setIsPlaying(true);
          commitPlaybackPosition(
            audioRef.current?.currentTime
              ? audioRef.current.currentTime * 1_000
              : elapsedMsRef.current,
            true,
            playbackDurationMs,
            true,
          );
        }}
        onPlaying={(event) => {
          if (event.currentTarget === audioRef.current) {
            beginDailyListening();
          }
        }}
        onPause={(event) => {
          if (event.currentTarget !== audioRef.current) return;
          pauseDailyListening();
          setIsPlaying(false);
          commitPlaybackPosition(
            event.currentTarget.currentTime * 1_000,
            false,
            playbackDurationMs,
            true,
          );
          playbackSessionStore.flush();
        }}
        onEnded={(event) => {
          if (event.currentTarget !== audioRef.current) {
            return;
          }
          pauseDailyListening();
          setIsPlaying(false);
          commitPlaybackPosition(
            playbackDurationMs,
            false,
            playbackDurationMs,
            true,
          );
          playNextQueueItem("ended");
        }}
        onWaiting={(event) => {
          if (event.currentTarget === audioRef.current) {
            pauseDailyListening();
            motionController.setPlaybackClock(
              event.currentTarget.currentTime * 1_000,
              false,
            );
          }
        }}
        onStalled={(event) => {
          if (event.currentTarget === audioRef.current) {
            pauseDailyListening();
            motionController.setPlaybackClock(
              event.currentTarget.currentTime * 1_000,
              false,
            );
          }
        }}
        onSeeking={(event) => {
          if (event.currentTarget === audioRef.current) {
            pauseDailyListening();
            motionController.setPlaybackClock(
              event.currentTarget.currentTime * 1_000,
              false,
            );
          }
        }}
        onSeeked={(event) => {
          if (
            event.currentTarget === audioRef.current
            && !event.currentTarget.paused
            && event.currentTarget.readyState
              >= HTMLMediaElement.HAVE_FUTURE_DATA
          ) {
            beginDailyListening();
            motionController.setPlaybackClock(
              event.currentTarget.currentTime * 1_000,
              true,
            );
          }
          persistPlaybackSession(
            event.currentTarget.currentTime * 1_000,
            true,
          );
          playbackSessionStore.flush();
        }}
        onTimeUpdate={(event) => {
          if (event.currentTarget !== audioRef.current) return;
          commitPlaybackPosition(
            event.currentTarget.currentTime * 1_000,
            !event.currentTarget.paused,
            playbackDurationMs,
          );
        }}
        onDurationChange={(event) => {
          if (event.currentTarget !== audioRef.current) return;
          const durationMs = event.currentTarget.duration * 1_000;
          if (Number.isFinite(durationMs) && durationMs > 0) {
            setMediaDurationMs(durationMs);
            paintPlaybackProgress(elapsedMsRef.current, durationMs);
          }
        }}
        onError={(event) => {
          if (
            event.currentTarget !== audioRef.current
            || !audioSourceUrl
          ) {
            return;
          }
          pauseDailyListening();
          playbackPrefetchService.evictAudio(activeTrack.id);
          shouldAutoplayRef.current = false;
          setAudioState("error");
          setIsPlaying(false);
          setPlaybackError(
            t("player.error.expired"),
          );
        }}
      />
      <div className="immersive-player__blackout" aria-hidden="true" />
      {atmosphereSpace ? (
        <AtmosphereEngine
          active={phase !== "exiting"}
          intensity={preferences.animationIntensity}
          particlesEnabled={preferences.particlesEnabled}
          quality={preferences.particleQuality}
          space={atmosphereSpace}
          theme={resolvedThemeId}
          responseEnabled={responseEnabled}
          responseScale={responseScale}
          soundResponseActive={phase === "active"}
        />
      ) : null}

      <TransitionLayer track={activeTrack} />

      <header className="immersive-player__header">
        <button
          className="immersive-player__close"
          type="button"
          aria-label={t("player.close")}
          onClick={() => closePlayer()}
        >
          CLOSE
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <ListeningSpaceRenderer
        mode={renderedListeningSpace}
        playbackSessionId={trackSessionId}
        track={listeningTrack ?? activeTrack}
        lyrics={lyricDocument}
        activeIndex={lyricIndex}
        elapsedMs={elapsedMs}
        durationMs={playbackDurationMs}
        isPlaying={isPlaying}
        lyricsStatus={activeRequest.lyricsStatus}
        showOriginalLyrics={preferences.showOriginalLyrics}
        showTranslation={preferences.showTranslation}
        animationIntensity={preferences.animationIntensity}
        audioResponseEnabled={preferences.audioResponseEnabled}
        audioAnalysisSource={
          resolvedAudioSource?.trackId === activeTrack.id
            ? {
                trackId: resolvedAudioSource.trackId,
                url: resolvedAudioSource.url,
                size: resolvedAudioSource.size,
              }
            : null
        }
        onSeek={seekToMs}
      />
      <LyricDiagnosticsOverlay
        document={lyricDocument}
        trackId={activeTrack.id}
        elapsedMs={elapsedMs}
        activeIndex={lyricIndex}
        wordIndex={getNormalizedLyricWordIndex(
          lyricDocument,
          lyricIndex,
          elapsedMs,
        )}
        playerTimeMs={elapsedMsRef.current}
        deviationMs={elapsedMsRef.current - elapsedMs}
        readElapsedMs={readDiagnosticsElapsedMs}
        readPlayerTimeMs={readDiagnosticsPlayerTimeMs}
      />

      <p
        className="immersive-player__playback-status"
        data-state={audioState}
        data-visible={audioState === "loading" || Boolean(playbackError)}
        role="status"
        aria-live="polite"
      >
        {
          audioState === "loading"
            ? t("player.connecting", { provider: providerName })
            : playbackError || "\u00A0"
        }
      </p>

      <footer className="immersive-player__controls">
        <div className="immersive-player__control-track">
          <strong lang="ja">{activeTrack.title}</strong>
          <span>{activeTrack.artist}</span>
        </div>

        <div className="immersive-player__timeline">
          <span ref={elapsedLabelRef}>{formatTime(elapsedMs)}</span>
          <input
            ref={progressInputRef}
            type="range"
            min="0"
            max={playbackDurationMs}
            step="100"
            defaultValue={elapsedMs}
            aria-label={t("player.progress")}
            onChange={(event) => {
              seekToMs(Number(event.target.value));
              revealInterface();
            }}
          />
          <span>{formatTime(playbackDurationMs)}</span>
        </div>

        <div className="immersive-player__transport">
          <button
            className="immersive-player__transport-skip"
            type="button"
            aria-label={t("common.previousTrack")}
            disabled={!queueSnapshot.current}
            onClick={() => {
              playPreviousQueueItem();
              revealInterface();
            }}
          >
            <span aria-hidden="true">|◀</span>
          </button>
          <button
            className="immersive-player__toggle"
            type="button"
            aria-label={
              isPlaying
                ? t("common.pause")
                : audioState === "error"
                  ? t("common.retryPlay")
                  : t("common.play")
            }
            onClick={() => {
              togglePlayback();
              revealInterface();
            }}
          >
            <span aria-hidden="true">
              {isPlaying ? "Ⅱ" : audioState === "loading" ? "…" : "▶"}
            </span>
            {
              isPlaying
                ? "PAUSE"
                : audioState === "loading"
                  ? "LOADING"
                  : audioState === "error"
                    ? "RETRY"
                    : "PLAY"
            }
          </button>
          <button
            className="immersive-player__transport-skip"
            type="button"
            aria-label={t("common.nextTrack")}
            disabled={!playbackQueueController.canAdvance("user")}
            onClick={() => {
              playNextQueueItem("user");
              revealInterface();
            }}
          >
            <span aria-hidden="true">▶|</span>
          </button>
          <span className="immersive-player__shortcut-hint">
            SPACE PLAY / ← → SEEK / SHIFT + ← → TRACK / ESC CLOSE
          </span>
        </div>
      </footer>

      <div
        className="immersive-player__user"
        data-open={settingsOpen}
        ref={settingsRef}
      >
        <button
          className="immersive-player__avatar"
          type="button"
          ref={avatarRef}
          aria-label={t("player.settings.open", { provider: providerName })}
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          aria-controls="immersive-player-settings"
          onClick={toggleSettings}
        >
          <span className="immersive-player__avatar-image">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <circle cx="16" cy="11" r="6" />
                <path d="M5.5 29c.8-7 4.3-10.5 10.5-10.5S25.7 22 26.5 29Z" />
              </svg>
            )}
          </span>
          <span className="immersive-player__sync-dot" aria-hidden="true" />
        </button>

        <PlayerControlPanel
          open={settingsOpen}
          route={panelRoute}
          preferences={preferences}
          resolvedThemeId={resolvedThemeId}
          themePreference={preference}
          user={user}
          providerName={providerName}
          onRouteChange={(nextRoute) => {
            panelRouteRef.current = nextRoute;
            setPanelRoute(nextRoute);
          }}
          onRequestClose={closeSettings}
          onPreferenceChange={updatePreference}
          onThemePreferenceChange={setPreference}
          onActivateQueueItem={(item) => {
            activateQueueItem(item, { autoplay: true });
          }}
          onAccountManage={onLogout
            ? () => {
                setSettingsStatus(t("player.settings.signingOut", {
                  provider: providerName,
                }));
                closePlayer(() => {
                  void onLogout();
                });
              }
            : undefined}
          onInteraction={revealInterface}
        />
      </div>
    </section>
  );
}
