import {
  isMusicProviderId,
  type MusicProvider,
  type MusicProviderId,
} from "./MusicProvider";
import { NeteaseMusicProvider } from "./NeteaseMusicProvider";
import { QqMusicProvider } from "./QqMusicProvider";
import { SpotifyMusicProvider } from "./SpotifyMusicProvider";

export const musicProviders: Record<MusicProviderId, MusicProvider> = {
  netease: new NeteaseMusicProvider(),
  qq: new QqMusicProvider(),
  spotify: new SpotifyMusicProvider(),
};

export const musicProviderOptions = [
  musicProviders.netease,
  musicProviders.qq,
  musicProviders.spotify,
] as readonly (MusicProvider & { readonly id: MusicProviderId })[];

export { isMusicProviderId };
