type HomeWallTransitionDirection = "home-wall" | "wall-home";
type PortalVisualOwner = "home" | "cover-medium" | "wall";

type NumericEntry = PerformanceEntry & Record<string, unknown>;

interface HomeWallGeometrySlotSample {
  position: "left" | "center" | "right";
  x: number;
  y: number;
  rectWidth: number;
  rectHeight: number;
  layoutWidth: number;
  inlineTransform: string;
  computedTransform: string;
  computedOpacity: string;
  coverOpacity: string;
  zIndex: string;
  boxShadow: string;
  filter: string;
  trackDim: string;
  focusScore: string;
  focusLayer: string;
}

interface HomeWallCoverOwnerSample {
  x: number;
  y: number;
  width: number;
  height: number;
  transform: string;
  opacity: string;
  boxShadow: string;
  border: string;
  padding: string;
  dataArt: string;
  currentSrc: string;
  objectFit: string;
  objectPosition: string;
}

interface HomeWallGeometrySample {
  name: string;
  at: number;
  view: string;
  slots: HomeWallGeometrySlotSample[];
  owners: {
    homeCenterOpacity: string;
    portalArtworkOpacity: string;
    portalSurfaceOpacity: string;
    returnVisualOwner: string;
    homeCenter: HomeWallCoverOwnerSample | null;
    portalShared: HomeWallCoverOwnerSample | null;
  };
}

interface HomeWallVisualSample {
  name: string;
  at: number;
  view: string;
  wallOwnerOpacity: string;
  wallCardOpacity: string;
  wallFieldOpacity: string;
  wallShadeOpacity: string;
  mediumOpacity: string;
  artworkOpacity: string;
  atmosphereOpacity: string;
  visualOwner: PortalVisualOwner;
  returnVisualOwner: string;
  homeSlotOpacity: Record<"left" | "center" | "right", string>;
}

interface HomeWallTransitionTrace {
  id: string;
  direction: HomeWallTransitionDirection;
  preparationCached: boolean;
  startedAt: number;
  endedAt: number | null;
  duration: number | null;
  phases: Array<{ name: string; at: number }>;
  reactCommits: number;
  reactCommitEvents: number[];
  musicWallCommits: number;
  musicWallCommitEvents: number[];
  layoutReads: Record<string, number>;
  layoutReadEvents: Array<{ name: string; at: number }>;
  frameCount: number;
  frameDeltas: number[];
  frameP95: number;
  slowFrames: Array<{ at: number; delta: number }>;
  maximumFrameDelta: number;
  performanceEntries: Array<Record<string, unknown>>;
  metrics: Array<{
    name: string;
    at: number;
    value: number | string | boolean;
  }>;
  animationStarts: Array<{
    name: string;
    target: string;
    at: number;
  }>;
  animationStartCounts: Record<string, number>;
  beginAttempts: number;
  counters: Record<string, number>;
  geometrySamples: HomeWallGeometrySample[];
  visualSamples: HomeWallVisualSample[];
  warnings: string[];
}

interface ActiveTrace {
  record: HomeWallTransitionTrace;
  animationFrame: number;
  previousFrameAt: number;
  observers: PerformanceObserver[];
  mutationObserver: MutationObserver | null;
}

let activeTrace: ActiveTrace | null = null;
let traceSequence = 0;
const traceHistory: HomeWallTransitionTrace[] = [];

export function homeWallDiagnosticsEnabled() {
  if (typeof window === "undefined") {
    return false;
  }

  return new URLSearchParams(window.location.search).has("wallTrace");
}

