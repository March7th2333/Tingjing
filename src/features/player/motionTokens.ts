export type AtmosphereSpace =
  | "music"
  | "flow"
  | "typography";

export interface AtmosphereProfile {
  ambient: number;
  particles: number;
  geometry: number;
  depth: number;
  soundReaction: number;
  motion: number;
  idlePresence: number;
  centerGravity: number;
  timeFlow: number;
  readingReserve: number;
}

export const coverPassageMotionTokens = {
  entryDuration: 1_750,
  reducedDuration: 220,
  exitDuration: 820,
  exitReducedDuration: 220,
  sharpApproachStart: 120,
  sharpApproachEnd: 620,
  textureStart: 480,
  coverMediumOwnershipStart: 700,
  atmosphereStart: 850,
  listeningSpaceStart: 1_050,
  stableStart: 1_350,
  exitMediumStart: 160,
  exitSharpStart: 360,
  exitWallHandoff: 760,
} as const;

export const motionTokens = {
  coverPassage: coverPassageMotionTokens,
  particleSpeed: {
    far: 0.055,
    mid: 0.09,
    near: 0.065,
  },
  centerGravity: {
    focusX: 0.5,
    focusY: 0.49,
    radialDensityPower: 1.68,
    breatheCycle: 0.18,
    farExpansionPx: 19,
    midExpansionPx: 38,
    beatFarPx: 9,
    beatMidPx: 22,
  },
  timeFlow: {
    leftAnchor: 0.16,
    rightAnchor: 0.84,
    farDriftPx: 11,
    midDriftPx: 22,
    verticalFarPx: 8,
    verticalMidPx: 17,
  },
  paperLight: {
    background: "#f4f3ee",
    particleMinimumGray: 42,
    particleMaximumGray: 128,
    particleShadowAlpha: 0.16,
  },
  particleDensity: {
    low: {
      glow: 3,
      far: 112,
      mid: 45,
      near: 6,
    },
    standard: {
      glow: 4,
      far: 176,
      mid: 56,
      near: 10,
    },
    high: {
      glow: 5,
      far: 200,
      mid: 76,
      near: 14,
    },
  },
  spaceParticleScale: {
    music: 1,
    flow: 0.78,
    typography: 0.7,
  },
  ambientFieldSizePx: {
    minimum: 300,
    maximum: 800,
  },
  ambientFieldViewportRatio: {
    minimum: 0.3,
    maximum: 0.52,
  },
  ambientFieldOpacity: {
    minimum: 0.03,
    maximum: 0.1,
  },
  fogIntensity: {
    minimum: 0.03,
    maximum: 0.12,
  },
  geometryDensity: {
    low: 0.58,
    standard: 0.9,
    high: 1,
  },
  lyricRevealDuration: 420,
  lyricRevealBlurPx: 8,
  lyricRevealScale: 0.96,
  typographyPoster: {
    sceneLineMinimum: 2,
    sceneLineMaximum: 5,
    futureLeadMinimumMs: 600,
    futureLeadMaximumMs: 1_200,
    interludePreviewMinimumMs: 900,
    interludePreviewMaximumMs: 1_300,
    pastHandoffMs: 180,
    pastTransitionMinimumMs: 620,
    pastTransitionMaximumMs: 700,
    pastReducedTransitionMinimumMs: 220,
    pastReducedTransitionMaximumMs: 320,
    pastLiftMinimumVh: 12,
    pastLiftMaximumVh: 20,
    pastDepthMinimumPx: 140,
    pastDepthMaximumPx: 220,
    pastBlurMaximumPx: 4,
    mediumInterludeMinimumMs: 2_000,
    longInterludeMinimumMs: 8_000,
    interludeGapMs: 3_500,
    interludeAfterimageMs: 620,
    architectureCrossfadeMs: 1_100,
    contextCrossfadeMs: 400,
    contextReducedCrossfadeMs: 180,
    presenceShortGapMaximumMs: 1_600,
    presenceEntryDelayMs: 700,
    presenceFadeInMs: 700,
    presenceExitLeadMs: 1_000,
    presenceMinimumStableMs: 400,
    memorySlots: 6,
    visualOccupancyMinimum: 0.24,
    visualOccupancyTarget: 0.32,
    visualOccupancyMaximum: 0.38,
    ordinaryLargestGlyphRatioMaximum: 0.32,
    cropLargestGlyphRatioMaximum: 0.5,
    backgroundObjectMinimum: 4,
    backgroundObjectMaximum: 5,
    focusQuietZoneRatio: 0.34,
    quietCenterAlpha: 0.34,
    focusMaximumVw: 3.2,
    focusSceneStepMaximumVw: 1.6,
    focusYBaseRatio: 0.425,
    focusYVariationRatio: 0.03,
    focusYMinimumRatio: 0.41,
    focusYMaximumRatio: 0.44,
    albumCenterRatio: 0.455,
    albumCompactCenterRatio: 0.475,
    compactViewportHeightPx: 680,
    leftStageWidthRatio: 0.64,
    viewportFocusXRatio: 0.315,
    memoryProtectionXRatio: 0.5,
    memoryProtectionYRatio: 0.425,
    contextDriftRatio: 0.68,
    architecturalDriftRatio: 0.34,
  },
  depthStrength: {
    low: 0.54,
    standard: 0.84,
    high: 1,
  },
  spaceTransitionDuration: coverPassageMotionTokens.entryDuration,
  listeningSpaceSwitch: {
    exitMs: 180,
    enterMs: 300,
    reducedExitMs: 40,
    reducedEnterMs: 80,
  },
  playerExitDuration: coverPassageMotionTokens.exitDuration,
  playerExitReducedDuration: coverPassageMotionTokens.exitReducedDuration,
  playerTransitionStages: {
    lock: 0,
    detach: coverPassageMotionTokens.sharpApproachStart,
    medium: coverPassageMotionTokens.coverMediumOwnershipStart,
    atmosphere: coverPassageMotionTokens.atmosphereStart,
    sound: coverPassageMotionTokens.listeningSpaceStart,
    active: coverPassageMotionTokens.entryDuration,
  },
  playerExitStages: {
    medium: coverPassageMotionTokens.exitMediumStart,
    sharp: coverPassageMotionTokens.exitSharpStart,
    wall: coverPassageMotionTokens.exitWallHandoff,
  },
  fogCycleMinMs: 15_000,
  fogCycleMaxMs: 30_000,
} as const;

export const atmosphereProfiles: Record<
  AtmosphereSpace,
  AtmosphereProfile
> = {
  music: {
    ambient: 1,
    particles: 1,
    geometry: 0.78,
    depth: 1,
    soundReaction: 1,
    motion: 1,
    idlePresence: 0.28,
    centerGravity: 1,
    timeFlow: 0,
    readingReserve: 0.82,
  },
  flow: {
    ambient: 0.78,
    particles: 0.72,
    geometry: 0.68,
    depth: 0.76,
    soundReaction: 0.66,
    motion: 0.72,
    idlePresence: 0.54,
    centerGravity: 0,
    timeFlow: 1,
    readingReserve: 1,
  },
  typography: {
    ambient: 0.72,
    particles: 0.6,
    geometry: 0.64,
    depth: 0.72,
    soundReaction: 0.36,
    motion: 0.46,
    idlePresence: 0.54,
    centerGravity: 0,
    timeFlow: 0,
    readingReserve: 1,
  },
};
