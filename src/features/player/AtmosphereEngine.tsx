import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { motion } from "../../config/motion";
import { motionController } from "../../config/MotionController";
import {
  usePerformanceTier,
  type PerformanceTier,
} from "../../hooks/useLowPerformanceMode";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type { ParticleQuality } from "../settings/playerPreferences";
import {
  atmosphereProfiles,
  motionTokens,
  type AtmosphereProfile,
  type AtmosphereSpace,
} from "./motionTokens";

type ParticleLayer = "glow" | "far" | "mid" | "near";
type ParticleKind = "dot" | "square" | "dash" | "slice" | "bracket";

export interface AtmosphereAudioResponse {
  low: number;
  mid: number;
  high: number;
  beat: number;
  isPlaying: boolean;
}

type AtmosphereStyle = CSSProperties &
  Record<
    | "--atmosphere-ambient"
    | "--atmosphere-particles"
    | "--atmosphere-geometry"
    | "--atmosphere-depth"
    | "--atmosphere-sound",
    number | string
  >;

interface PlayerParticle {
  x: number;
  y: number;
  size: number;
  opacity: number;
  angle: number;
  driftX: number;
  driftY: number;
  phase: number;
  kind: ParticleKind;
  tone: number;
  cluster: number;
}

interface ParticlePosition {
  x: number;
  y: number;
}

interface LayerSpec {
  layer: ParticleLayer;
  count: number;
  minimumSize: number;
  maximumSize: number;
  minimumOpacity: number;
  maximumOpacity: number;
}

const layerRanges: Record<
  ParticleLayer,
  Omit<LayerSpec, "layer" | "count">
> = {
  glow: {
    minimumSize: motionTokens.ambientFieldViewportRatio.minimum,
    maximumSize: motionTokens.ambientFieldViewportRatio.maximum,
    minimumOpacity: motionTokens.ambientFieldOpacity.minimum,
    maximumOpacity: motionTokens.ambientFieldOpacity.maximum,
  },
  far: {
    minimumSize: 1,
    maximumSize: 3,
    minimumOpacity: 0.018,
    maximumOpacity: 0.075,
  },
  mid: {
    minimumSize: 5,
    maximumSize: 30,
    minimumOpacity: 0.045,
    maximumOpacity: 0.18,
  },
  near: {
    minimumSize: 40,
    maximumSize: 120,
    minimumOpacity: 0.018,
    maximumOpacity: 0.058,
  },
};

const typographyLayerRanges: Record<
  Exclude<ParticleLayer, "glow">,
  Omit<LayerSpec, "layer" | "count">
> = {
  far: {
    minimumSize: 1,
    maximumSize: 3,
    minimumOpacity: 0.025,
    maximumOpacity: 0.08,
  },
  mid: {
    minimumSize: 4,
    maximumSize: 14,
    minimumOpacity: 0.04,
    maximumOpacity: 0.13,
  },
  near: {
    minimumSize: 18,
    maximumSize: 48,
    minimumOpacity: 0.018,
    maximumOpacity: 0.06,
  },
};

