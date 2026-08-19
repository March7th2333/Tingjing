import assert from "node:assert/strict";
import test from "node:test";
import type { MusicProvider } from "../src/providers/MusicProvider.ts";
import type { AudioSource, Lyrics, Track } from "../src/types/music.ts";
import {
  PlaybackPrefetchService,
} from "../src/features/player/PlaybackPrefetchService.ts";
import {
  ProviderRequestError,
  isSilentProviderRequestError,
} from "../src/features/player/ProviderRequestCoordinator.ts";
import type {
  PlaybackQueueItem,
  PlaybackQueueSnapshot,
} from "../src/features/player/PlaybackQueueController.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function track(id: string, coverImage = `cover://${id}`): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    album: "Album",
    durationMs: 180_000,
    coverImage,
    coverLabel: id,
    palette: {
      background: "#111",
      ambient: "#222",
      accent: "#ddd",
      text: "#fff",
    },
    lyrics: [],
  };
}

function audio(trackId: string, expiresInSeconds = 600): AudioSource {
  return {
    trackId,
    url: `https://audio.example/${trackId}.mp3`,
    expiresInSeconds,
    isFreeTrial: false,
  };
}

function lyrics(trackId: string): Lyrics {
  return {
    trackId,
    source: "lrc",
    lines: [{ atMs: 0, durationMs: 1_000, text: `Lyric ${trackId}` }],
    hasTranslation: false,
  };
}

interface ProviderHarness {
  provider: MusicProvider;
  audioCalls: string[];
  lyricCalls: string[];
}

function providerHarness(options: {
  id?: "qq" | "netease";
  getAudioSource?: (trackId: string) => Promise<AudioSource>;
  getLyrics?: (trackId: string) => Promise<Lyrics>;
} = {}): ProviderHarness {
  const audioCalls: string[] = [];
  const lyricCalls: string[] = [];
  const id = options.id ?? "qq";
  const provider: MusicProvider = {
    id,
    displayName: id,
    scanAppName: id,
    restoreSession: async () => ({ connected: false, message: "test" }),
    createQrLogin: async () => ({ key: "test", qrUrl: "test", qrSvg: "" }),
    checkQrLogin: async () => ({ state: "waiting", code: 0, message: "test" }),
    syncLibrary: async () => ({
      user: { id: "test", nickname: "Test" },
      playlists: [],
      radios: [],
      albums: [],
      tracks: [],
      likedTrackIds: [],
      syncedAt: 0,
      source: id,
      truncated: false,
    }),
    getCollectionTracks: async () => [],
    getLyrics: async (trackId) => {
      lyricCalls.push(trackId);
      return options.getLyrics?.(trackId) ?? lyrics(trackId);
    },
    getAudioSource: async (trackId) => {
      audioCalls.push(trackId);
      return options.getAudioSource?.(trackId) ?? audio(trackId);
    },
    disconnect: async () => undefined,
    isConnected: async () => true,
    getTracks: async () => [],
    getPlaylists: async () => [],
    search: async () => [],
  };
  return { provider, audioCalls, lyricCalls };
}

function setServiceContext(
  service: PlaybackPrefetchService,
  provider: MusicProvider,
  accountId = "account-a",
) {
  service.setContext({
    providerId: provider.id as "qq" | "netease",
    accountId,
    provider,
  });
}

function queueItem(id: string): PlaybackQueueItem {
  return {
    queueItemId: `queue:${id}`,
    track: track(id),
    sourceIndex: 0,
    origin: "collection",
  };
}

function queueSnapshot(
  history: PlaybackQueueItem[],
  current: PlaybackQueueItem,
  upcoming: PlaybackQueueItem[],
): PlaybackQueueSnapshot {
  return {
    queueId: "queue",
    providerId: "qq",
    context: {
      providerId: "qq",
      collectionId: "playlist-1",
      collectionKind: "playlist",
      collectionTitle: "Playlist",
    },
    sourceItems: [...history, current, ...upcoming],
    history,
    current,
    upcoming,
    order: "sequential",
    manuallyAdjusted: false,
  };
}

