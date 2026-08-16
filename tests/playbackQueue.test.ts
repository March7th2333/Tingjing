import assert from "node:assert/strict";
import test from "node:test";
import {
  PlaybackQueueController,
  type PlaybackQueueSeed,
} from "../src/features/player/PlaybackQueueController.ts";
import type { Track } from "../src/types/music.ts";
import { PlaybackRequestGeneration } from "../src/features/player/PlaybackRequestGeneration.ts";

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

function seed(ids: string[], startIndex = 0): PlaybackQueueSeed {
  return {
    context: {
      providerId: "qq",
      collectionId: "playlist-1",
      collectionKind: "playlist",
      collectionTitle: "Queue Test",
    },
    tracks: ids.map(track),
    startIndex,
  };
}

test("sequential queue starts from the real source index", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b", "c", "d"], 1));
  assert.equal(controller.getSnapshot().current?.track.id, "b");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["c", "d"],
  );
});

test("sequential queue stops at the end", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b"], 0));
  assert.equal(controller.next("ended")?.track.id, "b");
  assert.equal(controller.next("ended"), null);
});

test("shuffle bag does not repeat and previous uses real history", () => {
  const values = [0.8, 0.1, 0.6, 0.2];
  let randomIndex = 0;
  const controller = new PlaybackQueueController({
    random: () => values[randomIndex++ % values.length],
  });
  controller.setOrder("shuffle");
  controller.initialize(seed(["a", "b", "c", "d", "e"], 0));
  const played = [controller.getSnapshot().current?.track.id];
  let next = controller.next("ended");
  while (next) {
    played.push(next.track.id);
    next = controller.next("ended");
  }
  assert.equal(new Set(played).size, 5);
  assert.equal(controller.previous()?.track.id, played[played.length - 2]);
});

test("switching back to sequential restores source order after current", () => {
  const controller = new PlaybackQueueController({ random: () => 0 });
  controller.setOrder("shuffle");
  controller.initialize(seed(["a", "b", "c", "d"], 1));
  controller.setOrder("sequential");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["c", "d"],
  );
});

test("switching from a partly consumed shuffle keeps every unconsumed item", () => {
  const controller = new PlaybackQueueController({ random: () => 0 });
  controller.setOrder("shuffle");
  controller.initialize(seed(["a", "b", "c", "d"], 0));
  assert.equal(controller.next("user")?.track.id, "c");
  controller.setOrder("sequential");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["b", "d"],
  );
});

test("repeat one only repeats an automatic end", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b"], 0));
  controller.setRepeatMode("one");
  const before = controller.getSnapshot();

  assert.equal(controller.canAdvance("ended"), true);
  assert.equal(controller.next("ended")?.track.id, "a");
  assert.strictEqual(controller.getSnapshot(), before);
  assert.equal(controller.next("user")?.track.id, "b");
  assert.equal(controller.canAdvance("user"), false);
  assert.equal(controller.next("user"), null);
});

test("repeat all wraps collection entries and previous crosses the cycle", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b", "c"], 0));
  controller.setRepeatMode("all");
  assert.equal(controller.next("ended")?.track.id, "b");
  assert.equal(controller.next("ended")?.track.id, "c");
  assert.equal(controller.canAdvance("ended"), true);
  assert.equal(controller.next("ended")?.track.id, "a");
  assert.equal(controller.previous()?.track.id, "c");
  assert.equal(controller.next("user")?.track.id, "a");
});

test("repeat all never carries manual one-offs into the next cycle", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b"], 0));
  controller.append(track("manual"), "qq");
  controller.setRepeatMode("all");

  assert.equal(controller.next("ended")?.track.id, "b");
  assert.equal(controller.next("ended")?.track.id, "manual");
  assert.equal(controller.next("ended")?.track.id, "a");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["b"],
  );
});

test("repeat all respects removed collection occurrences", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b", "c"], 0));
  const removed = controller.getSnapshot().upcoming[0];
  assert.equal(controller.remove(removed.queueItemId), true);
  controller.setRepeatMode("all");

  assert.equal(controller.next("ended")?.track.id, "c");
  assert.equal(controller.next("ended")?.track.id, "a");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["c"],
  );
});

test("clearing upcoming prevents repeat all from resurrecting the cycle", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b", "c"], 0));
  controller.setRepeatMode("all");
  controller.clearUpcoming();

  assert.equal(controller.canAdvance("ended"), false);
  assert.equal(controller.next("ended"), null);
  controller.restoreModeOrder();
  assert.equal(controller.canAdvance("ended"), true);
  assert.equal(controller.next("ended")?.track.id, "b");
});

