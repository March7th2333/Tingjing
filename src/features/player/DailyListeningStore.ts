import type { MusicProviderId } from "../../providers/MusicProvider";
import type { DailyListeningSummary } from "../../types/dailyListening";

interface DailyListeningStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredDailyListening {
  version: 1;
  durationMs: number;
  updatedAt: number;
}

interface ActiveListeningSession {
  providerId: MusicProviderId;
  accountId: string;
  startedAtWallMs: number;
  startedAtMonotonicMs: number;
}

interface DailyListeningStoreOptions {
  storage?: DailyListeningStorage | null;
  wallNow?: () => number;
  monotonicNow?: () => number;
  saveIntervalMs?: number;
}

type DailyListeningListener = (summary: DailyListeningSummary) => void;

const storagePrefix = "tingjing:daily-listening-v1";
const defaultSaveIntervalMs = 30_000;

function defaultStorage(): DailyListeningStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-");
}

function nextLocalMidnight(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
  ).getTime();
}

function storageKey(
  providerId: MusicProviderId,
  accountId: string,
  localDate: string,
) {
  return [
    storagePrefix,
    providerId,
    encodeURIComponent(accountId),
    localDate,
  ].join(":");
}

function splitElapsedByLocalDate(
  startWallMs: number,
  endWallMs: number,
  elapsedMs: number,
) {
  if (elapsedMs <= 0) {
    return [];
  }
  if (endWallMs <= startWallMs) {
    return [{ localDate: localDateKey(startWallMs), durationMs: elapsedMs }];
  }

  const wallSpan = endWallMs - startWallMs;
  const segments: Array<{ localDate: string; durationMs: number }> = [];
  let cursor = startWallMs;
  let allocated = 0;

  while (cursor < endWallMs) {
    const segmentEnd = Math.min(nextLocalMidnight(cursor), endWallMs);
    const isFinal = segmentEnd === endWallMs;
    const segmentDuration = isFinal
      ? elapsedMs - allocated
      : elapsedMs * ((segmentEnd - cursor) / wallSpan);
    if (segmentDuration > 0) {
      segments.push({
        localDate: localDateKey(cursor),
        durationMs: segmentDuration,
      });
      allocated += segmentDuration;
    }
    cursor = segmentEnd;
  }

  return segments;
}

export class DailyListeningStore {
  private readonly storage: DailyListeningStorage | null;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly saveIntervalMs: number;
  private readonly listeners = new Set<DailyListeningListener>();
  private active: ActiveListeningSession | null = null;
  private saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor({
    storage = defaultStorage(),
    wallNow = () => Date.now(),
    monotonicNow = () => performance.now(),
    saveIntervalMs = defaultSaveIntervalMs,
  }: DailyListeningStoreOptions = {}) {
    this.storage = storage;
    this.wallNow = wallNow;
    this.monotonicNow = monotonicNow;
    this.saveIntervalMs = saveIntervalMs;
  }

