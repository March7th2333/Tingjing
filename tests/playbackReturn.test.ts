import assert from "node:assert/strict";
import test from "node:test";
import type { Track } from "../src/types/music.ts";
import {
  captureImmersivePlaybackReturnSnapshot,
  samePlaybackReturnOccurrence,
} from "../src/features/player/PlaybackReturnSnapshot.ts";
import {
  PlaybackQueueController,
  type PlaybackCollectionContext,
  type PlaybackQueueSeed,
} from "../src/features/player/PlaybackQueueController.ts";
import {
  chooseClosestWallInstance,
  isExactWallCurrent,
  resolvePlaybackReturnForWall,
  wallMayAutoMove,
} from "../src/features/library/MusicWallPlaybackReturn.ts";

function track(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    album: "Album",
    durationMs: 180_000,
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

const context: PlaybackCollectionContext = {
  providerId: "qq",
  collectionId: "playlist-1",
  collectionKind: "playlist",
  collectionTitle: "Return Test",
};

function seed(ids: string[], startIndex = 0): PlaybackQueueSeed {
  return { context, tracks: ids.map(track), startIndex };
}

test("exit snapshot freezes the actual A -> B -> C queue occurrence", () => {
  const controller = new PlaybackQueueController();
  const queueSeed = seed(["a", "b", "c", "d"]);
  controller.initialize(queueSeed);
  controller.next("user");
  controller.next("user");

  const snapshot = captureImmersivePlaybackReturnSnapshot(
    "request-1",
    controller.getSnapshot(),
  );
  assert.equal(snapshot?.trackId, "c");
  assert.equal(snapshot?.sourceIndex, 2);
  assert.equal(
    resolvePlaybackReturnForWall(snapshot, context, queueSeed.tracks).kind,
    "select",
  );

  controller.next("ended");
  assert.equal(controller.getSnapshot().current?.track.id, "d");
  assert.equal(snapshot?.trackId, "c");
  assert.equal(snapshot?.sourceIndex, 2);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("previous and queue entry selection return the exact source position", () => {
  const controller = new PlaybackQueueController();
  const queueSeed = seed(["a", "b", "c", "d"]);
  controller.initialize(queueSeed);
  controller.next("user");
  controller.next("user");
  assert.equal(controller.previous()?.track.id, "b");
  const target = controller.getSnapshot().upcoming.at(-1)!;
  assert.equal(controller.playEntry(target.queueItemId)?.track.id, "d");

  const snapshot = captureImmersivePlaybackReturnSnapshot(
    "request-2",
    controller.getSnapshot(),
  );
  const resolution = resolvePlaybackReturnForWall(
    snapshot,
    context,
    queueSeed.tracks,
  );
  assert.equal(resolution.kind, "select");
  if (resolution.kind === "select") {
    assert.equal(resolution.sourceIndex, 3);
    assert.equal(resolution.track.id, "d");
  }
});

test("shuffle returns the occurrence that is actually current", () => {
  const controller = new PlaybackQueueController({ random: () => 0 });
  const queueSeed = seed(["a", "b", "c", "d"]);
  controller.setOrder("shuffle");
  controller.initialize(queueSeed);
  controller.next("user");

  const current = controller.getSnapshot().current;
  const snapshot = captureImmersivePlaybackReturnSnapshot(
    "request-shuffle",
    controller.getSnapshot(),
  );
  assert.equal(snapshot?.queueItemId, current?.queueItemId);
  assert.equal(snapshot?.sourceIndex, current?.sourceIndex);

  const resolution = resolvePlaybackReturnForWall(
    snapshot,
    context,
    queueSeed.tracks,
  );
  assert.equal(resolution.kind, "select");
  if (resolution.kind === "select") {
    assert.equal(resolution.sourceIndex, current?.sourceIndex);
    assert.equal(resolution.track.id, current?.track.id);
  }
});

test("duplicate track ids remain distinct queue occurrences", () => {
  const controller = new PlaybackQueueController();
  const queueSeed = seed(["same", "same", "same"], 1);
  controller.initialize(queueSeed);
  const first = captureImmersivePlaybackReturnSnapshot(
    "request-duplicate",
    controller.getSnapshot(),
  );
  controller.next("user");
  const second = captureImmersivePlaybackReturnSnapshot(
    "request-duplicate",
    controller.getSnapshot(),
  );

  assert.equal(first?.sourceIndex, 1);
  assert.equal(second?.sourceIndex, 2);
  assert.notEqual(first?.queueItemId, second?.queueItemId);
  assert.equal(samePlaybackReturnOccurrence(first, second), false);
});

test("manual and cross-wall items clear instead of matching by track id", () => {
  const controller = new PlaybackQueueController();
  const queueSeed = seed(["same", "b"]);
  controller.initialize(queueSeed);
  controller.playNext(track("same"), "qq");
  controller.next("user");
  const manual = captureImmersivePlaybackReturnSnapshot(
    "request-manual",
    controller.getSnapshot(),
  );
  assert.deepEqual(
    resolvePlaybackReturnForWall(manual, context, queueSeed.tracks),
    { kind: "clear", reason: "manual-or-unscoped" },
  );

  const base = {
    requestId: "request-cross",
    queueItemId: "entry",
    trackId: "same",
    providerId: "qq" as const,
    collectionId: context.collectionId,
    sourceIndex: 0,
  };
  assert.deepEqual(
    resolvePlaybackReturnForWall(
      { ...base, providerId: "netease" },
      context,
      queueSeed.tracks,
    ),
    { kind: "clear", reason: "provider-mismatch" },
  );
  assert.deepEqual(
    resolvePlaybackReturnForWall(
      { ...base, collectionId: "playlist-2" },
      context,
      queueSeed.tracks,
    ),
    { kind: "clear", reason: "collection-mismatch" },
  );
});

test("invalid indexes and mismatched tracks never select a wall card", () => {
  const tracks = [track("a"), track("b")];
  const base = {
    requestId: "request-invalid",
    queueItemId: "entry",
    trackId: "a",
    providerId: "qq" as const,
    collectionId: context.collectionId,
    sourceIndex: 0,
  };
  for (const sourceIndex of [-1, 0.5, 2]) {
    assert.deepEqual(
      resolvePlaybackReturnForWall(
        { ...base, sourceIndex },
        context,
        tracks,
      ),
      { kind: "clear", reason: "invalid-source-index" },
    );
  }
  assert.deepEqual(
    resolvePlaybackReturnForWall(
      { ...base, trackId: "b" },
      context,
      tracks,
    ),
    { kind: "clear", reason: "track-mismatch" },
  );
});

test("instance resolution excludes clones and hidden slots", () => {
  const selected = chooseClosestWallInstance(
    2,
    "c",
    [
      {
        instanceId: "clone",
        sourceIndex: 2,
        trackId: "c",
        isClone: true,
        isHidden: false,
        centerX: 50,
        centerY: 50,
      },
      {
        instanceId: "hidden",
        sourceIndex: 2,
        trackId: "c",
        isClone: false,
        isHidden: true,
        centerX: 50,
        centerY: 50,
      },
      {
        instanceId: "offscreen",
        sourceIndex: 2,
        trackId: "c",
        isClone: false,
        isHidden: true,
        centerX: -500,
        centerY: 500,
      },
      {
        instanceId: "far",
        sourceIndex: 2,
        trackId: "c",
        isClone: false,
        isHidden: false,
        centerX: 900,
        centerY: 500,
      },
      {
        instanceId: "near",
        sourceIndex: 2,
        trackId: "c",
        isClone: false,
        isHidden: false,
        centerX: 510,
        centerY: 505,
      },
    ],
    { x: 500, y: 500 },
  );
  assert.equal(selected?.instanceId, "near");
});

test("current mark requires provider, collection, source index and track id", () => {
  const occurrence = {
    requestId: "request-current",
    queueItemId: "entry",
    trackId: "same",
    providerId: "qq" as const,
    collectionId: context.collectionId,
    sourceIndex: 1,
  };
  assert.equal(isExactWallCurrent(occurrence, context, track("same"), 1), true);
  assert.equal(isExactWallCurrent(occurrence, context, track("same"), 0), false);
  assert.equal(
    isExactWallCurrent(
      { ...occurrence, sourceIndex: null, collectionId: null },
      context,
      track("same"),
      1,
    ),
    false,
  );
});

test("wall motion is owned by opening or detail idle only", () => {
  assert.equal(wallMayAutoMove("opening", "idle", false), true);
  assert.equal(wallMayAutoMove("detail", "idle", false), true);
  assert.equal(wallMayAutoMove("detail", "braking", false), false);
  assert.equal(wallMayAutoMove("detail", "open", false), false);
  assert.equal(wallMayAutoMove("detail", "closing", false), false);
  assert.equal(wallMayAutoMove("detail", "idle", true), false);
  assert.equal(wallMayAutoMove("closing", "idle", false), false);
});
