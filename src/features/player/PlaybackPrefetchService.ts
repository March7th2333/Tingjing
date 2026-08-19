import type { MusicProvider } from "../../providers/MusicProvider";
import type {
  AudioSource,
  Lyrics,
  NormalizedLyricDocument,
  Track,
} from "../../types/music";
import {
  createUnavailableLyricDocument,
  normalizeLyricDocument,
} from "../lyrics/LyricTruth.ts";
import type {
  PlaybackQueueItem,
  PlaybackQueueSnapshot,
} from "./PlaybackQueueController";
import {
  classifyProviderRequestError,
  ProviderRequestCoordinator,
  ProviderRequestError,
  type PlaybackRequestIdentity,
  type ProviderRequestContext,
  type ProviderRequestLease,
} from "./ProviderRequestCoordinator.ts";

export interface PlaybackPrefetchContext extends ProviderRequestContext {
  provider: MusicProvider;
}

export interface PrefetchedLyrics {
  lyrics: Lyrics;
  document: NormalizedLyricDocument;
}

export interface LyricsRequestConsumer {
  resolve(track: Track): Promise<PrefetchedLyrics>;
  cancel(reason?: string): void;
}

interface AudioCacheEntry {
  source: AudioSource;
  fetchedAt: number;
  expiresAt: number;
  qualityKey: string;
}

interface LyricsCacheEntry extends PrefetchedLyrics {
  expiresAt: number;
}

export type PlaybackAvailabilityStatus =
  | "ready"
  | "trial"
  | "permission-denied";

export interface PlaybackAvailability {
  status: PlaybackAvailabilityStatus;
  checkedAt: number;
  expiresAt: number;
  source?: AudioSource;
  message?: string;
}

interface ScheduledPrefetch {
  thresholdTimer: ReturnType<typeof setTimeout>;
  idleHandle: number | null;
}

export interface PrefetchTrackOptions {
  qualityKey?: string;
  includeAudio?: boolean;
  includeLyrics?: boolean;
}

export interface PlaybackPrefetchDependencies {
  /** Reuses the application's decoded image cache; it must not create a new image cache. */
  preloadImage?: (source: string | undefined) => Promise<void>;
}

const defaultQualityKey = "provider-default";
const emptyLyricsCacheMs = 30_000;
const permissionStatusCacheMs = 30_000;

async function preloadWithSharedImageCache(source: string | undefined) {
  const { imageCache } = await import("../../config/ImageCache.ts");
  return imageCache.preload(source);
}

function lruGet<Value>(map: Map<string, Value>, key: string) {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function lruSet<Value>(
  map: Map<string, Value>,
  key: string,
  value: Value,
  capacity: number,
) {
  map.delete(key);
  map.set(key, value);
  while (map.size > capacity) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) break;
    map.delete(oldest);
  }
}

function cacheIdentity(context: ProviderRequestContext) {
  return `${context.providerId}:${context.accountId ?? "anonymous"}`;
}

function audioKey(
  context: ProviderRequestContext,
  trackId: string,
  qualityKey: string,
) {
  return `${cacheIdentity(context)}:${trackId}:${qualityKey}`;
}

function lyricsKey(context: ProviderRequestContext, trackId: string) {
  return `${cacheIdentity(context)}:${trackId}`;
}

function audioExpiry(source: AudioSource, fetchedAt: number) {
  const ttlMs = (source.expiresInSeconds ?? 0) * 1_000;
  if (ttlMs <= 0) {
    return fetchedAt;
  }
  const safetyMs = Math.min(30_000, Math.max(1_000, ttlMs * 0.1));
  return fetchedAt + Math.max(0, ttlMs - safetyMs);
}