  subscribe = (listener: DailyListeningListener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSummary(
    providerId: MusicProviderId,
    accountId: string,
    atMs = this.wallNow(),
  ): DailyListeningSummary {
    const localDate = localDateKey(atMs);
    const stored = this.readStored(providerId, accountId, localDate);
    let durationMs = stored?.durationMs ?? 0;

    if (
      this.active?.providerId === providerId
      && this.active.accountId === accountId
    ) {
      const elapsedMs = Math.max(
        0,
        this.monotonicNow() - this.active.startedAtMonotonicMs,
      );
      const pending = splitElapsedByLocalDate(
        this.active.startedAtWallMs,
        atMs,
        elapsedMs,
      ).find((segment) => segment.localDate === localDate);
      durationMs += pending?.durationMs ?? 0;
    }

    return {
      providerId,
      accountId,
      localDate,
      durationMs: durationMs > 0 ? Math.round(durationMs) : null,
      source: durationMs > 0 ? "local" : "unavailable",
      updatedAt: stored?.updatedAt ?? atMs,
    };
  }

  start(providerId: MusicProviderId, accountId: string) {
    if (!accountId) {
      return;
    }
    if (
      this.active?.providerId === providerId
      && this.active.accountId === accountId
    ) {
      return;
    }

    this.pause();
    this.active = {
      providerId,
      accountId,
      startedAtWallMs: this.wallNow(),
      startedAtMonotonicMs: this.monotonicNow(),
    };
    this.scheduleSave();
  }

  flush() {
    this.commitActive();
  }

  pause() {
    this.commitActive();
    this.active = null;
    this.clearSaveTimer();
  }

  deactivate(providerId?: MusicProviderId, accountId?: string) {
    if (
      this.active
      && providerId
      && (
        this.active.providerId !== providerId
        || (accountId && this.active.accountId !== accountId)
      )
    ) {
      return;
    }
    this.pause();
  }

  private commitActive() {
    if (!this.active) {
      return;
    }

    const active = this.active;
    const startWallMs = active.startedAtWallMs;
    const endWallMs = this.wallNow();
    const endMonotonicMs = this.monotonicNow();
    const elapsedMs = Math.max(
      0,
      endMonotonicMs - active.startedAtMonotonicMs,
    );
    active.startedAtWallMs = endWallMs;
    active.startedAtMonotonicMs = endMonotonicMs;

    if (elapsedMs < 1) {
      return;
    }

    let minuteChanged = false;
    for (const segment of splitElapsedByLocalDate(
      startWallMs,
      endWallMs,
      elapsedMs,
    )) {
      const before = this.readStored(
        active.providerId,
        active.accountId,
        segment.localDate,
      );
      const beforeDuration = before?.durationMs ?? 0;
      const durationMs = beforeDuration + segment.durationMs;
      minuteChanged = minuteChanged
        || Math.floor(beforeDuration / 60_000)
          !== Math.floor(durationMs / 60_000);
      this.writeStored(
        active.providerId,
        active.accountId,
        segment.localDate,
        durationMs,
        endWallMs,
      );
    }

    if (minuteChanged) {
      const summary = this.getSummary(
        active.providerId,
        active.accountId,
        endWallMs,
      );
      this.listeners.forEach((listener) => listener(summary));
    }
  }

  private readStored(
    providerId: MusicProviderId,
    accountId: string,
    localDate: string,
  ): StoredDailyListening | null {
    try {
      const value = this.storage?.getItem(
        storageKey(providerId, accountId, localDate),
      );
      if (!value) {
        return null;
      }
      const parsed = JSON.parse(value) as Partial<StoredDailyListening>;
      if (
        parsed.version !== 1
        || typeof parsed.durationMs !== "number"
        || !Number.isFinite(parsed.durationMs)
        || parsed.durationMs < 0
        || typeof parsed.updatedAt !== "number"
      ) {
        return null;
      }
      return {
        version: 1,
        durationMs: parsed.durationMs,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      return null;
    }
  }

  private writeStored(
    providerId: MusicProviderId,
    accountId: string,
    localDate: string,
    durationMs: number,
    updatedAt: number,
  ) {
    try {
      this.storage?.setItem(
        storageKey(providerId, accountId, localDate),
        JSON.stringify({
          version: 1,
          durationMs,
          updatedAt,
        } satisfies StoredDailyListening),
      );
    } catch {
      // Daily listening is an enhancement; storage failures never block audio.
    }
  }

  private scheduleSave() {
    this.clearSaveTimer();
    if (this.saveIntervalMs <= 0 || !this.active) {
      return;
    }
    this.saveTimer = globalThis.setTimeout(() => {
      this.saveTimer = null;
      this.commitActive();
      this.scheduleSave();
    }, this.saveIntervalMs);
  }

  private clearSaveTimer() {
    if (this.saveTimer !== null) {
      globalThis.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }
}

export const dailyListeningStore = new DailyListeningStore();