const layerOrder: ParticleLayer[] = ["glow", "far", "mid", "near"];
const particleLayerOrder = ["far", "mid", "near"] as const;
const musicClusterRatios = [0.42, 0.5, 0.58] as const;
const typographyClusterRatios = [0.08, 0.34, 0.6] as const;
const particleBlueprintCache = new Map<string, PlayerParticle[]>();
const particleBlueprintCacheLimit = 32;

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createRandom(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function getSpecs(
  tier: PerformanceTier,
  space: AtmosphereSpace,
): LayerSpec[] {
  const density = motionTokens.particleDensity[tier];
  const spaceScale = motionTokens.spaceParticleScale[space];

  return layerOrder.map((layer) => {
    const range = space === "typography" && layer !== "glow"
      ? typographyLayerRanges[layer]
      : layerRanges[layer];
    return {
      layer,
      count:
        layer === "glow"
          ? clamp(Math.round(density[layer] * spaceScale), 3, 5)
          : Math.max(1, Math.round(density[layer] * spaceScale)),
      ...range,
    };
  });
}

function positiveModulo(value: number, length: number) {
  return ((value % length) + length) % length;
}

function getLyricProtection(
  x: number,
  y: number,
  width: number,
  height: number,
  space: AtmosphereSpace,
) {
  const isCompact = width < 760;
  const isTypography = space === "typography" && !isCompact;
  const focusX = isTypography
    ? motionTokens.typographyPoster.viewportFocusXRatio
    : 0.5;
  const focusY = isTypography
    ? motionTokens.typographyPoster.focusYBaseRatio
    : isCompact ? 0.56 : 0.49;
  const horizontal =
    (x - width * focusX)
    / (width * (isCompact ? 0.5 : isTypography ? 0.34 : 0.46));
  const vertical =
    (y - height * focusY)
    / (height * (isCompact ? 0.34 : 0.25));
  const distance = Math.sqrt(horizontal * horizontal + vertical * vertical);
  const lyricProtection = clamp((distance - 0.62) / 0.48, 0.04, 1);

  if (!isTypography) {
    return lyricProtection;
  }

  const albumHorizontal = (x - width * 0.79) / (width * 0.24);
  const albumCenterRatio = height
      < motionTokens.typographyPoster.compactViewportHeightPx
    ? motionTokens.typographyPoster.albumCompactCenterRatio
    : motionTokens.typographyPoster.albumCenterRatio;
  const albumVertical = (
    y - height * albumCenterRatio
  ) / (height * 0.38);
  const albumDistance = Math.sqrt(
    albumHorizontal * albumHorizontal + albumVertical * albumVertical,
  );
  const albumProtection = clamp(
    (albumDistance - 0.72) / 0.42,
    0.12,
    1,
  );

  return Math.min(lyricProtection, albumProtection);
}

function createSpatialPosition(
  random: () => number,
  index: number,
  width: number,
  height: number,
  layer: ParticleLayer,
  space: AtmosphereSpace,
): ParticlePosition {
  if (layer === "glow") {
    const positions: Record<AtmosphereSpace, number[][]> = {
      music: [
        [0.5, 0.49],
        [0.12, 0.21],
        [0.88, 0.2],
        [0.18, 0.82],
        [0.84, 0.79],
      ],
      flow: [
        [0.12, 0.25],
        [0.88, 0.22],
        [0.16, 0.79],
        [0.86, 0.76],
        [0.5, 0.08],
      ],
      typography: [
        [0.06, 0.14],
        [0.34, 0.18],
        [0.1, 0.76],
        [0.58, 0.7],
        [0.61, 0.38],
      ],
    };
    const [x, y] = positions[space][index % positions[space].length];
    return { x: width * x, y: height * y };
  }

  if (layer === "near") {
    if (space === "typography") {
      const fromLeft = index % 2 === 0;
      return {
        x: width * (
          fromLeft
            ? -0.05 - random() * 0.06
            : 0.63 + random() * 0.045
        ),
        y: height * (0.04 + random() * 0.88),
      };
    }
    const fromLeft = index % 2 === 0;
    return {
      x: width * (
        fromLeft
          ? -0.06 - random() * 0.08
          : 1.06 + random() * 0.08
      ),
      y: height * (0.05 + random() * 0.9),
    };
  }

  if (space === "music") {
    const angle = random() * Math.PI * 2;
    const radius =
      Math.pow(
        random(),
        motionTokens.centerGravity.radialDensityPower,
      )
      * Math.min(width * 0.62, height * 0.86);
    return {
      x:
        width * motionTokens.centerGravity.focusX
        + Math.cos(angle) * radius,
      y:
        height * motionTokens.centerGravity.focusY
        + Math.sin(angle) * radius * 0.72,
    };
  }

  if (space === "flow") {
    const leftSide = index % 2 === 0;
    const outerBand = layer === "mid" ? 0.22 : 0.29;
    return {
      x: width * (
        leftSide
          ? 0.04 + random() * outerBand
          : 0.96 - random() * outerBand
      ),
      y: height * (0.04 + random() * 0.92),
    };
  }

  const band = typographyClusterRatios[index % typographyClusterRatios.length];
  const bandWidth = layer === "mid" ? 0.075 : 0.11;
  return {
    x: width * clamp(band + (random() - 0.5) * bandWidth, 0.01, 0.99),
    y: height * (0.04 + random() * 0.92),
  };
}

function createParticles(
  width: number,
  height: number,
  spec: LayerSpec,
  space: AtmosphereSpace,
): PlayerParticle[] {
  const seeds: Record<ParticleLayer, number> = {
    glow: 14_711,
    far: 19_911,
    mid: 82_117,
    near: 63_307,
  };
  const spaceSeed: Record<AtmosphereSpace, number> = {
    music: 0,
    flow: 10_037,
    typography: 20_081,
  };
  const random = createRandom(seeds[spec.layer] + spaceSeed[space]);

  return Array.from({ length: spec.count }, (_, index) => {
    const { x, y } = createSpatialPosition(
      random,
      index,
      width,
      height,
      spec.layer,
      space,
    );

    const size =
      spec.layer === "glow"
        ? clamp(
            width * (
              spec.minimumSize
              + random() * (spec.maximumSize - spec.minimumSize)
            ),
            motionTokens.ambientFieldSizePx.minimum,
            motionTokens.ambientFieldSizePx.maximum,
          )
        : spec.minimumSize
          + random() * (spec.maximumSize - spec.minimumSize);
    const kind: ParticleKind = space === "typography"
      ? spec.layer === "near" || spec.layer === "glow"
        ? "slice"
        : spec.layer === "far"
          ? index % 7 === 0
            ? "dash"
            : index % 5 === 0
              ? "square"
              : "dot"
          : index % 7 === 0
            ? "bracket"
            : index % 4 === 0
              ? "dot"
              : index % 3 === 0
                ? "square"
                : "dash"
      : spec.layer === "glow" || spec.layer === "near"
        ? "slice"
        : spec.layer === "far"
          ? index % 5 === 0
            ? "dash"
            : index % 3 === 0
              ? "square"
              : "dot"
          : index % 3 === 0
            ? "dash"
            : index % 4 === 0
              ? "slice"
              : "square";

    return {
      x,
      y,
      size,
      opacity:
        spec.minimumOpacity
        + random() * (spec.maximumOpacity - spec.minimumOpacity),
      angle: space === "typography" && spec.layer !== "glow"
        ? Math.PI / 2 + (random() - 0.5) * 0.18
        : random() * Math.PI * 2,
      driftX:
        space === "typography" && spec.layer !== "glow"
          ? 0.6 + random() * 1.4
          : spec.layer === "glow"
          ? 18 + random() * 34
          : spec.layer === "near"
            ? 44 + random() * 70
            : 5 + random() * 24,
      driftY:
        space === "typography" && spec.layer !== "glow"
          ? spec.layer === "far"
            ? 0.4 + random() * 0.6
            : spec.layer === "mid"
              ? 0.8 + random()
              : 0.2 + random() * 0.5
          : spec.layer === "glow"
          ? 12 + random() * 28
          : spec.layer === "near"
            ? 22 + random() * 46
            : 4 + random() * 18,
      phase: random() * Math.PI * 2,
      kind,
      tone: random(),
      cluster: index % 3,
    };
  });
}

function getParticleBlueprints(
  width: number,
  height: number,
  spec: LayerSpec,
  space: AtmosphereSpace,
) {
  const normalizedWidth = Math.max(1, Math.round(width));
  const normalizedHeight = Math.max(1, Math.round(height));
  const cacheKey = [
    normalizedWidth,
    normalizedHeight,
    spec.layer,
    spec.count,
    space,
  ].join(":");
  const cached = particleBlueprintCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const particles = createParticles(
    normalizedWidth,
    normalizedHeight,
    spec,
    space,
  );
  particleBlueprintCache.set(cacheKey, particles);

  if (particleBlueprintCache.size > particleBlueprintCacheLimit) {
    const oldestKey = particleBlueprintCache.keys().next().value;
    if (oldestKey) {
      particleBlueprintCache.delete(oldestKey);
    }
  }

  return particles;
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext("2d");
  context?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return context;
}

function drawGlowLayer(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  particles: PlayerParticle[],
  response: AtmosphereAudioResponse,
  time: number,
  motionAmount: number,
  theme: "dark" | "light",
  ambientIntensity: number,
) {
  for (let index = 0; index < particles.length; index += 1) {
    const particle = particles[index];
    const lowShift = response.low * motionAmount;
    const x =
      particle.x
      + Math.cos(time * 0.11 + particle.phase) * particle.driftX
      + Math.cos(particle.angle) * lowShift * 24;
    const y =
      particle.y
      + Math.sin(time * 0.09 + particle.phase) * particle.driftY
      + Math.sin(particle.angle) * lowShift * 18;
    const size =
      particle.size
      * (1 + Math.sin(time * 0.08 + particle.phase) * 0.035)
      * (1 + response.low * 0.08);
    const alpha = clamp(
      particle.opacity
        * ambientIntensity
        * (index === 0 ? 1.03 : 1)
        * (1 + response.low * 0.12),
      motionTokens.ambientFieldOpacity.minimum * ambientIntensity,
      motionTokens.ambientFieldOpacity.maximum * ambientIntensity,
    );
    const gradient = context.createRadialGradient(
      x,
      y,
      size * 0.04,
      x,
      y,
      size,
    );

    if (theme === "dark") {
      gradient.addColorStop(0, `rgba(246, 246, 242, ${alpha})`);
      gradient.addColorStop(0.46, `rgba(210, 210, 208, ${alpha * 0.4})`);
      gradient.addColorStop(1, "rgba(190, 190, 188, 0)");
    } else {
      gradient.addColorStop(0, `rgba(18, 18, 18, ${alpha * 0.72})`);
      gradient.addColorStop(0.46, `rgba(48, 48, 48, ${alpha * 0.3})`);
      gradient.addColorStop(1, "rgba(82, 82, 82, 0)");
    }
    context.fillStyle = gradient;
    context.fillRect(x - size, y - size, size * 2, size * 2);
  }
}

function drawParticleLayer(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  layer: Exclude<ParticleLayer, "glow">,
  particles: PlayerParticle[],
  response: AtmosphereAudioResponse,
  time: number,
  motionAmount: number,
  theme: "dark" | "light",
  space: AtmosphereSpace,
  profile: AtmosphereProfile,
  layerIntensity: number,
) {
  // Expensive Canvas filters are layer properties, not particle properties.
  // Applying them once preserves the near-field depth while avoiding dozens
  // of filter/shadow state changes and mid-layer shadow rasterizations per
  // frame on Paper Light.
  context.save();
  if (layer === "near") {
    context.filter = "blur(11px)";
    if (theme === "light") {
      context.shadowColor =
        `rgba(28, 28, 26, ${motionTokens.paperLight.particleShadowAlpha})`;
      context.shadowBlur = 5;
      context.shadowOffsetY = 3;
    }
  }

  for (const particle of particles) {
    const ambientSpeed =
      layer === "far"
        ? motionTokens.particleSpeed.far
        : layer === "mid"
          ? motionTokens.particleSpeed.mid
          : motionTokens.particleSpeed.near;
    const typographyMotion = space === "typography";
    let x = typographyMotion
      ? particle.x
        + Math.sin(time * 0.055 + particle.phase)
          * particle.driftX
          * motionAmount
      : particle.x
        + Math.cos(time * ambientSpeed + particle.phase)
          * particle.driftX
          * motionAmount;
    let y = typographyMotion
      ? positiveModulo(
          particle.y
            - time
              * particle.driftY
              * (response.isPlaying ? 1 : 0.18)
            + height * 0.06,
          height * 1.12,
        ) - height * 0.06
      : particle.y
        + Math.sin(time * ambientSpeed * 0.83 + particle.phase)
          * particle.driftY
          * motionAmount;

    if (space === "music" && layer !== "near") {
      const gravityBreath =
        (1
          - Math.cos(
            time * motionTokens.centerGravity.breatheCycle
            + particle.phase * 0.16,
          ))
        * 0.5;
      const expansion =
        gravityBreath
        * (
          layer === "mid"
            ? motionTokens.centerGravity.midExpansionPx
            : motionTokens.centerGravity.farExpansionPx
        )
        * motionAmount;
      const pulse =
        response.beat
        * (
          layer === "mid"
            ? motionTokens.centerGravity.beatMidPx
            : motionTokens.centerGravity.beatFarPx
        );
      const gravityStrength = profile.centerGravity;
      x +=
        Math.cos(particle.angle)
        * (expansion + pulse)
        * gravityStrength;
      y +=
        Math.sin(particle.angle)
        * (expansion + pulse)
        * 0.72
        * gravityStrength;
    }

    if (space === "flow" && layer !== "near") {
      const side = particle.x < width / 2 ? -1 : 1;
      const horizontalTimeField =
        Math.sin(time * 0.075 + particle.phase)
        * (
          layer === "mid"
            ? motionTokens.timeFlow.midDriftPx
            : motionTokens.timeFlow.farDriftPx
        )
        * motionAmount
        * profile.timeFlow;
      const verticalTimeField =
        Math.cos(time * 0.11 + particle.phase)
        * (
          layer === "mid"
            ? motionTokens.timeFlow.verticalMidPx
            : motionTokens.timeFlow.verticalFarPx
        )
        * motionAmount
        * profile.timeFlow;
      x += side * horizontalTimeField;
      y += verticalTimeField;
    }

    if (layer === "mid") {
      const aggregation = response.mid * 0.14;
      const typographyResponseRatio = space === "typography" ? 0.16 : 1;
      const targetX =
        space === "music"
          ? musicClusterRatios[particle.cluster] * width
          : space === "flow"
            ? (
              particle.x < width / 2
                ? motionTokens.timeFlow.leftAnchor
                : motionTokens.timeFlow.rightAnchor
            ) * width
            : typographyClusterRatios[particle.cluster] * width;
      x += (targetX - x) * aggregation;
      x += Math.cos(particle.angle)
        * response.low
        * particle.driftX
        * typographyResponseRatio;
      y += Math.sin(particle.angle)
        * response.low
        * particle.driftY
        * typographyResponseRatio;
      x += Math.cos(particle.phase)
        * response.beat
        * (space === "typography" ? 4 : 24);
      y += Math.sin(particle.phase)
        * response.beat
        * (space === "typography" ? 2.8 : 18);
    }

    if (layer === "near" && !typographyMotion) {
      const direction = particle.x < width / 2 ? 1 : -1;
      const pass =
        (0.5 + 0.5 * Math.sin(time * 0.055 + particle.phase))
        * particle.driftX;
      x += direction * pass * motionAmount;
      y += Math.sin(time * 0.1 + particle.phase) * 16 * motionAmount;
      x += direction
        * response.low
        * 34;
      x += direction
        * response.beat
        * 28;
    }

    const protection = Math.pow(
      getLyricProtection(x, y, width, height, space),
      profile.readingReserve,
    );

    if (layer === "near" && protection < 0.78) {
      continue;
    }

    const highFlash =
      layer === "far"
        ? Math.max(
            0,
            Math.sin(time * 8.6 + particle.phase) - 0.82,
          ) * response.high * 3.2
        : 0;
    const scale = space === "typography"
      ? 1
        + (layer === "mid" ? response.low * 0.018 : response.high * 0.01)
        + response.beat * 0.012
      : 1
        + (layer === "mid" ? response.low * 0.28 : response.high * 0.08)
        + response.beat * (layer === "mid" ? 0.16 : 0.06);
    const pauseFactor = response.isPlaying ? 1 : profile.idlePresence;
    const protectionFactor =
      layer === "far" ? 0.22 + protection * 0.78 : protection;
    const typographyStageFactor = space === "typography"
      ? clamp(
          (
            width * (motionTokens.typographyPoster.leftStageWidthRatio + 0.03)
            - x
          ) / (width * 0.09),
          0,
          1,
        )
      : 1;
    const themeLayerGain = theme === "dark"
      ? layer === "near"
        ? 1.75
        : layer === "mid"
          ? 1.38
          : 1.08
      : space === "typography"
        ? layer === "near"
          ? 1.25
          : layer === "mid"
            ? 1.18
            : 1.08
        : 1;
    const opacity =
      particle.opacity
      * themeLayerGain
      * pauseFactor
      * protectionFactor
      * typographyStageFactor
      * layerIntensity
      * (
        0.68
        + highFlash
        + (layer === "mid" ? response.mid * 0.82 : response.high * 0.28)
      );
    context.save();
    context.translate(x, y);
    context.rotate(
      typographyMotion
        ? particle.angle
        : particle.angle
          + (
            layer === "near"
              ? Math.sin(time * 0.04 + particle.phase) * 0.08 * motionAmount
              : 0
          ),
    );
    context.scale(scale, scale);
    context.globalAlpha = clamp(
      opacity,
      0,
      theme === "dark" ? 0.42 : 0.34,
    );
    const gray =
      theme === "dark"
        ? Math.round(132 + particle.tone * 112)
        : Math.round(
          motionTokens.paperLight.particleMinimumGray
          + particle.tone
          * (
            motionTokens.paperLight.particleMaximumGray
            - motionTokens.paperLight.particleMinimumGray
          ),
        );
    context.fillStyle = `rgb(${gray} ${gray} ${gray})`;
    context.strokeStyle = context.fillStyle;
    context.lineWidth = layer === "near" ? 1.4 : 1;
    if (particle.kind === "dot") {
      context.beginPath();
      context.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
      context.fill();
    } else if (particle.kind === "dash") {
      context.beginPath();
      context.moveTo(-particle.size, 0);
      context.lineTo(particle.size, 0);
      context.stroke();
    } else if (particle.kind === "slice") {
      context.fillRect(
        -particle.size * 0.7,
        -particle.size * 0.2,
        particle.size * 1.4,
        particle.size * 0.4,
      );
    } else if (particle.kind === "bracket") {
      context.beginPath();
      context.moveTo(-particle.size * 0.28, -particle.size * 0.55);
      context.lineTo(-particle.size * 0.28, particle.size * 0.55);
      context.lineTo(particle.size * 0.28, particle.size * 0.55);
      context.stroke();
    } else {
      context.fillRect(
        -particle.size / 2,
        -particle.size / 2,
        particle.size,
        particle.size,
      );
    }

    context.restore();
  }
  context.restore();
}

interface AtmosphereEngineProps {
  theme: "dark" | "light";
  quality?: ParticleQuality;
  intensity?: PerformanceTier;
  space: AtmosphereSpace;
  particlesEnabled?: boolean;
  active?: boolean;
  responseEnabled?: boolean;
  responseScale?: number;
  soundResponseActive?: boolean;
}

const performanceRank: Record<PerformanceTier, number> = {
  low: 0,
  standard: 1,
  high: 2,
};

export interface AtmospherePrewarmOptions {
  theme?: "dark" | "light";
  space?: AtmosphereSpace;
  tier?: PerformanceTier;
  width?: number;
  height?: number;
}

export function prewarmAtmosphereEngine({
  space = "music",
  tier = "standard",
  width =
    typeof window === "undefined" ? 1_440 : window.innerWidth,
  height =
    typeof window === "undefined" ? 900 : window.innerHeight,
}: AtmospherePrewarmOptions = {}) {
  for (const spec of getSpecs(tier, space)) {
    getParticleBlueprints(width, height, spec, space);
  }
}

export function AtmosphereEngine({
  theme,
  quality = "auto",
  intensity = "standard",
  space,
  particlesEnabled = true,
  active = true,
  responseEnabled = true,
  responseScale = 1,
  soundResponseActive = true,
}: AtmosphereEngineProps) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderOnceRef = useRef<(() => void) | null>(null);
  const syncActivityRef = useRef<(() => void) | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const detectedPerformanceTier = usePerformanceTier();
  const performanceTier: PerformanceTier =
    quality === "auto" ? detectedPerformanceTier : quality;
  const effectTier =
    performanceRank[intensity] < performanceRank[performanceTier]
      ? intensity
      : performanceTier;
  const specs = useMemo(
    () => getSpecs(effectTier, space),
    [effectTier, space],
  );
  const profile = atmosphereProfiles[space];
  const geometryScale = motionTokens.geometryDensity[effectTier];
  const depthScale = motionTokens.depthStrength[effectTier];
  const runtimeRef = useRef({
    active,
    responseEnabled,
    responseScale,
    soundResponseActive,
    theme,
    space,
    profile,
    particlesEnabled,
    depthScale,
    specs,
  });
  runtimeRef.current = {
    active,
    responseEnabled,
    responseScale,
    soundResponseActive,
    theme,
    space,
    profile,
    particlesEnabled,
    depthScale,
    specs,
  };

  useEffect(() => {
    syncActivityRef.current?.();
  }, [active]);

  useEffect(() => {
    renderOnceRef.current?.();
  }, [effectTier, particlesEnabled, space, theme]);

  useEffect(() => {
    const field = fieldRef.current;
    const canvas = canvasRef.current;

    if (!field || !canvas) {
      return;
    }

    let width = 0;
    let height = 0;
    let previousTime = performance.now();
    let hasWarmFrame = false;
    let particleConfigurationKey = "";
    let context: CanvasRenderingContext2D | null = null;
    let unsubscribeFrame: (() => void) | null = null;
    const particles: Record<ParticleLayer, PlayerParticle[]> = {
      glow: [],
      far: [],
      mid: [],
      near: [],
    };
    const smoothed: AtmosphereAudioResponse = {
      low: 0,
      mid: 0,
      high: 0,
      beat: 0,
      isPlaying: false,
    };

    const syncParticleConfiguration = () => {
      const runtime = runtimeRef.current;
      const nextConfigurationKey = [
        Math.round(width),
        Math.round(height),
        runtime.space,
        ...runtime.specs.map((spec) => `${spec.layer}:${spec.count}`),
      ].join(":");

      if (nextConfigurationKey === particleConfigurationKey) {
        return;
      }

      for (const spec of runtime.specs) {
        particles[spec.layer] = getParticleBlueprints(
          width,
          height,
          spec,
          runtime.space,
        );
      }
      particleConfigurationKey = nextConfigurationKey;
      hasWarmFrame = false;
    };

    const resize = () => {
      const bounds = field.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      context = prepareCanvas(canvas, width, height);
      particleConfigurationKey = "";
      syncParticleConfiguration();
    };

    const stopFrameLoop = () => {
      unsubscribeFrame?.();
      unsubscribeFrame = null;
    };

    const render = (now = performance.now()) => {
      const delta = Math.min(48, now - previousTime);
      previousTime = now;
      const runtime = runtimeRef.current;

      if (!runtime.active && hasWarmFrame) {
        stopFrameLoop();
        return;
      }

      const playbackTime = motionController.readPlaybackTime(now);
      const playbackClock = motionController.readPlaybackClock();
      const responseIsPlaying =
        playbackClock.isPlaying
        && runtime.responseEnabled
        && runtime.soundResponseActive;
      const beatPhase = (playbackTime % 560) / 560;
      const highPhase = (playbackTime % 210) / 210;
      const typographyBreath = runtime.space === "typography"
        ? 0.5 + Math.sin(playbackTime / 8_400) * 0.5
        : 0;
      const rawResponse: AtmosphereAudioResponse = {
        low:
          responseIsPlaying
              ? runtime.space === "typography"
                ? (0.04 + typographyBreath * 0.035) * runtime.responseScale
                : (
                  0.16 + (Math.sin(playbackTime / 940) + 1) * 0.17
                ) * runtime.responseScale
            : 0,
        mid:
          responseIsPlaying
            ? runtime.space === "typography"
              ? (0.018 + typographyBreath * 0.012) * runtime.responseScale
              : (
                  0.12
                  + (Math.sin(playbackTime / 430 + 1.2) + 1) * 0.2
                ) * runtime.responseScale
            : 0,
        high:
          responseIsPlaying
              ? runtime.space === "typography"
                ? 0
                : (
                  0.08 + Math.pow(1 - highPhase, 8) * 0.58
                ) * runtime.responseScale
            : 0,
        beat:
          responseIsPlaying
              ? runtime.space === "typography"
                ? 0
                : Math.max(0.06, Math.pow(1 - beatPhase, 5))
                  * runtime.responseScale
            : 0,
        isPlaying: responseIsPlaying,
      };
      const targetIsPlaying = prefersReducedMotion
        ? true
        : rawResponse.isPlaying;
      const targetLow = prefersReducedMotion
        ? 0
        : rawResponse.low * runtime.profile.soundReaction;
      const targetMid = prefersReducedMotion
        ? 0
        : rawResponse.mid * runtime.profile.soundReaction;
      const targetHigh = prefersReducedMotion
        ? 0
        : rawResponse.high * runtime.profile.soundReaction;
      const targetBeat = prefersReducedMotion
        ? 0
        : rawResponse.beat * runtime.profile.soundReaction;
      const damping = prefersReducedMotion
        ? 1
        : 1 - Math.pow(1 - motion.particleResponseDamping, delta / 16.67);

      smoothed.low +=
        ((targetIsPlaying ? targetLow : 0) - smoothed.low) * damping;
      smoothed.mid +=
        ((targetIsPlaying ? targetMid : 0) - smoothed.mid) * damping;
      smoothed.high +=
        ((targetIsPlaying ? targetHigh : 0) - smoothed.high) *
        damping;
      smoothed.beat = Math.max(
        targetIsPlaying ? targetBeat : 0,
        smoothed.beat * Math.pow(motion.particleBeatDecay, delta / 16.67),
      );
      smoothed.isPlaying = targetIsPlaying;

      const time = prefersReducedMotion ? 0 : now / 1_000;
      const motionAmount = prefersReducedMotion
        ? 0
        : targetIsPlaying
          ? runtime.profile.motion
          : 0.1 * runtime.profile.motion;

      if (!context) {
        return;
      }
      const drawingContext = context;
      syncParticleConfiguration();

      drawingContext.clearRect(0, 0, width, height);
      drawGlowLayer(
        drawingContext,
        width,
        height,
        particles.glow,
        smoothed,
        time,
        motionAmount,
        runtime.theme,
        runtime.profile.ambient,
      );

      if (runtime.particlesEnabled) {
        for (const layer of particleLayerOrder) {
          const layerIntensity =
            layer === "near"
              ? runtime.profile.depth * runtime.depthScale * 0.82
              : runtime.profile.particles
                * (layer === "mid" ? 0.96 : 0.9);
          drawParticleLayer(
            drawingContext,
            width,
            height,
            layer,
            particles[layer],
            smoothed,
            time,
            motionAmount,
            runtime.theme,
            runtime.space,
            runtime.profile,
            layerIntensity,
          );
        }
      }

      hasWarmFrame = true;
      if (!runtime.active) {
        stopFrameLoop();
      }
    };

    const startFrameLoop = () => {
      if (
        prefersReducedMotion
        || !runtimeRef.current.active
        || unsubscribeFrame !== null
      ) {
        return;
      }
      unsubscribeFrame = motionController.subscribeFrame(render);
    };

    const syncActivity = () => {
      hasWarmFrame = false;
      render();
      if (runtimeRef.current.active) {
        startFrameLoop();
      } else {
        stopFrameLoop();
      }
    };

    const observer = new ResizeObserver(() => {
      resize();
      hasWarmFrame = false;
      render();
    });

    observer.observe(field);
    resize();
    renderOnceRef.current = () => {
      hasWarmFrame = false;
      render();
    };
    syncActivityRef.current = syncActivity;
    syncActivity();

    return () => {
      observer.disconnect();
      stopFrameLoop();
      renderOnceRef.current = null;
      syncActivityRef.current = null;
    };
  }, [prefersReducedMotion]);

  return (
    <div
      className="atmosphere-engine"
      ref={fieldRef}
      data-space={space}
      data-performance-tier={effectTier}
      data-particles-enabled={particlesEnabled}
      style={{
        "--atmosphere-ambient": profile.ambient,
        "--atmosphere-particles": profile.particles,
        "--atmosphere-geometry": profile.geometry * geometryScale,
        "--atmosphere-depth": profile.depth * depthScale,
        "--atmosphere-sound": profile.soundReaction,
        "--typography-gaze-y":
          (motionTokens.typographyPoster.focusYBaseRatio * 100) + "%",
      } as AtmosphereStyle}
      aria-hidden="true"
    >
      <div className="atmosphere-engine__fog" data-layer="fog">
        <span />
        <span />
        <span />
      </div>
      <canvas
        ref={canvasRef}
        data-layer="atmosphere"
        data-count-glow={specs[0].count}
        data-count-far={specs[1].count}
        data-count-mid={specs[2].count}
        data-count-near={specs[3].count}
      />
      <div className="atmosphere-engine__geometry" data-layer="geometry">
        <span />
        <span />
        <span />
        <span />
        <span data-ambient-detail="true" />
        <span data-ambient-detail="true" />
      </div>
    </div>
  );
}
