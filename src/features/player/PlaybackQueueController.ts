import {
  isMusicProviderId,
  type MusicProviderId,
} from "../../providers/MusicProvider.ts";
import type { Track } from "../../types/music";

export type PlaybackOrder = "sequential" | "shuffle";
export type RepeatMode = "off" | "all" | "one";

export interface PlaybackCollectionContext {
  providerId: MusicProviderId;
  collectionId: string;
  collectionKind: "playlist" | "radio" | "album" | "artist";
  collectionTitle: string;
}

export interface PlaybackQueueSeed {
  context: PlaybackCollectionContext;
  tracks: readonly Track[];
  startIndex: number;
}

export interface PlaybackQueueItem {
  queueItemId: string;
  track: Track;
  sourceIndex: number | null;
  origin: "collection" | "manual";
}

export interface PlaybackQueueSnapshot {
  queueId: string | null;
  providerId: MusicProviderId | null;
  context: PlaybackCollectionContext | null;
  sourceItems: readonly PlaybackQueueItem[];
  history: readonly PlaybackQueueItem[];
  current: PlaybackQueueItem | null;
  upcoming: readonly PlaybackQueueItem[];
  order: PlaybackOrder;
  repeatMode: RepeatMode;
  manuallyAdjusted: boolean;
}

export interface PlaybackQueueRestorableState {
  version: 1;
  snapshot: PlaybackQueueSnapshot;
  sourceStartIndex: number;
  modeOrderIds: readonly string[];
  excludedEntryIds: readonly string[];
  upcomingCleared: boolean;
  manualSequence: number;
}

type QueueListener = () => void;

interface PlaybackQueueControllerOptions {
  random?: () => number;
}

const emptyItems: readonly PlaybackQueueItem[] = Object.freeze([]);

function sameContext(
  left: PlaybackCollectionContext | null,
  right: PlaybackCollectionContext | null,
) {
  return Boolean(
    left
    && right
    && left.providerId === right.providerId
    && left.collectionId === right.collectionId
    && left.collectionKind === right.collectionKind,
  );
}

function encodeQueuePart(value: string | number) {
  return encodeURIComponent(String(value));
}

function collectionItemId(
  context: PlaybackCollectionContext,
  sourceIndex: number,
  trackId: string,
) {
  return [
    context.providerId,
    context.collectionId,
    sourceIndex,
    trackId,
  ].map(encodeQueuePart).join(":");
}

function createEmptySnapshot(
  order: PlaybackOrder,
  repeatMode: RepeatMode,
): PlaybackQueueSnapshot {
  return {
    queueId: null,
    providerId: null,
    context: null,
    sourceItems: emptyItems,
    history: emptyItems,
    current: null,
    upcoming: emptyItems,
    order,
    repeatMode,
    manuallyAdjusted: false,
  };
}

function cloneTrack(track: Track): Track {
  return {
    ...track,
    artists: track.artists?.map((artist) => ({ ...artist })),
    palette: { ...track.palette },
    lyrics: track.lyrics.map((line) => ({
      ...line,
      words: line.words?.map((word) => ({ ...word })),
    })),
  };
}

function cloneQueueItem(item: PlaybackQueueItem): PlaybackQueueItem {
  return {
    ...item,
    track: cloneTrack(item.track),
  };
}

function isQueueItem(value: unknown): value is PlaybackQueueItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<PlaybackQueueItem>;
  const track = item.track as Partial<Track> | undefined;
  return (
    typeof item.queueItemId === "string"
    && item.queueItemId.length > 0
    && (item.origin === "collection" || item.origin === "manual")
    && (
      item.sourceIndex === null
      || (
        typeof item.sourceIndex === "number"
        && Number.isInteger(item.sourceIndex)
        && item.sourceIndex >= 0
      )
    )
    && Boolean(track)
    && typeof track?.id === "string"
    && typeof track?.title === "string"
    && typeof track?.artist === "string"
    && typeof track?.album === "string"
    && typeof track?.durationMs === "number"
    && Number.isFinite(track.durationMs)
    && Array.isArray(track.lyrics)
    && Boolean(track.palette)
  );
}