function serializeEntry(entry: PerformanceEntry) {
  const source = entry as NumericEntry;
  const serialized: Record<string, unknown> = {
    entryType: entry.entryType,
    name: entry.name,
    startTime: entry.startTime,
    duration: entry.duration,
  };

  for (const key of [
    "blockingDuration",
    "renderStart",
    "styleAndLayoutStart",
    "responseEnd",
    "initiatorType",
    "decodedBodySize",
    "transferSize",
    "value",
    "hadRecentInput",
  ]) {
    const value = source[key];
    if (
      typeof value === "number"
      || typeof value === "string"
      || typeof value === "boolean"
    ) {
      serialized[key] = value;
    }
  }

  const scripts = source.scripts;
  if (Array.isArray(scripts)) {
    serialized.scripts = scripts.map((script) => {
      const item = script as Record<string, unknown>;
      return {
        duration: item.duration,
        executionStart: item.executionStart,
        forcedStyleAndLayoutDuration: item.forcedStyleAndLayoutDuration,
        sourceURL: item.sourceURL,
        sourceFunctionName: item.sourceFunctionName,
        invoker: item.invoker,
      };
    });
  }

  return serialized;
}

function observeEntries(trace: ActiveTrace) {
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  const supported = PerformanceObserver.supportedEntryTypes;
  for (const type of [
    "long-animation-frame",
    "longtask",
    "layout-shift",
    "resource",
  ]) {
    if (!supported.includes(type)) {
      continue;
    }

    const observer = new PerformanceObserver((list) => {
      if (activeTrace !== trace) {
        return;
      }
      trace.record.performanceEntries.push(
        ...list.getEntries().map(serializeEntry),
      );
    });
    observer.observe({ type, buffered: true });
    trace.observers.push(observer);
  }
}

function renderFrame(now: number, trace: ActiveTrace) {
  if (activeTrace !== trace) {
    return;
  }

  const delta = now - trace.previousFrameAt;
  trace.previousFrameAt = now;
  trace.record.frameCount += 1;
  trace.record.frameDeltas.push(delta);
  trace.record.maximumFrameDelta = Math.max(
    trace.record.maximumFrameDelta,
    delta,
  );
  if (delta > 34) {
    trace.record.slowFrames.push({
      at: now - trace.record.startedAt,
      delta,
    });
  }
  trace.animationFrame = window.requestAnimationFrame((nextNow) =>
    renderFrame(nextNow, trace)
  );
}

export function beginHomeWallTransitionTrace(
  direction: HomeWallTransitionDirection,
  preparationCached: boolean,
) {
  if (!homeWallDiagnosticsEnabled()) {
    return;
  }
  if (activeTrace?.record.direction === direction) {
    activeTrace.record.beginAttempts += 1;
    return;
  }

  finishHomeWallTransitionTrace("superseded");
  const startedAt = performance.now();
  const record: HomeWallTransitionTrace = {
    id: `${direction}-${++traceSequence}`,
    direction,
    preparationCached,
    startedAt,
    endedAt: null,
    duration: null,
    phases: [{ name: "start", at: 0 }],
    reactCommits: 0,
    reactCommitEvents: [],
    musicWallCommits: 0,
    musicWallCommitEvents: [],
    layoutReads: {},
    layoutReadEvents: [],
    frameCount: 0,
    frameDeltas: [],
    frameP95: 0,
    slowFrames: [],
    maximumFrameDelta: 0,
    performanceEntries: [],
    metrics: [],
    animationStarts: [],
    animationStartCounts: {},
    beginAttempts: 1,
    counters: {},
    geometrySamples: [],
    visualSamples: [],
    warnings: [],
  };
  const trace: ActiveTrace = {
    record,
    animationFrame: 0,
    previousFrameAt: startedAt,
    observers: [],
    mutationObserver: null,
  };
  activeTrace = trace;
  const wallSurface = document.querySelector(
    ".library-home__portal-surface",
  );
  if (wallSurface && typeof MutationObserver !== "undefined") {
    trace.mutationObserver = new MutationObserver((records) => {
      if (activeTrace !== trace) {
        return;
      }
      const slotMutations = records.filter((record) =>
        record.type === "childList"
        || record.attributeName === "data-portal-participant"
      ).length;
      trace.record.counters["wall-surface-slot-mutations"] =
        (trace.record.counters["wall-surface-slot-mutations"] ?? 0)
        + slotMutations;
    });
    trace.mutationObserver.observe(wallSurface, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-portal-participant"],
    });
  }
  observeEntries(trace);
  trace.animationFrame = window.requestAnimationFrame((now) =>
    renderFrame(now, trace)
  );
}

