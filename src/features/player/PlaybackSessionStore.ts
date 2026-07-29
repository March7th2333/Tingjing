import type { ListeningSpaceId } from "../../listening-spaces/types";
import {
  isMusicProviderId,
  type MusicProviderId,
} from "../../providers/MusicProvider.ts";
import type { Track } from "../../types/music";
import type {
  PlaybackOrder,
  PlaybackQueueItem,
  PlaybackQueueRestorableState,
  PlaybackQueueSnapshot,
  RepeatMode,
} from "./PlaybackQueueController";

export const playbackSessionStorageKey =
  "tingjing:playback-session:v1";

const currentVersion = 1 as const;
const defaultSaveDelayMs = 750;
const maximumStoredOwners = 4;

export interface PlaybackSessionOwner {
  providerId: MusicProviderId;
  accountId: string;
}

export interface PlaybackSessionDraft extends PlaybackSessionOwner {
  queue: PlaybackQueueRestorableState;
  positionMs: number;
  listeningSpace: ListeningSpaceId;
  volume: number;
  muted: boolean;
  lyricOffsetKey?: string | null;
}

export interface RestoredPlaybackSession extends PlaybackSessionDraft {
  savedAt: number;
}

export function reconcileRestoredPlaybackSession(
  session: RestoredPlaybackSession,
  currentTracks: readonly Track[],
): RestoredPlaybackSession {
  const currentById = new Map(
    currentTracks.map((track) => [track.id, track] as const),
  );
  const itemById = new Map<string, PlaybackQueueItem>();
  const refreshItem = (item: PlaybackQueueItem) => {
    const existing = itemById.get(item.queueItemId);
    if (existing) return existing;
    const refreshed = {
      ...item,
      track: currentById.get(item.track.id) ?? item.track,
    };
    itemById.set(item.queueItemId, refreshed);
    return refreshed;
  };
  const snapshot = session.queue.snapshot;
  return {
    ...session,
    queue: {
      ...session.queue,
      snapshot: {
        ...snapshot,
        sourceItems: snapshot.sourceItems.map(refreshItem),
        history: snapshot.history.map(refreshItem),
        current: snapshot.current ? refreshItem(snapshot.current) : null,
        upcoming: snapshot.upcoming.map(refreshItem),
      },
    },
  };
}

interface PlaybackSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface CompactQueueItem {
  queueItemId: string;
  track: Track;
  sourceIndex: number | null;
  origin: PlaybackQueueItem["origin"];
}

interface CompactQueueState {
  version: 1;
  queueId: string;
  providerId: MusicProviderId;
  context: PlaybackQueueSnapshot["context"];
  items: readonly CompactQueueItem[];
  sourceItemIds: readonly string[];
  historyIds: readonly string[];
  currentId: string;
  upcomingIds: readonly string[];
  order: PlaybackOrder;
  repeatMode: RepeatMode;
  manuallyAdjusted: boolean;
  sourceStartIndex: number;
  modeOrderIds: readonly string[];
  excludedEntryIds: readonly string[];
  upcomingCleared: boolean;
  manualSequence: number;
}

interface StoredPlaybackSessionV1 extends PlaybackSessionOwner {
  version: 1;
  savedAt: number;
  positionMs: number;
  listeningSpace: ListeningSpaceId;
  volume: number;
  muted: boolean;
  lyricOffsetKey: string | null;
  queue: CompactQueueState;
}

interface StoredPlaybackSessionsV1 {
  version: 1;
  sessions: readonly StoredPlaybackSessionV1[];
}

interface PlaybackSessionStoreOptions {
  storage?: PlaybackSessionStorage | null;
  now?: () => number;
  saveDelayMs?: number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof globalThis.setTimeout>;
  clearTimer?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

function browserStorage(): PlaybackSessionStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && Number.isInteger(value);
}

function isPlaybackOrder(value: unknown): value is PlaybackOrder {
  return value === "sequential" || value === "shuffle";
}

function isRepeatMode(value: unknown): value is RepeatMode {
  return value === "off" || value === "all" || value === "one";
}

function isListeningSpace(value: unknown): value is ListeningSpaceId {
  return (
    value === "music"
    || value === "lyrics-flow"
    || value === "typography"
    || value === "imprint"
  );
}

