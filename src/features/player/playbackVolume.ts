export const defaultPlaybackVolume = 1;

export function clampPlaybackVolume(
  value: unknown,
  fallback = defaultPlaybackVolume,
) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, Math.min(1, fallback));
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Combines the persistent user volume with the short-lived transition gain.
 * Muting remains an independent HTMLMediaElement flag, so toggling mute never
 * destroys the volume that must be restored afterwards.
 */
export function resolvePlaybackVolume(
  userVolume: unknown,
  fadeGain: unknown,
) {
  return clampPlaybackVolume(userVolume)
    * clampPlaybackVolume(fadeGain);
}
