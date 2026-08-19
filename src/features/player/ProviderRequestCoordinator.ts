import type { MusicProviderId } from "../../providers/MusicProvider";

export type ProviderRequestErrorCode =
  | "network"
  | "auth-expired"
  | "permission-denied"
  | "trial-only"
  | "empty-audio-url"
  | "empty-lyrics"
  | "unsupported-lyrics"
  | "cancelled"
  | "stale";

export interface ProviderRequestContext {
  providerId: MusicProviderId;
  accountId: string | null;
}

export interface PlaybackRequestIdentity extends ProviderRequestContext {
  trackId: string;
  queueItemId?: string | null;
  collectionId?: string | null;
  qualityKey: string;
}

export interface ProviderRequestLease extends PlaybackRequestIdentity {
  contextGeneration: number;
  playbackGeneration: number;
  signal: AbortSignal;
}

export class ProviderRequestError extends Error {
  readonly code: ProviderRequestErrorCode;
  readonly userVisible: boolean;
  readonly cause?: unknown;

  constructor(
    code: ProviderRequestErrorCode,
    message: string,
    options: { cause?: unknown; userVisible?: boolean } = {},
  ) {
    super(message);
    this.name = "ProviderRequestError";
    this.code = code;
    this.userVisible = options.userVisible
      ?? (code !== "cancelled" && code !== "stale");
    this.cause = options.cause;
  }
}

function abortError(reason: "cancelled" | "stale", message: string) {
  return new ProviderRequestError(reason, message, { userVisible: false });
}

function abortReason(
  reason: "cancelled" | "stale",
  message: string,
) {
  return abortError(reason, message);
}

