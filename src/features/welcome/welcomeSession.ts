import {
  isMusicProviderId,
  type MusicProviderId,
} from "../../providers/MusicProvider.ts";
import type { User } from "../../types/music";

export type WelcomeSessionState =
  | "bootstrapping"
  | "signed-out"
  | "returning-user"
  | "validating"
  | "reconnect-required";

export interface CachedWelcomeIdentity {
  version: 1;
  providerId: MusicProviderId;
  user: User;
  syncedAt: number | null;
  hasLocalLibrary: boolean;
}

interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const welcomeIdentityStorageKey = "tingjing:welcome-identity-v1";
const providerStorageKey = "tingjing:music-provider";
const legacyAvatarStorageKey = "tingjing:music-avatar";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function normalizeUser(value: unknown): User | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = typeof record.id === "string" ? record.id.trim() : "";
  const nickname = typeof record.nickname === "string"
    ? record.nickname.trim()
    : "";
  const avatarUrl = typeof record.avatarUrl === "string"
    ? record.avatarUrl.trim()
    : "";

  if (!id && !nickname && !avatarUrl) {
    return null;
  }

  return {
    id,
    nickname,
    avatarUrl: avatarUrl || undefined,
  };
}

export function readCachedWelcomeIdentity(
  storage: IdentityStorage = window.localStorage,
): CachedWelcomeIdentity | null {
  try {
    const serialized = storage.getItem(welcomeIdentityStorageKey);
    if (serialized) {
      const record = asRecord(JSON.parse(serialized));
      const user = normalizeUser(record?.user);
      if (
        record?.version === 1
        && isMusicProviderId(record.providerId)
        && user
      ) {
        return {
          version: 1,
          providerId: record.providerId,
          user,
          syncedAt: typeof record.syncedAt === "number"
            && Number.isFinite(record.syncedAt)
            ? record.syncedAt
            : null,
          hasLocalLibrary: record.hasLocalLibrary === true,
        };
      }
    }

    // Older builds only persisted the provider and avatar after a successful
    // sync. Treat both keys together as a migration hint, never the provider
    // selector alone, so a user who merely clicked a tab is not considered
    // authenticated.
    const providerId = storage.getItem(providerStorageKey);
    const avatarUrl = storage.getItem(legacyAvatarStorageKey)?.trim();
    if (isMusicProviderId(providerId) && avatarUrl) {
      return {
        version: 1,
        providerId,
        user: { id: "", nickname: "", avatarUrl },
        syncedAt: null,
        hasLocalLibrary: false,
      };
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  return null;
}

export function writeCachedWelcomeIdentity(
  identity: CachedWelcomeIdentity,
  storage: IdentityStorage = window.localStorage,
) {
  storage.setItem(welcomeIdentityStorageKey, JSON.stringify(identity));
  storage.setItem(providerStorageKey, identity.providerId);
  if (identity.user.avatarUrl) {
    storage.setItem(legacyAvatarStorageKey, identity.user.avatarUrl);
  } else {
    storage.removeItem(legacyAvatarStorageKey);
  }
}

export function clearCachedWelcomeIdentity(
  storage: IdentityStorage = window.localStorage,
) {
  storage.removeItem(welcomeIdentityStorageKey);
  storage.removeItem(providerStorageKey);
  storage.removeItem(legacyAvatarStorageKey);
}
