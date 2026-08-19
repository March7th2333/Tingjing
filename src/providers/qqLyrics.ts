import { decryptQrc } from "qrc-decoder";
import type { LyricLine, Lyrics } from "../types/music";
import {
  mergeTimedLinesWithWordTimings,
  normalizeWordTimingMatchText,
  parseBracketWordSyncedLyrics,
} from "./wordSyncedLyrics.ts";

export interface QqLyricsPayload {
  original: string;
  translation: string;
  wordSynced: string;
  wordSyncedSource?: "qrc" | "provider" | "lrc";
}

export interface ParsedQqLyricLine {
  atMs: number;
  durationMs?: number;
  text: string;
  words?: LyricLine["words"];
  wordTimingRejection?: LyricLine["wordTimingRejection"];
}

type WordMarker = {
  atMs: number;
  durationMs: number;
};

const standardTimestampPattern = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/gu;
const qrcLinePattern = /^\[(\d+),(\d+)(?:,\d+)?\](.*)$/u;
const qrcWordPattern = /\((-?\d+),(\d+)(?:,\d+)?\)/gu;

function parseTimestamp(minutes: string, seconds: string) {
  return Math.round((Number(minutes) * 60 + Number(seconds)) * 1_000);
}

export function normalizeQqLyricText(value: string) {
  return normalizeWordTimingMatchText(value);
}

function decodeXmlEntities(value: string) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/giu,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return String.fromCodePoint(Number(decimal));
      }
      if (hexadecimal) {
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      }
      switch (entity.toLocaleLowerCase("en-US")) {
        case "&amp;": return "&";
        case "&lt;": return "<";
        case "&gt;": return ">";
        case "&quot;": return "\"";
        case "&apos;": return "'";
        default: return entity;
      }
    },
  );
}

