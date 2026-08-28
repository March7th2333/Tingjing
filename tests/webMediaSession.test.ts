import assert from "node:assert/strict";
import test from "node:test";
import {
  WebMediaSessionController,
  type WebMediaSessionAction,
  type WebMediaSessionActionDetails,
  type WebMediaSessionLike,
  type WebMediaSessionPositionState,
} from "../src/features/player/WebMediaSessionController.ts";

class FakeMediaSession implements WebMediaSessionLike {
  readonly handlers = new Map<
    WebMediaSessionAction,
    (details: WebMediaSessionActionDetails) => void
  >();
  readonly actionWrites: Array<{
    action: WebMediaSessionAction;
    handler: "set" | "clear";
  }> = [];
  readonly metadataWrites: Array<unknown | null> = [];
  readonly playbackStateWrites: Array<"none" | "paused" | "playing"> = [];
  readonly positionWrites: Array<WebMediaSessionPositionState | undefined> = [];
  readonly unsupportedActions = new Set<WebMediaSessionAction>();

  private metadataValue: unknown | null = null;
  private playbackStateValue: "none" | "paused" | "playing" = "none";

  get metadata() {
    return this.metadataValue;
  }

  set metadata(value: unknown | null) {
    this.metadataValue = value;
    this.metadataWrites.push(value);
  }

  get playbackState() {
    return this.playbackStateValue;
  }

  set playbackState(value: "none" | "paused" | "playing") {
    this.playbackStateValue = value;
    this.playbackStateWrites.push(value);
  }

  setActionHandler(
    action: WebMediaSessionAction,
    handler: ((details: WebMediaSessionActionDetails) => void) | null,
  ) {
    if (this.unsupportedActions.has(action)) {
      throw new Error(`${action} is unsupported`);
    }
    this.actionWrites.push({ action, handler: handler ? "set" : "clear" });
    if (handler) this.handlers.set(action, handler);
    else this.handlers.delete(action);
  }

  setPositionState(state?: WebMediaSessionPositionState) {
    this.positionWrites.push(state ? { ...state } : undefined);
  }

  dispatch(
    action: WebMediaSessionAction,
    details: Partial<WebMediaSessionActionDetails> = {},
  ) {
    this.handlers.get(action)?.({ action, ...details });
  }
}

test("bind maps metadata, playback and every supported action", () => {
  const session = new FakeMediaSession();
  const calls: string[] = [];
  const seeks: Array<[string, number, boolean?]> = [];
  const controller = new WebMediaSessionController({
    session,
    defaultSeekOffsetMs: 7_000,
    createMetadata: (metadata) => ({ built: metadata }),
  });

  const binding = controller.bind({
    metadata: {
      title: "Aural",
      artist: "Artist",
      album: "Album",
      artwork: [{ src: "cover.jpg" }],
    },
    playback: {
      playbackState: "playing",
      position: {
        positionMs: 1_250,
        durationMs: 10_000,
        playbackRate: 1.25,
      },
    },
    handlers: {
      play: () => calls.push("play"),
      pause: () => calls.push("pause"),
      previousTrack: () => calls.push("previous"),
      nextTrack: () => calls.push("next"),
      seekTo: (positionMs, fastSeek) => {
        seeks.push(["to", positionMs, fastSeek]);
      },
      seekForward: (offsetMs) => seeks.push(["forward", offsetMs]),
      seekBackward: (offsetMs) => seeks.push(["backward", offsetMs]),
    },
  });

  assert.deepEqual(session.metadata, {
    built: {
      title: "Aural",
      artist: "Artist",
      album: "Album",
      artwork: [{ src: "cover.jpg" }],
    },
  });
  assert.equal(session.playbackState, "playing");
  assert.deepEqual(session.positionWrites.at(-1), {
    duration: 10,
    playbackRate: 1.25,
    position: 1.25,
  });

  session.dispatch("play");
  session.dispatch("pause");
  session.dispatch("previoustrack");
  session.dispatch("nexttrack");
  session.dispatch("seekto", { seekTime: 30, fastSeek: true });
  session.dispatch("seekforward", { seekOffset: 3 });
  session.dispatch("seekbackward");
  session.dispatch("seekto", { seekTime: Number.NaN });

  assert.deepEqual(calls, ["play", "pause", "previous", "next"]);
  assert.deepEqual(seeks, [
    ["to", 10_000, true],
    ["forward", 3_000],
    ["backward", 7_000],
  ]);

  binding.cleanup();
});

