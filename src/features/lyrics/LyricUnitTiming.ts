import { segmentLyricText } from "./LyricTruth.ts";

export type TimedLyricUnitKind = "character" | "word" | "space";

export interface TimedLyricUnit {
  text: string;
  startMs: number;
  endMs: number;
  unit: TimedLyricUnitKind;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function readableLength(text: string) {
  return Array.from(text.normalize("NFKC")).filter(
    (character) => !/[\s\p{P}\p{S}]/u.test(character),
  ).length;
}

function unitWeight(text: string, unit: TimedLyricUnitKind) {
  if (unit === "space") {
    return 0;
  }
  if (unit === "word") {
    // Latin lyrics remain word-readable, while longer words receive a little
    // more of the provider/line window than short connective words.
    return clamp(Math.sqrt(Math.max(1, readableLength(text))), 1, 2.5);
  }
  return readableLength(text) > 0 ? 1 : 0.32;
}

/**
 * Splits one truthful timing interval into display units. CJK uses grapheme
 * units and Latin text uses complete words. The original interval remains the
 * authority; no unit is allowed to escape it.
 */
export function distributeLyricUnits(
  text: string,
  startMs: number,
  endMs: number,
  revealPortion = 1,
): TimedLyricUnit[] {
  const units = segmentLyricText(text);
  if (units.length === 0) {
    return [];
  }

  const safeStartMs = Number.isFinite(startMs) ? startMs : 0;
  const safeEndMs = Number.isFinite(endMs)
    ? Math.max(safeStartMs + 1, endMs)
    : safeStartMs + 1;
  const revealEndMs = safeStartMs
    + (safeEndMs - safeStartMs) * clamp(revealPortion, 0.2, 1);
  const weights = units.map(({ text: unitText, unit }) =>
    unitWeight(unitText, unit)
  );
  const totalWeight = Math.max(
    1,
    weights.reduce((total, weight) => total + weight, 0),
  );
  let consumedWeight = 0;
  let previousTime = safeStartMs;

  return units.map(({ text: unitText, unit }, index) => {
    const weight = weights[index];
    if (weight <= 0) {
      return {
        text: unitText,
        startMs: previousTime,
        endMs: previousTime,
        unit,
      };
    }

    const unitStartMs = safeStartMs
      + (revealEndMs - safeStartMs) * consumedWeight / totalWeight;
    consumedWeight += weight;
    const unitEndMs = safeStartMs
      + (revealEndMs - safeStartMs) * consumedWeight / totalWeight;
    previousTime = unitEndMs;
    return {
      text: unitText,
      startMs: unitStartMs,
      endMs: Math.max(unitStartMs + 1, unitEndMs),
      unit,
    };
  });
}

/**
 * Line-only timing is an explicit estimate: it follows the real line window,
 * finishes shortly before the boundary, and never pretends to be provider
 * character timing.
 */
export function estimateLineLyricUnits(
  text: string,
  startMs: number,
  endMs: number,
) {
  return distributeLyricUnits(text, startMs, endMs, 0.9);
}
