import type { LyricsStatus, Track } from "../../types/music";
import type { MusicProviderId } from "../../providers/MusicProvider";
import { motionController } from "../../config/MotionController";
import {
  prewarmAtmosphereEngine,
  type AtmospherePrewarmOptions,
} from "./AtmosphereEngine";
import type {
  PlaybackQueueItem,
  PlaybackQueueRestorableState,
  PlaybackQueueSeed,
  PlaybackQueueSnapshot,
} from "./PlaybackQueueController";
import type { RestoredPlaybackSession } from "./PlaybackSessionStore";
import type { ImmersivePlaybackReturnSnapshot } from "./PlaybackReturnSnapshot";

export type { ImmersivePlaybackReturnSnapshot } from "./PlaybackReturnSnapshot";

export const immersivePlaybackEvent = "tingjing:immersive-play";
export const immersivePlaybackClosedEvent = "tingjing:immersive-close";
export const immersivePlaybackTrackUpdateEvent =
  "tingjing:immersive-track-update";
export const immersivePlaybackLifecycleEvent =
  "tingjing:immersive-lifecycle";
export const immersivePlaybackCurrentTrackEvent =
  "tingjing:immersive-current-track";
export const immersivePlaybackReturnEvent =
  "tingjing:immersive-return";
export const immersivePlaybackResetEvent =
  "tingjing:immersive-reset";

export type ImmersivePlaybackLifecyclePhase = "active" | "closed";

export interface ImmersivePlaybackLifecycle {
  requestId: string;
  phase: ImmersivePlaybackLifecyclePhase;
}

export type PlaybackSource =
  | "playlist-track"
  | "playlist-play-all"
  | "cover-double-click"
  | "cover-space"
  | "music-wall"
  | "music-wall-double-click"
  | "music-wall-space"
  | "session-restore";

export interface ImmersivePlaybackRequest {
  requestId: string;
  track: Track;
  lyricsStatus: LyricsStatus;
  source: PlaybackSource;
  requestedAt: number;
  providerId?: MusicProviderId;
  origin?: PlaybackOrigin;
  queueSeed?: PlaybackQueueSeed;
  startPositionMs?: number;
  autoplay?: boolean;
  restoredQueue?: PlaybackQueueRestorableState;
  restoredListeningSpace?: RestoredPlaybackSession["listeningSpace"];
}

export interface ImmersivePlaybackTrackUpdate {
  requestId: string;
  track: Track;
  lyricsStatus: LyricsStatus;
}

export interface PlaybackOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ImmersivePlaybackCurrentTrack {
  requestId: string;
  trackId: string;
  queueItemId: string;
  sourceIndex: number | null;
  collectionId: string | null;
  providerId: PlaybackQueueSnapshot["providerId"];
}

export type ImmersivePlaybackReturnPhase = "prepare" | "commit" | "cancel";

export interface ImmersivePlaybackReturnTransition {
  phase: ImmersivePlaybackReturnPhase;
  requestId: string;
  snapshot: ImmersivePlaybackReturnSnapshot | null;
}

export interface ImmersivePlaybackClosed {
  trackId: string;
  returnSnapshot: ImmersivePlaybackReturnSnapshot | null;
}

let playbackRequestSequence = 0;
const playbackLifecycle = new Map<
  string,
  ImmersivePlaybackLifecyclePhase
>();

function dispatchPlaybackLifecycle(
  requestId: string,
  phase: ImmersivePlaybackLifecyclePhase,
) {
  playbackLifecycle.set(requestId, phase);
  while (playbackLifecycle.size > 24) {
    const oldestRequestId = playbackLifecycle.keys().next().value as
      | string
      | undefined;
    if (!oldestRequestId) {
      break;
    }
    playbackLifecycle.delete(oldestRequestId);
  }

  window.dispatchEvent(
    new CustomEvent<ImmersivePlaybackLifecycle>(
      immersivePlaybackLifecycleEvent,
      { detail: { requestId, phase } },
    ),
  );
}

export function notifyImmersivePlaybackActive(requestId: string) {
  dispatchPlaybackLifecycle(requestId, "active");
}