test("same audio and lyric keys deduplicate concurrent provider calls", async () => {
  const pendingAudio = deferred<AudioSource>();
  const pendingLyrics = deferred<Lyrics>();
  const harness = providerHarness({
    getAudioSource: () => pendingAudio.promise,
    getLyrics: () => pendingLyrics.promise,
  });
  const service = new PlaybackPrefetchService();
  setServiceContext(service, harness.provider);
  const item = track("dedupe");
  const lease = service.beginSinglePlayback(item.id);

  const audioA = service.resolveAudioForPlayback(lease);
  const audioB = service.resolveAudioForPlayback(lease);
  const lyricsA = service.resolveLyricsForPlayback(lease, item);
  const lyricsB = service.resolveLyricsForPlayback(lease, item);
  assert.deepEqual(harness.audioCalls, ["dedupe"]);
  assert.deepEqual(harness.lyricCalls, ["dedupe"]);

  pendingAudio.resolve(audio(item.id));
  pendingLyrics.resolve(lyrics(item.id));
  assert.equal((await audioA).trackId, item.id);
  assert.equal((await audioB).trackId, item.id);
  assert.equal((await lyricsA).lyrics.trackId, item.id);
  assert.equal((await lyricsB).lyrics.trackId, item.id);
});

test("audio cache honors TTL safety margin and expires at the boundary", async () => {
  let clock = 1_000;
  const harness = providerHarness({
    getAudioSource: async (trackId) => audio(trackId, 10),
  });
  const service = new PlaybackPrefetchService(undefined, () => clock);
  setServiceContext(service, harness.provider);

  let lease = service.beginSinglePlayback("ttl");
  await service.resolveAudioForPlayback(lease);
  clock = 9_999;
  lease = service.beginSinglePlayback("ttl");
  await service.resolveAudioForPlayback(lease);
  assert.equal(harness.audioCalls.length, 1);

  clock = 10_000;
  lease = service.beginSinglePlayback("ttl");
  await service.resolveAudioForPlayback(lease);
  assert.equal(harness.audioCalls.length, 2);
});

test("the same track with different quality keys never shares audio cache", async () => {
  const harness = providerHarness();
  const service = new PlaybackPrefetchService();
  setServiceContext(service, harness.provider);

  await service.resolveAudioForPlayback(
    service.beginSinglePlayback("quality", "standard"),
  );
  await service.resolveAudioForPlayback(
    service.beginSinglePlayback("quality", "lossless"),
  );
  assert.deepEqual(harness.audioCalls, ["quality", "quality"]);
});

test("audio cache is bounded by its LRU capacity", async () => {
  const harness = providerHarness();
  const service = new PlaybackPrefetchService();
  setServiceContext(service, harness.provider);

  for (let index = 0; index < 25; index += 1) {
    const id = `lru-${index}`;
    await service.resolveAudioForPlayback(service.beginSinglePlayback(id));
  }
  await service.resolveAudioForPlayback(
    service.beginSinglePlayback("lru-0"),
  );
  assert.equal(harness.audioCalls.length, 26);
  assert.equal(
    harness.audioCalls.filter((id) => id === "lru-0").length,
    2,
  );
});

test("provider failures are not cached and a later request retries", async () => {
  let attempt = 0;
  const harness = providerHarness({
    getAudioSource: async (trackId) => {
      attempt += 1;
      if (attempt === 1) throw new Error("network timeout");
      return audio(trackId);
    },
  });
  const service = new PlaybackPrefetchService();
  setServiceContext(service, harness.provider);

  await assert.rejects(
    service.resolveAudioForPlayback(service.beginSinglePlayback("retry")),
    (error: unknown) => error instanceof ProviderRequestError
      && error.code === "network",
  );
  const source = await service.resolveAudioForPlayback(
    service.beginSinglePlayback("retry"),
  );
  assert.equal(source.trackId, "retry");
  assert.equal(harness.audioCalls.length, 2);
});

