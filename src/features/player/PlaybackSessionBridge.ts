export interface PlaybackSessionSnapshot {
  requestId: string | null;
  queueItemId: string | null;
  trackId: string | null;
  elapsedMs: number;
  durationMs: number;
  isPlaying: boolean;
  canSeek: boolean;
}

const emptySnapshot: PlaybackSessionSnapshot = Object.freeze({
  requestId: null,
  queueItemId: null,
  trackId: null,
  elapsedMs: 0,
  durationMs: 0,
  isPlaying: false,
  canSeek: false,
});

class PlaybackSessionBridge {
  private snapshot = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private seekHandler: ((trackId: string, positionMs: number) => boolean) | null =
    null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  publish(next: PlaybackSessionSnapshot) {
    const unchanged = Object.entries(next).every(
      ([key, value]) => this.snapshot[key as keyof PlaybackSessionSnapshot] === value,
    );
    if (unchanged) return;
    this.snapshot = Object.freeze({ ...next });
    this.listeners.forEach((listener) => listener());
  }

  bindSeek(handler: (trackId: string, positionMs: number) => boolean) {
    this.seekHandler = handler;
    return () => {
      if (this.seekHandler === handler) this.seekHandler = null;
    };
  }

  requestSeek(trackId: string, positionMs: number) {
    return this.seekHandler?.(trackId, positionMs) ?? false;
  }

  clear() {
    this.publish(emptySnapshot);
  }
}

export const playbackSessionBridge = new PlaybackSessionBridge();
