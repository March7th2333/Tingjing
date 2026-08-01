import type { LyricTimingSource } from "../../types/music";

interface LyricOffsetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type PersistedOffsets = Record<string, number>;

const storageKey = "tingjing:lyric-offsets:v1";
const maximumOffsetMs = 10_000;

function browserStorage(): LyricOffsetStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function validOffsets(value: unknown): PersistedOffsets {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, offset]) =>
      Number.isFinite(offset)
        ? [[key, Math.max(
            -maximumOffsetMs,
            Math.min(maximumOffsetMs, Math.round(Number(offset))),
          )]]
        : []
    ),
  );
}

export function lyricOffsetKey(
  provider: string,
  trackId: string,
  source: LyricTimingSource,
) {
  return `${provider}:${trackId}:${source}`;
}

export class LyricOffsetStore {
  private offsets: PersistedOffsets;
  private readonly listeners = new Set<() => void>();
  private readonly storage: LyricOffsetStorage | null;

  constructor(storage: LyricOffsetStorage | null = browserStorage()) {
    this.storage = storage;
    this.offsets = this.read();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(key: string) {
    return this.offsets[key] ?? 0;
  }

  set(key: string, offsetMs: number) {
    const next = Math.max(
      -maximumOffsetMs,
      Math.min(maximumOffsetMs, Math.round(offsetMs)),
    );
    if (this.get(key) === next) {
      return next;
    }
    if (next === 0) {
      const { [key]: _removed, ...remaining } = this.offsets;
      this.offsets = remaining;
    } else {
      this.offsets = { ...this.offsets, [key]: next };
    }
    this.persist();
    this.listeners.forEach((listener) => listener());
    return next;
  }

  adjust(key: string, deltaMs: number) {
    return this.set(key, this.get(key) + deltaMs);
  }

  reset(key: string) {
    return this.set(key, 0);
  }

  export() {
    return { ...this.offsets };
  }

  private read() {
    try {
      const serialized = this.storage?.getItem(storageKey);
      return serialized ? validOffsets(JSON.parse(serialized)) : {};
    } catch {
      return {};
    }
  }

  private persist() {
    try {
      this.storage?.setItem(storageKey, JSON.stringify(this.offsets));
    } catch {
      // The in-memory offset remains authoritative for this session.
    }
  }
}

export const lyricOffsetStore = new LyricOffsetStore();