test("prefetch exposes trial and permission availability without autoplay", async () => {
  const trialHarness = providerHarness({
    getAudioSource: async (trackId) => ({
      ...audio(trackId),
      isFreeTrial: true,
    }),
  });
  const trialService = new PlaybackPrefetchService();
  setServiceContext(trialService, trialHarness.provider);
  await trialService.prefetchTrack(track("trial"));
  const trialStatus = trialService.getPlaybackAvailability("trial");
  assert.equal(trialStatus?.status, "trial");
  assert.equal(trialStatus?.source?.isFreeTrial, true);

  const permissionHarness = providerHarness({
    getAudioSource: async () => {
      throw new Error("HTTP 403 Forbidden");
    },
  });
  const permissionService = new PlaybackPrefetchService();
  setServiceContext(permissionService, permissionHarness.provider);
  await permissionService.prefetchTrack(track("blocked"));
  const permissionStatus =
    permissionService.getPlaybackAvailability("blocked");
  assert.equal(permissionStatus?.status, "permission-denied");
  assert.match(permissionStatus?.message ?? "", /403/);
});

test("wrong track identities are rejected silently and never cached", async () => {
  const harness = providerHarness({
    getAudioSource: async () => audio("another-track"),
  });
  const service = new PlaybackPrefetchService();
  setServiceContext(service, harness.provider);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      service.resolveAudioForPlayback(service.beginSinglePlayback("expected")),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError);
        assert.equal(error.code, "stale");
        assert.equal(isSilentProviderRequestError(error), true);
        return true;
      },
    );
  }
  assert.equal(harness.audioCalls.length, 2);
});

test("account switching logically cancels late work without caching it", async () => {
  const oldAudio = deferred<AudioSource>();
  const harness = providerHarness({ getAudioSource: () => oldAudio.promise });
  const service = new PlaybackPrefetchService();
  setServiceContext(service, harness.provider, "account-a");
  const oldRequest = service.resolveAudioForPlayback(
    service.beginSinglePlayback("switch"),
  );

  setServiceContext(service, harness.provider, "account-b");
  oldAudio.resolve(audio("switch"));
  await assert.rejects(oldRequest, (error: unknown) =>
    error instanceof ProviderRequestError
      && error.code === "stale"
      && isSilentProviderRequestError(error));

  setServiceContext(service, harness.provider, "account-a");
  await service.resolveAudioForPlayback(service.beginSinglePlayback("switch"));
  assert.equal(harness.audioCalls.length, 2);
});

test("clearContext cancels a playback result and requires a new session", async () => {
  const pendingAudio = deferred<AudioSource>();
  const harness = providerHarness({ getAudioSource: () => pendingAudio.promise });
  const service = new PlaybackPrefetchService();
  setServiceContext(service, harness.provider);
  const request = service.resolveAudioForPlayback(
    service.beginSinglePlayback("logout"),
  );

  service.clearContext("logout");
  pendingAudio.resolve(audio("logout"));
  await assert.rejects(request, (error: unknown) =>
    error instanceof ProviderRequestError
      && error.code === "stale"
      && isSilentProviderRequestError(error));
  assert.throws(
    () => service.beginSinglePlayback("logout"),
    (error: unknown) => error instanceof ProviderRequestError
      && error.code === "auth-expired",
  );
});

test("hover prefetch can be cancelled before its threshold", async () => {
  const covers: Array<string | undefined> = [];
  const harness = providerHarness();
  const service = new PlaybackPrefetchService(undefined, undefined, {
    preloadImage: async (source) => {
      covers.push(source);
    },
  });
  setServiceContext(service, harness.provider);
  const hovered = track("hover");

  const cancel = service.schedulePrefetch(hovered, { delayMs: 25 });
  cancel();
  await wait(45);
  assert.deepEqual(harness.audioCalls, []);
  assert.deepEqual(harness.lyricCalls, []);
  assert.deepEqual(covers, []);

  service.schedulePrefetch(hovered, { delayMs: 10 });
  await wait(35);
  assert.deepEqual(harness.audioCalls, ["hover"]);
  assert.deepEqual(harness.lyricCalls, ["hover"]);
  assert.deepEqual(covers, [hovered.coverImage]);
});