test("shuffle repeat cycle avoids an immediate tail-to-head duplicate", () => {
  const values = [0, 0.9];
  let randomIndex = 0;
  const controller = new PlaybackQueueController({
    random: () => values[randomIndex++ % values.length],
  });
  controller.initialize(seed(["a", "b", "c"], 0));
  controller.next("ended");
  controller.next("ended");
  assert.equal(controller.getSnapshot().current?.track.id, "c");
  controller.setOrder("shuffle");
  controller.setRepeatMode("all");

  const firstOfNextCycle = controller.next("ended");
  assert.notEqual(firstOfNextCycle?.track.id, "c");
  assert.deepEqual(
    new Set([
      firstOfNextCycle?.track.id,
      ...controller.getSnapshot().upcoming.map((item) => item.track.id),
    ]),
    new Set(["a", "b", "c"]),
  );
});

test("a one-item queue repeats without creating duplicate history", () => {
  for (const repeatMode of ["one", "all"] as const) {
    const controller = new PlaybackQueueController();
    controller.initialize(seed(["only"], 0));
    controller.setRepeatMode(repeatMode);
    assert.equal(controller.next("ended")?.track.id, "only");
    assert.deepEqual(controller.getSnapshot().history, []);
    assert.equal(controller.getSnapshot().current?.track.id, "only");
  }
});

test("queue state export and restore preserve the complete controller state", () => {
  const source = new PlaybackQueueController({ random: () => 0 });
  source.initialize(seed(["a", "b", "c", "d"], 0));
  source.setOrder("shuffle");
  source.setRepeatMode("all");
  source.next("user");
  source.append(track("manual"), "qq");
  const removed = source.getSnapshot().upcoming.find(
    (item) => item.origin === "collection",
  )!;
  source.remove(removed.queueItemId);
  const exported = source.exportState();

  const restored = new PlaybackQueueController({ random: () => 0.5 });
  assert.equal(restored.restoreState(exported), true);
  assert.deepEqual(restored.exportState(), exported);
  assert.equal(restored.getSnapshot().order, "shuffle");
  assert.equal(restored.getSnapshot().repeatMode, "all");

  exported.snapshot.sourceItems[0].track.title = "mutated export";
  assert.notEqual(
    source.getSnapshot().sourceItems[0].track.title,
    "mutated export",
  );
  assert.notEqual(
    restored.getSnapshot().sourceItems[0].track.title,
    "mutated export",
  );
});

test("queue validation recognizes Spotify as a provider-owned identity", () => {
  const source = new PlaybackQueueController();
  const spotifySeed = seed(["spotify-track"], 0);
  spotifySeed.context.providerId = "spotify";
  source.initialize(spotifySeed);

  const restored = new PlaybackQueueController();
  assert.equal(restored.restoreState(source.exportState()), true);
  assert.equal(restored.getSnapshot().providerId, "spotify");
});

test("invalid restore is rejected without partially changing live state", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b"], 0));
  const before = controller.exportState();
  const invalid = {
    ...before,
    modeOrderIds: ["missing-entry"],
  };

  assert.equal(controller.restoreState(invalid), false);
  assert.deepEqual(controller.exportState(), before);
});

test("a removed manual one-off does not poison session restoration", () => {
  const source = new PlaybackQueueController();
  source.initialize(seed(["a", "b"], 0));
  const manual = source.append(track("manual"), "qq")!;
  assert.equal(source.remove(manual.queueItemId), true);

  const restored = new PlaybackQueueController();
  assert.equal(restored.restoreState(source.exportState()), true);
  assert.equal(
    restored.getSnapshot().upcoming.some(
      (item) => item.track.id === "manual",
    ),
    false,
  );
});

test("duplicate track ids keep stable source identities", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["same", "same", "same"], 1));
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.current?.sourceIndex, 1);
  assert.equal(snapshot.upcoming[0]?.sourceIndex, 2);
  assert.notEqual(
    snapshot.current?.queueItemId,
    snapshot.upcoming[0]?.queueItemId,
  );
});

test("manual move, remove and restore alter only upcoming", () => {
  const controller = new PlaybackQueueController();
  controller.initialize(seed(["a", "b", "c", "d"], 0));
  const d = controller.getSnapshot().upcoming[2];
  assert.equal(controller.move(d.queueItemId, 0), true);
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["d", "b", "c"],
  );
  assert.equal(
    controller.remove(controller.getSnapshot().current!.queueItemId),
    false,
  );
  controller.restoreModeOrder();
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["b", "c", "d"],
  );
});

