import type {
  LyricsStatus,
  NormalizedLyricDocument,
  Track,
} from "../types/music";

export type ListeningSpaceId =
  | "music"
  | "lyrics-flow"
  | "typography"
  | "imprint";

export interface ListeningSpaceAudioAnalysisSource {
  trackId: string;
  url: string;
  size?: number;
}

export interface ListeningSpaceComponentProps {
  playbackSessionId: string;
  track: Track;
  lyrics: NormalizedLyricDocument;
  activeIndex: number;
  elapsedMs: number;
  durationMs: number;
  isPlaying: boolean;
  lyricsStatus: LyricsStatus;
  showOriginalLyrics: boolean;
  showTranslation: boolean;
  animationIntensity: "low" | "standard" | "high";
  audioResponseEnabled: boolean;
  audioAnalysisSource?: ListeningSpaceAudioAnalysisSource | null;
  onSeek: (elapsedMs: number) => void;
}