export function waitForImmersivePlaybackPhase(
  requestId: string,
  phase: ImmersivePlaybackLifecyclePhase,
  signal?: AbortSignal,
) {
  if (playbackLifecycle.get(requestId) === phase) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener(
        immersivePlaybackLifecycleEvent,
        handleLifecycle,
      );
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleLifecycle = (event: Event) => {
      const lifecycle = (
        event as CustomEvent<ImmersivePlaybackLifecycle>
      ).detail;
      if (
        lifecycle.requestId !== requestId
        || lifecycle.phase !== phase
      ) {
        return;
      }
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      cleanup();
      const error = new Error("Playback transition cancelled");
      error.name = "AbortError";
      reject(error);
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    window.addEventListener(
      immersivePlaybackLifecycleEvent,
      handleLifecycle,
    );
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function createPlaybackRequest(
  track: Track,
  source: PlaybackSource,
  origin?: PlaybackOrigin,
  lyricsStatus: LyricsStatus = track.lyrics.length > 0 ? "ready" : "empty",
  queueSeed?: PlaybackQueueSeed,
  providerId?: MusicProviderId,
  startPositionMs?: number,
): ImmersivePlaybackRequest {
  playbackRequestSequence += 1;
  return {
    requestId: `${Date.now()}:${playbackRequestSequence}`,
    track,
    lyricsStatus,
    source,
    requestedAt: Date.now(),
    providerId: providerId ?? queueSeed?.context.providerId,
    origin,
    queueSeed,
    startPositionMs:
      Number.isFinite(startPositionMs) && (startPositionMs ?? 0) > 0
        ? Math.max(0, startPositionMs as number)
        : undefined,
  };
}

function dispatchPlaybackRequest(request: ImmersivePlaybackRequest) {
  window.dispatchEvent(
    new CustomEvent<ImmersivePlaybackRequest>(immersivePlaybackEvent, {
      detail: request,
    }),
  );
}

export type ImmersivePlaybackPrewarmOptions = AtmospherePrewarmOptions;

export function prewarmImmersivePlayback(
  track: Track,
  atmosphere?: ImmersivePlaybackPrewarmOptions,
) {
  prewarmAtmosphereEngine(atmosphere);
  return motionController.preloadImage(track.coverImage);
}

export function requestImmersivePlayback(
  track: Track,
  source: PlaybackSource,
  origin?: PlaybackOrigin,
  lyricsStatus?: LyricsStatus,
  queueSeed?: PlaybackQueueSeed,
  providerId?: MusicProviderId,
  startPositionMs?: number,
) {
  const request = createPlaybackRequest(
    track,
    source,
    origin,
    lyricsStatus,
    queueSeed,
    providerId,
    startPositionMs,
  );

  void motionController.preloadImage(track.coverImage);

  motionController.afterPaint(() => {
    dispatchPlaybackRequest(request);
  });

  return request;
}

export function requestImmersivePlaybackImmediately(
  track: Track,
  source: PlaybackSource,
  origin?: PlaybackOrigin,
  lyricsStatus?: LyricsStatus,
  queueSeed?: PlaybackQueueSeed,
  providerId?: MusicProviderId,
  startPositionMs?: number,
) {
  const request = createPlaybackRequest(
    track,
    source,
    origin,
    lyricsStatus,
    queueSeed,
    providerId,
    startPositionMs,
  );
  void motionController.preloadImage(track.coverImage);
  dispatchPlaybackRequest(request);
  return request;
}

/**
 * Reopens a persisted session without inventing a Music Wall origin. The
 * player owns validation of the refreshed audio/lyrics responses and must
 * restore this request paused.
 */
export function requestImmersivePlaybackRestore(
  session: RestoredPlaybackSession,
) {
  const current = session.queue.snapshot.current;
  if (!current || session.queue.snapshot.providerId !== session.providerId) {
    return null;
  }
  const request: ImmersivePlaybackRequest = {
    ...createPlaybackRequest(
      current.track,
      "session-restore",
      undefined,
      current.track.lyrics.length > 0 ? "ready" : "loading",
      undefined,
      session.providerId,
      session.positionMs,
    ),
    autoplay: false,
    restoredQueue: session.queue,
    restoredListeningSpace: session.listeningSpace,
  };
  void motionController.preloadImage(current.track.coverImage);
  motionController.afterPaint(() => dispatchPlaybackRequest(request));
  return request;
}

export function updateImmersivePlaybackTrack(
  requestId: string,
  track: Track,
  lyricsStatus: LyricsStatus = track.lyrics.length > 0 ? "ready" : "empty",
) {
  const update: ImmersivePlaybackTrackUpdate = {
    requestId,
    track,
    lyricsStatus,
  };
  motionController.afterPaint(() => {
    window.dispatchEvent(
      new CustomEvent<ImmersivePlaybackTrackUpdate>(
        immersivePlaybackTrackUpdateEvent,
        { detail: update },
      ),
    );
  });
}

export function notifyImmersivePlaybackClosed(
  trackId: string,
  returnSnapshot: ImmersivePlaybackReturnSnapshot | null = null,
) {
  window.dispatchEvent(
    new CustomEvent<ImmersivePlaybackClosed>(immersivePlaybackClosedEvent, {
      detail: { trackId, returnSnapshot },
    }),
  );
}

export function notifyImmersivePlaybackReturn(
  phase: ImmersivePlaybackReturnPhase,
  requestId: string,
  snapshot: ImmersivePlaybackReturnSnapshot | null,
) {
  window.dispatchEvent(
    new CustomEvent<ImmersivePlaybackReturnTransition>(
      immersivePlaybackReturnEvent,
      { detail: { phase, requestId, snapshot } },
    ),
  );
}

export function notifyImmersivePlaybackLifecycleClosed(requestId: string) {
  dispatchPlaybackLifecycle(requestId, "closed");
}

export function resetImmersivePlaybackSession() {
  playbackLifecycle.clear();
  window.dispatchEvent(new Event(immersivePlaybackResetEvent));
}

export function notifyImmersivePlaybackCurrentTrack(
  requestId: string,
  item: PlaybackQueueItem,
  queue: PlaybackQueueSnapshot,
) {
  window.dispatchEvent(
    new CustomEvent<ImmersivePlaybackCurrentTrack>(
      immersivePlaybackCurrentTrackEvent,
      {
        detail: {
          requestId,
          trackId: item.track.id,
          queueItemId: item.queueItemId,
          sourceIndex: item.sourceIndex,
          collectionId: item.origin === "collection"
            ? queue.context?.collectionId ?? null
            : null,
          providerId: queue.providerId,
        },
      },
    ),
  );
}
