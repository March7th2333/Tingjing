export type AppLanguage = "zh-CN" | "en-US";

export const defaultAppLanguage: AppLanguage = "zh-CN";
export const appLanguageStorageKey = "tingjing:language";

export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === "en-US" || value === "zh-CN"
    ? value
    : defaultAppLanguage;
}
