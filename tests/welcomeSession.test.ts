import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCachedWelcomeIdentity,
  readCachedWelcomeIdentity,
  welcomeIdentityStorageKey,
  writeCachedWelcomeIdentity,
} from "../src/features/welcome/welcomeSession.ts";

function createStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

test("restores a validated provider identity without inventing profile data", () => {
  const storage = createStorage();
  writeCachedWelcomeIdentity({
    version: 1,
    providerId: "qq",
    user: {
      id: "u-1",
      nickname: "星野 🎧",
      avatarUrl: "https://example.com/avatar.jpg",
    },
    syncedAt: 123,
    hasLocalLibrary: true,
  }, storage);

  assert.deepEqual(readCachedWelcomeIdentity(storage), {
    version: 1,
    providerId: "qq",
    user: {
      id: "u-1",
      nickname: "星野 🎧",
      avatarUrl: "https://example.com/avatar.jpg",
    },
    syncedAt: 123,
    hasLocalLibrary: true,
  });
});

test("restores a Spotify identity in the same provider-owned cache", () => {
  const storage = createStorage();
  writeCachedWelcomeIdentity({
    version: 1,
    providerId: "spotify",
    user: {
      id: "spotify-user",
      nickname: "Spotify Listener",
    },
    syncedAt: 456,
    hasLocalLibrary: true,
  }, storage);

  assert.equal(readCachedWelcomeIdentity(storage)?.providerId, "spotify");
});

test("does not treat a provider selector value as a signed-in user", () => {
  const storage = createStorage({
    "tingjing:music-provider": "netease",
  });
  assert.equal(readCachedWelcomeIdentity(storage), null);
});

test("migrates the old provider plus avatar pair as a validation hint", () => {
  const storage = createStorage({
    "tingjing:music-provider": "netease",
    "tingjing:music-avatar": "https://example.com/legacy.jpg",
  });
  assert.deepEqual(readCachedWelcomeIdentity(storage), {
    version: 1,
    providerId: "netease",
    user: {
      id: "",
      nickname: "",
      avatarUrl: "https://example.com/legacy.jpg",
    },
    syncedAt: null,
    hasLocalLibrary: false,
  });
});

test("clears current identity and compatibility keys together", () => {
  const storage = createStorage({
    [welcomeIdentityStorageKey]: "cached",
    "tingjing:music-provider": "qq",
    "tingjing:music-avatar": "avatar",
  });
  clearCachedWelcomeIdentity(storage);
  assert.equal(readCachedWelcomeIdentity(storage), null);
  assert.equal(storage.getItem(welcomeIdentityStorageKey), null);
  assert.equal(storage.getItem("tingjing:music-provider"), null);
  assert.equal(storage.getItem("tingjing:music-avatar"), null);
});