function normalizedVolume(value: number) {
  return Math.max(0, Math.min(1, value));
}

function normalizedPosition(value: number, durationMs: number) {
  return Math.max(0, Math.min(Math.round(value), Math.max(0, durationMs)));
}

function sanitizedTrack(track: Track): Track {
  return {
    id: track.id,
    title: track.title,
    ...(track.translatedTitle
      ? { translatedTitle: track.translatedTitle }
      : {}),
    artist: track.artist,
    ...(track.artists
      ? {
          artists: track.artists.map((artist) => ({
            ...(artist.id ? { id: artist.id } : {}),
            name: artist.name,
          })),
        }
      : {}),
    album: track.album,
    ...(track.albumId ? { albumId: track.albumId } : {}),
    ...(track.releaseInfo ? { releaseInfo: track.releaseInfo } : {}),
    durationMs: track.durationMs,
    ...(track.coverImage ? { coverImage: track.coverImage } : {}),
    coverLabel: track.coverLabel,
    ...(track.externalUri ? { externalUri: track.externalUri } : {}),
    ...(track.externalUrl ? { externalUrl: track.externalUrl } : {}),
    ...(typeof track.isPlayable === "boolean"
      ? { isPlayable: track.isPlayable }
      : {}),
    ...(typeof track.isLocal === "boolean" ? { isLocal: track.isLocal } : {}),
    palette: {
      background: track.palette.background,
      ambient: track.palette.ambient,
      accent: track.palette.accent,
      text: track.palette.text,
    },
    // Lyrics are fetched again from the authenticated provider. Keeping them
    // out avoids duplicating large QRC/YRC documents in localStorage.
    lyrics: [],
  };
}

function compactQueue(
  state: PlaybackQueueRestorableState,
): CompactQueueState | null {
  const snapshot = state.snapshot;
  if (!snapshot.queueId || !snapshot.providerId || !snapshot.current) {
    return null;
  }

  const itemById = new Map<string, PlaybackQueueItem>();
  [
    ...snapshot.sourceItems,
    ...snapshot.history,
    snapshot.current,
    ...snapshot.upcoming,
  ].forEach((item) => itemById.set(item.queueItemId, item));

  return {
    version: currentVersion,
    queueId: snapshot.queueId,
    providerId: snapshot.providerId,
    context: snapshot.context ? { ...snapshot.context } : null,
    items: [...itemById.values()].map((item) => ({
      queueItemId: item.queueItemId,
      track: sanitizedTrack(item.track),
      sourceIndex: item.sourceIndex,
      origin: item.origin,
    })),
    sourceItemIds: snapshot.sourceItems.map((item) => item.queueItemId),
    historyIds: snapshot.history.map((item) => item.queueItemId),
    currentId: snapshot.current.queueItemId,
    upcomingIds: snapshot.upcoming.map((item) => item.queueItemId),
    order: snapshot.order,
    repeatMode: snapshot.repeatMode,
    manuallyAdjusted: snapshot.manuallyAdjusted,
    sourceStartIndex: state.sourceStartIndex,
    modeOrderIds: [...state.modeOrderIds],
    excludedEntryIds: [...state.excludedEntryIds],
    upcomingCleared: state.upcomingCleared,
    manualSequence: state.manualSequence,
  };
}

function validPalette(value: unknown): Track["palette"] | null {
  if (!isObject(value)) return null;
  const { background, ambient, accent, text } = value;
  return (
    typeof background === "string"
    && typeof ambient === "string"
    && typeof accent === "string"
    && typeof text === "string"
  )
    ? { background, ambient, accent, text }
    : null;
}

