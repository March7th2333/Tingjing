import type { LyricLine, Lyrics } from "../types/music";
import {
  mergeTimedLinesWithWordTimings,
  parseBracketWordSyncedLyrics,
  type ParsedWordSyncedLine,
} from "./wordSyncedLyrics.ts";

export interface NeteaseLyricsPayload {
  original: string;
  translation: string;
  wordSynced: string;
  wordSyncedSource?: "yrc" | "krc" | "lrc";
}

function parseTimestamp(minutes: string, seconds: string) {
  return Math.round((Number(minutes) * 60 + Number(seconds)) * 1_000);
}

export function parseNeteaseLrc(value: string): ParsedWordSyncedLine[] {
  const result: ParsedWordSyncedLine[] = [];
  const timestamp = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/gu;

  for (const row of value.split(/\r?\n/u)) {
    const text = row.replace(timestamp, "").trim();
    if (!text) {
      continue;
    }
    timestamp.lastIndex = 0;
    let match = timestamp.exec(row);
    while (match) {
      result.push({ atMs: parseTimestamp(match[1], match[2]), text });
      match = timestamp.exec(row);
    }
  }
  return result.sort((left, right) => left.atMs - right.atMs);
}

export function parseNeteaseWordSyncedLyrics(value: string) {
  return parseBracketWordSyncedLyrics(value);
}

export function mapNeteaseLyrics(
  trackId: string,
  payload: NeteaseLyricsPayload,
): Lyrics {
  const wordSynced = parseNeteaseWordSyncedLyrics(payload.wordSynced);
  const original = mergeTimedLinesWithWordTimings(
    parseNeteaseLrc(payload.original),
    wordSynced,
  );
  const translatedLines = parseNeteaseLrc(payload.translation);
  const translations = new Map(
    translatedLines.map((line) => [line.atMs, line.text]),
  );
  const lines: LyricLine[] = original.map((line) => ({
    ...line,
    translation:
      translations.get(line.atMs)
      ?? translatedLines.find(
        (translated) => Math.abs(translated.atMs - line.atMs) <= 220,
      )?.text,
  }));

  return {
    trackId,
    lines,
    hasTranslation: lines.some((line) => Boolean(line.translation?.trim())),
    source: wordSynced.length > 0
      ? payload.wordSyncedSource ?? "provider"
      : "lrc",
  };
}