test("restoring shuffle order reuses the same bag", () => {
  const values = [0.8, 0.1, 0.6, 0.2];
  let randomIndex = 0;
  const controller = new PlaybackQueueController({
    random: () => values[randomIndex++ % values.length],
  });
  controller.setOrder("shuffle");
  controller.initialize(seed(["a", "b", "c", "d", "e"], 0));
  const originalBag = controller.getSnapshot().upcoming.map(
    (item) => item.queueItemId,
  );
  const last = controller.getSnapshot().upcoming.at(-1)!;
  controller.move(last.queueItemId, 0);
  controller.restoreModeOrder();
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.queueItemId),
    originalBag,
  );
});

test("removed source entries stay removed when order changes", () => {
  const controller = new PlaybackQueueController({ random: () => 0 });
  controller.initialize(seed(["a", "b", "c", "d"], 0));
  const c = controller.getSnapshot().upcoming[1];
  assert.equal(controller.remove(c.queueItemId), true);
  controller.setOrder("shuffle");
  assert.equal(
    controller.getSnapshot().upcoming.some((item) => item.track.id === "c"),
    false,
  );
  controller.setOrder("sequential");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["b", "d"],
  );
});

test("cleared upcoming stays empty across order changes until restored", () => {
  const controller = new PlaybackQueueController({ random: () => 0 });
  controller.initialize(seed(["a", "b", "c", "d"], 0));
  controller.clearUpcoming();
  controller.setOrder("shuffle");
  assert.deepEqual(controller.getSnapshot().upcoming, []);
  controller.restoreModeOrder();
  assert.deepEqual(
    new Set(controller.getSnapshot().upcoming.map((item) => item.track.id)),
    new Set(["b", "c", "d"]),
  );
});

test("staged queue is adopted when playback begins", () => {
  const controller = new PlaybackQueueController();
  const queueSeed = seed(["a", "b", "c"], 1);
  controller.stage(queueSeed);
  assert.equal(controller.getSnapshot().current, null);
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["b", "c"],
  );
  controller.initialize(queueSeed);
  assert.equal(controller.getSnapshot().current?.track.id, "b");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["c"],
  );
});

test("staged manual edits remain intact when playback begins", () => {
  const controller = new PlaybackQueueController();
  const queueSeed = seed(["a", "b", "c", "d"], 1);
  controller.stage(queueSeed);
  const c = controller.getSnapshot().upcoming[1];
  assert.equal(controller.remove(c.queueItemId), true);
  controller.initialize(queueSeed);
  assert.equal(controller.getSnapshot().current?.track.id, "b");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["d"],
  );
  controller.restoreModeOrder();
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["d"],
  );
});

test("manual queue rejects tracks from another provider", () => {
  const controller = new PlaybackQueueController();
  assert.ok(controller.append(track("qq-a"), "qq"));
  assert.equal(controller.append(track("netease-a"), "netease"), null);
  assert.equal(controller.getSnapshot().providerId, "qq");
  assert.deepEqual(
    controller.getSnapshot().upcoming.map((item) => item.track.id),
    ["qq-a"],
  );
});

for (const count of [3, 20, 200, 1_000]) {
  test(`${count} item queue preserves source order and indexes`, () => {
    const controller = new PlaybackQueueController();
    const ids = Array.from({ length: count }, (_, index) => `track-${index}`);
    const startIndex = Math.min(2, count - 1);
    controller.initialize(seed(ids, startIndex));
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.sourceItems.length, count);
    assert.equal(snapshot.current?.sourceIndex, startIndex);
    assert.equal(
      snapshot.upcoming[0]?.sourceIndex,
      startIndex + 1 < count ? startIndex + 1 : undefined,
    );
    assert.equal(
      new Set(snapshot.sourceItems.map((item) => item.queueItemId)).size,
      count,
    );
  });
}

test("audio and lyrics generations reject stale rapid-switch results", () => {
  const generations = new PlaybackRequestGeneration();
  const firstAudio = generations.beginAudio();
  const firstLyrics = generations.beginLyrics();
  const secondAudio = generations.beginAudio();
  const secondLyrics = generations.beginLyrics();

  assert.equal(generations.isCurrentAudio(firstAudio), false);
  assert.equal(generations.isCurrentLyrics(firstLyrics), false);
  assert.equal(generations.isCurrentAudio(secondAudio), true);
  assert.equal(generations.isCurrentLyrics(secondLyrics), true);

  generations.invalidateAll();
  assert.equal(generations.isCurrentAudio(secondAudio), false);
  assert.equal(generations.isCurrentLyrics(secondLyrics), false);
});
