import { motionTokens } from "./motionTokens.ts";

export type TypographySceneTemplate =
  | "monument"
  | "paired"
  | "echo"
  | "crop"
  | "dense";

export type TypographyLyricLanguage = "ja" | "zh-CN" | "en";

export type TypographyMemoryGlyphKind =
  | "context-past"
  | "context-future"
  | "architectural";

export interface TypographySceneLineInput {
  index: number;
  text: string;
  startTime: number;
  endTime: number;
  glyphCount: number;
  language: TypographyLyricLanguage;
}

export interface TypographyMemoryGlyph {
  id: string;
  kind: TypographyMemoryGlyphKind;
  rank: number;
  text: string;
  xVw: number;
  yRatio: number;
  depth: number;
  scale: number;
  rotationDeg: number;
  opacity: number;
  blur: number;
}

export interface TypographyLinePosterPlan {
  index: number;
  sceneId: string;
  sceneIndex: number;
  template: TypographySceneTemplate;
  focusX: number;
  focusYRatio: number;
  preRollMs: number;
  futureDepth: number;
  pastDurationMs: number;
  pastLiftVh: number;
  pastDepthPx: number;
  preferredColumns: 1 | 2;
  memoryGlyphs: TypographyMemoryGlyph[];
}

export interface TypographyScenePlan {
  id: string;
  index: number;
  startLineIndex: number;
  endLineIndex: number;
  startTime: number;
  endTime: number;
  template: TypographySceneTemplate;
  focusX: number;
  focusYRatio: number;
  density: number;
  depthStrength: number;
  occupancy: TypographySceneOccupancy;
  memoryGlyphs: TypographyMemoryGlyph[];
}

export interface TypographySceneOccupancy {
  visualOccupancy: number;
  largestGlyphRatio: number;
  backgroundObjectCount: number;
  focusQuietZone: number;
  sceneBalanceScore: number;
}

export interface TypographyInterludePlan {
  id: string;
  previousLineIndex: number;
  nextLineIndex: number | null;
  startTime: number;
  endTime: number;
  afterimageEndTime: number;
  previewStartTime: number;
  kind: "medium" | "long";
}

export interface TypographyPosterPlan {
  scenes: TypographyScenePlan[];
  linePlans: TypographyLinePosterPlan[];
  lineToScene: number[];
  interludes: TypographyInterludePlan[];
}

interface PlannerInput {
  trackId: string;
  lines: TypographySceneLineInput[];
  trackDurationMs: number;
}

interface SceneFeatures {
  averageGlyphCount: number;
  maximumGlyphCount: number;
  totalGlyphCount: number;
  averageGapMs: number;
  density: number;
  continuity: number;
  hasLongLine: boolean;
}

