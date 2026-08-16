import assert from "node:assert/strict";
import test from "node:test";
import { DailyListeningStore } from "../src/features/player/DailyListeningStore.ts";
import {
  formatDailyListeningDuration,
} from "../src/types/dailyListening.ts";

function createHarness(startAt: Date) {
  let wallMs = startAt.getTime();
  let monotonicMs = 0;
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  const store = new DailyListeningStore({
    storage,
    wallNow: () => wallMs,
    monotonicNow: () => monotonicMs,
    saveIntervalMs: 0,
  });

  return {
    store,
    advance(durationMs: number) {
      wallMs += durationMs;
      monotonicMs += durationMs;
    },
    setWall(next: Date) {
      wallMs = next.getTime();
    },
  };
}

test("counts real playing time but not paused wall time", () => {
  const harness = createHarness(new Date(2026, 7, 12, 10, 0));
  harness.store.start("qq", "user-a");
  harness.advance(120_000);
  harness.store.pause();
  harness.advance(60_000);

  assert.equal(
    harness.store.getSummary("qq", "user-a").durationMs,
    120_000,
  );
});

test("keeps providers and accounts isolated", () => {
  const harness = createHarness(new Date(2026, 7, 12, 11, 0));
  harness.store.start("qq", "user-a");
  harness.advance(60_000);
  harness.store.pause();
  harness.store.start("netease", "user-b");
  harness.advance(120_000);
  harness.store.pause();

  assert.equal(
    harness.store.getSummary("qq", "user-a").durationMs,
    60_000,
  );
  assert.equal(
    harness.store.getSummary("netease", "user-b").durationMs,
    120_000,
  );
  assert.equal(
    harness.store.getSummary("qq", "user-b").durationMs,
    null,
  );
});

test("splits one continuous session across local midnight", () => {
  const harness = createHarness(new Date(2026, 7, 12, 23, 59, 30));
  harness.store.start("qq", "night-listener");
  harness.advance(90_000);
  harness.store.pause();

  harness.setWall(new Date(2026, 7, 12, 23, 59, 59));
  assert.equal(
    Math.round(
      harness.store.getSummary("qq", "night-listener").durationMs ?? 0,
    ),
    30_000,
  );

  harness.setWall(new Date(2026, 7, 13, 0, 1));
  assert.equal(
    Math.round(
      harness.store.getSummary("qq", "night-listener").durationMs ?? 0,
    ),
    60_000,
  );
});

test("does not derive listening time from track position or seeking", () => {
  const harness = createHarness(new Date(2026, 7, 12, 12, 0));
  harness.store.start("netease", "seeker");
  harness.advance(10_000);
  harness.store.pause();

  // No song position enters this store; seeking from 10s to 3m therefore
  // cannot add the skipped 170 seconds.
  assert.equal(
    harness.store.getSummary("netease", "seeker").durationMs,
    10_000,
  );
});

test("formats minute and hour ranges without seconds", () => {
  assert.equal(formatDailyListeningDuration(59_000), null);
  assert.deepEqual(formatDailyListeningDuration(60_000), [
    { value: "01", unit: "MIN" },
  ]);
  assert.deepEqual(formatDailyListeningDuration(59 * 60_000), [
    { value: "59", unit: "MIN" },
  ]);
  assert.deepEqual(formatDailyListeningDuration(60 * 60_000), [
    { value: "01", unit: "H" },
    { value: "00", unit: "MIN" },
  ]);
  assert.deepEqual(formatDailyListeningDuration(10 * 60 * 60_000), [
    { value: "10", unit: "H" },
    { value: "00", unit: "MIN" },
  ]);
});