export function activeHomeWallTransitionTraceId() {
  return activeTrace?.record.id ?? null;
}

export function markHomeWallTransitionPhase(
  name: string,
  expectedTraceId?: string | null,
) {
  if (
    !activeTrace
    || expectedTraceId !== undefined
      && activeTrace.record.id !== expectedTraceId
  ) {
    return;
  }
  activeTrace.record.phases.push({
    name,
    at: performance.now() - activeTrace.record.startedAt,
  });
}

export function noteHomeWallTransitionMetric(
  name: string,
  value: number | string | boolean,
  expectedTraceId?: string | null,
) {
  if (
    !activeTrace
    || expectedTraceId !== undefined
      && activeTrace.record.id !== expectedTraceId
  ) {
    return;
  }
  activeTrace.record.metrics.push({
    name,
    at: performance.now() - activeTrace.record.startedAt,
    value,
  });
}

export function incrementHomeWallTransitionCounter(
  name: string,
  amount = 1,
) {
  if (!activeTrace) {
    return;
  }
  activeTrace.record.counters[name] =
    (activeTrace.record.counters[name] ?? 0) + amount;
}

export function noteHomeWallAnimationStart(name: string, target: string) {
  if (!activeTrace) {
    return;
  }
  activeTrace.record.animationStarts.push({
    name,
    target,
    at: performance.now() - activeTrace.record.startedAt,
  });
  activeTrace.record.animationStartCounts[name] =
    (activeTrace.record.animationStartCounts[name] ?? 0) + 1;
}

export function captureHomeWallVisualSample(
  name: string,
  root: HTMLElement | null,
) {
  if (!activeTrace || !root) {
    return;
  }

  const opacityFor = (selector: string) => {
    const element = root.querySelector<HTMLElement>(selector);
    return element ? window.getComputedStyle(element).opacity : "";
  };
  const numericOpacity = (value: string) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const homeSlotOpacity = {
    left: opacityFor(
      '.library-home__shelf-plane[data-state="current"] '
        + '.library-home__cover-slot[data-position="left"]',
    ),
    center: opacityFor(
      '.library-home__shelf-plane[data-state="current"] '
        + '.library-home__cover-slot[data-position="center"]',
    ),
    right: opacityFor(
      '.library-home__shelf-plane[data-state="current"] '
        + '.library-home__cover-slot[data-position="right"]',
    ),
  };
  const wall = root.querySelector<HTMLElement>(".music-wall");
  const wallFieldOpacity = wall
    ? window.getComputedStyle(wall, "::before").opacity
    : "";
  const wallShadeOpacity = wall
    ? window.getComputedStyle(wall, "::after").opacity
    : "";
  const wallCardOpacity = Math.max(
    0,
    ...Array.from(
      root.querySelectorAll<HTMLElement>(
        '.music-wall__card-slot[data-portal-participant="true"]',
      ),
      (slot) => numericOpacity(window.getComputedStyle(slot).opacity),
    ),
  );
  const wallOwnerOpacity = opacityFor(".library-home__portal-surface");
  const mediumOpacity = opacityFor(".library-home__portal-medium-field");
  const artworkOpacity = opacityFor(".library-home__portal-artwork");
  const maximumHomeSlotOpacity = Math.max(
    ...Object.values(homeSlotOpacity).map(numericOpacity),
  );
  const effectiveHomeOpacity = maximumHomeSlotOpacity
    * (1 - numericOpacity(mediumOpacity));
  const effectiveWallOpacity = numericOpacity(wallOwnerOpacity)
    * wallCardOpacity;
  const numericArtworkOpacity = numericOpacity(artworkOpacity);
  const visualOwner: PortalVisualOwner =
    effectiveWallOpacity >= 0.35 && numericArtworkOpacity < 0.25
      ? "wall"
      : numericOpacity(mediumOpacity) >= 0.42
          || numericArtworkOpacity >= 0.25
        ? "cover-medium"
        : "home";

  const homeReadable = effectiveHomeOpacity >= 0.2;
  const artworkReadable = numericArtworkOpacity >= 0.2;
  const wallReadable = effectiveWallOpacity >= 0.2;
  if (homeReadable && wallReadable) {
    activeTrace.record.warnings.push(`scene-overlap:${name}`);
  }
  if (homeReadable && artworkReadable && wallReadable) {
    activeTrace.record.warnings.push(`triple-readable:${name}`);
  }
  if (!homeReadable && !artworkReadable && !wallReadable
      && numericOpacity(mediumOpacity) < 0.3) {
    activeTrace.record.warnings.push(`no-readable-owner:${name}`);
  }
  if (wallReadable && numericOpacity(wallShadeOpacity) < 0.7) {
    activeTrace.record.warnings.push(`wall-before-shade-ready:${name}`);
  }
  const isClosingSample = name.startsWith("closing-");
  const wallIsHidden = numericOpacity(wallOwnerOpacity) <= 0.02;
  const effectiveFieldOpacity = numericOpacity(wallOwnerOpacity)
    * numericOpacity(wallFieldOpacity);
  const effectiveShadeOpacity = numericOpacity(wallOwnerOpacity)
    * numericOpacity(wallShadeOpacity);
  if (
    isClosingSample
    && wallIsHidden
    && (
      effectiveFieldOpacity > 0.02
      || effectiveShadeOpacity > 0.02
    )
  ) {
    activeTrace.record.warnings.push(
      `wall-background-after-owner:${name}`,
    );
  }
  if (
    name === "closing-stable-before-commit"
    && (
      numericOpacity(wallOwnerOpacity) > 0.02
      || effectiveFieldOpacity > 0.02
      || effectiveShadeOpacity > 0.02
      || numericOpacity(mediumOpacity) > 0.02
      || numericArtworkOpacity > 0.02
    )
  ) {
    activeTrace.record.warnings.push(
      "visible-portal-residue-before-commit",
    );
  }

  noteHomeWallLayoutRead(`diagnostic-visual:${name}`);
  activeTrace.record.visualSamples.push({
    name,
    at: performance.now() - activeTrace.record.startedAt,
    view: root.dataset.view ?? "",
    wallOwnerOpacity,
    wallCardOpacity: String(wallCardOpacity),
    wallFieldOpacity,
    wallShadeOpacity,
    mediumOpacity,
    artworkOpacity,
    atmosphereOpacity: opacityFor(".cover-atmosphere"),
    visualOwner,
    returnVisualOwner: root.dataset.returnVisualOwner ?? "",
    homeSlotOpacity,
  });
}

