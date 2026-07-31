import assert from "node:assert/strict";
import test from "node:test";
import {
  PlaybackSessionStore,
  playbackSessionStorageKey,
  reconcileRestoredPlaybackSession,
  type PlaybackSessionDraft,
} from "../src/features/player/PlaybackSessionStore.ts";
import type {
  PlaybackQueueItem,
  PlaybackQueueRestorableState,
} from "../src/features/player/PlaybackQueueController.ts";
import type { Track } from "../src/types/music.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
    this.writes += 1;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function track(id: string, durationMs = 180_000): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    artists: [{ id: "artist-1", name: "Artist" }],
    album: "Album",
    albumId: "album-1",
    durationMs,
    coverImage: `https://img.test/${id}.jpg`,
    coverLabel: id,
    palette: {
      background: "#111",
      ambient: "#222",
      accent: "#ddd",
      text: "#fff",
    },
    lyrics: [{
      atMs: 0,
      text: "must not be persisted",
      words: [{ text: "secret", atMs: 0, durationMs: 100 }],
    }],
  };
}

function item(
  queueItemId: string,
  value: Track,
  sourceIndex: number | null,
  origin: PlaybackQueueItem["origin"] = "collection",
): PlaybackQueueItem {
  return { queueItemId, track: value, sourceIndex, origin };
}

function queueState(): PlaybackQueueRestorableState {
  const first = item("qq:collection:0:duplicate", track("duplicate"), 0);
  const second = item("qq:collection:1:duplicate", track("duplicate"), 1);
  const manualTrack = {
    ...track("manual", 90_000),
    // Runtime provider objects may carry extra fields. Persistence must use an
    // explicit allowlist rather than serializing those objects wholesale.
    audioUrl: "https://audio.test/credential-bearing-url",
    providerToken: "never-store-me",
  } as Track;
  const manual = item("qq:manual:7:manual", manualTrack, null, "manual");
  return {
    version: 1,
    snapshot: {
      queueId: "qq:queue:1",
      providerId: "qq",
      context: {
        providerId: "qq",
        collectionId: "playlist-1",
        collectionKind: "playlist",
        collectionTitle: "My playlist",
      },
      sourceItems: [first, second],
      history: [first],
      current: second,
      upcoming: [manual],
      order: "shuffle",
      repeatMode: "all",
      manuallyAdjusted: true,
    },
    sourceStartIndex: 1,
    modeOrderIds: [manual.queueItemId],
    excludedEntryIds: [first.queueItemId],
    upcomingCleared: true,
    manualSequence: 7,
  };
}

function draft(
  accountId = "account-a",
  positionMs = 999_999,
): PlaybackSessionDraft {
  return {
    providerId: "qq",
    accountId,
    queue: queueState(),
    positionMs,
    listeningSpace: "typography",
    volume: 1.5,
    muted: true,
    lyricOffsetKey: "qq:duplicate:qrc",
  };
}

test("round trip keeps queue occurrence identity and private controller state", () => {
  const storage = new MemoryStorage();
  const store = new PlaybackSessionStore({
    storage,
    now: () => 1_700_000_000_000,
  });
  store.scheduleSave(draft());
  assert.equal(store.flush(), true);

  const serialized = storage.getItem(playbackSessionStorageKey) ?? "";
  assert.equal(serialized.includes("must not be persisted"), false);
  assert.equal(serialized.includes("credential-bearing-url"), false);
  assert.equal(serialized.includes("never-store-me"), false);

  const restored = store.load({ providerId: "qq", accountId: "account-a" });
  assert.ok(restored);
  assert.equal(restored.savedAt, 1_700_000_000_000);
  assert.equal(restored.positionMs, 180_000);
  assert.equal(restored.volume, 1);
  assert.equal(restored.muted, true);
  assert.equal(restored.listeningSpace, "typography");
  assert.equal(restored.lyricOffsetKey, "qq:duplicate:qrc");
  assert.equal(restored.queue.snapshot.order, "shuffle");
  assert.equal(restored.queue.snapshot.repeatMode, "all");
  assert.equal(restored.queue.snapshot.manuallyAdjusted, true);
  assert.equal(restored.queue.sourceStartIndex, 1);
  assert.deepEqual(restored.queue.modeOrderIds, ["qq:manual:7:manual"]);
  assert.deepEqual(restored.queue.excludedEntryIds, [
    "qq:collection:0:duplicate",
  ]);
  assert.equal(restored.queue.upcomingCleared, true);
  assert.equal(restored.queue.manualSequence, 7);
  assert.equal(restored.queue.snapshot.current?.queueItemId,
    "qq:collection:1:duplicate");
  assert.equal(restored.queue.snapshot.current?.track.lyrics.length, 0);
  assert.equal(restored.queue.snapshot.upcoming[0]?.origin, "manual");
  assert.notEqual(
    restored.queue.snapshot.sourceItems[0]?.queueItemId,
    restored.queue.snapshot.sourceItems[1]?.queueItemId,
  );
});

