import { useEffect, useRef } from "react";
import { motion } from "../../config/motion";
import { motionController } from "../../config/MotionController";
import { useReducedMotion } from "../../hooks/useReducedMotion";

type MarkKind = "square" | "dot" | "dash" | "arc" | "note";

interface AmbientMark {
  kind: MarkKind;
  x: number;
  y: number;
  size: number;
  opacity: number;
  blur: number;
  phase: number;
  cycleMs: number;
  driftX: number;
  driftY: number;
  angle: number;
  colorIndex: number;
  densityRank: number;
}

const defaultGrayscalePalette = [
  "#d8d8d8",
  "#a8a8a8",
  "#858585",
  "#ededed",
] as const;

const kinds: MarkKind[] = [
  "square",
  "dot",
  "dash",
  "arc",
  "square",
  "dot",
  "dash",
  "arc",
  "square",
  "dot",
  "dash",
  "note",
];

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

function createMarks(
  width: number,
  height: number,
  paletteSize: number,
): AmbientMark[] {
  const random = createRandom(2_703_199);
  const count = Math.max(
    22,
    Math.min(38, Math.round((width * height) / 34_000)),
  );

  return Array.from({ length: count }, (_, index) => {
    let x = random() * width;
    let y = random() * height;

    const insideQuietCenter =
      x > width * 0.25 &&
      x < width * 0.75 &&
      y > height * 0.18 &&
      y < height * 0.82;

    if (insideQuietCenter) {
      x =
        random() > 0.5
          ? width * (0.76 + random() * 0.2)
          : width * (0.04 + random() * 0.2);
      y += (random() - 0.5) * height * 0.12;
    }

    const kind =
      index === count - 1
        ? "note"
        : kinds[Math.floor(random() * (kinds.length - 1))];

    return {
      kind,
      x,
      y,
      size: kind === "note" ? 10 + random() * 4 : 3 + random() * 10,
      opacity: 0.06 + random() * 0.15,
      blur: 0.7 + random() * 3.2,
      phase: random() * Math.PI * 2,
      cycleMs:
        motion.ambientCycleMinMs +
        random() * (motion.ambientCycleMaxMs - motion.ambientCycleMinMs),
      driftX: 4 + random() * 13,
      driftY: 3 + random() * 10,
      angle: random() * Math.PI,
      colorIndex: Math.floor(random() * paletteSize),
      densityRank: (index + random()) / count,
    };
  });
}

function hexToRgb(color: string) {
  const hex = color.replace("#", "");
  const value = Number.parseInt(hex, 16);

  return {
    red: (value >> 16) & 255,
    green: (value >> 8) & 255,
    blue: value & 255,
  };
}

function mixColor(from: string, to: string, progress: number) {
  const start = hexToRgb(from);
  const end = hexToRgb(to);
  const channel = (fromValue: number, toValue: number) =>
    Math.round(fromValue + (toValue - fromValue) * progress);

  return `rgb(${channel(start.red, end.red)} ${channel(start.green, end.green)} ${channel(start.blue, end.blue)})`;
}

function mixPalette(
  from: readonly string[],
  to: readonly string[],
  progress: number,
) {
  return from.map((color, index) =>
    mixColor(color, to[index % to.length], progress),
  );
}