export function captureHomeWallGeometrySample(
  name: string,
  root: HTMLElement | null,
) {
  if (!activeTrace || !root) {
    return;
  }

  const positions = ["left", "center", "right"] as const;
  const slots = positions.flatMap((position) => {
    const slot = root.querySelector<HTMLElement>(
      `.library-home__shelf-plane[data-state="current"] `
        + `.library-home__cover-slot[data-position="${position}"]`,
    );
    if (!slot) {
      return [];
    }
    const cover = slot.querySelector<HTMLElement>(".magazine-cover");
    const rect = slot.getBoundingClientRect();
    const slotStyle = window.getComputedStyle(slot);
    const coverStyle = cover ? window.getComputedStyle(cover) : null;
    return [{
      position,
      x: rect.x,
      y: rect.y,
      rectWidth: rect.width,
      rectHeight: rect.height,
      layoutWidth: Number.parseFloat(slotStyle.width) || 0,
      inlineTransform: slot.style.transform,
      computedTransform: slotStyle.transform,
      computedOpacity: slotStyle.opacity,
      coverOpacity: coverStyle?.opacity ?? "",
      zIndex: slotStyle.zIndex,
      boxShadow: coverStyle?.boxShadow ?? "",
      filter: coverStyle?.filter ?? "",
      trackDim: slotStyle.getPropertyValue("--track-dim"),
      focusScore: slot.dataset.focusScore ?? "",
      focusLayer: slot.dataset.focusLayer ?? "",
    }];
  });
  const homeCenter = root.querySelector<HTMLElement>(
    '.library-home__shelf-plane[data-state="current"] '
      + '.library-home__cover-slot[data-position="center"] '
      + ".magazine-cover",
  );
  const portalArtwork = root.querySelector<HTMLElement>(
    ".library-home__portal-artwork",
  );
  const portalSurface = root.querySelector<HTMLElement>(
    ".library-home__portal-surface",
  );
  const captureCover = (
    cover: HTMLElement | null,
  ): HomeWallCoverOwnerSample | null => {
    if (!cover) {
      return null;
    }
    const rect = cover.getBoundingClientRect();
    const style = window.getComputedStyle(cover);
    const image = cover.querySelector<HTMLImageElement>("img");
    const imageStyle = image ? window.getComputedStyle(image) : style;
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      transform: style.transform,
      opacity: style.opacity,
      boxShadow: style.boxShadow,
      border: style.border,
      padding: style.padding,
      dataArt: cover.dataset.art ?? "",
      currentSrc: image?.currentSrc ?? "",
      objectFit: imageStyle.objectFit,
      objectPosition: imageStyle.objectPosition,
    };
  };
  const homeCenterSample = captureCover(homeCenter);
  const portalSharedSample = captureCover(
    root.querySelector<HTMLElement>(
      ".library-home__portal-shared-cover .magazine-cover",
    ),
  );

  if (
    name.includes("93-5") || name.includes("94")
  ) {
    if (
      homeCenterSample
      && portalSharedSample
      && homeCenterSample.dataArt !== portalSharedSample.dataArt
    ) {
      activeTrace.record.warnings.push(`cover-data-art-mismatch:${name}`);
    }
    if (
      homeCenterSample?.currentSrc
      && portalSharedSample?.currentSrc
      && homeCenterSample.currentSrc !== portalSharedSample.currentSrc
    ) {
      activeTrace.record.warnings.push(`cover-current-src-mismatch:${name}`);
    }
  }

  noteHomeWallLayoutRead(`diagnostic-geometry:${name}`);
  activeTrace.record.geometrySamples.push({
    name,
    at: performance.now() - activeTrace.record.startedAt,
    view: root.dataset.view ?? "",
    slots,
    owners: {
      homeCenterOpacity: homeCenter
        ? window.getComputedStyle(homeCenter).opacity
        : "",
      portalArtworkOpacity: portalArtwork
        ? window.getComputedStyle(portalArtwork).opacity
        : "",
      portalSurfaceOpacity: portalSurface
        ? window.getComputedStyle(portalSurface).opacity
        : "",
      returnVisualOwner: root.dataset.returnVisualOwner ?? "",
      homeCenter: homeCenterSample,
      portalShared: portalSharedSample,
    },
  });
}

