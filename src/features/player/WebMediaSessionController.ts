export type WebMediaSessionAction =
  | "play"
  | "pause"
  | "previoustrack"
  | "nexttrack"
  | "seekto"
  | "seekforward"
  | "seekbackward";

export type WebMediaSessionPlaybackState = "none" | "paused" | "playing";

export interface WebMediaSessionActionDetails {
  action: WebMediaSessionAction;
  seekOffset?: number;
  seekTime?: number;
  fastSeek?: boolean;
}

export interface WebMediaSessionPositionState {
  duration: number;
  playbackRate: number;
  position: number;
}

export interface WebMediaSessionLike {
  metadata: unknown | null;
  playbackState: WebMediaSessionPlaybackState;
  setActionHandler(
    action: WebMediaSessionAction,
    handler: ((details: WebMediaSessionActionDetails) => void) | null,
  ): void;
  setPositionState(state?: WebMediaSessionPositionState): void;
}

export interface WebMediaSessionArtwork {
  src: string;
  sizes?: string;
  type?: string;
}

export interface WebMediaSessionMetadata {
  title: string;
  artist?: string;
  album?: string;
  artwork?: readonly WebMediaSessionArtwork[];
}

export interface WebMediaSessionActionHandlers {
  play?: () => void;
  pause?: () => void;
  previousTrack?: () => void;
  nextTrack?: () => void;
  seekTo?: (positionMs: number, fastSeek: boolean) => void;
  seekForward?: (offsetMs: number) => void;
  seekBackward?: (offsetMs: number) => void;
}

export interface WebMediaSessionPosition {
  positionMs: number;
  durationMs: number;
  playbackRate?: number;
}

export interface WebMediaSessionPlaybackUpdate {
  playbackState: WebMediaSessionPlaybackState;
  /** Omit to retain the current position, or pass null to clear it. */
  position?: WebMediaSessionPosition | null;
}

export interface WebMediaSessionBindOptions {
  handlers: WebMediaSessionActionHandlers;
  metadata?: WebMediaSessionMetadata | null;
  playback?: WebMediaSessionPlaybackUpdate;
}

export interface WebMediaSessionBinding {
  updateMetadata(metadata: WebMediaSessionMetadata | null): void;
  updatePlayback(update: WebMediaSessionPlaybackUpdate): void;
  cleanup(): void;
}

export interface WebMediaSessionControllerOptions {
  /** Omit to use navigator.mediaSession; pass null for an explicit no-op port. */
  session?: WebMediaSessionLike | null;
  createMetadata?: (metadata: WebMediaSessionMetadata) => unknown;
  defaultSeekOffsetMs?: number;
}

interface ActiveBinding {
  readonly token: symbol;
  readonly registeredActions: Set<WebMediaSessionAction>;
  durationMs: number | null;
  closed: boolean;
}

const defaultSeekOffsetMs = 5_000;

function resolveBrowserMediaSession(): WebMediaSessionLike | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return null;
  }
  return navigator.mediaSession as WebMediaSessionLike;
}

function createBrowserMetadata(metadata: WebMediaSessionMetadata): unknown {
  if (typeof MediaMetadata === "undefined") {
    return null;
  }
  return new MediaMetadata({
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    artwork: metadata.artwork?.map((item) => ({ ...item })),
  });
}

function finitePositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function legalPositionState(
  position: WebMediaSessionPosition,
): WebMediaSessionPositionState | null {
  if (
    !finitePositive(position.durationMs)
    || !Number.isFinite(position.positionMs)
  ) {
    return null;
  }

  const playbackRate = position.playbackRate ?? 1;
  if (!finitePositive(playbackRate)) {
    return null;
  }

  return {
    duration: position.durationMs / 1_000,
    playbackRate,
    position: Math.min(
      position.durationMs,
      Math.max(0, position.positionMs),
    ) / 1_000,
  };
}

export class WebMediaSessionController {
  private readonly session: WebMediaSessionLike | null;
  private readonly createMetadata: (
    metadata: WebMediaSessionMetadata,
  ) => unknown;
  private readonly seekOffsetMs: number;
  private activeBinding: ActiveBinding | null = null;

  constructor(options: WebMediaSessionControllerOptions = {}) {
    this.session = options.session === undefined
      ? resolveBrowserMediaSession()
      : options.session;
    this.createMetadata = options.createMetadata ?? createBrowserMetadata;
    this.seekOffsetMs = finitePositive(options.defaultSeekOffsetMs)
      ? options.defaultSeekOffsetMs
      : defaultSeekOffsetMs;
  }

  bind(options: WebMediaSessionBindOptions): WebMediaSessionBinding {
    this.cleanup();

    const active: ActiveBinding = {
      token: Symbol("web-media-session-owner"),
      registeredActions: new Set(),
      durationMs: null,
      closed: false,
    };
    this.activeBinding = active;
    this.registerHandlers(active, options.handlers);

    if (options.metadata !== undefined) {
      this.updateMetadata(active, options.metadata);
    }
    if (options.playback) {
      this.updatePlayback(active, options.playback);
    }

    return {
      updateMetadata: (metadata) => this.updateMetadata(active, metadata),
      updatePlayback: (update) => this.updatePlayback(active, update),
      cleanup: () => this.cleanupBinding(active),
    };
  }

