import type { PlaybackQueueSnapshot } from "./PlaybackQueueController";

/**
 * Immutable occurrence identity captured at the first frame of player exit.
 * A track id alone is not sufficient because the same track can occur more
 * than once in a collection (or can be appended manually).
 */
export interface ImmersivePlaybackReturnSnapshot {
  readonly requestId: string;
  readonly queueItemId: string;
  readonly trackId: string;
  readonly providerId: PlaybackQueueSnapshot["providerId"];
  readonly collectionId: string | null;
  readonly sourceIndex: number | null;
}

export function captureImmersivePlaybackReturnSnapshot(
  requestId: string,
  queue: PlaybackQueueSnapshot,
): ImmersivePlaybackReturnSnapshot | null {
  const item = queue.current;
  if (!item) {
    return null;
  }

  const belongsToCollection = item.origin === "collection" && queue.context;
  return Object.freeze({
    requestId,
    queueItemId: item.queueItemId,
    trackId: item.track.id,
    providerId: queue.providerId,
    collectionId: belongsToCollection
      ? queue.context?.collectionId ?? null
      : null,
    sourceIndex: belongsToCollection ? item.sourceIndex : null,
  });
}

export function playbackReturnSnapshotKey(
  snapshot: ImmersivePlaybackReturnSnapshot | null,
  requestId = snapshot?.requestId ?? "none",
) {
  return `${requestId}:${snapshot?.queueItemId ?? "none"}`;
}

export function samePlaybackReturnOccurrence(
  left: ImmersivePlaybackReturnSnapshot | null,
  right: ImmersivePlaybackReturnSnapshot | null,
) {
  if (!left || !right) {
    return left === right;
  }
  return left.requestId === right.requestId
    && left.queueItemId === right.queueItemId
    && left.providerId === right.providerId
    && left.collectionId === right.collectionId
    && left.sourceIndex === right.sourceIndex
    && left.trackId === right.trackId;
}
