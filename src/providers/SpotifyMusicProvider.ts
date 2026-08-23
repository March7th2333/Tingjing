import { invoke } from "@tauri-apps/api/core";
import type {
  Album,
  AudioSource,
  Lyrics,
  MusicLibrary,
  Playlist,
  Track,
  TrackPalette,
  User,
} from "../types/music";
import type {
  MusicProvider,
  MusicProviderId,
  OAuthLoginSession,
  OAuthLoginStatus,
  QrLoginSession,
  QrLoginStatus,
  SessionRestoreResult,
} from "./MusicProvider";

export const spotifyClientIdStorageKey = "tingjing:spotify-client-id";
export const spotifyRedirectRegistrationUri =
  "http://127.0.0.1/callback";

interface ClientIdStorage {
  getItem(key: string): string | null;
}

interface SpotifyClientIdOptions {
  environmentClientId?: string;
  storage?: ClientIdStorage | null;
}

export type SpotifyInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface SpotifyMusicProviderOptions {
  invokeCommand?: SpotifyInvoke;
  clientId?: () => string;
}

type RawSpotifyTrack = Omit<Track, "palette" | "lyrics">;

interface RawSpotifyLibraryPayload {
  profile: User;
  playlists: Playlist[];
  albums: Album[];
  likedTrackIds: string[];
  tracks: RawSpotifyTrack[];
  truncated: boolean;
}

interface RawOAuthStatus {
  state: OAuthLoginStatus["state"];
  message: string;
  profile?: User;
}

const grayscalePalettes: TrackPalette[] = [
  {
    background: "#141414",
    ambient: "#3c3c3c",
    accent: "#e7e7e7",
    text: "#f5f5f5",
  },
  {
    background: "#242424",
    ambient: "#555555",
    accent: "#d0d0d0",
    text: "#f6f6f6",
  },
  {
    background: "#e9e9e7",
    ambient: "#bdbdb9",
    accent: "#303030",
    text: "#111111",
  },
  {
    background: "#d5d5d2",
    ambient: "#aaaaa6",
    accent: "#202020",
    text: "#101010",
  },
];

export class SpotifyProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SpotifyProviderError";
    this.code = code;
  }
}

function browserStorage(): ClientIdStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function buildTimeClientId() {
  return import.meta.env?.VITE_SPOTIFY_CLIENT_ID;
}

export function resolveSpotifyClientId(
  options: SpotifyClientIdOptions = {},
) {
  const environmentClientId = (
    options.environmentClientId ?? buildTimeClientId() ?? ""
  ).trim();
  if (environmentClientId) {
    return environmentClientId;
  }

  const storedClientId = (
    (options.storage ?? browserStorage())?.getItem(spotifyClientIdStorageKey)
      ?? ""
  ).trim();
  if (storedClientId) {
    return storedClientId;
  }

  throw new SpotifyProviderError(
    "SPOTIFY_CLIENT_ID_MISSING",
    `Spotify 尚未配置 Client ID。请在 Spotify Developer Dashboard 登记 ${spotifyRedirectRegistrationUri}，再在设置中填写公开 Client ID。`,
  );
}

function stablePalette(id: string) {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return { ...grayscalePalettes[hash % grayscalePalettes.length] };
}

function mapTrack(raw: RawSpotifyTrack): Track {
  return {
    ...raw,
    coverLabel: raw.coverLabel || "Spotify original album artwork",
    palette: stablePalette(raw.id),
    lyrics: [],
  };
}