function waitForLogicalRequest<T>(
  promise: Promise<T>,
  signal: AbortSignal,
) {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export interface ProviderRequestScope {
  run<T>(producer: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancel(reason?: string): void;
}

class CoordinatedProviderRequestScope implements ProviderRequestScope {
  private controller = new AbortController();

  async run<T>(producer: (signal: AbortSignal) => Promise<T>) {
    this.controller.abort(abortReason(
      "stale",
      "请求已被同一界面的新请求取代",
    ));
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      return await waitForLogicalRequest(producer(signal), signal);
    } catch (error) {
      if (signal.aborted) {
        const reason = signal.reason;
        if (reason instanceof ProviderRequestError) {
          throw reason;
        }
        throw abortError("cancelled", "请求已取消");
      }
      throw classifyProviderRequestError(error);
    }
  }

  cancel(reason = "Scoped provider request cancelled") {
    this.controller.abort(abortReason("cancelled", reason));
    this.controller = new AbortController();
  }
}

export function classifyProviderRequestError(
  error: unknown,
  fallback: ProviderRequestErrorCode = "network",
) {
  if (error instanceof ProviderRequestError) {
    return error;
  }
  if (
    typeof DOMException !== "undefined"
    && error instanceof DOMException
    && error.name === "AbortError"
  ) {
    return abortError("cancelled", "请求已取消");
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLocaleLowerCase("zh-CN");
  let code = fallback;
  if (
    /未登录|登录.*失效|cookie|session|unauthori|http\s*401|\b401\b/iu.test(
      normalized,
    )
  ) {
    code = "auth-expired";
  } else if (/试听|trial/iu.test(normalized)) {
    code = "trial-only";
  } else if (
    /版权|无权|权限|不可播放|forbidden|permission|http\s*403|\b403\b/iu.test(
      normalized,
    )
  ) {
    code = "permission-denied";
  } else if (/歌词.*不支持|unsupported.*lyric/iu.test(normalized)) {
    code = "unsupported-lyrics";
  } else if (/网络|超时|timeout|network|连接|fetch/iu.test(normalized)) {
    code = "network";
  }

  return new ProviderRequestError(code, message || "音乐资源请求失败", {
    cause: error,
  });
}

export function isSilentProviderRequestError(error: unknown) {
  return error instanceof ProviderRequestError && !error.userVisible;
}

export class ProviderRequestCoordinator {
  private context: ProviderRequestContext | null = null;
  private contextGeneration = 0;
  private playbackGeneration = 0;
  private contextController = new AbortController();
  private playbackController = new AbortController();

  createScope(): ProviderRequestScope {
    return new CoordinatedProviderRequestScope();
  }

  setContext(next: ProviderRequestContext) {
    if (
      this.context?.providerId === next.providerId
      && this.context.accountId === next.accountId
    ) {
      return;
    }
    this.invalidateContext("Provider or account changed");
    this.context = { ...next };
  }

  getContext() {
    return this.context ? { ...this.context } : null;
  }

  beginPlayback(identity: PlaybackRequestIdentity): ProviderRequestLease {
    this.assertContext(identity);
    this.playbackController.abort(abortReason(
      "stale",
      "播放请求已被更新的歌曲取代",
    ));
    this.playbackController = new AbortController();
    this.playbackGeneration += 1;

    return {
      ...identity,
      contextGeneration: this.contextGeneration,
      playbackGeneration: this.playbackGeneration,
      signal: this.playbackController.signal,
    };
  }

  currentPlaybackLease(identity: PlaybackRequestIdentity) {
    this.assertContext(identity);
    return {
      ...identity,
      contextGeneration: this.contextGeneration,
      playbackGeneration: this.playbackGeneration,
      signal: this.playbackController.signal,
    } satisfies ProviderRequestLease;
  }

  async runPlayback<T>(
    lease: ProviderRequestLease,
    producer: (signal: AbortSignal) => Promise<T>,
  ) {
    this.assertLease(lease);
    try {
      const value = await waitForLogicalRequest(
        producer(lease.signal),
        lease.signal,
      );
      this.assertLease(lease);
      return value;
    } catch (error) {
      const invalidation = this.getLeaseInvalidation(lease);
      if (invalidation) {
        throw invalidation;
      }
      if (!this.isLeaseCurrent(lease)) {
        throw abortError("stale", "旧的播放资源结果已废弃");
      }
      throw classifyProviderRequestError(error);
    }
  }

  async runInContext<T>(
    context: ProviderRequestContext,
    producer: (signal: AbortSignal) => Promise<T>,
  ) {
    this.assertContext(context);
    const generation = this.contextGeneration;
    const signal = this.contextController.signal;
    try {
      const value = await waitForLogicalRequest(producer(signal), signal);
      if (
        signal.aborted
        || generation !== this.contextGeneration
        || !this.sameContext(context)
      ) {
        throw abortError("stale", "旧的 Provider 结果已废弃");
      }
      return value;
    } catch (error) {
      if (
        signal.aborted
        || generation !== this.contextGeneration
        || !this.sameContext(context)
      ) {
        throw abortError("stale", "旧的 Provider 结果已废弃");
      }
      throw classifyProviderRequestError(error);
    }
  }

  invalidatePlayback(reason = "Playback invalidated") {
    this.playbackController.abort(abortReason(
      "cancelled",
      reason,
    ));
    this.playbackController = new AbortController();
    this.playbackGeneration += 1;
  }

  invalidateContext(reason = "Provider context invalidated") {
    const invalidation = abortReason("stale", reason);
    this.contextController.abort(invalidation);
    this.playbackController.abort(invalidation);
    this.contextController = new AbortController();
    this.playbackController = new AbortController();
    this.contextGeneration += 1;
    this.playbackGeneration += 1;
    this.context = null;
  }

  private sameContext(candidate: ProviderRequestContext) {
    return this.context?.providerId === candidate.providerId
      && this.context.accountId === candidate.accountId;
  }

  private assertContext(candidate: ProviderRequestContext) {
    if (!this.sameContext(candidate)) {
      throw abortError("stale", "Provider 上下文已变化");
    }
  }

  private isLeaseCurrent(lease: ProviderRequestLease) {
    return !lease.signal.aborted
      && this.sameContext(lease)
      && lease.contextGeneration === this.contextGeneration
      && lease.playbackGeneration === this.playbackGeneration;
  }

  private getLeaseInvalidation(lease: ProviderRequestLease) {
    if (lease.signal.aborted) {
      const reason = lease.signal.reason;
      if (
        reason instanceof ProviderRequestError
        && (reason.code === "cancelled" || reason.code === "stale")
      ) {
        return reason;
      }
      return abortError("cancelled", "播放资源请求已取消");
    }
    if (
      !this.sameContext(lease)
      || lease.contextGeneration !== this.contextGeneration
      || lease.playbackGeneration !== this.playbackGeneration
    ) {
      return abortError("stale", "旧的播放资源结果已废弃");
    }
    return null;
  }

  private assertLease(lease: ProviderRequestLease) {
    const invalidation = this.getLeaseInvalidation(lease);
    if (invalidation) {
      throw invalidation;
    }
  }
}