test("Spotify session validation preserves official external playback identity", () => {
  const storage = new MemoryStorage();
  const store = new PlaybackSessionStore({ storage });
  const spotifyQueue = queueState();
  spotifyQueue.snapshot.providerId = "spotify";
  spotifyQueue.snapshot.context = {
    ...spotifyQueue.snapshot.context!,
    providerId: "spotify",
  };
  const current = spotifyQueue.snapshot.current!;
  current.track.externalUri = "spotify:track:duplicate";
  current.track.externalUrl = "https://open.spotify.com/track/duplicate";
  current.track.isPlayable = true;
  store.scheduleSave({
    ...draft(),
    providerId: "spotify",
    queue: spotifyQueue,
  });
  assert.equal(store.flush(), true);

  const restored = store.load({ providerId: "spotify", accountId: "account-a" });
  assert.equal(restored?.queue.snapshot.providerId, "spotify");
  assert.equal(
    restored?.queue.snapshot.current?.track.externalUri,
    "spotify:track:duplicate",
  );
  assert.equal(
    restored?.queue.snapshot.current?.track.externalUrl,
    "https://open.spotify.com/track/duplicate",
  );
});

test("round trip preserves every registered listening space", () => {
  const spaces = [
    "music",
    "lyrics-flow",
    "typography",
    "imprint",
  ] as const;

  for (const listeningSpace of spaces) {
    const storage = new MemoryStorage();
    const store = new PlaybackSessionStore({ storage });
    store.scheduleSave({ ...draft(), listeningSpace });
    assert.equal(store.flush(), true);
    assert.equal(
      store.load({ providerId: "qq", accountId: "account-a" })
        ?.listeningSpace,
      listeningSpace,
    );
  }
});

test("session ownership is isolated by provider and account", () => {
  const storage = new MemoryStorage();
  const store = new PlaybackSessionStore({ storage });
  store.scheduleSave(draft("account-a", 12_000));
  store.flush();
  store.scheduleSave(draft("account-b", 34_000));
  store.flush();

  assert.equal(
    store.load({ providerId: "qq", accountId: "account-a" })?.positionMs,
    12_000,
  );
  assert.equal(
    store.load({ providerId: "qq", accountId: "account-b" })?.positionMs,
    34_000,
  );
  assert.equal(
    store.load({ providerId: "netease", accountId: "account-a" }),
    null,
  );

  store.clear({ providerId: "qq", accountId: "account-a" });
  assert.equal(store.load({ providerId: "qq", accountId: "account-a" }), null);
  assert.ok(store.load({ providerId: "qq", accountId: "account-b" }));
});

test("scheduled writes are coalesced and flush the latest playback position", () => {
  const storage = new MemoryStorage();
  let scheduled: (() => void) | null = null;
  const store = new PlaybackSessionStore({
    storage,
    setTimer: (callback) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimer: () => {
      scheduled = null;
    },
  });
  store.scheduleSave(draft("account-a", 1_000));
  store.scheduleSave(draft("account-a", 2_000));
  assert.equal(storage.writes, 0);
  assert.ok(scheduled);
  const callback = scheduled as () => void;
  callback();
  assert.equal(storage.writes, 1);
  assert.equal(
    store.load({ providerId: "qq", accountId: "account-a" })?.positionMs,
    2_000,
  );
});

test("corrupt, unknown-version, and dangling-reference sessions are rejected", () => {
  const storage = new MemoryStorage();
  const store = new PlaybackSessionStore({ storage });
  storage.setItem(playbackSessionStorageKey, "not-json");
  assert.equal(store.load({ providerId: "qq", accountId: "account-a" }), null);

  storage.setItem(playbackSessionStorageKey, JSON.stringify({
    version: 2,
    sessions: [],
  }));
  assert.equal(store.load({ providerId: "qq", accountId: "account-a" }), null);

  store.scheduleSave(draft());
  store.flush();
  const parsed = JSON.parse(
    storage.getItem(playbackSessionStorageKey) ?? "{}",
  ) as {
    sessions: Array<{ queue: { currentId: string } }>;
  };
  parsed.sessions[0].queue.currentId = "missing-occurrence";
  storage.setItem(playbackSessionStorageKey, JSON.stringify(parsed));
  assert.equal(store.load({ providerId: "qq", accountId: "account-a" }), null);
});

test("clear without an owner removes all persisted and pending sessions", () => {
  const storage = new MemoryStorage();
  let scheduled: (() => void) | null = null;
  const store = new PlaybackSessionStore({
    storage,
    setTimer: (callback) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimer: () => {
      scheduled = null;
    },
  });
  store.scheduleSave(draft());
  store.clear();
  assert.equal(scheduled, null);
  assert.equal(store.flush(), false);
  assert.equal(storage.getItem(playbackSessionStorageKey), null);
});

test("restoration prefers freshly synchronized track metadata", () => {
  const storage = new MemoryStorage();
  const store = new PlaybackSessionStore({ storage });
  store.scheduleSave(draft());
  store.flush();
  const restored = store.load({ providerId: "qq", accountId: "account-a" });
  assert.ok(restored);

  const refreshed = {
    ...track("duplicate"),
    title: "Fresh synchronized title",
    lyrics: [{ atMs: 0, text: "fresh provider lyric" }],
  };
  const reconciled = reconcileRestoredPlaybackSession(restored, [refreshed]);
  assert.equal(
    reconciled.queue.snapshot.current?.track.title,
    "Fresh synchronized title",
  );
  assert.equal(
    reconciled.queue.snapshot.current?.track.lyrics[0]?.text,
    "fresh provider lyric",
  );
  assert.equal(
    reconciled.queue.snapshot.current?.queueItemId,
    restored.queue.snapshot.current?.queueItemId,
  );
});
