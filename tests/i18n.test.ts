import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLocalizedDate,
  formatProviderName,
  formatProviderScanApp,
} from "../src/i18n/formatters.ts";
import {
  appLanguageStorageKey,
  defaultAppLanguage,
  normalizeAppLanguage,
} from "../src/i18n/language.ts";
import {
  messageCatalogs,
  translate,
} from "../src/i18n/messages.ts";

function placeholders(message: string) {
  return [...message.matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
    .map((match) => match[1])
    .sort();
}

test("language preference defaults safely and uses the stable storage key", () => {
  assert.equal(defaultAppLanguage, "zh-CN");
  assert.equal(appLanguageStorageKey, "tingjing:language");
  assert.equal(normalizeAppLanguage("zh-CN"), "zh-CN");
  assert.equal(normalizeAppLanguage("en-US"), "en-US");
  assert.equal(normalizeAppLanguage("en"), "zh-CN");
  assert.equal(normalizeAppLanguage(null), "zh-CN");
});

test("Chinese and English catalogs expose the same keys and placeholders", () => {
  const chineseKeys = Object.keys(messageCatalogs["zh-CN"]).sort();
  const englishKeys = Object.keys(messageCatalogs["en-US"]).sort();
  assert.deepEqual(englishKeys, chineseKeys);

  for (const key of chineseKeys) {
    assert.deepEqual(
      placeholders(messageCatalogs["en-US"][key as keyof typeof messageCatalogs["en-US"]]),
      placeholders(messageCatalogs["zh-CN"][key as keyof typeof messageCatalogs["zh-CN"]]),
      `placeholder mismatch for ${key}`,
    );
  }
});

test("translation interpolates values without changing provider identity", () => {
  assert.equal(
    translate("zh-CN", "welcome.provider.connect", {
      provider: "Spotify",
    }),
    "连接 Spotify",
  );
  assert.equal(
    translate("en-US", "welcome.provider.connect", {
      provider: "Spotify",
    }),
    "Connect Spotify",
  );
});

test("known music services and scan apps are localized", () => {
  assert.equal(
    formatProviderName("en-US", "netease", "网易云音乐"),
    "NetEase Cloud Music",
  );
  assert.equal(
    formatProviderName("en-US", "qq", "QQ 音乐"),
    "QQ Music",
  );
  assert.equal(
    formatProviderName("zh-CN", "spotify", "Spotify"),
    "Spotify",
  );
  assert.equal(
    formatProviderScanApp("en-US", "qq", "QQ 音乐 App"),
    "QQ Music app",
  );
  assert.equal(
    formatProviderName("en-US", "future-provider", "Future Music"),
    "Future Music",
  );
});

test("date formatting follows the selected locale", () => {
  const date = new Date(2026, 0, 2);
  assert.notEqual(
    formatLocalizedDate("zh-CN", date),
    formatLocalizedDate("en-US", date),
  );
});
