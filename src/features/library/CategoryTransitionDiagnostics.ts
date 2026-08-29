type NumericEntry = PerformanceEntry & Record<string, unknown>;

interface CategoryTransitionTrace {
  id: string;
  requestId: number | null;
  from: string;
  to: string;
  preparationCached: boolean;
  startedAt: number;
  endedAt: number | null;
  duration: number | null;
  phases: Array<{ name: string; at: number }>;
  reactCommits: number;
  domScans: Record<string, number>;
  frameCount: number;
  slowFrames: Array<{ at: number; delta: number }>;
  maximumFrameDelta: number;
  minimumInstantFps: number | null;
  clickToAnimationStart: number | null;
  animationStartCount: number;
  evidence: Array<{
    name: string;
    at: number;
    details: Record<string, unknown>;
  }>;
  performanceEntries: Array<Record<string, unknown>>;
}

interface ActiveTrace {
  record: CategoryTransitionTrace;
  animationFrame: number;
  previousFrameAt: number;
  observers: PerformanceObserver[];
}

let activeTrace: ActiveTrace | null = null;
let traceSequence = 0;

function diagnosticsEnabled() {
  return typeof window !== "undefined"
    && new URLSearchParams(window.location.search).has("categoryTrace");
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
  ]) {
    const value = source[key];
    if (typeof value === "number" || typeof value === "string") {
      serialized[key] = value;
    }
  }

  return serialized;
}

function observeEntries(trace: ActiveTrace) {
  if (typeof PerformanceObserver === "undefined") {
    return;
  }

  for (const type of ["long-animation-frame", "longtask", "resource"]) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) {
      continue;
    }
    const observer = new PerformanceObserver((list) => {
      if (activeTrace === trace) {
        trace.record.performanceEntries.push(
          ...list.getEntries().map(serializeEntry),
        );
      }
    });
    observer.observe({ type, buffered: true });
    trace.observers.push(observer);
  }
}

function sampleFrame(now: number, trace: ActiveTrace) {
  if (activeTrace !== trace) {
    return;
  }

  const delta = now - trace.previousFrameAt;
  trace.previousFrameAt = now;
  trace.record.frameCount += 1;
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
    sampleFrame(nextNow, trace)
  );
}

export function beginCategoryTransitionTrace(
  from: string,
  to: string,
  preparationCached: boolean,
  requestId: number | null = null,
) {
  if (!diagnosticsEnabled()) {
    return;
  }

  finishCategoryTransitionTrace("superseded");
  const startedAt = performance.now();
  const record: CategoryTransitionTrace = {
    id: `category-${++traceSequence}`,
    requestId,
    from,
    to,
    preparationCached,
    startedAt,
    endedAt: null,
    duration: null,
    phases: [{ name: "request", at: 0 }],
    reactCommits: 0,
    domScans: {},
    frameCount: 0,
    slowFrames: [],
    maximumFrameDelta: 0,
    minimumInstantFps: null,
    clickToAnimationStart: null,
    animationStartCount: 0,
    evidence: [],
    performanceEntries: [],
  };
  const trace: ActiveTrace = {
    record,
    animationFrame: 0,
    previousFrameAt: startedAt,
    observers: [],
  };
  activeTrace = trace;
  observeEntries(trace);
  trace.animationFrame = window.requestAnimationFrame((now) =>
    sampleFrame(now, trace)
  );
}

export function noteCategoryTransitionEvidence(
  name: string,
  readDetails: () => Record<string, unknown>,
) {
  if (!activeTrace) {
    return;
  }
  const at = performance.now() - activeTrace.record.startedAt;
  let details: Record<string, unknown>;
  try {
    details = readDetails();
  } catch (error) {
    details = {
      evidenceError: error instanceof Error ? error.message : String(error),
    };
  }
  activeTrace.record.evidence.push({ name, at, details });
  if (name === "animation-start") {
    activeTrace.record.animationStartCount += 1;
  }
}

export function markCategoryTransitionPhase(name: string) {
  if (!activeTrace) {
    return;
  }
  const at = performance.now() - activeTrace.record.startedAt;
  activeTrace.record.phases.push({ name, at });
  if (name === "animate-first-paint") {
    activeTrace.record.clickToAnimationStart = at;
  }
}

export function noteCategoryTransitionDomScan(name: string, count = 1) {
  if (!activeTrace) {
    return;
  }
  activeTrace.record.domScans[name] =
    (activeTrace.record.domScans[name] ?? 0) + count;
}

export function noteCategoryTransitionReactCommit() {
  if (activeTrace) {
    activeTrace.record.reactCommits += 1;
  }
}

export function finishCategoryTransitionTrace(finalPhase = "complete") {
  const trace = activeTrace;
  if (!trace) {
    return;
  }
  activeTrace = null;
  window.cancelAnimationFrame(trace.animationFrame);
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
  trace.record.minimumInstantFps = trace.record.maximumFrameDelta > 0
    ? 1_000 / trace.record.maximumFrameDelta
    : null;
  trace.record.performanceEntries = trace.record.performanceEntries.filter(
    (entry) => {
      const startTime = Number(entry.startTime ?? 0);
      const duration = Number(entry.duration ?? 0);
      return startTime + duration >= trace.record.startedAt - 20
        && startTime <= endedAt + 20;
    },
  );
  document.documentElement.dataset.categoryPerformanceTrace =
    JSON.stringify(trace.record);
}
