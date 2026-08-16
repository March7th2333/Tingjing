import { mockPlaylists, mockTracks } from "../data/mockMusic";
import type { AudioSource, Lyrics, MusicLibrary } from "../types/music";
import type {
  MusicProvider,
  QrLoginSession,
  QrLoginStatus,
  SessionRestoreResult,
} from "./MusicProvider";

export class MockMusicProvider implements MusicProvider {
  readonly id = "local-demo";
  readonly displayName = "本地演示数据";
  readonly scanAppName = "本地演示";
  readonly capabilities = {
    login: "qr",
    playback: "direct-audio",
    lyrics: "provider",
  } as const;

  private connected = false;

  async restoreSession(): Promise<SessionRestoreResult> {
    return {
      connected: false,
      message: "",
    };
  }

  async createQrLogin(): Promise<QrLoginSession> {
    throw new Error("本地演示数据不支持扫码登录");
  }

  async checkQrLogin(_key: string): Promise<QrLoginStatus> {
    throw new Error("本地演示数据不支持扫码登录");
  }

  async syncLibrary(): Promise<MusicLibrary> {
    throw new Error("本地演示数据不支持真实音乐库同步");
  }

  async disconnect() {
    this.connected = false;
  }

  async isConnected() {
    return this.connected;
  }

  async getTracks() {
    return structuredClone(mockTracks);
  }

  async getPlaylists() {
    return structuredClone(mockPlaylists);
  }

  async getLyrics(trackId: string): Promise<Lyrics> {
    const track = mockTracks.find((item) => item.id === trackId);
    return {
      trackId,
      lines: structuredClone(track?.lyrics ?? []),
      hasTranslation: Boolean(
        track?.lyrics.some((line) => Boolean(line.translation)),
      ),
      source: "embedded",
    };
  }

  async getAudioSource(_trackId: string): Promise<AudioSource> {
    throw new Error("网页预览数据不包含音频；请在听境桌面应用中播放网易云歌曲。");
  }

  async getCollectionTracks() {
    return this.getTracks();
  }

  async search(query: string) {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");

    if (!keyword) {
      return this.getTracks();
    }

    return structuredClone(
      mockTracks.filter((track) =>
        [
          track.title,
          track.translatedTitle,
          track.artist,
          track.album,
        ].some((value) =>
          value?.toLocaleLowerCase("zh-CN").includes(keyword),
        ),
      ),
    );
  }
}