export class PlaybackPrefetchService {
  readonly coordinator: ProviderRequestCoordinator;
  private context: PlaybackPrefetchContext | null = null;
  private readonly now: () => number;
  private readonly dependencies: PlaybackPrefetchDependencies;
  private readonly audioCache = new Map<string, AudioCacheEntry>();
  private readonly lyricsCache = new Map<string, LyricsCacheEntry>();
  private readonly availabilityCache = new Map<
    string,
    PlaybackAvailability
  >();
  private readonly audioInFlight = new Map<string, Promise<AudioCacheEntry>>();
  private readonly lyricsInFlight = new Map<string, Promise<LyricsCacheEntry>>();
  private readonly scheduled = new Map<string, ScheduledPrefetch>();

  constructor(
    coordinator = new ProviderRequestCoordinator(),
    now = () => Date.now(),
    dependencies: PlaybackPrefetchDependencies = {},
  ) {
    this.coordinator = coordinator;
    this.now = now;
    this.dependencies = dependencies;
  }

  setContext(next: PlaybackPrefetchContext) {
    const identityChanged = this.context?.providerId !== next.providerId
      || this.context.accountId !== next.accountId;
    const providerChanged = Boolean(
      this.context
      && this.context.provider !== next.provider,
    );
    if (providerChanged && !identityChanged) {
      this.coordinator.invalidateContext("Provider client changed");
    }
    this.coordinator.setContext(next);
    this.context = next;
    if (identityChanged || providerChanged) {
      this.clearCaches();
    }
  }

  getContext() {
    return this.context;
  }

  beginPlayback(
    item: PlaybackQueueItem,
    snapshot: PlaybackQueueSnapshot,
    qualityKey = defaultQualityKey,
  ) {
    const context = this.requireContext();
    return this.coordinator.beginPlayback({
      providerId: context.providerId,
      accountId: context.accountId,
      trackId: item.track.id,
      queueItemId: item.queueItemId,
      collectionId: snapshot.context?.collectionId ?? null,
      qualityKey,
    });
  }

  beginSinglePlayback(
    trackId: string,
    qualityKey = defaultQualityKey,
  ) {
    const context = this.requireContext();
    return this.coordinator.beginPlayback({
      providerId: context.providerId,
      accountId: context.accountId,
      trackId,
      qualityKey,
    });
  }

  async resolveAudioForPlayback(
    lease: ProviderRequestLease,
  ) {
    return this.coordinator.runPlayback(lease, async () => {
      const entry = await this.getAudioEntry(
        lease,
        lease.trackId,
        lease.qualityKey,
      );
      return entry.source;
    });
  }

  async resolveLyricsForPlayback(
    lease: ProviderRequestLease,
    track: Track,
  ) {
    return this.coordinator.runPlayback(lease, async () =>
      this.getLyricsEntry(lease, track));
  }

  async resolveLyrics(track: Track) {
    const context = this.requireContext();
    return this.getLyricsEntry(context, track);
  }

  createLyricsConsumer(): LyricsRequestConsumer {
    const scope = this.coordinator.createScope();
    return {
      resolve: (track) =>
        scope.run(async () => this.resolveLyrics(track)),
      cancel: (reason) => scope.cancel(reason),
    };
  }

  prefetchTrack(track: Track, options: PrefetchTrackOptions = {}) {
    const context = this.requireContext();
    const qualityKey = options.qualityKey ?? defaultQualityKey;
    const preloadImage = this.dependencies.preloadImage
      ?? preloadWithSharedImageCache;
    void preloadImage(track.coverImage).catch(() => undefined);
    const work: Promise<unknown>[] = [];
    if (options.includeAudio !== false) {
      work.push(this.getAudioEntry(context, track.id, qualityKey));
    }
    if (options.includeLyrics !== false) {
      work.push(this.getLyricsEntry(context, track));
    }
    return Promise.allSettled(work);
  }

