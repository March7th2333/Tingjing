import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceQrProgress,
  QrPollRequestTimeoutError,
  qrPollIntervalMs,
  qrPollRetryDelayMs,
  withQrPollRequestTimeout,
} from "../src/features/welcome/QrPollingPolicy.ts";

test("QR progress never regresses from scanned to waiting", () => {
  assert.equal(advanceQrProgress("waiting", "waiting"), "waiting");
  assert.equal(advanceQrProgress("waiting", "scanned"), "scanned");
  assert.equal(advanceQrProgress("scanned", "waiting"), "scanned");
  assert.equal(advanceQrProgress("scanned", "scanned"), "scanned");
});

test("transient QR polling failures use a bounded retry delay", () => {
  assert.equal(qrPollRetryDelayMs(1), qrPollIntervalMs);
  assert.equal(qrPollRetryDelayMs(2), qrPollIntervalMs * 2);
  assert.equal(qrPollRetryDelayMs(3), 5_000);
  assert.equal(qrPollRetryDelayMs(99), 5_000);
});

test("a lost native QR status reply cannot occupy the poll loop forever", async () => {
  const neverSettles = new Promise<never>(() => undefined);

  await assert.rejects(
    withQrPollRequestTimeout(neverSettles, 5),
    (error) => error instanceof QrPollRequestTimeoutError,
  );
});

test("a native QR status reply passes through before the watchdog", async () => {
  const status = { state: "authorized" as const, code: 803 };

  assert.deepEqual(
    await withQrPollRequestTimeout(Promise.resolve(status), 50),
    status,
  );
});
