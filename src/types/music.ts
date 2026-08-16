export interface LyricWordTiming {
  text: string;
  atMs: number;
  durationMs: number;
}

export type LyricTimingQuality =
  | "word-exact"
  | "aligned"
  | "line-only"
  | "estimated"
  | "unavailable";

export type LyricTimingSource =
  | "provider"
  | "ttml"
  | "qrc"
  | "yrc"
  | "krc"
  | "lrc"
  | "embedded"
  | "sidecar"
  | "manual"
  | "none";

export type WordTimingRejection =
  | "missing"
  | "text-mismatch"
  | "invalid-duration"
  | "out-of-line-range"
  | "overlap"
  | "non-monotonic"
  | "provider-match-failed"
  | "translation-primary";

export interface LyricLine {
  atMs: number;
  /** Provider-reported duration for this timed lyric line, when available. */
  durationMs?: number;
  /** Absolute provider-reported line end; may differ from atMs + durationMs when LRC/QRC anchors differ. */
  endAtMs?: number;
  text: string;
  translation?: string;
  words?: LyricWordTiming[];
  wordTimingRejection?: WordTimingRejection;
}

export interface Lyrics {
  trackId: string;
  lines: LyricLine[];
  hasTranslation: boolean;
  source?: LyricTimingSource;
}

export interface NormalizedLyricWord extends LyricWordTiming {
  startTimeMs: number;
  endTimeMs: number;
  rawStartTimeMs: number;
  rawEndTimeMs: number;
}

export interface NormalizedLyricLine extends LyricLine {
  id: string;
  startTimeMs: number;
  endTimeMs: number;
  renderEndTimeMs: number;
  rawStartTimeMs: number;
  rawEndTimeMs: number;
  romanization?: string;
  words?: NormalizedLyricWord[];
}

export interface LyricDiagnostics {
  provider: string;
  source: LyricTimingSource;
  timingQuality: LyricTimingQuality;
  sourceLineCount: number;
  validLineCount: number;
  wordTimedLineCount: number;
  providerWordTimingAvailable: boolean;
  providerWordTimingUsed: boolean;
  rejectedWordTimingReasons: Partial<Record<WordTimingRejection, number>>;
  invalidLineReasons: string[];
}

export interface NormalizedLyricDocument {
  trackKey: string;
  provider: string;
  source: LyricTimingSource;
  timingQuality: LyricTimingQuality;
  offsetMs: number;
  lines: NormalizedLyricLine[];
  diagnostics: LyricDiagnostics;
}

export type LyricsStatus = "loading" | "ready" | "empty" | "error";

export interface AudioSource {
  trackId: string;
  url: string;
  format?: string;
  level?: string;
  bitrate?: number;
  size?: number;
  expiresInSeconds?: number;
  isFreeTrial: boolean;
}

export interface TrackPalette {
  background: string;
  ambient: string;
  accent: string;
  text: string;
}

export interface ArtistRef {
  id?: string;
  name: string;
}

export interface Track {
  id: string;
  title: string;
  translatedTitle?: string;
  artist: string;
  artists?: ArtistRef[];
  album: string;
  albumId?: string;
  releaseInfo?: string;
  durationMs: number;
  coverImage?: string;
  coverLabel: string;
  /** Provider-owned URI for handing playback to an official client. */
  externalUri?: string;
  /** Provider attribution and web playback target. */
  externalUrl?: string;
  /** Provider-reported playback availability; undefined means not reported. */
  isPlayable?: boolean;
  /** True for provider-local items that may not have a stable catalog id. */
  isLocal?: boolean;
  palette: TrackPalette;
  lyrics: LyricLine[];
}

export interface Playlist {
  id: string;
  number: string;
  title: string;
  subtitle?: string;
  creator: string;
  description: string;
  coverImage?: string;
  trackCount?: number;
  trackIds: string[];
  isLikedSongs?: boolean;
  externalUrl?: string;
  /** The provider exposed metadata but not every collection item. */
  isPartial?: boolean;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  coverImage?: string;
  releaseDate?: string;
  trackCount: number;
  trackIds: string[];
  externalUrl?: string;
  isPartial?: boolean;
}

export interface RadioCollection {
  id: string;
  number: string;
  title: string;
  subtitle?: string;
  creator: string;
  coverImage?: string;
  trackCount: number;
  trackIds: string[];
}

export interface User {
  id: string;
  nickname: string;
  avatarUrl?: string;
}

export interface MusicLibrary {
  user: User;
  playlists: Playlist[];
  radios: RadioCollection[];
  albums: Album[];
  tracks: Track[];
  likedTrackIds: string[];
  syncedAt: number;
  source: "netease" | "qq" | "spotify" | "demo";
  truncated: boolean;
}
