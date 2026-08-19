import type { AppLanguage } from "./language";

const providerNames: Readonly<Record<string, Readonly<Record<AppLanguage, string>>>> = {
  netease: {
    "zh-CN": "网易云音乐",
    "en-US": "NetEase Cloud Music",
  },
  qq: {
    "zh-CN": "QQ 音乐",
    "en-US": "QQ Music",
  },
  spotify: {
    "zh-CN": "Spotify",
    "en-US": "Spotify",
  },
};

const providerScanApps: Readonly<Record<string, Readonly<Record<AppLanguage, string>>>> = {
  netease: {
    "zh-CN": "网易云音乐 App",
    "en-US": "NetEase Cloud Music app",
  },
  qq: {
    "zh-CN": "QQ 音乐 App",
    "en-US": "QQ Music app",
  },
  spotify: {
    "zh-CN": "Spotify",
    "en-US": "Spotify",
  },
};

export function formatProviderName(
  language: AppLanguage,
  providerId: string,
  fallback: string,
) {
  return providerNames[providerId]?.[language] ?? fallback;
}
export function formatProviderScanApp(
  language: AppLanguage,
  providerId: string,
  fallback: string,
) {
  return providerScanApps[providerId]?.[language] ?? fallback;
}

export function formatLocalizedDate(
  language: AppLanguage,
  value: number | Date,
) {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function formatLocalizedNumber(
  language: AppLanguage,
  value: number,
) {
  return new Intl.NumberFormat(language).format(value);
}