test("one unsupported action does not disable the remaining session", () => {
  const session = new FakeMediaSession();
  session.unsupportedActions.add("nexttrack");
  const calls: string[] = [];
  const controller = new WebMediaSessionController({
    session,
    createMetadata: (metadata) => metadata,
  });

  assert.doesNotThrow(() => controller.bind({
    metadata: { title: "Partial WebKit" },
    handlers: {
      play: () => calls.push("play"),
      nextTrack: () => calls.push("next"),
      seekForward: () => calls.push("seek"),
    },
  }));

  session.dispatch("play");
  session.dispatch("nexttrack");
  session.dispatch("seekforward");
  assert.deepEqual(calls, ["play", "seek"]);
  assert.deepEqual(session.metadata, { title: "Partial WebKit" });
});

test("position updates only send legal second-based state", () => {
  const session = new FakeMediaSession();
  const controller = new WebMediaSessionController({ session });
  const binding = controller.bind({ handlers: {} });

  binding.updatePlayback({
    playbackState: "paused",
    position: { positionMs: -500, durationMs: 20_000 },
  });
  assert.deepEqual(session.positionWrites.at(-1), {
    duration: 20,
    playbackRate: 1,
    position: 0,
  });

  binding.updatePlayback({
    playbackState: "playing",
    position: { positionMs: 25_000, durationMs: 20_000 },
  });
  assert.deepEqual(session.positionWrites.at(-1), {
    duration: 20,
    playbackRate: 1,
    position: 20,
  });

  for (const position of [
    { positionMs: 1_000, durationMs: 0 },
    { positionMs: Number.NaN, durationMs: 20_000 },
    { positionMs: 1_000, durationMs: 20_000, playbackRate: 0 },
  ]) {
    binding.updatePlayback({ playbackState: "paused", position });
    assert.equal(session.positionWrites.at(-1), undefined);
  }

  binding.updatePlayback({ playbackState: "paused", position: null });
  assert.equal(session.positionWrites.at(-1), undefined);
});

test("stale cleanup and updates cannot clear a newer owner", () => {
  const session = new FakeMediaSession();
  const calls: string[] = [];
  const controller = new WebMediaSessionController({
    session,
    createMetadata: (metadata) => metadata,
  });
  const first = controller.bind({
    metadata: { title: "First" },
    handlers: { play: () => calls.push("first") },
  });
  const second = controller.bind({
    metadata: { title: "Second" },
    playback: { playbackState: "paused" },
    handlers: { play: () => calls.push("second") },
  });

  const writesBeforeStaleCleanup = {
    actions: session.actionWrites.length,
    metadata: session.metadataWrites.length,
    playback: session.playbackStateWrites.length,
    position: session.positionWrites.length,
  };
  first.updateMetadata({ title: "Stale" });
  first.updatePlayback({ playbackState: "playing", position: null });
  first.cleanup();

  assert.deepEqual(session.metadata, { title: "Second" });
  assert.equal(session.playbackState, "paused");
  assert.deepEqual(
    {
      actions: session.actionWrites.length,
      metadata: session.metadataWrites.length,
      playback: session.playbackStateWrites.length,
      position: session.positionWrites.length,
    },
    writesBeforeStaleCleanup,
  );

  session.dispatch("play");
  assert.deepEqual(calls, ["second"]);

  second.cleanup();
  const writesAfterCleanup = {
    actions: session.actionWrites.length,
    metadata: session.metadataWrites.length,
    playback: session.playbackStateWrites.length,
    position: session.positionWrites.length,
  };
  assert.equal(session.metadata, null);
  assert.equal(session.playbackState, "none");
  assert.equal(session.handlers.size, 0);
  assert.equal(session.positionWrites.at(-1), undefined);

  second.cleanup();
  controller.cleanup();
  assert.deepEqual(
    {
      actions: session.actionWrites.length,
      metadata: session.metadataWrites.length,
      playback: session.playbackStateWrites.length,
      position: session.positionWrites.length,
    },
    writesAfterCleanup,
  );
});

test("an explicitly unavailable media session is a safe no-op", () => {
  const controller = new WebMediaSessionController({ session: null });
  const binding = controller.bind({
    metadata: { title: "Unavailable" },
    playback: {
      playbackState: "playing",
      position: { positionMs: 1_000, durationMs: 10_000 },
    },
    handlers: { play: () => assert.fail("must not be called") },
  });

  assert.doesNotThrow(() => {
    binding.updateMetadata(null);
    binding.updatePlayback({ playbackState: "none", position: null });
    binding.cleanup();
    controller.cleanup();
  });
});