test("queue window prefetches previous one, current, and next two only", async () => {
  const covers: Array<string | undefined> = [];
  const harness = providerHarness();
  const service = new PlaybackPrefetchService(undefined, undefined, {
    preloadImage: async (source) => {
      covers.push(source);
    },
  });
  setServiceContext(service, harness.provider);
  const snapshot = queueSnapshot(
    [queueItem("old-2"), queueItem("previous")],
    queueItem("current"),
    [queueItem("next-1"), queueItem("next-2"), queueItem("next-3")],
  );

  service.prefetchQueueWindow(snapshot);
  await wait(220);
  const expected = new Set(["previous", "current", "next-1", "next-2"]);
  assert.deepEqual(new Set(harness.audioCalls), expected);
  assert.deepEqual(new Set(harness.lyricCalls), expected);
  assert.deepEqual(
    new Set(covers),
    new Set([...expected].map((id) => `cover://${id}`)),
  );
  assert.equal(harness.audioCalls.includes("next-3"), false);
  assert.equal(harness.audioCalls.includes("old-2"), false);
});

test("replacing a queue window before its threshold cancels every old request", async () => {
  const covers: Array<string | undefined> = [];
  const harness = providerHarness();
  const service = new PlaybackPrefetchService(undefined, undefined, {
    preloadImage: async (source) => {
      covers.push(source);
    },
  });
  setServiceContext(service, harness.provider);
  const oldSnapshot = queueSnapshot(
    [queueItem("old-previous")],
    queueItem("old-current"),
    [queueItem("old-next-1"), queueItem("old-next-2")],
  );
  const nextSnapshot = queueSnapshot(
    [queueItem("new-previous")],
    queueItem("new-current"),
    [queueItem("new-next-1"), queueItem("new-next-2")],
  );

  const cancelOldWindow = service.prefetchQueueWindow(oldSnapshot);
  cancelOldWindow();
  service.prefetchQueueWindow(nextSnapshot);
  await wait(220);

  const oldIds = new Set([
    "old-previous",
    "old-current",
    "old-next-1",
    "old-next-2",
  ]);
  assert.equal(harness.audioCalls.some((id) => oldIds.has(id)), false);
  assert.equal(harness.lyricCalls.some((id) => oldIds.has(id)), false);
  assert.equal(
    covers.some((source) => source != null && oldIds.has(source.replace("cover://", ""))),
    false,
  );

  const expectedNew = new Set([
    "new-previous",
    "new-current",
    "new-next-1",
    "new-next-2",
  ]);
  assert.deepEqual(new Set(harness.audioCalls), expectedNew);
  assert.deepEqual(new Set(harness.lyricCalls), expectedNew);
  assert.deepEqual(
    new Set(covers),
    new Set([...expectedNew].map((id) => `cover://${id}`)),
  );
});

test("prefetch only resolves resources and reuses the injected image cache path", async () => {
  const decodedCovers = new Set<string>();
  const coverDownloads: string[] = [];
  const harness = providerHarness();
  const service = new PlaybackPrefetchService(undefined, undefined, {
    preloadImage: async (source) => {
      if (source && !decodedCovers.has(source)) {
        decodedCovers.add(source);
        coverDownloads.push(source);
      }
    },
  });
  setServiceContext(service, harness.provider);
  const sharedCover = "cover://shared";

  await service.prefetchTrack(track("one", sharedCover));
  await service.prefetchTrack(track("two", sharedCover));
  assert.deepEqual(coverDownloads, [sharedCover]);
  assert.deepEqual(harness.audioCalls, ["one", "two"]);
  assert.deepEqual(harness.lyricCalls, ["one", "two"]);
  // Playback is deliberately absent from the prefetch service API: resolving
  // provider data cannot call HTMLMediaElement.play().
});
