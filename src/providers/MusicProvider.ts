import type {
  AudioSource,
  Lyrics,
  MusicLibrary,
  Playlist,
  Track,
  User,
} from "../types/music";

export interface QrLoginSession {
  key: string;
  qrUrl: string;
  qrSvg: string;
}

export type QrLoginState =
  | "expired"
  | "waiting"
  | "scanned"
  | "authorized";

export interface QrLoginStatus {
  state: QrLoginState;
  code: number;
  message: string;
  user?: User;
}

export interface SessionRestoreResult {
  connected: boolean;
  message: string;
  user?: User;
}

export const musicProviderIds = ["netease", "qq", "spotify"] as const;

export type MusicProviderId = typeof musicProviderIds[number];

export function isMusicProviderId(value: unknown): value is MusicProviderId {
  return typeof value === "string"
    && musicProviderIds.includes(value as MusicProviderId);
}

export type ProviderLoginKind = "qr" | "oauth-pkce";
export type ProviderPlaybackKind = "direct-audio" | "external";

export interface MusicProviderCapabilities {
  login: ProviderLoginKind;
  playback: ProviderPlaybackKind;
  lyrics: "provider" | "none";
}

export interface OAuthLoginSession {
  key: string;
  authorizationUrl: string;
  redirectUri: string;
  /** Register this portless loopback URI in the Spotify Developer Dashboard. */
  registrationRedirectUri?: string;
}

export type OAuthLoginState = "waiting" | "authorized" | "expired" | "error";

export interface OAuthLoginStatus {
  state: OAuthLoginState;
  message: string;
  user?: User;
}

export interface MusicProvider {
  readonly id: string;
  readonly displayName: string;
  readonly scanAppName: string;
  readonly capabilities: MusicProviderCapabilities;
  restoreSession(): Promise<SessionRestoreResult>;
  createQrLogin(): Promise<QrLoginSession>;
  checkQrLogin(key: string): Promise<QrLoginStatus>;
  beginOAuthLogin?(): Promise<OAuthLoginSession>;
  checkOAuthLogin?(key: string): Promise<OAuthLoginStatus>;
  syncLibrary(): Promise<MusicLibrary>;
  getCollectionTracks(
    kind: "playlist" | "album",
    collectionId: string,
  ): Promise<Track[]>;
  getLyrics(trackId: string): Promise<Lyrics>;
  getAudioSource(trackId: string): Promise<AudioSource>;
  openExternalPlayback?(track: Track): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getTracks(): Promise<Track[]>;
  getPlaylists(): Promise<Playlist[]>;
  search(query: string): Promise<Track[]>;
}
