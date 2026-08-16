import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSpotifyClientId,
  SpotifyMusicProvider,
  SpotifyProviderError,
  spotifyClientIdStorageKey,
  spotifyRedirectRegistrationUri,
} from "../src/providers/SpotifyMusicProvider.ts";

function storage(value: string | null) {
  return {
    getItem(key: string) {
      return key === spotifyClientIdStorageKey ? value : null;
    },
  };
}

test("build configuration wins over the persisted public Spotify client id", () => {
  assert.equal(
    resolveSpotifyClientId({
      environmentClientId: " build-client-id-0123456789 ",
      storage: storage("saved-client-id-0123456789"),
    }),
    "build-client-id-0123456789",
  );
});

test("persisted public Spotify client id supports Finder-launched builds", () => {
  assert.equal(
    resolveSpotifyClientId({
      environmentClientId: "",
      storage: storage(" saved-client-id-0123456789 "),
    }),
    "saved-client-id-0123456789",
  );
});

test("missing Spotify client id has a stable configuration error", () => {
  assert.throws(
    () => resolveSpotifyClientId({ environmentClientId: "", storage: storage(null) }),
    (error) => error instanceof SpotifyProviderError
      && error.code === "SPOTIFY_CLIENT_ID_MISSING"
      && error.message.includes(spotifyRedirectRegistrationUri),
  );
});

test("Spotify exposes official external playback without inventing lyrics or audio", async () => {
  const provider = new SpotifyMusicProvider();
  assert.deepEqual(provider.capabilities, {
    login: "oauth-pkce",
    playback: "external",
    lyrics: "none",
  });
  assert.deepEqual(await provider.getLyrics("spotify-track"), {
    trackId: "spotify-track",
    lines: [],
    hasTranslation: false,
    source: "none",
  });
  await assert.rejects(
    provider.getAudioSource("spotify-track"),
    (error) => error instanceof SpotifyProviderError
      && error.code === "SPOTIFY_EXTERNAL_PLAYBACK_ONLY",
  );
});

function spotifyLibraryPayload(accountId: string, trackId: string) {
  return {
    profile: {
      id: accountId,
      nickname: `Listener ${accountId}`,
      avatarUrl: undefined,
    },
    playlists: [],
    albums: [],
    likedTrackIds: [trackId],
    tracks: [{
      id: trackId,
      title: `Track ${trackId}`,
      translatedTitle: undefined,
      artist: "Artist",
      artists: [],
      album: "Album",
      albumId: "album-id",
      releaseInfo: "2026",
      durationMs: 180_000,
      coverImage: undefined,
      coverLabel: "Spotify original album artwork",
      externalUri: `spotify:track:${trackId}`,
      externalUrl: `https://open.spotify.com/track/${trackId}`,
      isPlayable: true,
      isLocal: false,
    }],
    truncated: false,
  };
}

test("starting a new Spotify authorization clears the previous account library", async () => {
  const provider = new SpotifyMusicProvider({
    clientId: () => "0123456789abcdef0123456789abcdef",
    invokeCommand: async <T>(command: string) => {
      if (command === "spotify_sync_library") {
        return spotifyLibraryPayload("account-a", "track-a") as T;
      }
      if (command === "spotify_begin_oauth") {
        return {
          key: "new-flow",
          authorizationUrl: "https://accounts.spotify.com/authorize",
          redirectUri: "http://127.0.0.1:49152/callback",
        } as T;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  await provider.syncLibrary();
  assert.deepEqual((await provider.getTracks()).map((track) => track.id), ["track-a"]);
  await provider.beginOAuthLogin();
  assert.deepEqual(await provider.getTracks(), []);
});

test("a disconnected Spotify restore cannot expose a previous account cache", async () => {
  const provider = new SpotifyMusicProvider({
    invokeCommand: async <T>(command: string) => {
      if (command === "spotify_sync_library") {
        return spotifyLibraryPayload("account-a", "track-a") as T;
      }
      if (command === "spotify_restore_session") {
        return {
          connected: false,
          message: "not connected",
        } as T;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  await provider.syncLibrary();
  await provider.restoreSession();
  assert.deepEqual(await provider.getTracks(), []);
  assert.equal(await provider.isConnected(), false);
});