const posterTokens = motionTokens.typographyPoster;
const minimumSceneLineCount = posterTokens.sceneLineMinimum;
const maximumSceneLineCount = posterTokens.sceneLineMaximum;
const hardSceneGapMs = posterTokens.interludeGapMs;
const interludeAfterimageMs = posterTokens.interludeAfterimageMs;
const previewLeadMinimumMs = posterTokens.interludePreviewMinimumMs;
const previewLeadMaximumMs = posterTokens.interludePreviewMaximumMs;
const memorySlotCount = posterTokens.memorySlots;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function hashString(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function unitFromHash(value: string) {
  return hashString(value) / 4_294_967_295;
}

function normalizeText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function hasTerminalPunctuation(value: string) {
  return /[。！？!?…,.，、；;：:]\s*$/u.test(value);
}

function getGapAfter(lines: TypographySceneLineInput[], index: number) {
  const nextLine = lines[index + 1];
  if (!nextLine) {
    return 0;
  }
  return Math.max(0, nextLine.startTime - lines[index].endTime);
}

function getTimestampGroupOwnerIndex(
  lines: TypographySceneLineInput[],
  index: number,
) {
  const safeIndex = clamp(index, 0, Math.max(0, lines.length - 1));
  const timestamp = lines[safeIndex]?.startTime;
  let ownerIndex = safeIndex;
  while (
    ownerIndex + 1 < lines.length
    && lines[ownerIndex + 1].startTime === timestamp
  ) {
    ownerIndex += 1;
  }
  return ownerIndex;
}

function getBoundaryScore(
  lines: TypographySceneLineInput[],
  startIndex: number,
  endIndex: number,
) {
  const current = lines[endIndex];
  const next = lines[endIndex + 1];
  const lineCount = endIndex - startIndex + 1;
  const gapAfter = getGapAfter(lines, endIndex);
  if (!next) {
    return Number.POSITIVE_INFINITY;
  }
  if (gapAfter >= hardSceneGapMs) {
    return 10_000 + gapAfter;
  }

  const currentDuration = Math.max(1, current.endTime - current.startTime);
  const nextDuration = Math.max(1, next.endTime - next.startTime);
  const glyphContrast = Math.abs(current.glyphCount - next.glyphCount)
    / Math.max(1, current.glyphCount, next.glyphCount);
  const durationContrast = Math.abs(currentDuration - nextDuration)
    / Math.max(currentDuration, nextDuration);
  const balancedSceneBonus = lineCount === 3 ? 1.1 : lineCount === 4 ? 0.9 : 0;

  return (hasTerminalPunctuation(current.text) ? 3.2 : 0)
    + (gapAfter >= 1_200 ? 4.4 : gapAfter / 1_200)
    + glyphContrast * 1.4
    + durationContrast
    + balancedSceneBonus;
}

function groupSceneRanges(lines: TypographySceneLineInput[]) {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let startIndex = 0;

  while (startIndex < lines.length) {
    const remaining = lines.length - startIndex;
    if (remaining <= maximumSceneLineCount) {
      if (remaining === 1 && ranges.length > 0) {
        ranges[ranges.length - 1].endIndex = startIndex;
      } else {
        ranges.push({ startIndex, endIndex: lines.length - 1 });
      }
      break;
    }

    const maximumCandidateCount = Math.min(
      maximumSceneLineCount,
      remaining - minimumSceneLineCount,
    );
    let selectedEndIndex = startIndex + minimumSceneLineCount - 1;
    let selectedScore = Number.NEGATIVE_INFINITY;

    for (
      let lineCount = minimumSceneLineCount;
      lineCount <= maximumCandidateCount;
      lineCount += 1
    ) {
      const endIndex = startIndex + lineCount - 1;
      const score = getBoundaryScore(lines, startIndex, endIndex);
      if (score > selectedScore) {
        selectedScore = score;
        selectedEndIndex = endIndex;
      }
    }

    ranges.push({ startIndex, endIndex: selectedEndIndex });
    startIndex = selectedEndIndex + 1;
  }

  return ranges;
}

function getTextUnits(line: TypographySceneLineInput) {
  if (line.language === "en") {
    return line.text
      .normalize("NFKC")
      .split(/\s+/u)
      .map((unit) => unit.replace(/[^\p{L}\p{N}'’-]/gu, ""))
      .filter(Boolean);
  }

  return Array.from(
    line.text.normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, ""),
  );
}

function createArchitecturalFragment(
  line: TypographySceneLineInput,
  seed: string,
) {
  const units = getTextUnits(line);
  if (units.length === 0) {
    return Array.from(line.text.normalize("NFKC"))
      .find((unit) => /[\p{P}\p{S}]/u.test(unit)) ?? "";
  }

  const count = line.language === "en"
    ? Math.min(units.length, units.length >= 3 ? 2 : 1)
    : Math.min(
        units.length,
        units.length >= 5 ? 3 : units.length >= 2 ? 2 : 1,
      );
  const maximumStart = Math.max(0, units.length - count);
  const start = maximumStart === 0
    ? 0
    : hashString(`${seed}:start`) % (maximumStart + 1);
  return units.slice(start, start + count).join(
    line.language === "en" ? " " : "",
  );
}

function createArchitecturalCandidates(
  sceneId: string,
  lines: TypographySceneLineInput[],
) {
  const candidates = lines.flatMap((line, lineIndex) => {
    const variantCount = line.language === "en" ? 2 : 3;
    return Array.from({ length: variantCount }, (_unused, variant) => ({
      text: createArchitecturalFragment(
        line,
        `${sceneId}:${lineIndex}:${variant}`,
      ),
      language: line.language,
    }));
  }).filter((candidate) => candidate.text.length > 0);

  return candidates.filter((candidate, index) =>
    candidates.findIndex((entry) =>
      entry.language === candidate.language && entry.text === candidate.text
    ) === index
  );
}

function getContinuity(lines: TypographySceneLineInput[]) {
  if (lines.length <= 1) {
    return 0;
  }

  let total = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const previousUnits = new Set(getTextUnits(lines[index - 1]));
    const currentUnits = new Set(getTextUnits(lines[index]));
    const union = new Set([...previousUnits, ...currentUnits]);
    let intersectionCount = 0;
    previousUnits.forEach((unit) => {
      if (currentUnits.has(unit)) {
        intersectionCount += 1;
      }
    });
    total += union.size === 0 ? 0 : intersectionCount / union.size;
  }

  return total / (lines.length - 1);
}

function getSceneFeatures(lines: TypographySceneLineInput[]): SceneFeatures {
  const totalGlyphCount = lines.reduce(
    (sum, line) => sum + line.glyphCount,
    0,
  );
  const sceneDurationMs = Math.max(
    1,
    lines[lines.length - 1].endTime - lines[0].startTime,
  );
  const gapTotal = lines.slice(0, -1).reduce(
    (sum, line, index) =>
      sum + Math.max(0, lines[index + 1].startTime - line.endTime),
    0,
  );

  return {
    averageGlyphCount: totalGlyphCount / Math.max(1, lines.length),
    maximumGlyphCount: Math.max(...lines.map((line) => line.glyphCount)),
    totalGlyphCount,
    averageGapMs: gapTotal / Math.max(1, lines.length - 1),
    density: totalGlyphCount / (sceneDurationMs / 1_000),
    continuity: getContinuity(lines),
    hasLongLine: lines.some((line) => line.glyphCount >= 17),
  };
}

function chooseTemplate(
  sceneLines: TypographySceneLineInput[],
  features: SceneFeatures,
  previousTemplate?: TypographySceneTemplate,
): TypographySceneTemplate {
  if (features.hasLongLine || features.maximumGlyphCount >= 18) {
    return "paired";
  }
  if (
    features.density >= 4.4
    || (features.totalGlyphCount >= 44 && sceneLines.length >= 4)
  ) {
    return "dense";
  }
  if (features.continuity >= 0.14 || features.averageGapMs < 620) {
    return "echo";
  }
  if (features.averageGlyphCount <= 9 && features.density < 2.8) {
    return "monument";
  }

  const semanticSignature = sceneLines
    .map((line) => normalizeText(line.text))
    .join("|");
  const cropCandidate = features.averageGlyphCount >= 10
    && features.averageGlyphCount <= 14
    && features.density >= 2.4
    && features.density <= 3.8
    && hashString(semanticSignature) % 7 === 0;
  if (cropCandidate && previousTemplate !== "crop") {
    return "crop";
  }
  return features.averageGlyphCount <= 10 ? "monument" : "echo";
}

function getArchitecturalGlyphCount(template: TypographySceneTemplate) {
  switch (template) {
    case "monument":
      return 3;
    case "crop":
      return 2;
    case "paired":
    case "echo":
      return 3;
    case "dense":
      return 3;
  }
}

interface TypographyMemoryAnchor {
  x: number;
  y: number;
}

const pastContextAnchors: readonly TypographyMemoryAnchor[] = [
  { x: -24, y: 0.18 },
  { x: -22, y: 0.46 },
  { x: -14, y: 0.58 },
];

const futureContextAnchors: readonly TypographyMemoryAnchor[] = [
  { x: 23, y: 0.14 },
  { x: 22, y: 0.43 },
  { x: 14, y: 0.55 },
];

const architecturalAnchors: readonly TypographyMemoryAnchor[] = [
  { x: -18, y: 0.09 },
  { x: -17, y: 0.36 },
  { x: -14, y: 0.58 },
  { x: -5, y: 0.12 },
  { x: 9, y: 0.08 },
  { x: 15, y: 0.3 },
  { x: 14, y: 0.56 },
  { x: 5, y: 0.58 },
];

const cropArchitecturalAnchors: readonly TypographyMemoryAnchor[] = [
  { x: -25, y: 0.08 },
  { x: -23, y: 0.48 },
  { x: 21, y: 0.1 },
  { x: 23, y: 0.5 },
];

function anchorDistance(
  left: TypographyMemoryAnchor,
  right: TypographyMemoryAnchor,
) {
  const horizontal = (left.x - right.x) / 17;
  const vertical = (left.y - right.y) / 0.2;
  return Math.sqrt(horizontal * horizontal + vertical * vertical);
}

function selectMemoryAnchor(
  anchors: readonly TypographyMemoryAnchor[],
  seed: string,
  occupied: TypographyMemoryAnchor[],
) {
  const startIndex = hashString(seed) % anchors.length;
  let fallback = anchors[startIndex];
  let fallbackDistance = -1;

  for (let offset = 0; offset < anchors.length; offset += 1) {
    const candidate = anchors[(startIndex + offset) % anchors.length];
    const nearestDistance = occupied.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(...occupied.map((anchor) => anchorDistance(
          candidate,
          anchor,
        )));
    if (nearestDistance >= 1) {
      occupied.push(candidate);
      return candidate;
    }
    if (nearestDistance > fallbackDistance) {
      fallback = candidate;
      fallbackDistance = nearestDistance;
    }
  }

  occupied.push(fallback);
  return fallback;
}

function createContextFragment(
  line: TypographySceneLineInput,
  seed: string,
) {
  const units = getTextUnits(line);
  if (units.length === 0) {
    return "";
  }
  const maximumCount = line.language === "en" ? 3 : 4;
  const minimumCount = line.language === "en" ? 1 : 2;
  const count = Math.min(
    units.length,
    minimumCount
      + hashString(`${seed}:count`) % (maximumCount - minimumCount + 1),
  );
  const maximumStart = Math.max(0, units.length - count);
  const start = maximumStart === 0
    ? 0
    : hashString(`${seed}:start`) % (maximumStart + 1);
  return units.slice(start, start + count).join(
    line.language === "en" ? " " : "",
  );
}

function createContextMemoryGlyph(
  line: TypographySceneLineInput,
  sceneId: string,
  kind: "context-past" | "context-future",
  occupied: TypographyMemoryAnchor[],
): TypographyMemoryGlyph | null {
  const seedKey = `${sceneId}:${kind}`;
  const text = createContextFragment(line, seedKey);
  if (!text) {
    return null;
  }
  const anchor = selectMemoryAnchor(
    kind === "context-past" ? pastContextAnchors : futureContextAnchors,
    seedKey,
    occupied,
  );
  return {
    id: `${sceneId}-${kind}`,
    kind,
    rank: 0,
    text,
    xVw: anchor.x + (unitFromHash(`${seedKey}:x`) - 0.5) * 1.8,
    yRatio: clamp(
      anchor.y + (unitFromHash(`${seedKey}:y`) - 0.5) * 0.035,
      0.08,
      0.6,
    ),
    depth: -72 - unitFromHash(`${seedKey}:depth`) * 72,
    scale: 0.72 + unitFromHash(`${seedKey}:scale`) * 0.18,
    rotationDeg: (unitFromHash(`${seedKey}:rotation`) - 0.5) * 3,
    opacity: 0.275 + unitFromHash(`${seedKey}:opacity`) * 0.17,
    blur: 0.2 + unitFromHash(`${seedKey}:blur`) * 1,
  };
}

function createArchitecturalGlyphs(
  trackId: string,
  sceneId: string,
  sceneLines: TypographySceneLineInput[],
  template: TypographySceneTemplate,
  occupied: TypographyMemoryAnchor[],
) {
  const candidates = createArchitecturalCandidates(sceneId, sceneLines);
  if (candidates.length === 0) {
    return [];
  }
  const glyphCount = getArchitecturalGlyphCount(template);
  const usedCandidateIndices = new Set<number>();
  return Array.from({ length: glyphCount }, (_unused, rank) => {
    const seedKey = `${trackId}:${sceneId}:architecture:${rank}`;
    const candidateStartIndex = hashString(seedKey) % candidates.length;
    let unitIndex = candidateStartIndex;
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const candidateIndex = (candidateStartIndex + offset) % candidates.length;
      if (!usedCandidateIndices.has(candidateIndex)) {
        unitIndex = candidateIndex;
        break;
      }
    }
    usedCandidateIndices.add(unitIndex);
    const candidate = candidates[unitIndex];
    const text = candidate.text;
    const anchor = selectMemoryAnchor(
      template === "crop"
        ? cropArchitecturalAnchors
        : architecturalAnchors,
      seedKey,
      occupied,
    );
    const visibleLength = Math.max(1, Array.from(text).length);
    const scriptAdjustment = candidate.language === "en"
      ? clamp(0.98 - Math.max(0, visibleLength - 5) * 0.018, 0.84, 0.98)
      : visibleLength === 1
        ? 0.97
        : clamp(0.96 - (visibleLength - 1) * 0.045, 0.82, 0.92);
    const rankAdjustment = template === "crop" && rank > 0 ? 0.9 : 1;
    const scaleRange = templateScaleRanges[template];
    const scale = clamp(
      (0.92 + unitFromHash(`${seedKey}:scale`) * 0.12)
        * scriptAdjustment
        * rankAdjustment,
      scaleRange.minimum,
      scaleRange.maximum,
    );
    return {
      id: `${sceneId}-architecture-${rank}`,
      kind: "architectural" as const,
      rank,
      text,
      xVw: anchor.x + (unitFromHash(`${seedKey}:x`) - 0.5) * 1.6,
      yRatio: clamp(
        anchor.y + (unitFromHash(`${seedKey}:y`) - 0.5) * 0.028,
        0.08,
        template === "crop" ? 0.64 : 0.6,
      ),
      depth: -155 - unitFromHash(`${seedKey}:depth`) * 125,
      scale,
      rotationDeg: (unitFromHash(`${seedKey}:rotation`) - 0.5) * 5,
      opacity: 0.11 + unitFromHash(`${seedKey}:opacity`) * 0.09,
      blur: 0.2 + unitFromHash(`${seedKey}:blur`) * 0.8,
    } satisfies TypographyMemoryGlyph;
  });
}

const templateScaleRanges = {
  monument: { minimum: 0.82, maximum: 0.97 },
  paired: { minimum: 0.84, maximum: 1.02 },
  echo: { minimum: 0.84, maximum: 1.04 },
  crop: { minimum: 0.78, maximum: 0.94 },
  dense: { minimum: 0.86, maximum: 1.02 },
} satisfies Record<
  TypographySceneTemplate,
  { minimum: number; maximum: number }
>;

const templateOccupancy = {
  monument: { glyph: 0.095, largest: 0.3 },
  paired: { glyph: 0.065, largest: 0.26 },
  echo: { glyph: 0.055, largest: 0.22 },
  crop: { glyph: 0.105, largest: 0.45 },
  dense: { glyph: 0.05, largest: 0.19 },
} satisfies Record<
  TypographySceneTemplate,
  { glyph: number; largest: number }
>;

function calculateSceneOccupancy(
  template: TypographySceneTemplate,
  memoryGlyphs: TypographyMemoryGlyph[],
): TypographySceneOccupancy {
  const profile = templateOccupancy[template];
  const architecture = memoryGlyphs.filter(
    (glyph) => glyph.kind === "architectural",
  );
  const contextCount = memoryGlyphs.length - architecture.length;
  const permanentBedOccupancy = 0.08;
  const contextOccupancy = contextCount * 0.025;
  const architectureOccupancy = architecture.reduce(
    (total, glyph) => total + profile.glyph * glyph.scale * glyph.scale,
    0,
  );
  const visualOccupancy = permanentBedOccupancy
    + contextOccupancy
    + architectureOccupancy;
  const largestGlyphRatio = profile.largest
    * Math.max(0, ...architecture.map((glyph) => glyph.scale));
  const occupancyDistance = Math.abs(
    visualOccupancy - posterTokens.visualOccupancyTarget,
  );
  const objectPenalty = memoryGlyphs.length
      < posterTokens.backgroundObjectMinimum
    || memoryGlyphs.length > posterTokens.backgroundObjectMaximum
    ? 0.18
    : 0;
  return {
    visualOccupancy,
    largestGlyphRatio,
    backgroundObjectCount: memoryGlyphs.length,
    focusQuietZone: posterTokens.focusQuietZoneRatio,
    sceneBalanceScore: clamp(
      1 - occupancyDistance / 0.14 - objectPenalty,
      0,
      1,
    ),
  };
}

function balanceMemoryGlyphs(
  template: TypographySceneTemplate,
  memoryGlyphs: TypographyMemoryGlyph[],
) {
  const architecture = memoryGlyphs.filter(
    (glyph) => glyph.kind === "architectural",
  );
  if (architecture.length === 0) {
    return memoryGlyphs;
  }

  const profile = templateOccupancy[template];
  const contextCount = memoryGlyphs.length - architecture.length;
  const fixedOccupancy = 0.08 + contextCount * 0.025;
  const currentArchitectureOccupancy = architecture.reduce(
    (total, glyph) => total + profile.glyph * glyph.scale * glyph.scale,
    0,
  );
  const desiredArchitectureOccupancy = Math.max(
    0.01,
    posterTokens.visualOccupancyTarget - fixedOccupancy,
  );
  const occupancyScale = Math.sqrt(
    desiredArchitectureOccupancy
      / Math.max(0.01, currentArchitectureOccupancy),
  );
  const scaleRange = templateScaleRanges[template];
  const largestRatioMaximum = template === "crop"
    ? posterTokens.cropLargestGlyphRatioMaximum
    : posterTokens.ordinaryLargestGlyphRatioMaximum;
  const largestScaleMaximum = largestRatioMaximum / profile.largest;

  return memoryGlyphs.map((glyph) => glyph.kind !== "architectural"
    ? glyph
    : {
        ...glyph,
        scale: clamp(
          glyph.scale * occupancyScale,
          scaleRange.minimum,
          Math.min(scaleRange.maximum, largestScaleMaximum),
        ),
      });
}

function createMemoryGlyphs(
  trackId: string,
  sceneId: string,
  sceneLines: TypographySceneLineInput[],
  template: TypographySceneTemplate,
): TypographyMemoryGlyph[] {
  const primaryLine = sceneLines[0];
  if (!primaryLine) {
    return [];
  }
  const occupied: TypographyMemoryAnchor[] = [];
  const pastContext = createContextMemoryGlyph(
    primaryLine,
    sceneId,
    "context-past",
    occupied,
  );
  const futureContext = createContextMemoryGlyph(
    primaryLine,
    sceneId,
    "context-future",
    occupied,
  );
  const glyphs = [
    ...(pastContext ? [pastContext] : []),
    ...(futureContext ? [futureContext] : []),
    ...createArchitecturalGlyphs(
      trackId,
      sceneId,
      sceneLines,
      template,
      occupied,
    ),
  ].slice(0, memorySlotCount);
  return balanceMemoryGlyphs(template, glyphs);
}

/*
 * Context fragments remain line-specific, while architectural glyphs are
 * planned for the complete scene. Runtime can therefore update past/future
 * context without rebuilding the typographic architecture every lyric line.
 * Both still share the fixed A/B banks and never expose a complete lyric line.
 */

function createInterludes(
  lines: TypographySceneLineInput[],
  trackDurationMs: number,
): TypographyInterludePlan[] {
  return lines.flatMap((line, index) => {
    const nextGroupStartIndex = index + 1;
    const nextLineIndex = nextGroupStartIndex < lines.length
      ? getTimestampGroupOwnerIndex(lines, nextGroupStartIndex)
      : null;
    const nextLine = nextLineIndex === null
      ? undefined
      : lines[nextLineIndex];
    const gapEndTime = nextLine?.startTime ?? trackDurationMs;
    const gapDurationMs = gapEndTime - line.endTime;
    if (gapDurationMs < posterTokens.mediumInterludeMinimumMs) {
      return [];
    }

    const previewLeadMs = clamp(
      gapDurationMs * 0.28,
      previewLeadMinimumMs,
      previewLeadMaximumMs,
    );
    return [{
      id: `interlude-${index}`,
      previousLineIndex: index,
      nextLineIndex,
      startTime: line.endTime,
      endTime: gapEndTime,
      afterimageEndTime: Math.min(
        gapEndTime,
        line.endTime + interludeAfterimageMs,
      ),
      previewStartTime: nextLine
        ? Math.max(line.endTime, gapEndTime - previewLeadMs)
        : gapEndTime,
      kind: gapDurationMs >= posterTokens.longInterludeMinimumMs
        ? "long"
        : "medium",
    }];
  });
}

export function planTypographyScenes({
  trackId,
  lines,
  trackDurationMs,
}: PlannerInput): TypographyPosterPlan {
  if (lines.length === 0) {
    return {
      scenes: [],
      linePlans: [],
      lineToScene: [],
      interludes: [],
    };
  }

  const ranges = groupSceneRanges(lines);
  const linePlans: TypographyLinePosterPlan[] = Array.from({
    length: lines.length,
  });
  const lineToScene = Array.from({ length: lines.length }, () => 0);
  let previousFocusX = 0;
  let previousTemplate: TypographySceneTemplate | undefined;

  const scenes = ranges.map((range, sceneIndex): TypographyScenePlan => {
    const sceneLines = lines.slice(range.startIndex, range.endIndex + 1);
    const features = getSceneFeatures(sceneLines);
    const template = chooseTemplate(sceneLines, features, previousTemplate);
    previousTemplate = template;
    const signature = sceneLines
      .map((line) => normalizeText(line.text))
      .join("|");
    const sceneId = `poster-${hashString(`${trackId}:${signature}`).toString(36)}`;
    const desiredFocusX = sceneIndex === 0
      ? 0
      : (unitFromHash(`${trackId}:${signature}:focus-x`) - 0.5)
        * posterTokens.focusMaximumVw * 2;
    const focusX = clamp(
      desiredFocusX,
      previousFocusX - posterTokens.focusSceneStepMaximumVw,
      previousFocusX + posterTokens.focusSceneStepMaximumVw,
    );
    const focusYRatio = clamp(
      posterTokens.focusYBaseRatio
        + (unitFromHash(`${trackId}:${signature}:focus-y`) - 0.5)
          * posterTokens.focusYVariationRatio,
      posterTokens.focusYMinimumRatio,
      posterTokens.focusYMaximumRatio,
    );
    previousFocusX = focusX;
    const density = clamp(features.density / 5.2, 0.28, 1);
    const depthStrength = template === "dense"
      ? 1
      : template === "crop"
        ? 0.88
        : template === "echo"
          ? 0.74
          : 0.62;

    sceneLines.forEach((line) => {
      const lineSeed = `${trackId}:${sceneId}:${normalizeText(line.text)}`;
      lineToScene[line.index] = sceneIndex;
      linePlans[line.index] = {
        index: line.index,
        sceneId,
        sceneIndex,
        template,
        focusX,
        focusYRatio,
        preRollMs: posterTokens.futureLeadMinimumMs
          + unitFromHash(`${lineSeed}:pre-roll`)
            * (posterTokens.futureLeadMaximumMs
              - posterTokens.futureLeadMinimumMs),
        futureDepth: -110 - unitFromHash(`${lineSeed}:future-depth`) * 70,
        pastDurationMs: posterTokens.pastTransitionMinimumMs
          + unitFromHash(`${lineSeed}:past`)
            * (posterTokens.pastTransitionMaximumMs
              - posterTokens.pastTransitionMinimumMs),
        pastLiftVh: posterTokens.pastLiftMinimumVh
          + unitFromHash(`${lineSeed}:lift`)
            * (posterTokens.pastLiftMaximumVh
              - posterTokens.pastLiftMinimumVh),
        pastDepthPx: posterTokens.pastDepthMinimumPx
          + unitFromHash(`${lineSeed}:depth`)
            * (posterTokens.pastDepthMaximumPx
              - posterTokens.pastDepthMinimumPx),
        preferredColumns: line.glyphCount >= 17 ? 2 : 1,
        memoryGlyphs: createMemoryGlyphs(
          trackId,
          `${sceneId}:line:${line.index}`,
          [line],
          template,
        ),
      };
    });

    const memoryGlyphs = createMemoryGlyphs(
      trackId,
      sceneId,
      sceneLines,
      template,
    );
    return {
      id: sceneId,
      index: sceneIndex,
      startLineIndex: range.startIndex,
      endLineIndex: range.endIndex,
      startTime: sceneLines[0].startTime,
      endTime: sceneLines[sceneLines.length - 1].endTime,
      template,
      focusX,
      focusYRatio,
      density,
      depthStrength,
      occupancy: calculateSceneOccupancy(template, memoryGlyphs),
      memoryGlyphs,
    };
  });

  return {
    scenes,
    linePlans,
    lineToScene,
    interludes: createInterludes(lines, trackDurationMs),
  };
}

export function getTypographySceneAtLine(
  plan: TypographyPosterPlan,
  lineIndex: number,
) {
  if (plan.scenes.length === 0) {
    return null;
  }
  const sceneIndex = plan.lineToScene[clamp(
    lineIndex,
    0,
    Math.max(0, plan.lineToScene.length - 1),
  )] ?? 0;
  return plan.scenes[sceneIndex] ?? plan.scenes[0];
}

export function getTypographyInterludeAtTime(
  plan: TypographyPosterPlan,
  timeMs: number,
) {
  return plan.interludes.find(
    (interlude) => timeMs >= interlude.startTime && timeMs < interlude.endTime,
  ) ?? null;
}