function drawMark(
  context: CanvasRenderingContext2D,
  mark: AmbientMark,
  color: string,
  elapsed: number,
  reducedMotion: boolean,
  responseLevel: number,
  beatOnly: boolean,
) {
  const response = reducedMotion ? 0 : clamp(responseLevel);
  const progress = reducedMotion || beatOnly
    ? 0
    : (elapsed / mark.cycleMs) * Math.PI * 2;
  const densityThreshold = 0.94;

  if (mark.densityRank > densityThreshold) {
    return;
  }

  const x =
    mark.x +
    Math.sin(progress + mark.phase) * mark.driftX +
    Math.cos(mark.angle) * mark.driftX * response * 0.42;
  const y =
    mark.y +
    Math.cos(progress * 0.72 + mark.phase) * mark.driftY +
    Math.sin(mark.angle) * mark.driftY * response * 0.38;
  const softness = clamp(mark.blur / 4, 0, 1);
  const scale = 1 + response * 0.16 + softness * 0.025;

  context.save();
  context.translate(x, y);
  context.rotate(
    mark.angle +
      (reducedMotion || beatOnly ? 0 : Math.sin(progress) * 0.035),
  );
  context.scale(scale, scale);
  context.globalAlpha =
    mark.opacity * (0.82 + response * 0.5) * (1 - softness * 0.12);
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.lineCap = "round";

  switch (mark.kind) {
    case "square":
      context.fillRect(
        -mark.size / 2,
        -mark.size / 2,
        mark.size,
        mark.size,
      );
      break;
    case "dot":
      context.beginPath();
      context.arc(0, 0, mark.size * 0.34, 0, Math.PI * 2);
      context.fill();
      break;
    case "dash":
      context.beginPath();
      context.moveTo(-mark.size, 0);
      context.lineTo(mark.size, 0);
      context.stroke();
      break;
    case "arc":
      context.beginPath();
      context.arc(0, 0, mark.size, Math.PI * 0.12, Math.PI * 1.42);
      context.stroke();
      break;
    case "note":
      context.font = `500 ${mark.size}px ui-sans-serif, system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("♪", 0, 0);
      break;
  }

  context.restore();
}

interface AmbientCanvasProps {
  palette?: readonly string[];
  paletteTransitionMs?: number;
  responseLevel?: number;
  beatOnly?: boolean;
  active?: boolean;
  suspended?: boolean;
}

interface PaletteTransition {
  from: readonly string[];
  to: readonly string[];
  startedAt: number;
  durationMs: number;
}

export function AmbientCanvas({
  palette = defaultGrayscalePalette,
  paletteTransitionMs = motion.ambientShiftMs,
  responseLevel = 0,
  beatOnly = false,
  active = true,
  suspended = false,
}: AmbientCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const responseRef = useRef(clamp(responseLevel));
  const renderedPaletteRef = useRef<readonly string[]>(palette);
  const paletteTransitionRef = useRef<PaletteTransition>({
    from: palette,
    to: palette,
    startedAt: performance.now(),
    durationMs: 0,
  });
  const renderOnceRef = useRef<(() => void) | null>(null);
  const syncActivityRef = useRef<(() => void) | null>(null);
  const shouldRenderRef = useRef(active && !suspended);
  shouldRenderRef.current = active && !suspended;

  useEffect(() => {
    syncActivityRef.current?.();
  }, [active, suspended]);

  useEffect(() => {
    responseRef.current = clamp(responseLevel);

    if (prefersReducedMotion) {
      renderOnceRef.current?.();
    }
  }, [prefersReducedMotion, responseLevel]);

  useEffect(() => {
    if (prefersReducedMotion) {
      renderedPaletteRef.current = palette;
      paletteTransitionRef.current = {
        from: palette,
        to: palette,
        startedAt: performance.now(),
        durationMs: 0,
      };
      renderOnceRef.current?.();
      return;
    }

    paletteTransitionRef.current = {
      from: renderedPaletteRef.current,
      to: palette,
      startedAt: performance.now(),
      durationMs: paletteTransitionMs,
    };
  }, [palette, paletteTransitionMs, prefersReducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    let marks: AmbientMark[] = [];
    let unsubscribeFrame: (() => void) | null = null;
    let startTime = performance.now();
    let surfaceWidth = 0;
    let surfaceHeight = 0;
    let surfacePixelRatio = 0;
    let pageVisible = document.visibilityState !== "hidden";

    const resize = (width: number, height: number) => {
      if (width <= 0 || height <= 0) {
        return;
      }

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

      if (
        Math.abs(width - surfaceWidth) < 0.5
        && Math.abs(height - surfaceHeight) < 0.5
        && pixelRatio === surfacePixelRatio
      ) {
        return;
      }

      surfaceWidth = width;
      surfaceHeight = height;
      surfacePixelRatio = pixelRatio;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      marks = createMarks(width, height, renderedPaletteRef.current.length);
      startTime = performance.now();
    };

    const draw = (now: number) => {
      if (!pageVisible || surfaceWidth <= 0 || surfaceHeight <= 0) {
        return;
      }

      const paletteTransition = paletteTransitionRef.current;
      const rawProgress =
        paletteTransition.durationMs === 0
          ? 1
          : clamp(
              (now - paletteTransition.startedAt) /
                paletteTransition.durationMs,
            );
      const paletteProgress = 1 - Math.pow(1 - rawProgress, 3);
      const activePalette =
        rawProgress >= 1
          ? paletteTransition.to
          : mixPalette(
              paletteTransition.from,
              paletteTransition.to,
              paletteProgress,
            );

      renderedPaletteRef.current = activePalette;
      if (rawProgress >= 1 && paletteTransition.durationMs !== 0) {
        paletteTransitionRef.current = {
          from: paletteTransition.to,
          to: paletteTransition.to,
          startedAt: now,
          durationMs: 0,
        };
      }

      context.clearRect(0, 0, surfaceWidth, surfaceHeight);

      for (const mark of marks) {
        drawMark(
          context,
          mark,
          activePalette[mark.colorIndex % activePalette.length],
          now - startTime,
          prefersReducedMotion,
          responseRef.current,
          beatOnly,
        );
      }
    };

    const stopRenderLoop = () => {
      unsubscribeFrame?.();
      unsubscribeFrame = null;
    };

    const startRenderLoop = () => {
      if (
        prefersReducedMotion
        || !pageVisible
        || !shouldRenderRef.current
        || unsubscribeFrame !== null
      ) {
        return;
      }

      unsubscribeFrame = motionController.subscribeFrame(draw);
    };

    const renderOnce = () => {
      if (!pageVisible || !shouldRenderRef.current) {
        return;
      }

      draw(performance.now());
      startRenderLoop();
    };

    const syncActivity = () => {
      if (!pageVisible || !shouldRenderRef.current) {
        stopRenderLoop();
        return;
      }
      renderOnce();
    };

    const handleVisibilityChange = () => {
      pageVisible = document.visibilityState !== "hidden";

      if (!pageVisible) {
        stopRenderLoop();
        return;
      }

      syncActivity();
    };

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }

      resize(entry.contentRect.width, entry.contentRect.height);

      if (prefersReducedMotion && pageVisible) {
        draw(performance.now());
      }
    });

    observer.observe(canvas);
    const initialBounds = canvas.getBoundingClientRect();
    resize(initialBounds.width, initialBounds.height);
    renderOnceRef.current = renderOnce;
    syncActivityRef.current = syncActivity;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    syncActivity();

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopRenderLoop();
      renderOnceRef.current = null;
      syncActivityRef.current = null;
    };
  }, [beatOnly, prefersReducedMotion]);

  return <canvas className="ambient-canvas" ref={canvasRef} aria-hidden="true" />;
}