function validTrack(value: unknown): Track | null {
  if (!isObject(value)) return null;
  const palette = validPalette(value.palette);
  if (
    typeof value.id !== "string"
    || typeof value.title !== "string"
    || typeof value.artist !== "string"
    || typeof value.album !== "string"
    || !isFiniteNumber(value.durationMs)
    || value.durationMs < 0
    || typeof value.coverLabel !== "string"
    || !palette
  ) {
    return null;
  }
  if (
    value.translatedTitle !== undefined
    && typeof value.translatedTitle !== "string"
  ) return null;
  if (value.albumId !== undefined && typeof value.albumId !== "string") {
    return null;
  }
  if (
    value.releaseInfo !== undefined
    && typeof value.releaseInfo !== "string"
  ) return null;
  if (
    value.coverImage !== undefined
    && typeof value.coverImage !== "string"
  ) return null;
  if (
    value.externalUri !== undefined
    && typeof value.externalUri !== "string"
  ) return null;
  if (
    value.externalUrl !== undefined
    && typeof value.externalUrl !== "string"
  ) return null;
  if (
    value.isPlayable !== undefined
    && typeof value.isPlayable !== "boolean"
  ) return null;
  if (
    value.isLocal !== undefined
    && typeof value.isLocal !== "boolean"
  ) return null;
  if (
    value.artists !== undefined
    && (
      !Array.isArray(value.artists)
      || value.artists.some((artist) => (
        !isObject(artist)
        || typeof artist.name !== "string"
        || (artist.id !== undefined && typeof artist.id !== "string")
      ))
    )
  ) return null;

  return {
    id: value.id,
    title: value.title,
    ...(typeof value.translatedTitle === "string"
      ? { translatedTitle: value.translatedTitle }
      : {}),
    artist: value.artist,
    ...(Array.isArray(value.artists)
      ? {
          artists: value.artists.map((artist) => ({
            ...(typeof artist.id === "string" ? { id: artist.id } : {}),
            name: String(artist.name),
          })),
        }
      : {}),
    album: value.album,
    ...(typeof value.albumId === "string" ? { albumId: value.albumId } : {}),
    ...(typeof value.releaseInfo === "string"
      ? { releaseInfo: value.releaseInfo }
      : {}),
    durationMs: value.durationMs,
    ...(typeof value.coverImage === "string"
      ? { coverImage: value.coverImage }
      : {}),
    coverLabel: value.coverLabel,
    ...(typeof value.externalUri === "string"
      ? { externalUri: value.externalUri }
      : {}),
    ...(typeof value.externalUrl === "string"
      ? { externalUrl: value.externalUrl }
      : {}),
    ...(typeof value.isPlayable === "boolean"
      ? { isPlayable: value.isPlayable }
      : {}),
    ...(typeof value.isLocal === "boolean"
      ? { isLocal: value.isLocal }
      : {}),
    palette,
    lyrics: [],
  };
}

function validContext(
  value: unknown,
  providerId: MusicProviderId,
): PlaybackQueueSnapshot["context"] | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  if (
    value.providerId !== providerId
    || typeof value.collectionId !== "string"
    || !(
      value.collectionKind === "playlist"
      || value.collectionKind === "radio"
      || value.collectionKind === "album"
      || value.collectionKind === "artist"
    )
    || typeof value.collectionTitle !== "string"
  ) return undefined;
  return {
    providerId,
    collectionId: value.collectionId,
    collectionKind: value.collectionKind,
    collectionTitle: value.collectionTitle,
  };
}

function validStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : null;
}