  cleanup() {
    if (this.activeBinding) {
      this.cleanupBinding(this.activeBinding);
    }
  }

  private owns(active: ActiveBinding) {
    return !active.closed
      && this.activeBinding?.token === active.token;
  }

  private safelySetActionHandler(
    active: ActiveBinding,
    action: WebMediaSessionAction,
    handler: ((details: WebMediaSessionActionDetails) => void) | null,
  ) {
    if (!this.session) return false;
    try {
      this.session.setActionHandler(action, handler);
      if (handler) active.registeredActions.add(action);
      else active.registeredActions.delete(action);
      return true;
    } catch {
      return false;
    }
  }

  private registerHandlers(
    active: ActiveBinding,
    handlers: WebMediaSessionActionHandlers,
  ) {
    const guard = (
      handler: (details: WebMediaSessionActionDetails) => void,
    ) => (details: WebMediaSessionActionDetails) => {
      if (this.owns(active)) handler(details);
    };

    if (handlers.play) {
      this.safelySetActionHandler(
        active,
        "play",
        guard(() => handlers.play?.()),
      );
    }
    if (handlers.pause) {
      this.safelySetActionHandler(
        active,
        "pause",
        guard(() => handlers.pause?.()),
      );
    }
    if (handlers.previousTrack) {
      this.safelySetActionHandler(
        active,
        "previoustrack",
        guard(() => handlers.previousTrack?.()),
      );
    }
    if (handlers.nextTrack) {
      this.safelySetActionHandler(
        active,
        "nexttrack",
        guard(() => handlers.nextTrack?.()),
      );
    }
    if (handlers.seekTo) {
      this.safelySetActionHandler(
        active,
        "seekto",
        guard((details) => {
          if (
            typeof details.seekTime !== "number"
            || !Number.isFinite(details.seekTime)
            || details.seekTime < 0
          ) {
            return;
          }
          const requestedMs = details.seekTime * 1_000;
          const durationMs = active.durationMs;
          const positionMs = durationMs !== null && finitePositive(durationMs)
            ? Math.min(requestedMs, durationMs)
            : requestedMs;
          if (Number.isFinite(positionMs)) {
            handlers.seekTo?.(positionMs, Boolean(details.fastSeek));
          }
        }),
      );
    }
    if (handlers.seekForward) {
      this.safelySetActionHandler(
        active,
        "seekforward",
        guard((details) => {
          const requestedSeconds = details.seekOffset;
          const offsetMs = finitePositive(requestedSeconds)
            ? requestedSeconds * 1_000
            : this.seekOffsetMs;
          handlers.seekForward?.(offsetMs);
        }),
      );
    }
    if (handlers.seekBackward) {
      this.safelySetActionHandler(
        active,
        "seekbackward",
        guard((details) => {
          const requestedSeconds = details.seekOffset;
          const offsetMs = finitePositive(requestedSeconds)
            ? requestedSeconds * 1_000
            : this.seekOffsetMs;
          handlers.seekBackward?.(offsetMs);
        }),
      );
    }
  }

  private updateMetadata(
    active: ActiveBinding,
    metadata: WebMediaSessionMetadata | null,
  ) {
    if (!this.owns(active) || !this.session) return;
    try {
      this.session.metadata = metadata
        ? this.createMetadata(metadata)
        : null;
    } catch {
      // Artwork and metadata support can vary independently of action support.
    }
  }

  private updatePlayback(
    active: ActiveBinding,
    update: WebMediaSessionPlaybackUpdate,
  ) {
    if (!this.owns(active) || !this.session) return;

    try {
      this.session.playbackState = update.playbackState;
    } catch {
      // A partial implementation must not disable the remaining integration.
    }

    if (update.position === undefined) return;
    if (update.position === null) {
      active.durationMs = null;
      this.clearPositionState();
      return;
    }

    const state = legalPositionState(update.position);
    if (!state) {
      active.durationMs = null;
      this.clearPositionState();
      return;
    }

    active.durationMs = update.position.durationMs;
    try {
      this.session.setPositionState(state);
    } catch {
      // setPositionState is independently optional in WebKit implementations.
    }
  }

  private clearPositionState() {
    if (!this.session) return;
    try {
      this.session.setPositionState();
    } catch {
      // Clearing an unsupported position state is a no-op.
    }
  }

  private cleanupBinding(active: ActiveBinding) {
    if (!this.owns(active)) return;
    active.closed = true;

    for (const action of [...active.registeredActions]) {
      this.safelySetActionHandler(active, action, null);
    }
    active.registeredActions.clear();

    if (this.session) {
      try {
        this.session.metadata = null;
      } catch {
        // Metadata cleanup is best effort on partial implementations.
      }
      try {
        this.session.playbackState = "none";
      } catch {
        // Playback-state cleanup is best effort on partial implementations.
      }
      this.clearPositionState();
    }

    if (this.activeBinding?.token === active.token) {
      this.activeBinding = null;
    }
  }
}
