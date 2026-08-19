import { useCallback, useSyncExternalStore } from "react";
import type { ListeningSpaceId } from "../../listening-spaces/types";
import type {
  PlaybackOrder,
  RepeatMode,
} from "../player/PlaybackQueueController";
import { clampPlaybackVolume } from "../player/playbackVolume.ts";

export type AnimationIntensity = "low" | "standard" | "high";
export type ParticleQuality = "auto" | "low" | "standard" | "high";
export type ListeningSpaceMode = ListeningSpaceId;

export interface PlayerPreferences {
  listeningSpace: ListeningSpaceMode;
  showTranslation: boolean;
  scrollShowTranslation: boolean;
  showOriginalLyrics: boolean;
  animationIntensity: AnimationIntensity;
  particlesEnabled: boolean;
  particleQuality: ParticleQuality;
  audioResponseEnabled: boolean;
  playbackOrder: PlaybackOrder;
  repeatMode: RepeatMode;
  volume: number;
  muted: boolean;
}

export const playerPreferencesStorageKey =
  "tingjing:immersive-player-settings";

export const defaultPlayerPreferences: Readonly<PlayerPreferences> =
  Object.freeze({
    listeningSpace: "music",
    showTranslation: true,
    scrollShowTranslation: true,
    showOriginalLyrics: true,
    animationIntensity: "standard",
    particlesEnabled: true,
    particleQuality: "auto",
    audioResponseEnabled: true,
    playbackOrder: "sequential",
    repeatMode: "off",
    volume: 1,
    muted: false,
  });

type PreferenceUpdate =
  | Partial<PlayerPreferences>
  | ((current: PlayerPreferences) => Partial<PlayerPreferences>);

const listeners = new Set<() => void>();
let cachedPreferences: PlayerPreferences | null = null;
let storageListening = false;

function isAnimationIntensity(
  value: unknown,
): value is AnimationIntensity {
  return value === "low" || value === "standard" || value === "high";
}

function isParticleQuality(value: unknown): value is ParticleQuality {
  return (
    value === "auto"
    || value === "low"
    || value === "standard"
    || value === "high"
  );
}

function isListeningSpaceMode(
  value: unknown,
): value is ListeningSpaceMode {
  return (
    value === "music"
    || value === "lyrics-flow"
    || value === "typography"
    || value === "imprint"
  );
}

function isPlaybackOrder(value: unknown): value is PlaybackOrder {
  return value === "sequential" || value === "shuffle";
}

function isRepeatMode(value: unknown): value is RepeatMode {
  return value === "off" || value === "all" || value === "one";
}

function normalizeListeningSpaceMode(
  value: unknown,
): ListeningSpaceMode {
  if (value === "flow") {
    return "lyrics-flow";
  }

  if (value === "scroll" || value === "vertical") {
    return "typography";
  }

  return isListeningSpaceMode(value)
    ? value
    : defaultPlayerPreferences.listeningSpace;
}

export function normalizePlayerPreferences(value: unknown): PlayerPreferences {
  type StoredPlayerPreferences =
    Omit<Partial<PlayerPreferences>, "listeningSpace"> & {
      listeningSpace?: unknown;
      verticalShowTranslation?: unknown;
    };
  const parsed =
    value && typeof value === "object"
      ? value as StoredPlayerPreferences
      : {};
  // `showTranslation` is the canonical preference. Older Typography builds
  // persisted a separate scroll flag, so only consult that value when the
  // canonical field is absent. Both compatibility fields are written back in
  // lockstep and original lyrics are always restored for old installations.
  const showTranslation = typeof parsed.showTranslation === "boolean"
    ? parsed.showTranslation
    : typeof parsed.scrollShowTranslation === "boolean"
      ? parsed.scrollShowTranslation
      : typeof parsed.verticalShowTranslation === "boolean"
        ? parsed.verticalShowTranslation
        : defaultPlayerPreferences.showTranslation;

  return {
    listeningSpace: normalizeListeningSpaceMode(parsed.listeningSpace),
    showTranslation,
    scrollShowTranslation: showTranslation,
    showOriginalLyrics: true,
    animationIntensity: isAnimationIntensity(parsed.animationIntensity)
      ? parsed.animationIntensity
      : defaultPlayerPreferences.animationIntensity,
    particlesEnabled: parsed.particlesEnabled !== false,
    particleQuality: isParticleQuality(parsed.particleQuality)
      ? parsed.particleQuality
      : defaultPlayerPreferences.particleQuality,
    audioResponseEnabled: parsed.audioResponseEnabled !== false,
    playbackOrder: isPlaybackOrder(parsed.playbackOrder)
      ? parsed.playbackOrder
      : defaultPlayerPreferences.playbackOrder,
    repeatMode: isRepeatMode(parsed.repeatMode)
      ? parsed.repeatMode
      : defaultPlayerPreferences.repeatMode,
    volume: clampPlaybackVolume(
      parsed.volume,
      defaultPlayerPreferences.volume,
    ),
    muted: parsed.muted === true,
  };
}

function readStoredPreferences(): PlayerPreferences {
  if (typeof window === "undefined") {
    return { ...defaultPlayerPreferences };
  }

  try {
    const stored = window.localStorage.getItem(playerPreferencesStorageKey);
    return stored
      ? normalizePlayerPreferences(JSON.parse(stored) as unknown)
      : { ...defaultPlayerPreferences };
  } catch {
    return { ...defaultPlayerPreferences };
  }
}

export function readPlayerPreferences(): PlayerPreferences {
  cachedPreferences ??= readStoredPreferences();
  return cachedPreferences;
}

function emitPreferenceChange() {
  listeners.forEach((listener) => listener());
}

function handleStorageChange(event: StorageEvent) {
  if (event.key !== playerPreferencesStorageKey) {
    return;
  }

  try {
    cachedPreferences = event.newValue
      ? normalizePlayerPreferences(JSON.parse(event.newValue) as unknown)
      : { ...defaultPlayerPreferences };
  } catch {
    cachedPreferences = { ...defaultPlayerPreferences };
  }
  emitPreferenceChange();
}

function startStorageListener() {
  if (storageListening || typeof window === "undefined") {
    return;
  }

  window.addEventListener("storage", handleStorageChange);
  storageListening = true;
}

function stopStorageListener() {
  if (
    !storageListening
    || listeners.size > 0
    || typeof window === "undefined"
  ) {
    return;
  }

  window.removeEventListener("storage", handleStorageChange);
  storageListening = false;
}

export function subscribePlayerPreferences(listener: () => void) {
  listeners.add(listener);
  startStorageListener();

  return () => {
    listeners.delete(listener);
    stopStorageListener();
  };
}

export function updatePlayerPreferences(update: PreferenceUpdate) {
  const current = readPlayerPreferences();
  const patch =
    typeof update === "function" ? update(current) : update;
  const next = normalizePlayerPreferences({ ...current, ...patch });

  cachedPreferences = next;
  try {
    window.localStorage.setItem(
      playerPreferencesStorageKey,
      JSON.stringify(next),
    );
  } catch {
    // Settings remain active for this session when storage is unavailable.
  }
  emitPreferenceChange();
  return next;
}

export function usePlayerPreferences() {
  const preferences = useSyncExternalStore(
    subscribePlayerPreferences,
    readPlayerPreferences,
    () => defaultPlayerPreferences,
  );
  const updatePreferences = useCallback(
    (update: PreferenceUpdate) => updatePlayerPreferences(update),
    [],
  );

  return [preferences, updatePreferences] as const;
}