function expandQueue(value: unknown): PlaybackQueueRestorableState | null {
  if (!isObject(value) || value.version !== currentVersion) return null;
  if (
    typeof value.queueId !== "string"
    || !isMusicProviderId(value.providerId)
    || !Array.isArray(value.items)
    || !isPlaybackOrder(value.order)
    || !isRepeatMode(value.repeatMode)
    || typeof value.manuallyAdjusted !== "boolean"
    || !isNonNegativeInteger(value.sourceStartIndex)
    || typeof value.upcomingCleared !== "boolean"
    || !isNonNegativeInteger(value.manualSequence)
  ) return null;

  const context = validContext(value.context, value.providerId);
  if (context === undefined) return null;
  const sourceItemIds = validStringArray(value.sourceItemIds);
  const historyIds = validStringArray(value.historyIds);
  const upcomingIds = validStringArray(value.upcomingIds);
  const modeOrderIds = validStringArray(value.modeOrderIds);
  const excludedEntryIds = validStringArray(value.excludedEntryIds);
  if (
    !sourceItemIds
    || !historyIds
    || !upcomingIds
    || !modeOrderIds
    || !excludedEntryIds
    || typeof value.currentId !== "string"
  ) return null;

  const itemById = new Map<string, PlaybackQueueItem>();
  for (const candidate of value.items) {
    if (!isObject(candidate)) return null;
    const track = validTrack(candidate.track);
    if (
      typeof candidate.queueItemId !== "string"
      || itemById.has(candidate.queueItemId)
      || !track
      || !(
        candidate.sourceIndex === null
        || isNonNegativeInteger(candidate.sourceIndex)
      )
      || !(candidate.origin === "collection" || candidate.origin === "manual")
      || (candidate.origin === "manual" && candidate.sourceIndex !== null)
    ) return null;
    itemById.set(candidate.queueItemId, {
      queueItemId: candidate.queueItemId,
      track,
      sourceIndex: candidate.sourceIndex,
      origin: candidate.origin,
    });
  }

  const resolve = (ids: readonly string[]) => ids.flatMap((id) => {
    const item = itemById.get(id);
    return item ? [item] : [];
  });
  const referencedIds = [
    ...sourceItemIds,
    ...historyIds,
    value.currentId,
    ...upcomingIds,
    ...modeOrderIds,
    ...excludedEntryIds,
  ];
  if (referencedIds.some((id) => !itemById.has(id))) return null;
  const current = itemById.get(value.currentId);
  if (!current) return null;

  return {
    version: currentVersion,
    snapshot: {
      queueId: value.queueId,
      providerId: value.providerId,
      context,
      sourceItems: resolve(sourceItemIds),
      history: resolve(historyIds),
      current,
      upcoming: resolve(upcomingIds),
      order: value.order,
      repeatMode: value.repeatMode,
      manuallyAdjusted: value.manuallyAdjusted,
    },
    sourceStartIndex: value.sourceStartIndex,
    modeOrderIds,
    excludedEntryIds,
    upcomingCleared: value.upcomingCleared,
    manualSequence: value.manualSequence,
  };
}

function validStoredSession(value: unknown): StoredPlaybackSessionV1 | null {
  if (!isObject(value) || value.version !== currentVersion) return null;
  if (
    !isMusicProviderId(value.providerId)
    || typeof value.accountId !== "string"
    || value.accountId.length === 0
    || !isFiniteNumber(value.savedAt)
    || value.savedAt < 0
    || !isFiniteNumber(value.positionMs)
    || !isListeningSpace(value.listeningSpace)
    || !isFiniteNumber(value.volume)
    || typeof value.muted !== "boolean"
    || !(
      value.lyricOffsetKey === null
      || typeof value.lyricOffsetKey === "string"
    )
  ) return null;
  const queue = expandQueue(value.queue);
  if (
    !queue
    || queue.snapshot.providerId !== value.providerId
    || !queue.snapshot.current
  ) return null;
  const compactedQueue = compactQueue(queue);
  if (!compactedQueue) return null;
  return {
    version: currentVersion,
    providerId: value.providerId,
    accountId: value.accountId,
    savedAt: value.savedAt,
    positionMs: normalizedPosition(
      value.positionMs,
      queue.snapshot.current.track.durationMs,
    ),
    listeningSpace: value.listeningSpace,
    volume: normalizedVolume(value.volume),
    muted: value.muted,
    lyricOffsetKey: value.lyricOffsetKey,
    queue: compactedQueue,
  };
}

function validEnvelope(value: unknown): StoredPlaybackSessionsV1 | null {
  if (
    !isObject(value)
    || value.version !== currentVersion
    || !Array.isArray(value.sessions)
  ) return null;
  const sessions = value.sessions.map(validStoredSession);
  if (sessions.some((session) => session === null)) return null;
  return {
    version: currentVersion,
    sessions: sessions as StoredPlaybackSessionV1[],
  };
}

function restoreStoredSession(
  stored: StoredPlaybackSessionV1,
): RestoredPlaybackSession | null {
  const queue = expandQueue(stored.queue);
  if (!queue?.snapshot.current) return null;
  return {
    providerId: stored.providerId,
    accountId: stored.accountId,
    savedAt: stored.savedAt,
    positionMs: normalizedPosition(
      stored.positionMs,
      queue.snapshot.current.track.durationMs,
    ),
    listeningSpace: stored.listeningSpace,
    volume: normalizedVolume(stored.volume),
    muted: stored.muted,
    lyricOffsetKey: stored.lyricOffsetKey,
    queue,
  };
}

