import { imageCache } from "./ImageCache";
import type {
  DeferredImagePreloadOptions,
  ImagePreloadOptions,
} from "./ImageCache";

export interface PlaybackClockSnapshot {
  elapsedMs: number;
  capturedAt: number;
  isPlaying: boolean;
}

export interface MotionStage {
  atMs: number;
  name: string;
}

type FrameSubscriber = (now: number, deltaMs: number) => void;

function canUseDom() {
  return typeof window !== "undefined";
}

class MotionController {
  private subscribers = new Set<FrameSubscriber>();
  private frameId: number | null = null;
  private lastFrameAt = 0;
  private playbackClock: PlaybackClockSnapshot = {
    elapsedMs: 0,
    capturedAt: 0,
    isPlaying: false,
  };

  setPlaybackClock(
    elapsedMs: number,
    isPlaying: boolean,
    capturedAt = canUseDom() ? performance.now() : 0,
  ) {
    this.playbackClock = {
      elapsedMs,
      capturedAt,
      isPlaying,
    };
  }

  readPlaybackTime(now = canUseDom() ? performance.now() : 0) {
    const clock = this.playbackClock;
    return Math.max(
      0,
      clock.elapsedMs
        + (clock.isPlaying ? Math.max(0, now - clock.capturedAt) : 0),
    );
  }

  readPlaybackClock(): PlaybackClockSnapshot {
    return { ...this.playbackClock };
  }

  subscribeFrame(subscriber: FrameSubscriber) {
    this.subscribers.add(subscriber);
    this.ensureFrame();

    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0 && this.frameId !== null) {
        window.cancelAnimationFrame(this.frameId);
        this.frameId = null;
        this.lastFrameAt = 0;
      }
    };
  }

  afterPaint(callback: () => void, frameCount = 1) {
    let remainingFrames = Math.max(1, frameCount);
    const unsubscribe = this.subscribeFrame(() => {
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        return;
      }
      unsubscribe();
      callback();
    });

    return unsubscribe;
  }

  runStages(
    stages: readonly MotionStage[],
    onStage: (stage: MotionStage) => void,
  ) {
    const orderedStages = [...stages].sort((left, right) =>
      left.atMs - right.atMs
    );
    const startedAt = canUseDom() ? performance.now() : 0;
    let nextStageIndex = 0;

    const unsubscribe = this.subscribeFrame((now) => {
      const elapsed = now - startedAt;
      while (
        nextStageIndex < orderedStages.length
        && elapsed >= orderedStages[nextStageIndex].atMs
      ) {
        onStage(orderedStages[nextStageIndex]);
        nextStageIndex += 1;
      }

      if (nextStageIndex >= orderedStages.length) {
        unsubscribe();
      }
    });

    return unsubscribe;
  }

  preloadImage(source: string | undefined) {
    return imageCache.preload(source);
  }

  preloadImages(
    sources: Array<string | undefined>,
    options: ImagePreloadOptions = {},
  ) {
    return imageCache.preloadMany(sources, options);
  }

  preloadImagesDeferred(
    sources: Array<string | undefined>,
    options: DeferredImagePreloadOptions = {},
  ) {
    imageCache.preloadDeferred(sources, options);
  }

  private ensureFrame() {
    if (!canUseDom() || this.frameId !== null) {
      return;
    }

    this.frameId = window.requestAnimationFrame(this.renderFrame);
  }

  private renderFrame = (now: number) => {
    const deltaMs =
      this.lastFrameAt === 0
        ? 16.67
        : Math.min(50, Math.max(0, now - this.lastFrameAt));
    this.lastFrameAt = now;
    this.frameId = null;

    try {
      for (const subscriber of this.subscribers) {
        try {
          subscriber(now, deltaMs);
        } catch (error) {
          // One visual layer must never be able to stall every other spatial
          // animation. Remove a faulty subscriber so it cannot throw at 60fps,
          // while keeping the shared clock alive for the remaining layers.
          this.subscribers.delete(subscriber);
          console.error("Motion frame subscriber failed", error);
        }
      }
    } finally {
      if (this.subscribers.size > 0) {
        this.frameId = window.requestAnimationFrame(this.renderFrame);
      } else {
        this.lastFrameAt = 0;
      }
    }
  };
}

export const motionController = new MotionController();
