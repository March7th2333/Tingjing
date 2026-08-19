import { motionController } from "../../config/MotionController";
import type { TransitionContext } from "../../config/TransitionManager";
import type { MusicLibrary, Track } from "../../types/music";

const visibleOffsets = [0, -1, 1] as const;
const preloadBatchSize = 2;
const preloadBatchTimeoutMs = 650;
const preloadTotalTimeoutMs = 1_800;
const paintYieldTimeoutMs = 90;
const maximumLayoutPaints = 8;

export const homeEntrancePerformanceMarks = {
  loginAnimationComplete: "aural:login-animation-complete",
  homeFirstReadyFrame: "aural:home-first-ready-frame",
  homeInteractive: "aural:home-interactive",
  activationMeasure: "aural:login-complete-to-home-interactive",
} as const;

export function markHomeEntrancePerformance(
  name: typeof homeEntrancePerformanceMarks[keyof Omit<
    typeof homeEntrancePerformanceMarks,
    "activationMeasure"
  >],
) {
  if (typeof performance === "undefined") {
    return;
  }

  performance.clearMarks(name);
  performance.mark(name);
}

function positiveModulo(value: number, length: number) {
  return ((value % length) + length) % length;
}

function uniqueSources(sources: Array<string | undefined>) {
  return Array.from(
    new Set(sources.filter((source): source is string => Boolean(source))),
  );
}

function initialPlaylistCovers(library: MusicLibrary) {
  if (library.playlists.length === 0) {
    return [];
  }

  const trackById = new Map<string, Track>(
    library.tracks.map((track) => [track.id, track]),
  );

  return visibleOffsets.map((offset) => {
    const playlist = library.playlists[
      positiveModulo(offset, library.playlists.length)
    ];
    const fallbackTrack = playlist.trackIds
      .map((trackId) => trackById.get(trackId))
      .find((track): track is Track => Boolean(track?.coverImage));

    return playlist.coverImage ?? fallbackTrack?.coverImage;
  });
}

function initialHomeSources(library: MusicLibrary) {
  return uniqueSources([
    ...initialPlaylistCovers(library),
    library.user.avatarUrl,
  ]);
}

function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || timeoutMs <= 0) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(timeoutId);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeoutId = globalThis.setTimeout(finish, timeoutMs);

    signal.addEventListener("abort", finish, { once: true });
    // A failed or stalled cover must never prevent the user from entering Home.
    // The original preload is allowed to finish in the shared cache later.
    void work.then(finish, finish);
  });
}

async function preloadInSmallBatches(
  sources: readonly string[],
  transition: TransitionContext,
) {
  const startedAt = Date.now();

  for (let index = 0; index < sources.length; index += preloadBatchSize) {
    if (transition.signal.aborted) {
      return;
    }

    const remainingBudget = preloadTotalTimeoutMs - (Date.now() - startedAt);
    if (remainingBudget <= 0) {
      void motionController.preloadImages(sources.slice(index));
      return;
    }

    await settleWithin(
      Promise.all(
        sources
          .slice(index, index + preloadBatchSize)
          .map((source) => motionController.preloadImage(source)),
      ),
      Math.min(preloadBatchTimeoutMs, remainingBudget),
      transition.signal,
    );

    if (
      index + preloadBatchSize < sources.length
      && !transition.signal.aborted
    ) {
      // Decoding two covers at a time avoids a single large completion burst.
      // Yielding here keeps the still-visible login surface responsive.
      const remainingAfterBatch =
        preloadTotalTimeoutMs - (Date.now() - startedAt);
      if (remainingAfterBatch <= 0) {
        return;
      }
      await settleWithin(
        transition.afterPaint(),
        Math.min(paintYieldTimeoutMs, remainingAfterBatch),
        transition.signal,
      );
    }
  }
}

function expectedVisibleOffsets(playlistCount: number) {
  if (playlistCount <= 0) {
    return [];
  }
  return playlistCount === 1 ? [0] : [-1, 0, 1];
}

