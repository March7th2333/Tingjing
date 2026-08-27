import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderRequestCoordinator,
  ProviderRequestError,
  classifyProviderRequestError,
  isSilentProviderRequestError,
  type PlaybackRequestIdentity,
} from "../src/features/player/ProviderRequestCoordinator.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const context = { providerId: "qq" as const, accountId: "account-a" };

function identity(trackId: string): PlaybackRequestIdentity {
  return {
    ...context,
    trackId,
    queueItemId: `queue:${trackId}`,
    collectionId: "playlist-1",
    qualityKey: "provider-default",
  };
}

test("slow A cannot commit after fast B becomes the active playback", async () => {
  const coordinator = new ProviderRequestCoordinator();
  coordinator.setContext(context);
  const slowA = deferred<string>();
  const fastB = deferred<string>();

  const leaseA = coordinator.beginPlayback(identity("a"));
  const requestA = coordinator.runPlayback(leaseA, () => slowA.promise);
  const leaseB = coordinator.beginPlayback(identity("b"));
  const requestB = coordinator.runPlayback(leaseB, () => fastB.promise);

  fastB.resolve("B");
  assert.equal(await requestB, "B");
  slowA.resolve("A");
  await assert.rejects(requestA, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.code, "stale");
    assert.equal(isSilentProviderRequestError(error), true);
    return true;
  });
});

test("provider or account switch rejects the old logical result as stale", async () => {
  const coordinator = new ProviderRequestCoordinator();
  coordinator.setContext(context);
  const oldResult = deferred<string>();
  const request = coordinator.runInContext(context, () => oldResult.promise);

  coordinator.setContext({ providerId: "netease", accountId: "account-b" });
  oldResult.resolve("old-provider-result");

  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.code, "stale");
    assert.equal(error.userVisible, false);
    return true;
  });
});

test("logout-style context clearing invalidates both context and playback", async () => {
  const coordinator = new ProviderRequestCoordinator();
  coordinator.setContext(context);
  const pending = deferred<string>();
  const lease = coordinator.beginPlayback(identity("logout-track"));
  const request = coordinator.runPlayback(lease, () => pending.promise);

  coordinator.invalidateContext("logout");
  assert.equal(coordinator.getContext(), null);
  pending.resolve("late-result");

  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.code, "stale");
    assert.equal(isSilentProviderRequestError(error), true);
    return true;
  });
});

test("explicit playback cancellation is silent and distinct from superseding", async () => {
  const coordinator = new ProviderRequestCoordinator();
  coordinator.setContext(context);
  const pending = deferred<string>();
  const lease = coordinator.beginPlayback(identity("cancel-track"));
  const request = coordinator.runPlayback(lease, () => pending.promise);

  coordinator.invalidatePlayback("player closed");
  pending.resolve("late-result");

  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.code, "cancelled");
    assert.equal(isSilentProviderRequestError(error), true);
    return true;
  });
});

test("logical cancellation settles immediately without claiming transport abort", async () => {
  const coordinator = new ProviderRequestCoordinator();
  coordinator.setContext(context);
  const transport = deferred<string>();
  const lease = coordinator.beginPlayback(identity("logical-cancel"));
  const request = coordinator.runPlayback(lease, () => transport.promise);

  coordinator.invalidatePlayback("overlay closed");
  const settledBeforeTransport = await Promise.race([
    request.then(
      () => false,
      (error: unknown) => error instanceof ProviderRequestError
        && error.code === "cancelled",
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  assert.equal(settledBeforeTransport, true);

  // The provider/Tauri transport is deliberately still allowed to complete;
  // only its application-level result has already been discarded.
  transport.resolve("transport-finished-later");
});

test("scoped consumer supersedes the previous logical request immediately", async () => {
  const coordinator = new ProviderRequestCoordinator();
  const scope = coordinator.createScope();
  const firstTransport = deferred<string>();
  const secondTransport = deferred<string>();
  let firstSignal: AbortSignal | null = null;

  const firstRequest = scope.run((signal) => {
    firstSignal = signal;
    return firstTransport.promise;
  });
  const secondRequest = scope.run(() => secondTransport.promise);

  await assert.rejects(firstRequest, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.code, "stale");
    assert.equal(error.userVisible, false);
    return true;
  });
  assert.equal(firstSignal?.aborted, true);

  secondTransport.resolve("second-result");
  assert.equal(await secondRequest, "second-result");

  // Superseding is logical: the original provider transport may finish later,
  // but its result can no longer reach the scoped consumer.
  firstTransport.resolve("late-first-result");
});

test("scoped consumer cancellation settles immediately as cancelled", async () => {
  const coordinator = new ProviderRequestCoordinator();
  const scope = coordinator.createScope();
  const transport = deferred<string>();
  const request = scope.run(() => transport.promise);

  scope.cancel("lyrics overlay closed");

  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError);
    assert.equal(error.code, "cancelled");
    assert.equal(error.message, "lyrics overlay closed");
    assert.equal(isSilentProviderRequestError(error), true);
    return true;
  });
  transport.resolve("transport-finished-after-close");
});

test("provider failures keep actionable error categories", () => {
  assert.equal(classifyProviderRequestError(new Error("登录已失效")).code, "auth-expired");
  assert.equal(classifyProviderRequestError(new Error("HTTP 401 Unauthorized")).code, "auth-expired");
  assert.equal(classifyProviderRequestError(new Error("版权限制，不可播放")).code, "permission-denied");
  assert.equal(classifyProviderRequestError(new Error("request failed with status 403")).code, "permission-denied");
  assert.equal(classifyProviderRequestError(new Error("仅可试听")).code, "trial-only");
  assert.equal(classifyProviderRequestError(new Error("network timeout")).code, "network");
});