  schedulePrefetch(
    track: Track,
    options: PrefetchTrackOptions & { delayMs?: number } = {},
  ) {
    const context = this.requireContext();
    const qualityKey = options.qualityKey ?? defaultQualityKey;
    const key = `${cacheIdentity(context)}:${track.id}:${qualityKey}`;
    const existing = this.scheduled.get(key);
    if (existing) {
      this.cancelScheduledPrefetch(existing);
    }
    const run = () => {
      const scheduled = this.scheduled.get(key);
      if (scheduled !== entry) return;
      this.scheduled.delete(key);
      try {
        void this.prefetchTrack(track, options);
      } catch {
        // The Provider/account may have been cleared between hover and idle.
      }
    };
    const thresholdTimer = setTimeout(() => {
      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        entry.idleHandle = window.requestIdleCallback(run, { timeout: 320 });
        return;
      }
      run();
    }, Math.max(0, options.delayMs ?? 140));
    const entry: ScheduledPrefetch = {
      thresholdTimer,
      idleHandle: null,
    };
    this.scheduled.set(key, entry);
    return () => {
      if (this.scheduled.get(key) === entry) {
        this.cancelScheduledPrefetch(entry);
        this.scheduled.delete(key);
      }
    };
  }

  prefetchQueueWindow(snapshot: PlaybackQueueSnapshot) {
    const items = [
      snapshot.history.at(-1),
      snapshot.current,
      ...snapshot.upcoming.slice(0, 2),
    ].filter((item): item is PlaybackQueueItem => Boolean(item));
    const unique = new Map(items.map((item) => [item.queueItemId, item]));
    const cancellations = [...unique.values()].map((item, index) =>
      this.schedulePrefetch(item.track, { delayMs: 80 + index * 24 }));
    return () => cancellations.forEach((cancel) => cancel());
  }

  evictAudio(trackId: string, qualityKey = defaultQualityKey) {
    const context = this.context;
    if (!context) return;
    this.audioCache.delete(audioKey(context, trackId, qualityKey));
    this.availabilityCache.delete(audioKey(context, trackId, qualityKey));
  }

  getPlaybackAvailability(
    trackId: string,
    qualityKey = defaultQualityKey,
  ) {
    const context = this.context;
    if (!context) return null;
    const key = audioKey(context, trackId, qualityKey);
    const availability = lruGet(this.availabilityCache, key);
    if (!availability || availability.expiresAt <= this.now()) {
      this.availabilityCache.delete(key);
      return null;
    }
    return availability;
  }

  invalidatePlayback(reason?: string) {
    this.coordinator.invalidatePlayback(reason);
  }

  clearContext(reason = "Playback provider context cleared") {
    this.coordinator.invalidateContext(reason);
    this.context = null;
    this.clearCaches();
  }

  private requireContext() {
    if (!this.context) {
      throw new ProviderRequestError(
        "auth-expired",
        "尚未建立音乐平台会话",
      );
    }
    return this.context;
  }

  private async getAudioEntry(
    context: ProviderRequestContext,
    trackId: string,
    qualityKey: string,
  ) {
    const key = audioKey(context, trackId, qualityKey);
    const cached = lruGet(this.audioCache, key);
    if (cached && cached.expiresAt > this.now()) {
      return cached;
    }
    this.audioCache.delete(key);

    const pending = this.audioInFlight.get(key);
    if (pending) return pending;
    const activeContext = this.requireContext();
    const request = this.coordinator.runInContext(context, async () => {
      // Tauri invoke requests cannot be physically aborted here. The
      // coordinator rejects their result if this logical context is stale.
      const source = await activeContext.provider.getAudioSource(trackId);
      if (!source.url.trim()) {
        throw new ProviderRequestError("empty-audio-url", "播放地址为空");
      }
      if (String(source.trackId) !== String(trackId)) {
        throw new ProviderRequestError("stale", "播放地址属于另一首歌曲", {
          userVisible: false,
        });
      }
      return source;
    }).then((source) => {
      const fetchedAt = this.now();
      const entry: AudioCacheEntry = {
        source,
        fetchedAt,
        expiresAt: audioExpiry(source, fetchedAt),
        qualityKey,
      };
      if (entry.expiresAt > fetchedAt) {
        lruSet(this.audioCache, key, entry, 24);
      }
      const availability: PlaybackAvailability = {
        status: source.isFreeTrial ? "trial" : "ready",
        checkedAt: fetchedAt,
        expiresAt: entry.expiresAt > fetchedAt
          ? entry.expiresAt
          : fetchedAt + permissionStatusCacheMs,
        source,
      };
      lruSet(this.availabilityCache, key, availability, 24);
      return entry;
    }).catch((error: unknown) => {
      const classified = classifyProviderRequestError(error);
      if (
        classified.code === "permission-denied"
        || classified.code === "trial-only"
      ) {
        const checkedAt = this.now();
        lruSet(this.availabilityCache, key, {
          status: classified.code === "trial-only"
            ? "trial"
            : "permission-denied",
          checkedAt,
          expiresAt: checkedAt + permissionStatusCacheMs,
          message: classified.message,
        }, 24);
      }
      throw error;
    }).finally(() => {
      if (this.audioInFlight.get(key) === request) {
        this.audioInFlight.delete(key);
      }
    });
    this.audioInFlight.set(key, request);
    return request;
  }

  private async getLyricsEntry(
    context: ProviderRequestContext,
    track: Track,
  ) {
    if (track.lyrics.length > 0) {
      const lyrics: Lyrics = {
        trackId: track.id,
        lines: track.lyrics,
        hasTranslation: track.lyrics.some((line) => Boolean(line.translation)),
        source: "embedded",
      };
      return {
        lyrics,
        document: normalizeLyricDocument({
          provider: context.providerId,
          trackId: track.id,
          durationMs: track.durationMs,
          lyrics,
          source: "embedded",
        }),
        expiresAt: Number.POSITIVE_INFINITY,
      } satisfies LyricsCacheEntry;
    }

    const key = lyricsKey(context, track.id);
    const cached = lruGet(this.lyricsCache, key);
    if (cached && cached.expiresAt > this.now()) {
      return cached;
    }
    this.lyricsCache.delete(key);
    const pending = this.lyricsInFlight.get(key);
    if (pending) return pending;
    const activeContext = this.requireContext();
    const request = this.coordinator.runInContext(context, async () => {
      const lyrics = await activeContext.provider.getLyrics(track.id);
      if (String(lyrics.trackId) !== String(track.id)) {
        throw new ProviderRequestError("stale", "歌词属于另一首歌曲", {
          userVisible: false,
        });
      }
      return lyrics;
    }).then((lyrics) => {
      const document = lyrics.lines.length > 0
        ? normalizeLyricDocument({
            provider: context.providerId,
            trackId: track.id,
            durationMs: track.durationMs,
            lyrics,
          })
        : createUnavailableLyricDocument(context.providerId, track.id);
      const entry: LyricsCacheEntry = {
        lyrics,
        document,
        expiresAt: lyrics.lines.length > 0
          ? Number.POSITIVE_INFINITY
          : this.now() + emptyLyricsCacheMs,
      };
      lruSet(this.lyricsCache, key, entry, 96);
      return entry;
    }).finally(() => {
      if (this.lyricsInFlight.get(key) === request) {
        this.lyricsInFlight.delete(key);
      }
    });
    this.lyricsInFlight.set(key, request);
    return request;
  }

  private clearCaches() {
    this.scheduled.forEach((scheduled) =>
      this.cancelScheduledPrefetch(scheduled));
    this.scheduled.clear();
    this.audioCache.clear();
    this.lyricsCache.clear();
    this.availabilityCache.clear();
    this.audioInFlight.clear();
    this.lyricsInFlight.clear();
  }

  private cancelScheduledPrefetch(scheduled: ScheduledPrefetch) {
    clearTimeout(scheduled.thresholdTimer);
    if (
      scheduled.idleHandle !== null
      && typeof window !== "undefined"
      && "cancelIdleCallback" in window
    ) {
      window.cancelIdleCallback(scheduled.idleHandle);
    }
  }
}

export function playbackRequestIdentity(
  context: ProviderRequestContext,
  trackId: string,
  qualityKey = defaultQualityKey,
): PlaybackRequestIdentity {
  return { ...context, trackId, qualityKey };
}
