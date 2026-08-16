import type { Track } from "../../types/music";
import type { ImmersivePlaybackReturnSnapshot } from "../player/PlaybackReturnSnapshot";
import type { PlaybackCollectionContext } from "../player/PlaybackQueueController";

export type MusicWallReturnClearReason =
  | "missing-snapshot"
  | "manual-or-unscoped"
  | "provider-mismatch"
  | "collection-mismatch"
  | "invalid-source-index"
  | "track-mismatch";

export type MusicWallPlaybackReturnResolution =
  | {
      kind: "select";
      sourceIndex: number;
      queueItemId: string;
      track: Track;
    }
  | {
      kind: "clear";
      reason: MusicWallReturnClearReason;
    };

export type MusicWallSelectionPhase =
  | "idle"
  | "braking"
  | "open"
  | "closing";

export type MusicWallMotionSurfaceState =
  | "prepared"
  | "opening"
  | "detail"
  | "closing";

export interface MusicWallInstanceCandidate {
  instanceId: string;
  sourceIndex: number;
  trackId: string;
  isClone: boolean;
  isHidden: boolean;
  centerX: number;
  centerY: number;
}

export function resolvePlaybackReturnForWall(
  snapshot: ImmersivePlaybackReturnSnapshot | null,
  context: PlaybackCollectionContext,
  tracks: readonly Track[],
): MusicWallPlaybackReturnResolution {
  if (!snapshot) {
    return { kind: "clear", reason: "missing-snapshot" };
  }
  if (snapshot.sourceIndex === null || snapshot.collectionId === null) {
    return { kind: "clear", reason: "manual-or-unscoped" };
  }
  if (snapshot.providerId !== context.providerId) {
    return { kind: "clear", reason: "provider-mismatch" };
  }
  if (snapshot.collectionId !== context.collectionId) {
    return { kind: "clear", reason: "collection-mismatch" };
  }
  if (
    !Number.isInteger(snapshot.sourceIndex)
    || snapshot.sourceIndex < 0
    || snapshot.sourceIndex >= tracks.length
  ) {
    return { kind: "clear", reason: "invalid-source-index" };
  }

  const track = tracks[snapshot.sourceIndex];
  if (!track || track.id !== snapshot.trackId) {
    return { kind: "clear", reason: "track-mismatch" };
  }

  return {
    kind: "select",
    sourceIndex: snapshot.sourceIndex,
    queueItemId: snapshot.queueItemId,
    track,
  };
}

export function chooseClosestWallInstance(
  sourceIndex: number,
  trackId: string,
  candidates: readonly MusicWallInstanceCandidate[],
  viewportCenter: { x: number; y: number },
) {
  let best: MusicWallInstanceCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (
      candidate.isClone
      || candidate.isHidden
      || candidate.sourceIndex !== sourceIndex
      || candidate.trackId !== trackId
    ) {
      continue;
    }
    const distance = Math.hypot(
      candidate.centerX - viewportCenter.x,
      candidate.centerY - viewportCenter.y,
    );
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

export function isExactWallCurrent(
  occurrence: ImmersivePlaybackReturnSnapshot | null,
  context: PlaybackCollectionContext,
  track: Track,
  sourceIndex: number,
) {
  return Boolean(
    occurrence
    && occurrence.providerId === context.providerId
    && occurrence.collectionId === context.collectionId
    && occurrence.sourceIndex === sourceIndex
    && occurrence.trackId === track.id,
  );
}

export function wallMayAutoMove(
  state: MusicWallMotionSurfaceState,
  selectionPhase: MusicWallSelectionPhase,
  isPlayerTransitioning: boolean,
) {
  return !isPlayerTransitioning
    && (
      state === "opening"
      || (state === "detail" && selectionPhase === "idle")
    );
}
