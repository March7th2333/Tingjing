import type { LyricsStatus } from "../../types/music";
import { motionTokens } from "./motionTokens.ts";
import type { TypographySceneTemplate } from "./TypographyScenePlanner";

export type TypographyPresenceMode =
  | "lyrics"
  | "sustained-gap"
  | "lyrics-unavailable";

export type TypographyContextRole = "past" | "future";

export interface TypographyPresenceInput {
  lyricsStatus: LyricsStatus;
  hasReadyLyrics: boolean;
  hasCurrentLyric: boolean;
  waiting: boolean;
  playbackTimeMs: number;
  gapStartMs: number;
  gapEndMs: number;
  gapDurationMs: number;
}

const presenceTokens = motionTokens.typographyPoster;

/**
 * Presence is deliberately coarser than the raw lyric owner. Short timing
 * gaps remain part of the lyric flow; only a genuinely stable empty interval
 * is allowed to reveal the non-semantic breath layer.
 */
export function resolveTypographyPresenceMode({
  lyricsStatus,
  hasReadyLyrics,
  hasCurrentLyric,
  waiting,
  playbackTimeMs,
  gapStartMs,
  gapEndMs,
  gapDurationMs,
}: TypographyPresenceInput): TypographyPresenceMode {
  if (!hasReadyLyrics || lyricsStatus !== "ready") {
    return "lyrics-unavailable";
  }
  if (
    hasCurrentLyric
    || !waiting
    || gapDurationMs < presenceTokens.presenceShortGapMaximumMs
  ) {
    return "lyrics";
  }

  const stableWindowMs = gapDurationMs
    - presenceTokens.presenceEntryDelayMs
    - presenceTokens.presenceFadeInMs
    - presenceTokens.presenceExitLeadMs;
  if (stableWindowMs < presenceTokens.presenceMinimumStableMs) {
    return "lyrics";
  }

  const elapsedInGapMs = Math.max(0, playbackTimeMs - gapStartMs);
  const remainingInGapMs = Math.max(0, gapEndMs - playbackTimeMs);
  return elapsedInGapMs >= presenceTokens.presenceEntryDelayMs
      && remainingInGapMs > presenceTokens.presenceExitLeadMs
    ? "sustained-gap"
    : "lyrics";
}

export function createTypographyArchitectureSignature(
  trackId: string,
  sceneId: string | undefined,
  template: TypographySceneTemplate,
  reducedMotion: boolean,
) {
  return [
    trackId,
    "scene",
    sceneId ?? "none",
    template,
    reducedMotion ? "reduced" : "full",
  ].join(":");
}

export function createTypographyContextSignature(
  trackId: string,
  role: TypographyContextRole,
  lineIndex: number | null,
  lineAtMs?: number,
) {
  return [
    trackId,
    "context",
    role,
    lineIndex ?? "none",
    lineAtMs ?? "none",
  ].join(":");
}