export function noteHomeWallLayoutRead(name: string) {
  if (!activeTrace) {
    return;
  }
  activeTrace.record.layoutReads[name] =
    (activeTrace.record.layoutReads[name] ?? 0) + 1;
  activeTrace.record.layoutReadEvents.push({
    name,
    at: performance.now() - activeTrace.record.startedAt,
  });
}

export function noteHomeWallReactCommit() {
  if (activeTrace) {
    activeTrace.record.reactCommits += 1;
    activeTrace.record.reactCommitEvents.push(
      performance.now() - activeTrace.record.startedAt,
    );
  }
}

export function noteHomeWallMusicWallCommit() {
  if (activeTrace) {
    activeTrace.record.musicWallCommits += 1;
    activeTrace.record.musicWallCommitEvents.push(
      performance.now() - activeTrace.record.startedAt,
    );
  }
}

export function finishHomeWallTransitionTrace(finalPhase = "complete") {
  const trace = activeTrace;
  if (!trace) {
    return;
  }
  activeTrace = null;
  window.cancelAnimationFrame(trace.animationFrame);
  trace.mutationObserver?.disconnect();
  trace.observers.forEach((observer) => {
    trace.record.performanceEntries.push(
      ...observer.takeRecords().map(serializeEntry),
    );
    observer.disconnect();
  });
  const endedAt = performance.now();
  trace.record.phases.push({
    name: finalPhase,
    at: endedAt - trace.record.startedAt,
  });
  trace.record.endedAt = endedAt;
  trace.record.duration = endedAt - trace.record.startedAt;
  if (trace.record.frameDeltas.length > 0) {
    const orderedDeltas = [...trace.record.frameDeltas].sort(
      (left, right) => left - right,
    );
    const percentileIndex = Math.min(
      orderedDeltas.length - 1,
      Math.max(0, Math.ceil(orderedDeltas.length * 0.95) - 1),
    );
    trace.record.frameP95 = orderedDeltas[percentileIndex] ?? 0;
  }
  trace.record.performanceEntries = trace.record.performanceEntries.filter(
    (entry) => {
      const startTime = Number(entry.startTime ?? 0);
      const duration = Number(entry.duration ?? 0);
      return startTime + duration >= trace.record.startedAt - 20
        && startTime <= endedAt + 20;
    },
  );
  if (trace.record.maximumFrameDelta > 50) {
    trace.record.warnings.push(
      `frame-gap-over-50ms:${trace.record.maximumFrameDelta.toFixed(1)}`,
    );
  }
  if (trace.record.performanceEntries.some((entry) =>
    (entry.entryType === "longtask" && Number(entry.duration ?? 0) > 50)
      || (entry.entryType === "long-animation-frame"
        && Number(entry.blockingDuration ?? 0) > 50)
  )) {
    trace.record.warnings.push("long-main-thread-task-over-50ms");
  }

  const detailSpeed = [...trace.record.metrics].reverse().find(
    (metric) => metric.name === "wall-detail-commit-speed",
  );
  if (
    trace.record.direction === "home-wall"
    && detailSpeed
    && Number(detailSpeed.value) === 0
  ) {
    trace.record.warnings.push("wall-committed-with-zero-speed");
  }

  if (trace.record.direction === "wall-home") {
    const settled = trace.record.geometrySamples.find(
      (sample) => sample.name === "visual-home-settled-paint-2",
    );
    const browsing = trace.record.geometrySamples.find(
      (sample) => sample.name === "browsing-paint-1",
    );
    if (settled && browsing) {
      for (const settledSlot of settled.slots) {
        const browsingSlot = browsing.slots.find(
          (slot) => slot.position === settledSlot.position,
        );
        if (!browsingSlot) {
          continue;
        }
        const geometryDelta = Math.max(
          Math.abs(settledSlot.x - browsingSlot.x),
          Math.abs(settledSlot.y - browsingSlot.y),
          Math.abs(settledSlot.rectWidth - browsingSlot.rectWidth),
          Math.abs(settledSlot.rectHeight - browsingSlot.rectHeight),
        );
        if (geometryDelta > 0.5) {
          trace.record.warnings.push(
            `home-slot-geometry-shift:${settledSlot.position}:`
              + geometryDelta.toFixed(2),
          );
        }
        if (
          settledSlot.computedTransform !== browsingSlot.computedTransform
        ) {
          trace.record.warnings.push(
            `home-slot-transform-shift:${settledSlot.position}`,
          );
        }
        if (settledSlot.boxShadow !== browsingSlot.boxShadow) {
          trace.record.warnings.push(
            `home-slot-shadow-shift:${settledSlot.position}`,
          );
        }
        if (settledSlot.filter !== browsingSlot.filter) {
          trace.record.warnings.push(
            `home-slot-filter-shift:${settledSlot.position}`,
          );
        }
        if (settledSlot.zIndex !== browsingSlot.zIndex) {
          trace.record.warnings.push(
            `home-slot-layer-shift:${settledSlot.position}`,
          );
        }
        if (
          Math.abs(
            Number.parseFloat(settledSlot.computedOpacity)
              - Number.parseFloat(browsingSlot.computedOpacity),
          ) > 0.01
        ) {
          trace.record.warnings.push(
            `home-slot-opacity-shift:${settledSlot.position}`,
          );
        }
      }
    }
  }

  traceHistory.push(trace.record);
  while (traceHistory.length > 4) {
    traceHistory.shift();
  }
  document.documentElement.dataset.homeWallPerformanceTrace =
    JSON.stringify(trace.record);
  document.documentElement.dataset.homeWallPerformanceTraceHistory =
    JSON.stringify(traceHistory);
}
