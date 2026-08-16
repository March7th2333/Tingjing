import { invoke } from "@tauri-apps/api/core";
import type {
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
  QrLoginSession,
  QrLoginState,
  QrLoginStatus,
  SessionRestoreResult,
} from "./MusicProvider";
import { mapQqLyrics, type QqLyricsPayload } from "./qqLyrics";

interface RawQrStatus {
  code: number;
  message: string;
  profile?: User;
}

interface RawSessionRestore {
  connected: boolean;
  message: string;
  profile?: User;
}

type RawQqTrack = Omit<Track, "palette" | "lyrics">;

interface RawLibraryPayload {
  profile: User;
  playlists: Playlist[];
  radios: MusicLibrary["radios"];
  albums: MusicLibrary["albums"];
  likedTrackIds: string[];
  tracks: RawQqTrack[];
  truncated: boolean;
}

type RawLyricsPayload = QqLyricsPayload;

interface RawAudioSourcePayload {
  trackId: string;
  url: string;
  format?: string;
  level?: string;
  bitrate?: number;
  size?: number;
  expiresInSeconds?: number;
  isFreeTrial: boolean;
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

function stablePalette(id: string) {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return { ...grayscalePalettes[hash % grayscalePalettes.length] };
}

function mapTrack(raw: RawQqTrack): Track {
  return {
    ...raw,
    palette: stablePalette(raw.id),
    lyrics: [],
  };
}

function qrState(code: number): QrLoginState {
  if (code === 800) return "expired";
  if (code === 802) return "scanned";
  if (code === 803) return "authorized";
  return "waiting";
}

function normalizeInvokeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("__TAURI_INTERNALS__")
    || message.includes("invoke")
    || !("__TAURI_INTERNALS__" in window)
  ) {
    return new Error("真实扫码登录仅在听境桌面应用中可用，请启动 Tauri 桌面版。");
  }
  return new Error(message);
}

export class QqMusicProvider implements MusicProvider {
  readonly id: MusicProviderId = "qq";
  readonly displayName = "QQ 音乐";
  readonly scanAppName = "QQ 音乐 App";
  readonly capabilities = {
    login: "qr",
    playback: "direct-audio",
    lyrics: "provider",
  } as const;

  private library: MusicLibrary | null = null;
  private connected = false;

  async restoreSession(): Promise<SessionRestoreResult> {
    try {
      const response = await invoke<RawSessionRestore>("qq_restore_session");
      this.connected = response.connected;
      return response;
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async createQrLogin(): Promise<QrLoginSession> {
    try {
      return await invoke<QrLoginSession>("qq_create_qr");
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async checkQrLogin(key: string): Promise<QrLoginStatus> {
    try {
      const response = await invoke<RawQrStatus>("qq_check_qr", { key });
      if (![800, 801, 802, 803].includes(response.code)) {
        throw new Error(
          `扫码登录失败（code ${response.code}）：${response.message}`,
        );
      }
      this.connected = response.code === 803 || this.connected;
      return {
        ...response,
        state: qrState(response.code),
        user: response.profile,
      };
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async syncLibrary(): Promise<MusicLibrary> {
    try {
      const response = await invoke<RawLibraryPayload>("qq_sync_library");
      const library: MusicLibrary = {
        user: response.profile,
        playlists: response.playlists,
        radios: response.radios,
        albums: response.albums,
        tracks: response.tracks.map(mapTrack),
        likedTrackIds: response.likedTrackIds,
        syncedAt: Date.now(),
        source: "qq",
        truncated: response.truncated,
      };
      this.library = library;
      this.connected = true;
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
      const response = await invoke<RawQqTrack[]>(
        "qq_get_collection_tracks",
        { collectionKind: kind, collectionId },
      );
      return response.map(mapTrack);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async getLyrics(trackId: string): Promise<Lyrics> {
    try {
      const response = await invoke<RawLyricsPayload>("qq_get_lyrics", {
        trackId,
      });
      return mapQqLyrics(trackId, response);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async getAudioSource(trackId: string): Promise<AudioSource> {
    try {
      const response = await invoke<RawAudioSourcePayload>(
        "qq_get_audio_source",
        { trackId },
      );
      return {
        ...response,
        url: response.url.startsWith("http://")
          ? `https://${response.url.slice(7)}`
          : response.url,
      };
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async disconnect() {
    try {
      await invoke("qq_logout");
    } catch (error) {
      throw normalizeInvokeError(error);
    } finally {
      this.library = null;
      this.connected = false;
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
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    const tracks = this.library?.tracks ?? [];
    if (!keyword) {
      return structuredClone(tracks);
    }
    return structuredClone(
      tracks.filter((track) =>
        [
          track.title,
          track.translatedTitle,
          track.artist,
          track.album,
        ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(keyword)),
      ),
    );
  }
}