function normalizeInvokeError(error: unknown) {
  if (error instanceof SpotifyProviderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const coded = message.match(/^\[([A-Z0-9_]+)]\s*(.*)$/s);
  if (coded) {
    return new SpotifyProviderError(coded[1], coded[2] || message);
  }
  if (
    typeof window === "undefined"
    || !("__TAURI_INTERNALS__" in window)
    || message.includes("__TAURI_INTERNALS__")
    || message.includes("invoke")
  ) {
    return new SpotifyProviderError(
      "SPOTIFY_DESKTOP_REQUIRED",
      "Spotify 官方授权仅在听境桌面应用中可用。",
    );
  }
  return new SpotifyProviderError("SPOTIFY_UNKNOWN", message);
}

export class SpotifyMusicProvider implements MusicProvider {
  readonly id: MusicProviderId = "spotify";
  readonly displayName = "Spotify";
  readonly scanAppName = "系统浏览器";
  readonly capabilities = {
    login: "oauth-pkce",
    playback: "external",
    lyrics: "none",
  } as const;

  private library: MusicLibrary | null = null;
  private connected = false;
  private accountId: string | null = null;
  private readonly invokeCommand: SpotifyInvoke;
  private readonly configuredClientId: () => string;

  constructor(options: SpotifyMusicProviderOptions = {}) {
    this.invokeCommand = options.invokeCommand ?? invoke;
    this.configuredClientId = options.clientId ?? resolveSpotifyClientId;
  }

  private clearIdentity() {
    this.library = null;
    this.connected = false;
    this.accountId = null;
  }

  private bindIdentity(accountId: string) {
    const normalized = accountId.trim();
    if (!normalized) {
      this.clearIdentity();
      return false;
    }
    if (this.accountId !== normalized) {
      this.library = null;
    }
    this.accountId = normalized;
    this.connected = true;
    return true;
  }

  async restoreSession(): Promise<SessionRestoreResult> {
    try {
      const response = await this.invokeCommand<SessionRestoreResult>(
        "spotify_restore_session",
      );
      if (!response.connected || !response.user || !this.bindIdentity(response.user.id)) {
        this.clearIdentity();
      }
      return response;
    } catch (error) {
      this.clearIdentity();
      throw normalizeInvokeError(error);
    }
  }

  async beginOAuthLogin(): Promise<OAuthLoginSession> {
    this.clearIdentity();
    try {
      return await this.invokeCommand<OAuthLoginSession>("spotify_begin_oauth", {
        clientId: this.configuredClientId(),
      });
    } catch (error) {
      this.clearIdentity();
      throw normalizeInvokeError(error);
    }
  }

  async checkOAuthLogin(key: string): Promise<OAuthLoginStatus> {
    try {
      const response = await this.invokeCommand<RawOAuthStatus>("spotify_check_oauth", {
        key,
      });
      if (
        response.state === "authorized"
        && response.profile
        && !this.bindIdentity(response.profile.id)
      ) {
        this.clearIdentity();
      } else if (response.state !== "waiting" && response.state !== "authorized") {
        this.clearIdentity();
      }
      return {
        state: response.state,
        message: response.message,
        user: response.profile,
      };
    } catch (error) {
      this.clearIdentity();
      throw normalizeInvokeError(error);
    }
  }

  async createQrLogin(): Promise<QrLoginSession> {
    throw new SpotifyProviderError(
      "SPOTIFY_OAUTH_REQUIRED",
      "Spotify 使用系统浏览器完成官方授权，不使用扫码登录。",
    );
  }

  async checkQrLogin(_key: string): Promise<QrLoginStatus> {
    throw new SpotifyProviderError(
      "SPOTIFY_OAUTH_REQUIRED",
      "Spotify 当前登录会话不是二维码会话。",
    );
  }

  async syncLibrary(): Promise<MusicLibrary> {
    try {
      const response = await this.invokeCommand<RawSpotifyLibraryPayload>(
        "spotify_sync_library",
      );
      const library: MusicLibrary = {
        user: response.profile,
        playlists: response.playlists,
        radios: [],
        albums: response.albums,
        tracks: response.tracks.map(mapTrack),
        likedTrackIds: response.likedTrackIds,
        syncedAt: Date.now(),
        source: "spotify",
        truncated: response.truncated,
      };
      if (!this.bindIdentity(response.profile.id)) {
        throw new SpotifyProviderError(
          "SPOTIFY_PROFILE_INVALID",
          "Spotify 用户信息缺少稳定账号标识。",
        );
      }
      this.library = library;
      return structuredClone(library);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async getCollectionTracks(
    kind: "playlist" | "album",
    collectionId: string,
  ) {
    try {
      const response = await this.invokeCommand<RawSpotifyTrack[]>(
        "spotify_get_collection_tracks",
        { collectionKind: kind, collectionId },
      );
      return response.map(mapTrack);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async getLyrics(trackId: string): Promise<Lyrics> {
    return {
      trackId,
      lines: [],
      hasTranslation: false,
      source: "none",
    };
  }

  async getAudioSource(_trackId: string): Promise<AudioSource> {
    throw new SpotifyProviderError(
      "SPOTIFY_EXTERNAL_PLAYBACK_ONLY",
      "Spotify Web API 不提供歌曲音频地址；请使用 Spotify 官方客户端播放。",
    );
  }

  async openExternalPlayback(track: Track) {
    if (!track.externalUri && !track.externalUrl) {
      throw new SpotifyProviderError(
        "SPOTIFY_EXTERNAL_TARGET_MISSING",
        "这首歌曲没有可用的 Spotify 官方播放链接。",
      );
    }
    try {
      await this.invokeCommand<void>("spotify_open_external", {
        externalUri: track.externalUri,
        externalUrl: track.externalUrl,
      });
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async disconnect() {
    try {
      await this.invokeCommand<void>("spotify_logout");
    } catch (error) {
      throw normalizeInvokeError(error);
    } finally {
      this.clearIdentity();
    }
  }

  async isConnected() {
    return this.connected;
  }

  async getTracks() {
    return structuredClone(this.library?.tracks ?? []);
  }

  async getPlaylists() {
    return structuredClone(this.library?.playlists ?? []);
  }

  async search(query: string) {
    const keyword = query.trim().toLocaleLowerCase();
    const tracks = this.library?.tracks ?? [];
    if (!keyword) {
      return structuredClone(tracks);
    }
    return structuredClone(
      tracks.filter((track) =>
        [track.title, track.translatedTitle, track.artist, track.album]
          .some((value) => value?.toLocaleLowerCase().includes(keyword)),
      ),
    );
  }
}
