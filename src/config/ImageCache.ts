interface ImageCacheEntry {
  image: HTMLImageElement;
  promise: Promise<void>;
  ready: boolean;
}

export interface ImagePreloadOptions {
  concurrency?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DeferredImagePreloadOptions extends ImagePreloadOptions {
  batchSize?: number;
}

const IMAGE_ENTRY_HARD_TIMEOUT_MS = 15_000;

function canCreateImage() {
  return typeof window !== "undefined" && typeof Image !== "undefined";
}

function preloadAbortError() {
  const error = new Error("Image preload cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Small decoded-image LRU. Holding the HTMLImageElement keeps the decoded
 * bitmap warm for cover crossfades and shared-element transitions.
 */
export class ImageCache {
  private readonly entries = new Map<string, ImageCacheEntry>();
  private readonly deferredSources: string[] = [];
  private readonly deferredSourceSet = new Set<string>();
  private deferredBatchScheduled = false;
  private deferredBatchRunning = false;

  constructor(private readonly capacity = 48) {}

  has(source: string | null | undefined) {
    if (!source) {
      return false;
    }

    const entry = this.entries.get(source);
    if (!entry?.ready) {
      return false;
    }

    this.touch(source, entry);
    return true;
  }

  preload(source: string | null | undefined): Promise<void> {
    if (!source || !canCreateImage()) {
      return Promise.resolve();
    }

    const cached = this.entries.get(source);
    if (cached) {
      this.touch(source, cached);
      return cached.promise;
    }

    const image = new Image();
    image.decoding = "async";

    const entry: ImageCacheEntry = {
      image,
      promise: Promise.resolve(),
      ready: false,
    };

    entry.promise = new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        if (timeoutId !== null) {
          globalThis.clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const finish = (ready: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (this.entries.get(source) === entry) {
          if (ready) {
            entry.ready = true;
            this.touch(source, entry);
            this.trim();
          } else {
            this.entries.delete(source);
          }
        }
        resolve();
      };

      image.onload = () => {
        const decode = typeof image.decode === "function"
          ? image.decode().catch(() => undefined)
          : Promise.resolve();

        void decode.finally(() => finish(true));
      };

      image.onerror = () => {
        finish(false);
      };

      // A browser image request is allowed to outlive a short caller budget,
      // but the shared cache entry itself must never remain unresolved. A
      // broken URL is released so a later retry cannot inherit a dead promise.
      timeoutId = globalThis.setTimeout(() => {
        finish(false);
        image.removeAttribute("src");
      }, IMAGE_ENTRY_HARD_TIMEOUT_MS);
    });

    this.entries.set(source, entry);
    this.trim();
    image.src = source;
    return entry.promise;
  }

  preloadMany(
    sources: ReadonlyArray<string | null | undefined>,
    options: ImagePreloadOptions = {},
  ): Promise<void[]> {
    const uniqueSources = Array.from(
      new Set(sources.filter((source): source is string => Boolean(source))),
    );
    if (uniqueSources.length === 0) {
      return Promise.resolve([]);
    }

    const results = Array.from<void>({ length: uniqueSources.length });
    const concurrency = Math.max(
      1,
      Math.min(options.concurrency ?? 4, uniqueSources.length),
    );
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < uniqueSources.length) {
        if (options.signal?.aborted) {
          return;
        }
        const sourceIndex = nextIndex;
        nextIndex += 1;
        await this.preload(uniqueSources[sourceIndex]);
        results[sourceIndex] = undefined;
      }
    };

    const work = Promise.all(
      Array.from({ length: concurrency }, () => worker()),
    ).then(() => results);
    const signal = options.signal;
    const timeoutMs = options.timeoutMs;

    if (!signal && !(timeoutMs && timeoutMs > 0)) {
      return work;
    }

    // A shared image request is deliberately not cancelled at the element
    // level: another collection may already be awaiting the same URL. The
    // caller can still stop waiting immediately, while the deduplicated cache
    // entry finishes safely in the background for its remaining consumers.
    return new Promise<void[]>((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

      const cleanup = () => {
        signal?.removeEventListener("abort", handleAbort);
        if (timeoutId !== null) {
          globalThis.clearTimeout(timeoutId);
          timeoutId = null;
        }
      };
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };
      const handleAbort = () => {
        settle(() => reject(preloadAbortError()));
      };

      if (signal?.aborted) {
        handleAbort();
        return;
      }
      signal?.addEventListener("abort", handleAbort, { once: true });

      if (timeoutMs && timeoutMs > 0) {
        timeoutId = globalThis.setTimeout(() => {
          // The palette fallback is already present in the prepared wall; a
          // slow or broken cover must not hold the spatial transition open.
          settle(() => resolve(results));
        }, timeoutMs);
      }

      work.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  /**
   * Queue non-critical covers for cooperative idle decoding. Only one small
   * batch is allowed to load at a time, so a large collection can never start
   * dozens of image decodes in the same frame as a spatial transition.
   */
  preloadDeferred(
    sources: ReadonlyArray<string | null | undefined>,
    options: DeferredImagePreloadOptions = {},
  ) {
    for (const source of sources) {
      if (
        !source
        || this.entries.has(source)
        || this.deferredSourceSet.has(source)
      ) {
        continue;
      }
      this.deferredSourceSet.add(source);
      this.deferredSources.push(source);
    }

    this.scheduleDeferredBatch(options);
  }

  private touch(source: string, entry: ImageCacheEntry) {
    this.entries.delete(source);
    this.entries.set(source, entry);
  }

  private trim() {
    while (this.entries.size > Math.max(1, this.capacity)) {
      // Never evict an in-flight entry. Dropping it here would let a second
      // request for the same source start while the first decode is running.
      const oldest = [...this.entries].find(([, entry]) => entry.ready)?.[0];
      if (oldest === undefined) {
        return;
      }
      this.entries.delete(oldest);
    }
  }

  private scheduleDeferredBatch(options: DeferredImagePreloadOptions) {
    if (
      !canCreateImage()
      || this.deferredBatchScheduled
      || this.deferredBatchRunning
      || this.deferredSources.length === 0
    ) {
      return;
    }

    this.deferredBatchScheduled = true;
    const run = () => {
      this.deferredBatchScheduled = false;
      void this.runDeferredBatch(options);
    };

    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 1_200 });
      return;
    }

    window.setTimeout(run, 96);
  }

  private async runDeferredBatch(options: DeferredImagePreloadOptions) {
    if (this.deferredBatchRunning || this.deferredSources.length === 0) {
      return;
    }

    this.deferredBatchRunning = true;
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 2, 4));
    const batch = this.deferredSources.splice(0, batchSize);
    batch.forEach((source) => this.deferredSourceSet.delete(source));

    try {
      await this.preloadMany(batch, {
        concurrency: Math.max(
          1,
          Math.min(options.concurrency ?? 2, batch.length),
        ),
      });
    } finally {
      this.deferredBatchRunning = false;
      this.scheduleDeferredBatch(options);
    }
  }
}

export const imageCache = new ImageCache(48);