function isContext(value: unknown): value is PlaybackCollectionContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const context = value as Partial<PlaybackCollectionContext>;
  return (
    isMusicProviderId(context.providerId)
    && typeof context.collectionId === "string"
    && (
      context.collectionKind === "playlist"
      || context.collectionKind === "radio"
      || context.collectionKind === "album"
      || context.collectionKind === "artist"
    )
    && typeof context.collectionTitle === "string"
  );
}

export class PlaybackQueueController {
  private snapshot: PlaybackQueueSnapshot;
  private readonly listeners = new Set<QueueListener>();
  private readonly random: () => number;
  private queueSequence = 0;
  private manualSequence = 0;
  private sourceStartIndex = 0;
  private modeOrder: readonly PlaybackQueueItem[] = emptyItems;
  private readonly excludedEntryIds = new Set<string>();
  private upcomingCleared = false;

  constructor(options: PlaybackQueueControllerOptions = {}) {
    this.random = options.random ?? Math.random;
    this.snapshot = createEmptySnapshot("sequential", "off");
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: QueueListener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(next: PlaybackQueueSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  private nextQueueId(providerId: MusicProviderId) {
    this.queueSequence += 1;
    return `${providerId}:${Date.now()}:${this.queueSequence}`;
  }

  private buildSourceItems(seed: PlaybackQueueSeed) {
    return seed.tracks.map((track, sourceIndex): PlaybackQueueItem => ({
      queueItemId: collectionItemId(seed.context, sourceIndex, track.id),
      track,
      sourceIndex,
      origin: "collection",
    }));
  }

  private shuffle(items: readonly PlaybackQueueItem[]) {
    const next = [...items];
    for (let index = next.length - 1; index > 0; index -= 1) {
      const target = Math.floor(this.random() * (index + 1));
      [next[index], next[target]] = [next[target], next[index]];
    }
    return next;
  }

  private setModeOrder(items: readonly PlaybackQueueItem[]) {
    this.modeOrder = [...items];
  }

  private removeFromModeOrder(entryId: string) {
    this.modeOrder = this.modeOrder.filter(
      (item) => item.queueItemId !== entryId,
    );
  }

  private eligibleSourceItems() {
    return this.snapshot.sourceItems.filter((item) => (
      (item.sourceIndex ?? -1) >= this.sourceStartIndex
      && !this.excludedEntryIds.has(item.queueItemId)
    ));
  }

  private beginRepeatedCycle() {
    if (this.upcomingCleared) {
      return null;
    }
    let cycle = this.eligibleSourceItems();
    if (cycle.length === 0) {
      return null;
    }
    if (this.snapshot.order === "shuffle") {
      cycle = this.shuffle(cycle);
      if (
        cycle.length > 1
        && cycle[0]?.queueItemId === this.snapshot.current?.queueItemId
      ) {
        [cycle[0], cycle[1]] = [cycle[1], cycle[0]];
      }
    }
    const [current, ...upcoming] = cycle;
    if (
      cycle.length === 1
      && current.queueItemId === this.snapshot.current?.queueItemId
    ) {
      return this.snapshot.current;
    }
    const history = this.snapshot.current
      ? [...this.snapshot.history, this.snapshot.current]
      : this.snapshot.history;
    this.setModeOrder(upcoming);
    this.emit({
      ...this.snapshot,
      history,
      current,
      upcoming,
      manuallyAdjusted: false,
    });
    return current;
  }

  initialize(seed: PlaybackQueueSeed) {
    if (seed.tracks.length === 0) {
      this.clear();
      return;
    }

    const startIndex = Math.max(
      0,
      Math.min(Math.trunc(seed.startIndex), seed.tracks.length - 1),
    );
    const sourceItems = this.buildSourceItems(seed);
    const current = sourceItems[startIndex];
    const hasStagedQueue =
      this.snapshot.current === null
      && this.snapshot.queueId !== null
      && sameContext(this.snapshot.context, seed.context);
    if (!hasStagedQueue) {
      this.excludedEntryIds.clear();
      this.upcomingCleared = false;
    }
    const staged = hasStagedQueue ? this.snapshot.upcoming : emptyItems;
    let upcoming = hasStagedQueue
      ? staged.filter((item) => item.queueItemId !== current.queueItemId)
      : sourceItems.slice(startIndex + 1);

    if (this.snapshot.order === "shuffle" && !hasStagedQueue) {
      upcoming = this.shuffle(upcoming);
    }

    this.sourceStartIndex = startIndex;
    if (hasStagedQueue) {
      this.setModeOrder(this.modeOrder.filter(
        (item) => item.queueItemId !== current.queueItemId,
      ));
    } else {
      this.setModeOrder(upcoming);
    }
    this.emit({
      queueId: this.nextQueueId(seed.context.providerId),
      providerId: seed.context.providerId,
      context: seed.context,
      sourceItems,
      history: emptyItems,
      current,
      upcoming,
      order: this.snapshot.order,
      repeatMode: this.snapshot.repeatMode,
      manuallyAdjusted: hasStagedQueue
        ? this.snapshot.manuallyAdjusted
        : false,
    });
  }

  initializeSingle(providerId: MusicProviderId, track: Track) {
    this.sourceStartIndex = 0;
    this.excludedEntryIds.clear();
    this.upcomingCleared = false;
    this.setModeOrder(emptyItems);
    const queueId = this.nextQueueId(providerId);
    const current: PlaybackQueueItem = {
      queueItemId: `${queueId}:single:${encodeQueuePart(track.id)}`,
      track,
      sourceIndex: 0,
      origin: "collection",
    };
    this.emit({
      queueId,
      providerId,
      context: null,
      sourceItems: [current],
      history: emptyItems,
      current,
      upcoming: emptyItems,
      order: this.snapshot.order,
      repeatMode: this.snapshot.repeatMode,
      manuallyAdjusted: false,
    });
  }

  stage(seed: PlaybackQueueSeed) {
    if (seed.tracks.length === 0) {
      return;
    }
    this.excludedEntryIds.clear();
    this.upcomingCleared = false;
    const startIndex = Math.max(
      0,
      Math.min(Math.trunc(seed.startIndex), seed.tracks.length - 1),
    );
    const sourceItems = this.buildSourceItems(seed);
    let upcoming = sourceItems.slice(startIndex);
    if (this.snapshot.order === "shuffle") {
      upcoming = this.shuffle(upcoming);
    }
    this.sourceStartIndex = startIndex;
    this.setModeOrder(upcoming);
    this.emit({
      queueId: this.nextQueueId(seed.context.providerId),
      providerId: seed.context.providerId,
      context: seed.context,
      sourceItems,
      history: emptyItems,
      current: null,
      upcoming,
      order: this.snapshot.order,
      repeatMode: this.snapshot.repeatMode,
      manuallyAdjusted: false,
    });
  }

  playEntry(entryId: string) {
    if (this.snapshot.current?.queueItemId === entryId) {
      return this.snapshot.current;
    }
    const entryIndex = this.snapshot.upcoming.findIndex(
      (item) => item.queueItemId === entryId,
    );
    if (entryIndex < 0) {
      return null;
    }

    const current = this.snapshot.upcoming[entryIndex];
    const history = this.snapshot.current
      ? [...this.snapshot.history, this.snapshot.current]
      : this.snapshot.history;
    this.removeFromModeOrder(entryId);
    this.emit({
      ...this.snapshot,
      history,
      current,
      upcoming: this.snapshot.upcoming.filter(
        (item) => item.queueItemId !== entryId,
      ),
    });
    return current;
  }

  canAdvance(reason: "user" | "ended" = "user") {
    if (this.snapshot.upcoming.length > 0) {
      return true;
    }
    if (
      reason === "ended"
      && this.snapshot.repeatMode === "one"
      && this.snapshot.current
    ) {
      return true;
    }
    return Boolean(
      !this.upcomingCleared
      && this.snapshot.repeatMode === "all"
      && this.eligibleSourceItems().length > 0,
    );
  }

  next(reason: "user" | "ended") {
    if (
      reason === "ended"
      && this.snapshot.repeatMode === "one"
      && this.snapshot.current
    ) {
      return this.snapshot.current;
    }
    const [current, ...upcoming] = this.snapshot.upcoming;
    if (!current) {
      return this.snapshot.repeatMode === "all"
        ? this.beginRepeatedCycle()
        : null;
    }
    const history = this.snapshot.current
      ? [...this.snapshot.history, this.snapshot.current]
      : this.snapshot.history;
    this.removeFromModeOrder(current.queueItemId);
    this.emit({ ...this.snapshot, history, current, upcoming });
    return current;
  }

  previous() {
    const history = [...this.snapshot.history];
    const current = history.pop() ?? null;
    if (!current) {
      return null;
    }
    const upcoming = this.snapshot.current
      ? [this.snapshot.current, ...this.snapshot.upcoming]
      : this.snapshot.upcoming;
    if (this.snapshot.current) {
      this.setModeOrder([
        this.snapshot.current,
        ...this.modeOrder.filter(
          (item) => item.queueItemId !== this.snapshot.current?.queueItemId,
        ),
      ]);
    }
    this.emit({ ...this.snapshot, history, current, upcoming });
    return current;
  }

  setOrder(order: PlaybackOrder) {
    if (order === this.snapshot.order) {
      return;
    }
    const remainingSource = this.modeOrder.filter(
      (item) => (
        item.origin === "collection"
        && !this.excludedEntryIds.has(item.queueItemId)
      ),
    ).sort(
      (left, right) => (left.sourceIndex ?? 0) - (right.sourceIndex ?? 0),
    );
    const manual = this.modeOrder.filter(
      (item) => item.origin === "manual",
    );
    const ordered = [...remainingSource, ...manual];
    const modeOrder = order === "shuffle" ? this.shuffle(ordered) : ordered;
    const upcoming = this.upcomingCleared
      ? emptyItems
      : modeOrder;
    this.setModeOrder(modeOrder);
    this.emit({
      ...this.snapshot,
      order,
      upcoming,
      manuallyAdjusted: false,
    });
  }

  setRepeatMode(repeatMode: RepeatMode) {
    if (repeatMode === this.snapshot.repeatMode) {
      return;
    }
    this.emit({ ...this.snapshot, repeatMode });
  }

  exportState(): PlaybackQueueRestorableState {
    const sourceItems = this.snapshot.sourceItems.map(cloneQueueItem);
    const history = this.snapshot.history.map(cloneQueueItem);
    const current = this.snapshot.current
      ? cloneQueueItem(this.snapshot.current)
      : null;
    const upcoming = this.snapshot.upcoming.map(cloneQueueItem);
    return {
      version: 1,
      snapshot: {
        ...this.snapshot,
        context: this.snapshot.context ? { ...this.snapshot.context } : null,
        sourceItems,
        history,
        current,
        upcoming,
      },
      sourceStartIndex: this.sourceStartIndex,
      modeOrderIds: this.modeOrder.map((item) => item.queueItemId),
      excludedEntryIds: [...this.excludedEntryIds],
      upcomingCleared: this.upcomingCleared,
      manualSequence: this.manualSequence,
    };
  }

  restoreState(state: PlaybackQueueRestorableState) {
    const candidate = state as Partial<PlaybackQueueRestorableState>;
    const snapshot = candidate.snapshot as
      | Partial<PlaybackQueueSnapshot>
      | undefined;
    if (
      candidate.version !== 1
      || !snapshot
      || !isMusicProviderId(snapshot.providerId)
      || typeof snapshot.queueId !== "string"
      || (
        snapshot.context !== null
        && !isContext(snapshot.context)
      )
      || (
        snapshot.context !== null
        && snapshot.context?.providerId !== snapshot.providerId
      )
      || !Array.isArray(snapshot.sourceItems)
      || !snapshot.sourceItems.every(isQueueItem)
      || !Array.isArray(snapshot.history)
      || !snapshot.history.every(isQueueItem)
      || (snapshot.current !== null && !isQueueItem(snapshot.current))
      || !Array.isArray(snapshot.upcoming)
      || !snapshot.upcoming.every(isQueueItem)
      || (snapshot.order !== "sequential" && snapshot.order !== "shuffle")
      || (
        snapshot.repeatMode !== "off"
        && snapshot.repeatMode !== "all"
        && snapshot.repeatMode !== "one"
      )
      || typeof snapshot.manuallyAdjusted !== "boolean"
      || typeof candidate.sourceStartIndex !== "number"
      || !Number.isFinite(candidate.sourceStartIndex)
      || !Array.isArray(candidate.modeOrderIds)
      || !candidate.modeOrderIds.every((entryId) => typeof entryId === "string")
      || !Array.isArray(candidate.excludedEntryIds)
      || !candidate.excludedEntryIds.every(
        (entryId) => typeof entryId === "string",
      )
      || typeof candidate.upcomingCleared !== "boolean"
      || typeof candidate.manualSequence !== "number"
      || !Number.isFinite(candidate.manualSequence)
    ) {
      return false;
    }
    const allItems: PlaybackQueueItem[] = [
      ...snapshot.sourceItems,
      ...snapshot.history,
      ...(snapshot.current ? [snapshot.current] : []),
      ...snapshot.upcoming,
    ];
    const itemById = new Map<string, PlaybackQueueItem>();
    allItems.forEach((item) => {
      if (!itemById.has(item.queueItemId)) {
        itemById.set(item.queueItemId, cloneQueueItem(item));
      }
    });
    const modeOrder = candidate.modeOrderIds.map(
      (entryId) => itemById.get(entryId),
    );
    if (
      modeOrder.some((item) => !item)
      || candidate.excludedEntryIds.some((entryId) => !itemById.has(entryId))
    ) {
      return false;
    }
    const resolveItems = (items: readonly PlaybackQueueItem[]) => items.map(
      (item) => itemById.get(item.queueItemId)!,
    );
    const nextSnapshot: PlaybackQueueSnapshot = {
      queueId: snapshot.queueId,
      providerId: snapshot.providerId,
      context: snapshot.context ? { ...snapshot.context } : null,
      sourceItems: resolveItems(snapshot.sourceItems),
      history: resolveItems(snapshot.history),
      current: snapshot.current
        ? itemById.get(snapshot.current.queueItemId) ?? null
        : null,
      upcoming: resolveItems(snapshot.upcoming),
      order: snapshot.order,
      repeatMode: snapshot.repeatMode,
      manuallyAdjusted: snapshot.manuallyAdjusted,
    };
    const nextSourceStartIndex = Math.max(
      0,
      Math.trunc(candidate.sourceStartIndex),
    );
    const nextManualSequence = Math.max(
      0,
      Math.trunc(candidate.manualSequence),
    );

    this.sourceStartIndex = nextSourceStartIndex;
    this.manualSequence = nextManualSequence;
    this.excludedEntryIds.clear();
    candidate.excludedEntryIds.forEach((entryId) => {
      this.excludedEntryIds.add(entryId);
    });
    this.upcomingCleared = candidate.upcomingCleared;
    this.setModeOrder(modeOrder as PlaybackQueueItem[]);
    this.emit(nextSnapshot);
    return true;
  }

  move(entryId: string, targetIndex: number) {
    const currentIndex = this.snapshot.upcoming.findIndex(
      (item) => item.queueItemId === entryId,
    );
    if (currentIndex < 0 || this.snapshot.upcoming.length < 2) {
      return false;
    }
    const boundedTarget = Math.max(
      0,
      Math.min(Math.trunc(targetIndex), this.snapshot.upcoming.length - 1),
    );
    if (boundedTarget === currentIndex) {
      return false;
    }
    const upcoming = [...this.snapshot.upcoming];
    const [item] = upcoming.splice(currentIndex, 1);
    upcoming.splice(boundedTarget, 0, item);
    this.emit({ ...this.snapshot, upcoming, manuallyAdjusted: true });
    return true;
  }

  private createManualItem(
    track: Track,
    providerId?: MusicProviderId,
  ): PlaybackQueueItem | null {
    const resolvedProviderId =
      providerId
      ?? this.snapshot.providerId
      ?? this.snapshot.context?.providerId;
    if (!resolvedProviderId) {
      return null;
    }
    if (
      this.snapshot.providerId
      && this.snapshot.providerId !== resolvedProviderId
    ) {
      return null;
    }
    this.manualSequence += 1;
    return {
      queueItemId: [
        resolvedProviderId,
        "manual",
        this.manualSequence,
        track.id,
      ].map(encodeQueuePart).join(":"),
      track,
      sourceIndex: null,
      origin: "manual",
    };
  }

  playNext(track: Track, providerId?: MusicProviderId) {
    const item = this.createManualItem(track, providerId);
    if (!item) {
      return null;
    }
    this.setModeOrder([...this.modeOrder, item]);
    this.emit({
      ...this.snapshot,
      queueId:
        this.snapshot.queueId ?? this.nextQueueId(
          providerId ?? this.snapshot.providerId!,
        ),
      providerId: this.snapshot.providerId ?? providerId ?? null,
      upcoming: [item, ...this.snapshot.upcoming],
      manuallyAdjusted: true,
    });
    return item;
  }

  append(track: Track, providerId?: MusicProviderId) {
    const item = this.createManualItem(track, providerId);
    if (!item) {
      return null;
    }
    this.setModeOrder([...this.modeOrder, item]);
    this.emit({
      ...this.snapshot,
      queueId:
        this.snapshot.queueId ?? this.nextQueueId(
          providerId ?? this.snapshot.providerId!,
        ),
      providerId: this.snapshot.providerId ?? providerId ?? null,
      upcoming: [...this.snapshot.upcoming, item],
      manuallyAdjusted: true,
    });
    return item;
  }

  remove(entryId: string) {
    const removedItem = this.snapshot.upcoming.find(
      (item) => item.queueItemId === entryId,
    );
    const upcoming = this.snapshot.upcoming.filter(
      (item) => item.queueItemId !== entryId,
    );
    if (upcoming.length === this.snapshot.upcoming.length) {
      return false;
    }
    if (removedItem?.origin === "collection") {
      this.excludedEntryIds.add(entryId);
    }
    this.removeFromModeOrder(entryId);
    this.emit({ ...this.snapshot, upcoming, manuallyAdjusted: true });
    return true;
  }

  clearUpcoming() {
    if (this.snapshot.upcoming.length === 0) {
      return;
    }
    this.upcomingCleared = true;
    this.emit({
      ...this.snapshot,
      upcoming: emptyItems,
      manuallyAdjusted: true,
    });
  }

  restoreModeOrder() {
    this.upcomingCleared = false;
    this.emit({
      ...this.snapshot,
      upcoming: [...this.modeOrder],
      manuallyAdjusted: false,
    });
  }

  clear() {
    this.sourceStartIndex = 0;
    this.excludedEntryIds.clear();
    this.upcomingCleared = false;
    this.setModeOrder(emptyItems);
    this.emit(createEmptySnapshot(
      this.snapshot.order,
      this.snapshot.repeatMode,
    ));
  }
}

export const playbackQueueController = new PlaybackQueueController();