function unwrapQrcXml(value: string) {
  if (!value.includes("<")) {
    return value;
  }

  const attribute = /\bLyricContent\s*=\s*(["'])([\s\S]*?)\1/iu.exec(value);
  if (attribute?.[2]) {
    return decodeXmlEntities(attribute[2]);
  }

  const element = /<LyricContent\b[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/LyricContent>/iu.exec(value);
  return element?.[1] ? decodeXmlEntities(element[1]) : value;
}

function looksLikeTimedLyrics(value: string) {
  const trimmed = value.trim();
  return trimmed.includes("LyricContent")
    || /^\[(?:\d{1,3}:\d{2}(?:\.\d{1,3})?|\d+,\d+)\]/mu.test(trimmed);
}

function decodeHexText(value: string) {
  if (value.length % 2 !== 0 || !/^[\da-f]+$/iu.test(value)) {
    return "";
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

function decodeBase64Text(value: string) {
  const compact = value.replace(/\s+/gu, "");
  if (
    compact.length < 8
    || compact.length % 4 !== 0
    || !/^[A-Za-z\d+/]+={0,2}$/u.test(compact)
  ) {
    return "";
  }

  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

export function decodeQqLyricPayload(value: string) {
  let decoded = value.trim();

  for (let pass = 0; pass < 3 && decoded; pass += 1) {
    const unwrapped = unwrapQrcXml(decoded).trim();
    if (unwrapped !== decoded) {
      decoded = unwrapped;
      continue;
    }

    const isHex = decoded.length >= 16
      && decoded.length % 2 === 0
      && /^[\da-f]+$/iu.test(decoded);
    if (isHex) {
      try {
        const qrc = decryptQrc(decoded).trim();
        if (qrc && (looksLikeTimedLyrics(qrc) || qrc.includes("<"))) {
          decoded = qrc;
          continue;
        }
      } catch {
        // Some QQ payloads are plain UTF-8 hex rather than encrypted QRC.
      }

      const plainHex = decodeHexText(decoded).trim();
      if (plainHex && (looksLikeTimedLyrics(plainHex) || plainHex.includes("<"))) {
        decoded = plainHex;
        continue;
      }
    }

    const base64 = decodeBase64Text(decoded).trim();
    if (
      base64
      && (
        looksLikeTimedLyrics(base64)
        || base64.includes("<")
        || (/^[\da-f]+$/iu.test(base64) && base64.length % 2 === 0)
      )
    ) {
      decoded = base64;
      continue;
    }

    break;
  }

  return unwrapQrcXml(decoded).trim();
}

function splitQrcContent(content: string) {
  const markers = Array.from(content.matchAll(qrcWordPattern));
  const segments: string[] = [];
  let cursor = 0;

  for (const marker of markers) {
    const start = marker.index ?? cursor;
    segments.push(content.slice(cursor, start));
    cursor = start + marker[0].length;
  }
  segments.push(content.slice(cursor));

  return {
    markers: markers.map<WordMarker>((marker) => ({
      atMs: Number(marker[1]),
      durationMs: Number(marker[2]),
    })),
    segments,
  };
}

export function parseWordSyncedLyrics(value: string): ParsedQqLyricLine[] {
  const decoded = decodeQqLyricPayload(value);
  return parseBracketWordSyncedLyrics(decoded);
}

export function parseTimedQqLyrics(value: string): ParsedQqLyricLine[] {
  const result: ParsedQqLyricLine[] = [];
  const decoded = decodeQqLyricPayload(value);

  for (const row of decoded.split(/\r?\n/u)) {
    const standardMatches = Array.from(row.matchAll(standardTimestampPattern));
    if (standardMatches.length > 0) {
      const text = row.replace(standardTimestampPattern, "").trim();
      if (text) {
        for (const match of standardMatches) {
          result.push({
            atMs: parseTimestamp(match[1], match[2]),
            text,
          });
        }
      }
      continue;
    }

    const qrcMatch = qrcLinePattern.exec(row.trim());
    if (!qrcMatch) {
      continue;
    }
    const { segments } = splitQrcContent(qrcMatch[3]);
    const text = segments.join("").trim();
    if (text) {
      result.push({ atMs: Number(qrcMatch[1]), text });
    }
  }

  return result.sort((left, right) => left.atMs - right.atMs);
}

function median(values: readonly number[]) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function stableSequenceOffset(
  lines: readonly LyricLine[],
  translations: readonly ParsedQqLyricLine[],
) {
  if (lines.length === 0 || lines.length !== translations.length) {
    return undefined;
  }
  const offsets = lines.map((line, index) =>
    translations[index].atMs - line.atMs);
  const offset = median(offsets);
  const deviation = median(offsets.map((value) => Math.abs(value - offset)));
  return Math.abs(offset) <= 2_000 && deviation <= 180 ? offset : undefined;
}

function attachTranslations(
  lines: readonly LyricLine[],
  translations: readonly ParsedQqLyricLine[],
) {
  if (translations.length === 0) {
    return lines.map((line) => ({ ...line, translation: undefined }));
  }

  const sequenceOffset = stableSequenceOffset(lines, translations);
  if (sequenceOffset !== undefined) {
    return lines.map((line, index) => ({
      ...line,
      translation: translations[index].text.trim() || undefined,
    }));
  }

  let lastTranslationIndex = -1;
  return lines.map((line, lineIndex) => {
    const lineEnd = Math.min(
      lines[lineIndex + 1]?.atMs ?? line.atMs + 8_000,
      line.atMs + 12_000,
    );
    const candidates = translations
      .map((translation, index) => ({
        translation,
        index,
        delta: Math.abs(translation.atMs - line.atMs),
        translationEnd: Math.min(
          translations[index + 1]?.atMs ?? translation.atMs + 8_000,
          translation.atMs + 12_000,
        ),
      }))
      .filter(({ index }) => index > lastTranslationIndex);

    const exact = candidates.find(({ delta }) => delta <= 30);
    const overlapping = candidates
      .filter(({ translation, translationEnd }) =>
        translation.atMs < lineEnd
        && translationEnd > line.atMs
        && Math.abs(translation.atMs - line.atMs) <= 900)
      .sort((left, right) => left.delta - right.delta)[0];
    const nearestLimit = Math.min(
      700,
      Math.max(250, (lineEnd - line.atMs) * 0.3),
    );
    const nearest = candidates
      .filter(({ delta }) => delta <= nearestLimit)
      .sort((left, right) => left.delta - right.delta)[0];
    const match = exact ?? overlapping ?? nearest;

    if (!match) {
      return { ...line, translation: undefined };
    }
    lastTranslationIndex = match.index;
    return {
      ...line,
      translation: match.translation.text.trim() || undefined,
    };
  });
}

export function mapQqLyrics(
  trackId: string,
  payload: QqLyricsPayload,
): Lyrics {
  const original = parseTimedQqLyrics(payload.original);
  const wordSynced = parseWordSyncedLyrics(payload.wordSynced);
  const completeLines = mergeTimedLinesWithWordTimings(original, wordSynced);
  const translated = parseTimedQqLyrics(payload.translation);
  const lines = attachTranslations(completeLines, translated);

  return {
    trackId,
    lines,
    hasTranslation: lines.some((line) => Boolean(line.translation?.trim())),
    source: wordSynced.length > 0
      ? payload.wordSyncedSource ?? "provider"
      : "lrc",
  };
}
