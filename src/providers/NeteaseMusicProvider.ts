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
  QrLoginSession,
  QrLoginState,
  QrLoginStatus,
  SessionRestoreResult,
} from "./MusicProvider";
import { mapNeteaseLyrics } from "./neteaseLyrics.ts";

interface RawQrStatus {
  code: number;
  message: string;
  profile?: unknown;
}

interface RawSessionRestore {
  connected: boolean;
  message: string;
  profile?: unknown;
}

interface RawLibraryPayload {
  profile: unknown;
  playlists: unknown[];
  albums: unknown[];
  likedTrackIds: string[];
  tracks: unknown[];
  truncated: boolean;
}

interface RawLyricsPayload {
  original: string;
  translation: string;
  wordSynced: string;
  wordSyncedSource?: "yrc" | "krc" | "lrc";
}

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

type UnknownRecord = Record<string, unknown>;

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

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object"
    ? value as UnknownRecord
    : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = "") {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function secureImageUrl(value: unknown) {
  const url = asString(value);
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

function stablePalette(id: string) {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return { ...grayscalePalettes[hash % grayscalePalettes.length] };
}

function mapUser(value: unknown): User {
  const profile = asRecord(value);
  return {
    id: asString(profile.userId ?? profile.id),
    nickname: asString(profile.nickname, "网易云用户"),
    avatarUrl: secureImageUrl(profile.avatarUrl) || undefined,
  };
}

function mapTrack(value: unknown): Track {
  const raw = asRecord(value);
  const album = asRecord(raw.al);
  const artists = asArray(raw.ar)
    .map((artist) => {
      const record = asRecord(artist);
      const name = asString(record.name);
      return name
        ? {
            id: asString(record.id) || undefined,
            name,
          }
        : null;
    })
    .filter((artist): artist is { id: string | undefined; name: string } =>
      Boolean(artist)
    );
  const aliases = asArray(raw.alia).map((alias) => asString(alias)).filter(Boolean);
  const translatedNames = asArray(album.tns)
    .map((name) => asString(name))
    .filter(Boolean);
  const id = asString(raw.id);
  const coverImage = secureImageUrl(album.picUrl);

  return {
    id,
    title: asString(raw.name, "未命名歌曲"),
    translatedTitle: aliases[0] || translatedNames[0] || undefined,
    artist: artists.map((artist) => artist.name).join(" / ") || "未知艺人",
    artists,
    album: asString(album.name, "未知专辑"),
    albumId: asString(album.id) || undefined,
    releaseInfo: asNumber(raw.publishTime) > 0
      ? new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(asNumber(raw.publishTime)))
      : undefined,
    durationMs: Math.max(1_000, asNumber(raw.dt, 180_000)),
    coverImage: coverImage || undefined,
    coverLabel: "网易云音乐原始专辑封面",
    palette: stablePalette(id),
    lyrics: [],
  };
}

function mapPlaylist(value: unknown, index: number): Playlist {
  const raw = asRecord(value);
  const creator = asRecord(raw.creator);
  const trackIds = asArray(raw.trackIds).map((id) => asString(id)).filter(Boolean);

  return {
    id: asString(raw.id),
    number: String(index + 1).padStart(3, "0"),
    title: asString(raw.name, "未命名歌单"),
    subtitle: asString(raw.englishTitle) || undefined,
    creator: asString(creator.nickname, "网易云用户"),
    description: asString(raw.description),
    coverImage: secureImageUrl(raw.coverImgUrl) || undefined,
    trackCount: asNumber(raw.trackCount, trackIds.length),
    trackIds,
    isLikedSongs: asNumber(raw.specialType) === 5,
  };
}

function mapAlbum(value: unknown): Album {
  const raw = asRecord(value);
  const artist = asRecord(raw.artist);
  const trackIds = asArray(raw.trackIds).map((id) => asString(id)).filter(Boolean);
  const publishTime = asNumber(raw.publishTime);

  return {
    id: asString(raw.id),
    title: asString(raw.name, "未命名专辑"),
    artist: asString(artist.name, "未知艺人"),
    artistId: asString(artist.id) || undefined,
    coverImage: secureImageUrl(raw.picUrl) || undefined,
    releaseDate: publishTime > 0
      ? new Intl.DateTimeFormat("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(publishTime))
      : undefined,
    trackCount: asNumber(raw.size, trackIds.length),
    trackIds,
  };
}

function mapAudioSource(payload: RawAudioSourcePayload): AudioSource {
  const url = payload.url.startsWith("http://")
    ? `https://${payload.url.slice(7)}`
    : payload.url;

  return {
    ...payload,
    url,
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

export class NeteaseMusicProvider implements MusicProvider {
  readonly id: MusicProviderId = "netease";
  readonly displayName = "网易云音乐";
  readonly scanAppName = "网易云音乐 App";
  readonly capabilities = {
    login: "qr",
    playback: "direct-audio",
    lyrics: "provider",
  } as const;

  private library: MusicLibrary | null = null;
  private connected = false;

  async restoreSession(): Promise<SessionRestoreResult> {
    try {
      const response = await invoke<RawSessionRestore>(
        "netease_restore_session",
      );
      const user = response.profile ? mapUser(response.profile) : undefined;
      this.connected = response.connected;
      return {
        connected: response.connected,
        message: response.message,
        user,
      };
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async createQrLogin(): Promise<QrLoginSession> {
    try {
      return await invoke<QrLoginSession>("netease_create_qr");
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async checkQrLogin(key: string): Promise<QrLoginStatus> {
    try {
      const response = await invoke<RawQrStatus>("netease_check_qr", { key });
      if (![800, 801, 802, 803].includes(response.code)) {
        const detail = response.message || "网易云拒绝了本次扫码登录";
        throw new Error(`扫码登录失败（code ${response.code}）：${detail}`);
      }
      const user = response.profile ? mapUser(response.profile) : undefined;
      this.connected = response.code === 803 || this.connected;
      return {
        state: qrState(response.code),
        code: response.code,
        message: response.message,
        user,
      };
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async syncLibrary(): Promise<MusicLibrary> {
    try {
      const response = await invoke<RawLibraryPayload>(
        "netease_sync_library",
      );
      const library: MusicLibrary = {
        user: mapUser(response.profile),
        playlists: response.playlists.map(mapPlaylist),
        radios: [],
        albums: response.albums.map(mapAlbum),
        tracks: response.tracks.map(mapTrack),
        likedTrackIds: response.likedTrackIds.map(String),
        syncedAt: Date.now(),
        source: "netease",
        truncated: response.truncated,
      };
      this.library = library;
      this.connected = true;
      return structuredClone(library);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async getLyrics(trackId: string): Promise<Lyrics> {
    try {
      const response = await invoke<RawLyricsPayload>(
        "netease_get_lyrics",
        { trackId },
      );
      return mapNeteaseLyrics(trackId, response);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async getAudioSource(trackId: string): Promise<AudioSource> {
    try {
      const response = await invoke<RawAudioSourcePayload>(
        "netease_get_audio_source",
        { trackId },
      );
      return mapAudioSource(response);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async getCollectionTracks(
    kind: "playlist" | "album",
    collectionId: string,
  ) {
    try {
      const response = await invoke<unknown[]>(
        "netease_get_collection_tracks",
        {
          collectionKind: kind,
          collectionId,
        },
      );
      return response.map(mapTrack);
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async disconnect() {
    try {
      await invoke("netease_logout");
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

export const musicProvider: MusicProvider = new NeteaseMusicProvider();