function ownerKey(owner: PlaybackSessionOwner) {
  return `${owner.providerId}:${owner.accountId}`;
}

export class PlaybackSessionStore {
  private readonly storage: PlaybackSessionStorage | null;
  private readonly now: () => number;
  private readonly saveDelayMs: number;
  private readonly setTimer: NonNullable<PlaybackSessionStoreOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<PlaybackSessionStoreOptions["clearTimer"]>;
  private pending: PlaybackSessionDraft | null = null;
  private saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor({
    storage = browserStorage(),
    now = () => Date.now(),
    saveDelayMs = defaultSaveDelayMs,
    setTimer = (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
  }: PlaybackSessionStoreOptions = {}) {
    this.storage = storage;
    this.now = now;
    this.saveDelayMs = Math.max(0, saveDelayMs);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  scheduleSave(session: PlaybackSessionDraft) {
    this.pending = session;
    if (this.saveTimer !== null) return;
    this.saveTimer = this.setTimer(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
  }

  flush() {
    if (this.saveTimer !== null) {
      this.clearTimer(this.saveTimer);
      this.saveTimer = null;
    }
    const session = this.pending;
    this.pending = null;
    if (!session) return false;
    return this.write(session);
  }

  load(owner: PlaybackSessionOwner): RestoredPlaybackSession | null {
    const envelope = this.readEnvelope();
    if (!envelope) return null;
    const stored = envelope.sessions.find(
      (session) => ownerKey(session) === ownerKey(owner),
    );
    return stored ? restoreStoredSession(stored) : null;
  }

  clear(owner?: PlaybackSessionOwner) {
    if (
      this.pending
      && (!owner || ownerKey(this.pending) === ownerKey(owner))
    ) {
      this.pending = null;
      if (this.saveTimer !== null) {
        this.clearTimer(this.saveTimer);
        this.saveTimer = null;
      }
    }
    try {
      if (!owner) {
        this.storage?.removeItem(playbackSessionStorageKey);
        return;
      }
      const envelope = this.readEnvelope();
      if (!envelope) return;
      const sessions = envelope.sessions.filter(
        (session) => ownerKey(session) !== ownerKey(owner),
      );
      if (sessions.length === 0) {
        this.storage?.removeItem(playbackSessionStorageKey);
      } else {
        this.storage?.setItem(
          playbackSessionStorageKey,
          JSON.stringify({ version: currentVersion, sessions }),
        );
      }
    } catch {
      // Session persistence never blocks account logout or playback.
    }
  }

  private write(session: PlaybackSessionDraft) {
    const queue = compactQueue(session.queue);
    if (
      !queue
      || !session.accountId
      || queue.providerId !== session.providerId
      || !isListeningSpace(session.listeningSpace)
      || !isFiniteNumber(session.positionMs)
      || !isFiniteNumber(session.volume)
    ) return false;
    const current = session.queue.snapshot.current;
    if (!current) return false;

    const stored: StoredPlaybackSessionV1 = {
      version: currentVersion,
      providerId: session.providerId,
      accountId: session.accountId,
      savedAt: this.now(),
      positionMs: normalizedPosition(
        session.positionMs,
        current.track.durationMs,
      ),
      listeningSpace: session.listeningSpace,
      volume: normalizedVolume(session.volume),
      muted: session.muted,
      lyricOffsetKey:
        typeof session.lyricOffsetKey === "string"
          ? session.lyricOffsetKey
          : null,
      queue,
    };
    const existing = this.readEnvelope()?.sessions ?? [];
    const sessions = [
      stored,
      ...existing.filter((candidate) => (
        ownerKey(candidate) !== ownerKey(stored)
      )),
    ].slice(0, maximumStoredOwners);
    try {
      this.storage?.setItem(
        playbackSessionStorageKey,
        JSON.stringify({ version: currentVersion, sessions }),
      );
      return Boolean(this.storage);
    } catch {
      return false;
    }
  }

  private readEnvelope() {
    try {
      const serialized = this.storage?.getItem(playbackSessionStorageKey);
      return serialized
        ? validEnvelope(JSON.parse(serialized) as unknown)
        : null;
    } catch {
      return null;
    }
  }
}

export const playbackSessionStore = new PlaybackSessionStore();