function readPreparedHomeFrame(playlistCount: number) {
  const home = document.querySelector<HTMLElement>(".library-home");
  if (!home) {
    return null;
  }

  const expectedOffsets = expectedVisibleOffsets(playlistCount);
  if (expectedOffsets.length === 0) {
    return "empty-home-ready";
  }

  const visibleSlots = Array.from(
    home.querySelectorAll<HTMLElement>(
      '.library-home__cover-slot[data-track-offset="-1"], '
      + '.library-home__cover-slot[data-track-offset="0"], '
      + '.library-home__cover-slot[data-track-offset="1"]',
    ),
  );

  const visibleImages = visibleSlots.flatMap((slot) =>
    Array.from(slot.querySelectorAll<HTMLImageElement>("img"))
  );

  const offsets = new Set(
    visibleSlots.map((slot) => Number(slot.dataset.trackOffset)),
  );
  const covers = home.querySelector<HTMLElement>(".library-home__covers");
  const hasFinalOffsets = expectedOffsets.every((offset) =>
    offsets.has(offset)
  );
  const hasFinalTransforms = visibleSlots.every((slot) => {
    const bounds = slot.getBoundingClientRect();
    return slot.style.transform.startsWith("translate3d(")
      && slot.style.opacity.length > 0
      && bounds.width > 0
      && bounds.height > 0;
  });
  const center = visibleSlots.find(
    (slot) => slot.dataset.trackOffset === "0",
  );
  const centerIsFocused = center?.dataset.focused === "true";
  const imagesAreReady = visibleImages.every(
    (image) => image.complete && image.naturalWidth > 0,
  );

  if (
    !hasFinalOffsets
    || !hasFinalTransforms
    || !centerIsFocused
    || !imagesAreReady
    || covers?.dataset.moving === "true"
    || covers?.dataset.dragging === "true"
  ) {
    return null;
  }

  return visibleSlots
    .sort((left, right) =>
      Number(left.dataset.trackOffset) - Number(right.dataset.trackOffset)
    )
    .map((slot) => [
      slot.dataset.trackOffset,
      slot.dataset.position,
      slot.dataset.focused,
      slot.style.transform,
      slot.style.opacity,
    ].join(":"))
    .join("|");
}

/**
 * Prepares the first Home frame while it is still hidden behind Welcome.
 * Images are decoded before the component mounts, then the hidden Home is
 * given enough paint boundaries to establish its RAF-authored card geometry.
 */
export class HomeEntranceTransition {
  resetPerformanceMarks() {
    if (typeof performance === "undefined") {
      return;
    }

    Object.values(homeEntrancePerformanceMarks).forEach((name) => {
      performance.clearMarks(name);
      performance.clearMeasures(name);
    });
  }

  async preloadAssets(
    library: MusicLibrary,
    transition: TransitionContext,
  ) {
    await preloadInSmallBatches(initialHomeSources(library), transition);
  }

  async waitUntilReady(
    library: MusicLibrary,
    transition: TransitionContext,
  ) {
    let previousFrame: string | null = null;

    for (let paint = 0; paint < maximumLayoutPaints; paint += 1) {
      await transition.afterPaint();
      const frame = readPreparedHomeFrame(library.playlists.length);
      if (frame && frame === previousFrame) {
        markHomeEntrancePerformance(
          homeEntrancePerformanceMarks.homeFirstReadyFrame,
        );
        return;
      }
      previousFrame = frame;
    }
  }

  markInteractive() {
    if (typeof performance === "undefined") {
      return;
    }

    markHomeEntrancePerformance(homeEntrancePerformanceMarks.homeInteractive);
    const hasAnimationComplete = performance.getEntriesByName(
      homeEntrancePerformanceMarks.loginAnimationComplete,
      "mark",
    ).length > 0;
    if (!hasAnimationComplete) {
      return;
    }

    performance.clearMeasures(homeEntrancePerformanceMarks.activationMeasure);
    performance.measure(
      homeEntrancePerformanceMarks.activationMeasure,
      homeEntrancePerformanceMarks.loginAnimationComplete,
      homeEntrancePerformanceMarks.homeInteractive,
    );
  }
}

export const homeEntranceTransition = new HomeEntranceTransition();
