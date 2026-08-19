import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { motionController } from "../../config/MotionController";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { useLanguage } from "../../i18n/LanguageContext";
import type { MessageKey } from "../../i18n/messages";
import type { ListeningSpaceComponentProps } from "../types";
import {
  alignImprintWordText,
  adaptAuralTrackToImprint,
  normalizeForRepeatKey,
  type ImprintFrame,
  type ImprintHistoryItem,
} from "./imprintTimeline";
import {
  commitPendingImprintPolicyPlan,
  createImprintPolicyPlan,
  stageImprintPolicyPlan,
  type ImprintPolicyPlan,
} from "./imprintPolicySession";
import "./imprint-space.css";

type ImprintVariableStyle = CSSProperties & Partial<Record<
  | "--imprint-history-column"
  | "--imprint-history-span"
  | "--imprint-history-row"
  | "--imprint-history-left"
  | "--imprint-history-top"
  | "--imprint-history-width"
  | "--imprint-history-opacity"
  | "--imprint-history-scale"
  | "--imprint-history-blur"
  | "--imprint-history-x"
  | "--imprint-history-y"
  | "--imprint-history-z"
  | "--imprint-copy-layer"
  | "--imprint-copy-offset"
  | "--imprint-proof-index"
  | "--imprint-retire-duration",
  string | number
>>;

const performanceLimits = {
  low: { frameIntervalMs: 33 },
  standard: { frameIntervalMs: 16 },
  high: { frameIntervalMs: 16 },
} as const;

const historySlots = [
  { left: 1, top: 12, width: 25, band: "upper" },
  { left: 3, top: 65, width: 25, band: "lower" },
  { left: 37, top: 12, width: 25, band: "upper" },
  { left: 36, top: 66, width: 27, band: "lower" },
  { left: 72, top: 13, width: 25, band: "upper" },
  { left: 71, top: 65, width: 26, band: "lower" },
  { left: 8, top: 21, width: 28, band: "upper" },
  { left: 9, top: 74, width: 27, band: "lower" },
  { left: 43, top: 22, width: 25, band: "upper" },
  { left: 43, top: 75, width: 24, band: "lower" },
  { left: 76, top: 22, width: 22, band: "upper" },
  { left: 76, top: 74, width: 22, band: "lower" },
  { left: 1, top: 30, width: 21, band: "upper" },
  { left: 1, top: 83, width: 22, band: "lower" },
  { left: 27, top: 30, width: 27, band: "upper" },
  { left: 28, top: 84, width: 28, band: "lower" },
  { left: 59, top: 31, width: 22, band: "upper" },
  { left: 61, top: 83, width: 21, band: "lower" },
  { left: 83, top: 30, width: 16, band: "upper" },
  { left: 84, top: 84, width: 15, band: "lower" },
] as const;

interface ImprintRetiringHistory {
  item: ImprintHistoryItem;
  slotIndex: number;
  durationMs: number;
}

function historyLimitForViewport(
  intensity: ListeningSpaceComponentProps["animationIntensity"],
  width: number,
  height: number,
) {
  const genuinelySmall = width < 620 || height < 480;
  if (genuinelySmall) {
    return { density: "compact" as const, limit: intensity === "high" ? 8 : 6 };
  }
  if (width < 800) {
    return { density: "compact" as const, limit: 8 };
  }
  if (height < 620) {
    return {
      density: "desktop" as const,
      limit: intensity === "low" ? 8 : intensity === "standard" ? 10 : 12,
    };
  }
  if (height < 700) {
    return {
      density: "desktop" as const,
      limit: intensity === "low" ? 8 : intensity === "standard" ? 12 : 16,
    };
  }
  const large = width >= 1360 && height >= 760;
  if (large) {
    return {
      density: "large" as const,
      limit: intensity === "low" ? 10 : intensity === "standard" ? 16 : 20,
    };
  }
  return {
    density: "desktop" as const,
    limit: intensity === "low" ? 8 : intensity === "standard" ? 14 : 18,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function detectLanguage(text: string) {
  const letters = Array.from(text.normalize("NFKC")).filter((character) =>
    /\p{L}/u.test(character)
  );
  const latin = letters.filter((character) => /[A-Za-z]/u.test(character));
  if (letters.length > 0 && latin.length / letters.length >= 0.55) {
    return "en";
  }
  return /[\u3040-\u30ff]/u.test(text) ? "ja" : "zh-CN";
}

function historyStyle(
  position: number,
  total: number,
  templateLineIndex: number,
  copyNumber: number,
  slotIndex: number,
): ImprintVariableStyle {
  const slot = historySlots[slotIndex];
  const distance = Math.max(0, total - position - 1);
  const recent = distance <= 2;
  const middle = distance <= Math.max(5, Math.floor(total * 0.55));
  const opacity = recent
    ? clamp(0.42 - distance * 0.05, 0.30, 0.42)
    : middle
      ? clamp(0.30 - (distance - 3) * 0.025, 0.18, 0.30)
      : clamp(0.18 - (distance - 6) * 0.014, 0.09, 0.18);
  const scale = recent
    ? clamp(1 - distance * 0.02, 0.96, 1)
    : middle
      ? clamp(0.96 - (distance - 3) * 0.012, 0.90, 0.96)
      : clamp(0.92 - (distance - 6) * 0.014, 0.84, 0.92);
  const blur = recent
    ? clamp(distance * 0.35, 0, 1)
    : middle
      ? clamp(0.6 + (distance - 3) * 0.18, 0.6, 1.5)
      : clamp(1.1 + (distance - 6) * 0.12, 1.1, 2);
  const copyOffset = Math.max(0, Math.min(2, copyNumber - 1));
  return {
    "--imprint-history-left": `${slot.left}%`,
    "--imprint-history-top": `${slot.top}%`,
    "--imprint-history-width": `${slot.width}%`,
    "--imprint-history-opacity": String(opacity),
    "--imprint-history-scale": String(scale),
    "--imprint-history-blur": `${blur}px`,
    "--imprint-history-x": "0px",
    "--imprint-history-y": "0px",
    "--imprint-history-z": `${-18 - distance * 6}px`,
    "--imprint-copy-offset": `${copyOffset}px`,
  };
}

function assignHistorySlots(
  history: readonly ImprintHistoryItem[],
  previousAssignments: ReadonlyMap<string, number>,
  previousRepeatAssignments: ReadonlyMap<string, number>,
  protectedSlots: ReadonlySet<number> = new Set<number>(),
) {
  const assignments = new Map(previousAssignments);
  const repeatAssignments = new Map(previousRepeatAssignments);
  const activeIds = new Set(history.map(({ id }) => id));
  for (const id of assignments.keys()) {
    if (!activeIds.has(id)) assignments.delete(id);
  }
  const occupied = new Set([...assignments.values(), ...protectedSlots]);
  const layout = history.map((item) => {
    const assigned = assignments.get(item.id);
    if (assigned !== undefined) {
      return { item, slotIndex: assigned };
    }
    const repeatedSlot = item.copyNumber > 1
      ? repeatAssignments.get(item.repeatKey)
      : undefined;
    const repeatSlotIsBlocked = repeatedSlot !== undefined && history.some(
      (other) =>
        other.id !== item.id
        && other.repeatKey !== item.repeatKey
        && assignments.get(other.id) === repeatedSlot,
    );
    const reusableRepeatSlot = repeatSlotIsBlocked ? undefined : repeatedSlot;
    const preferred = reusableRepeatSlot
      ?? Math.abs(item.templateLineIndex) % historySlots.length;
    let slotIndex = preferred;
    if (reusableRepeatSlot === undefined) {
      for (let offset = 0; offset < historySlots.length; offset += 1) {
        const candidate = (preferred + offset) % historySlots.length;
        if (!occupied.has(candidate)) {
          slotIndex = candidate;
          break;
        }
      }
    }
    occupied.add(slotIndex);
    assignments.set(item.id, slotIndex);
    if (!repeatAssignments.has(item.repeatKey)) {
      repeatAssignments.set(item.repeatKey, slotIndex);
    }
    return { item, slotIndex };
  });
  return { assignments, repeatAssignments, layout };
}

function createPolicyFingerprint(
  track: ListeningSpaceComponentProps["track"],
  durationMs: number,
  showOriginalLyrics: boolean,
  lyricsStatus: ListeningSpaceComponentProps["lyricsStatus"],
) {
  return JSON.stringify([
    track.id,
    Math.max(0, Math.round(durationMs)),
    showOriginalLyrics,
    lyricsStatus,
    track.lyrics.map((line) => [
      line.atMs,
      line.durationMs ?? "",
      line.endAtMs ?? "",
      line.text,
      line.translation ?? "",
      line.wordTimingRejection ?? "",
      line.words?.map((word) => [word.text, word.atMs, word.durationMs]) ?? [],
    ]),
  ]);
}

function policyLabelKey(plan: ImprintPolicyPlan): MessageKey {
  if (plan.timeline.renderPolicy !== "static") {
    return "space.imprint.mode.live";
  }
  if (plan.timeline.analysis.fallbackReason === "lyrics-loading") {
    return "space.imprint.mode.waiting";
  }
  return "space.imprint.mode.static";
}

function proofCode(value: string, fallback: string) {
  const compact = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleUpperCase("en-US");
  return Array.from(compact).slice(0, 6).join("") || fallback;
}

function proofTime(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${seconds}`;
}

function emptyMessageKey(
  status: ListeningSpaceComponentProps["lyricsStatus"],
): MessageKey {
  if (status === "loading") return "space.imprint.status.loading";
  if (status === "error") return "space.imprint.status.error";
  return "space.imprint.status.empty";
}

function ImprintListeningSpaceComponent({
  playbackSessionId,
  track,
  lyrics,
  activeIndex,
  elapsedMs,
  durationMs,
  isPlaying,
  lyricsStatus,
  showOriginalLyrics,
  showTranslation,
  animationIntensity,
  onSeek,
}: ListeningSpaceComponentProps) {
  const { t } = useLanguage();
  const reducedMotion = useReducedMotion();
  const normalizedTrack = useMemo(
    () => ({ ...track, lyrics: lyrics.lines }),
    [lyrics.lines, track],
  );
  const candidateTrack = useMemo(
    () =>
      adaptAuralTrackToImprint(
        normalizedTrack,
        durationMs,
        showOriginalLyrics,
        lyricsStatus,
      ),
    [durationMs, lyricsStatus, normalizedTrack, showOriginalLyrics],
  );
  const policyFingerprint = useMemo(
    () => createPolicyFingerprint(
      normalizedTrack,
      durationMs,
      showOriginalLyrics,
      lyricsStatus,
    ),
    [durationMs, lyricsStatus, normalizedTrack, showOriginalLyrics],
  );
  const candidatePlan = useMemo(
    () => createImprintPolicyPlan(candidateTrack, policyFingerprint),
    [candidateTrack, policyFingerprint],
  );
  const [policyPlan, setPolicyPlan] = useState<ImprintPolicyPlan>(() =>
    stageImprintPolicyPlan(playbackSessionId, candidatePlan, elapsedMs)
  );
  const policyPlanRef = useRef(policyPlan);
  policyPlanRef.current = policyPlan;
  const imprintTrack = policyPlan.track;
  const timeline = policyPlan.timeline;
  const limits = performanceLimits[animationIntensity];
  const rootRef = useRef<HTMLDivElement>(null);
  const [historyDensity, setHistoryDensity] = useState(() =>
    historyLimitForViewport(
      animationIntensity,
      typeof window === "undefined" ? 1280 : window.innerWidth,
      typeof window === "undefined" ? 720 : window.innerHeight,
    )
  );
  const [frame, setFrame] = useState<ImprintFrame>(() =>
    timeline.derive(
      elapsedMs,
      { historyLimit: historyDensity.limit },
      activeIndex,
    )
  );
  const currentLineRef = useRef<HTMLParagraphElement>(null);
  const translationRef = useRef<HTMLParagraphElement>(null);
  const residueLineRef = useRef<HTMLParagraphElement>(null);
  const tokenNodesRef = useRef(new Map<string, HTMLSpanElement>());
  const tokenProgressRef = useRef(new Map<string, number>());
  const frameRef = useRef(frame);
  const activeLineIndexRef = useRef(frame.activeLineIndex);
  const lastPaintAtRef = useRef(0);
  const lastPlaybackPositionRef = useRef(elapsedMs);
  const historySlotMapRef = useRef(new Map<string, number>());
  const repeatSlotMapRef = useRef(new Map<string, number>());
  const historySessionRef = useRef(playbackSessionId);
  const enteringHistoryIdRef = useRef<string | undefined>(undefined);
  const retiringTimerRef = useRef<number | undefined>(undefined);
  const [retiringHistory, setRetiringHistory] = useState<ImprintRetiringHistory>();
  const rootPaintRef = useRef({
    dataset: {} as Record<string, string>,
    progress: -1,
    introStrength: -1,
  });

  const registerToken = useCallback(
    (tokenId: string, element: HTMLSpanElement | null) => {
      if (element) tokenNodesRef.current.set(tokenId, element);
      else tokenNodesRef.current.delete(tokenId);
    },
    [],
  );

  const rebuild = useCallback(
    (positionMs: number, allowPlaybackBoundaryEffects = false) => {
      const previousFrame = frameRef.current;
      const nextFrame = timeline.derive(positionMs, {
        historyLimit: historyDensity.limit,
      }, activeIndex);
      if (historySessionRef.current !== playbackSessionId) {
        historySlotMapRef.current.clear();
        repeatSlotMapRef.current.clear();
        historySessionRef.current = playbackSessionId;
      }
      const nextHistoryIds = new Set(nextFrame.history.map(({ id }) => id));
      const evictedItem = allowPlaybackBoundaryEffects
        ? previousFrame.history.find(({ id }) => !nextHistoryIds.has(id))
        : undefined;
      const evictedSlot = evictedItem
        ? historySlotMapRef.current.get(evictedItem.id)
        : undefined;
      const slotResult = assignHistorySlots(
        nextFrame.history,
        historySlotMapRef.current,
        repeatSlotMapRef.current,
        evictedSlot === undefined ? undefined : new Set([evictedSlot]),
      );
      historySlotMapRef.current = slotResult.assignments;
      repeatSlotMapRef.current = slotResult.repeatAssignments;
      const completedItem = allowPlaybackBoundaryEffects && previousFrame.activeLine
        ? nextFrame.history.find(({ line }) => line.id === previousFrame.activeLine?.id)
        : undefined;
      enteringHistoryIdRef.current = completedItem?.id;
      if (evictedItem && evictedSlot !== undefined) {
        const duration = reducedMotion ? 160 : 440;
        if (retiringTimerRef.current !== undefined) {
          window.clearTimeout(retiringTimerRef.current);
        }
        setRetiringHistory({ item: evictedItem, slotIndex: evictedSlot, durationMs: duration });
        retiringTimerRef.current = window.setTimeout(() => {
          setRetiringHistory(undefined);
          retiringTimerRef.current = undefined;
        }, duration);
      } else if (!allowPlaybackBoundaryEffects && retiringTimerRef.current !== undefined) {
        window.clearTimeout(retiringTimerRef.current);
        retiringTimerRef.current = undefined;
        setRetiringHistory(undefined);
      }
      frameRef.current = nextFrame;
      activeLineIndexRef.current = nextFrame.activeLineIndex;
      tokenProgressRef.current.clear();
      setFrame(nextFrame);
      return nextFrame;
    },
    [
      activeIndex,
      historyDensity.limit,
      playbackSessionId,
      reducedMotion,
      timeline,
    ],
  );

  useLayoutEffect(() => () => {
    if (retiringTimerRef.current !== undefined) {
      window.clearTimeout(retiringTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const update = () => {
      const next = historyLimitForViewport(
        animationIntensity,
        window.innerWidth,
        window.innerHeight,
      );
      setHistoryDensity((current) =>
        current.density === next.density && current.limit === next.limit
          ? current
          : next
      );
    };
    update();
    window.addEventListener("resize", update, { passive: true });
    return () => window.removeEventListener("resize", update);
  }, [animationIntensity]);

  const commitPolicyPlan = useCallback((nextPlan: ImprintPolicyPlan) => {
    if (policyPlanRef.current.fingerprint === nextPlan.fingerprint) return;
    policyPlanRef.current = nextPlan;
    tokenProgressRef.current.clear();
    setPolicyPlan(nextPlan);
  }, []);

  useLayoutEffect(() => {
    const positionMs = motionController.readPlaybackTime(performance.now());
    const committed = stageImprintPolicyPlan(
      playbackSessionId,
      candidatePlan,
      positionMs,
    );
    commitPolicyPlan(committed);
  }, [candidatePlan, commitPolicyPlan, playbackSessionId]);

  const paint = useCallback(
    (positionMs: number, activeFrame: ImprintFrame) => {
      for (const token of activeFrame.currentTokens) {
        const element = tokenNodesRef.current.get(token.id);
        if (!element) continue;
        const availableMs = Math.max(1, token.endMs - token.startMs);
        const pressDuration = reducedMotion
          ? Math.min(availableMs, 120)
          : Math.min(
              availableMs,
              clamp(
                availableMs * 0.72,
                token.timingSource === "provider" ? 120 : 48,
                token.timingSource === "provider" ? 280 : 240,
              ),
            );
        const progress = clamp(
          (positionMs - token.startMs) / pressDuration,
          0,
          1,
        );
        const previous = tokenProgressRef.current.get(token.id);
        if (
          previous === progress
          || Math.abs((previous ?? -1) - progress) < 0.008
        ) {
          continue;
        }
        tokenProgressRef.current.set(token.id, progress);
        const eased = progress * (2 - progress);
        const noDepth = reducedMotion || animationIntensity === "low";
        const waiting = positionMs < token.startMs;
        element.style.setProperty(
          "--imprint-token-opacity",
          String(waiting ? 0 : 0.12 + 0.88 * eased),
        );
        element.style.setProperty(
          "--imprint-token-blur",
          `${noDepth || waiting ? 0 : (1 - eased) * 5}px`,
        );
        element.style.setProperty(
          "--imprint-token-z",
          `${noDepth || waiting ? 0 : (1 - eased) * 8}px`,
        );
        element.style.setProperty(
          "--imprint-token-compression",
          String(noDepth || waiting ? 1 : 0.97 + 0.03 * eased),
        );
        element.dataset.state =
          progress <= 0
            ? "future"
            : progress >= 1
              ? "imprinted"
              : "imprinting";
      }

      const lineExitProgress = activeFrame.activeLine
        ? clamp(
            ((reducedMotion ? 120 : 160)
              - Math.max(0, activeFrame.activeLine.endMs - positionMs))
              / (reducedMotion ? 120 : 160),
            0,
            1,
          )
        : 1;
      const lineElement = currentLineRef.current;
      if (lineElement && activeFrame.activeLine) {
        lineElement.style.opacity = String(1 - lineExitProgress);
        lineElement.style.filter = reducedMotion
          ? "none"
          : `blur(${lineExitProgress * 1.5}px)`;
        lineElement.style.transform = "none";
      }

      const translationElement = translationRef.current;
      if (translationElement && activeFrame.activeLine) {
        const revealStartMs = activeFrame.currentTokens[0]?.startMs
          ?? activeFrame.activeLine.startMs;
        const translationProgress = clamp(
          (positionMs - revealStartMs) / (reducedMotion ? 100 : 180),
          0,
          1,
        );
        translationElement.style.opacity = String(
          translationProgress * 0.72 * (1 - lineExitProgress),
        );
      }

      const residueElement = residueLineRef.current;
      const residue = !activeFrame.activeLine
        ? activeFrame.history.at(-1)?.line
        : undefined;
      if (residueElement && residue) {
        const ageMs = Math.max(0, positionMs - residue.endMs);
        const progress = clamp(ageMs / 1_800, 0, 1);
        residueElement.style.opacity = String(
          0.08 + 0.18 * (1 - progress),
        );
        residueElement.style.filter = reducedMotion
          ? "none"
          : `blur(${1.5 + progress * 2.5}px)`;
        residueElement.style.transform = reducedMotion
          ? "none"
          : `translate3d(0,${-3 * progress}px,${-18 - 18 * progress}px) scale(${1 - 0.035 * progress})`;
      }

      const root = rootRef.current;
      if (root) {
        const stagePhase = activeFrame.activeLine
          ? "active"
          : activeFrame.history.length > 0
            ? "gap"
            : timeline.firstLineStartMs !== undefined
              ? "intro"
              : "static";
        const nextDataset = {
          activeLineIndex: String(activeFrame.activeLineIndex),
          timingMode: activeFrame.timingMode,
          activeTimingMode: activeFrame.timingMode,
          renderPolicy: activeFrame.renderPolicy,
          lineRenderPolicy: activeFrame.lineRenderPolicy,
          stagePhase,
          imprintCount: String(activeFrame.imprintCount),
        };
        const rootPaint = rootPaintRef.current;
        for (const [key, value] of Object.entries(nextDataset)) {
          if (rootPaint.dataset[key] === value) continue;
          rootPaint.dataset[key] = value;
          root.dataset[key] = value;
        }
        const visualProgress = Math.round(
          clamp(positionMs / Math.max(1, durationMs), 0, 1) * 500,
        ) / 500;
        if (rootPaint.progress !== visualProgress) {
          rootPaint.progress = visualProgress;
          root.style.setProperty(
            "--imprint-progress",
            String(visualProgress),
          );
        }
        const firstLineStartMs = timeline.firstLineStartMs;
        const introStrength = firstLineStartMs === undefined
          ? 1
          : positionMs < firstLineStartMs
            ? 1
            : Math.max(
                0.34,
                1 - (positionMs - firstLineStartMs) / 2_200,
              );
        const visualIntroStrength = Math.round(introStrength * 100) / 100;
        if (rootPaint.introStrength !== visualIntroStrength) {
          rootPaint.introStrength = visualIntroStrength;
          root.style.setProperty(
            "--imprint-intro-strength",
            String(visualIntroStrength),
          );
        }
      }
    },
    [animationIntensity, durationMs, reducedMotion, timeline.firstLineStartMs],
  );

  useLayoutEffect(() => {
    const previousPosition = lastPlaybackPositionRef.current;
    const pending = commitPendingImprintPolicyPlan(
      playbackSessionId,
      elapsedMs,
      previousPosition,
      true,
    );
    lastPlaybackPositionRef.current = elapsedMs;
    if (pending) {
      commitPolicyPlan(pending);
      return;
    }
    const nextFrame = rebuild(elapsedMs);
    paint(elapsedMs, nextFrame);
  }, [
    activeIndex,
    commitPolicyPlan,
    elapsedMs,
    paint,
    playbackSessionId,
    rebuild,
  ]);

  useLayoutEffect(() => {
    paint(frame.elapsedMs, frame);
  }, [frame, paint, showTranslation]);

  useLayoutEffect(() => {
    if (!isPlaying) return;
    lastPaintAtRef.current = 0;
    const render = (now: number) => {
      if (
        now - lastPaintAtRef.current < limits.frameIntervalMs
        && lastPaintAtRef.current > 0
      ) {
        return;
      }
      lastPaintAtRef.current = now;
      const positionMs = motionController.readPlaybackTime(now);
      const previousPositionMs = lastPlaybackPositionRef.current;
      lastPlaybackPositionRef.current = positionMs;
      const pending = commitPendingImprintPolicyPlan(
        playbackSessionId,
        positionMs,
        previousPositionMs,
      );
      if (pending) {
        commitPolicyPlan(pending);
        return;
      }
      let activeFrame = frameRef.current;
      if (activeIndex !== activeLineIndexRef.current) {
        activeFrame = rebuild(positionMs, true);
      }
      paint(positionMs, activeFrame);
    };
    const unsubscribe = motionController.subscribeFrame(render);
    render(performance.now());
    return unsubscribe;
  }, [
    activeIndex,
    commitPolicyPlan,
    isPlaying,
    limits.frameIntervalMs,
    paint,
    playbackSessionId,
    rebuild,
  ]);

  const gapResidue = frame.activeLine ? undefined : frame.history.at(-1);
  const activeRepeatKey =
    frame.activeLine && frame.currentCopyNumber > 1
      ? normalizeForRepeatKey(frame.activeLine.text)
      : undefined;
  const activeCopies = activeRepeatKey
    ? frame.history
        .filter(({ repeatKey }) => repeatKey === activeRepeatKey)
        .slice(-2)
    : [];
  const visibleHistory = frame.history;
  const historySlotResult = useMemo(
    () => assignHistorySlots(
      frame.history,
      historySessionRef.current === playbackSessionId
        ? historySlotMapRef.current
        : new Map<string, number>(),
      historySessionRef.current === playbackSessionId
        ? repeatSlotMapRef.current
        : new Map<string, number>(),
    ),
    [frame.history, playbackSessionId],
  );
  useLayoutEffect(() => {
    if (historySessionRef.current !== playbackSessionId) {
      tokenProgressRef.current.clear();
      repeatSlotMapRef.current.clear();
      historySessionRef.current = playbackSessionId;
    }
    historySlotMapRef.current = historySlotResult.assignments;
    repeatSlotMapRef.current = historySlotResult.repeatAssignments;
  }, [
    historySlotResult.assignments,
    historySlotResult.repeatAssignments,
    playbackSessionId,
  ]);
  const visibleHistoryIds = useMemo(
    () => new Set(visibleHistory.map(({ id }) => id)),
    [visibleHistory],
  );
  const historyLayout = historySlotResult.layout.filter(({ item }) =>
    visibleHistoryIds.has(item.id)
  );
  const alignedTokenText = frame.activeLine
    ? alignImprintWordText(frame.activeLine.text, frame.currentTokens)
    : undefined;
  const estimatedTokenText = frame.timingMode === "word-estimated"
    ? frame.currentTokens.map(({ text }) => text)
    : undefined;
  const useTokenNodes = Boolean(
    frame.activeLine
    && frame.lineRenderPolicy !== "static"
    && frame.currentTokens.length > 0
    && (
      estimatedTokenText?.length === frame.currentTokens.length
      || alignedTokenText?.length === frame.currentTokens.length
    )
  );
  const tokenText = useTokenNodes
    ? estimatedTokenText ?? alignedTokenText ?? frame.currentTokens.map(({ text }) => text)
    : [];
  const currentText = frame.activeLine?.text ?? "";
  const albumProof = proofCode(track.album, "ALBUM");
  const titleProof = Array.from(track.title).slice(0, 2).join("");

  return (
    <div
      className="immersive-player__lyrics imprint-listening-space"
      data-listening-space="imprint"
      data-playing={isPlaying}
      data-active-line-index={frame.activeLineIndex}
      data-timing-mode={frame.timingMode}
      data-track-timing-mode={frame.trackTimingMode}
      data-render-policy={frame.renderPolicy}
      data-line-render-policy={frame.lineRenderPolicy}
      data-active-timing-mode={frame.timingMode}
      data-timing-source={frame.activeLine?.timingSource ?? "static"}
      data-active-fallback-reason={frame.activeLine?.fallbackReason ?? "none"}
      data-word-coverage={timeline.analysis.wordCoverage.toFixed(3)}
      data-exact-line-count={timeline.analysis.exactLineCount}
      data-line-only-count={timeline.analysis.lineOnlyCount}
      data-estimated-line-count={timeline.analysis.estimatedLineCount}
      data-fallback-reason={timeline.analysis.fallbackReason}
      data-word-rejections={timeline.analysis.rejections
        .map(({ sourceIndex, reason }) => `${sourceIndex}:${reason}`)
        .join("|")}
      data-compacted-tokens={frame.compactedTokens}
      data-performance-tier={animationIntensity}
      data-history-density={historyDensity.density}
      data-history-limit={historyDensity.limit}
      data-reduced-motion={reducedMotion}
      data-imprint-count={frame.imprintCount}
      data-lyrics-status={imprintTrack.lyricsStatus}
      ref={rootRef}
      aria-label={t("space.imprint.aria")}
    >
      <div className="imprint-listening-space__texture" aria-hidden="true" />
      <header className="imprint-listening-space__masthead">
        <p className="imprint-listening-space__identity">
          SPACE 04 — IMPRINT
          <small>{t("space.imprint.subtitle")}</small>
        </p>
        <div className="imprint-listening-space__track">
          {track.coverImage ? (
            <img
              className="imprint-listening-space__cover"
              src={track.coverImage}
              alt=""
              decoding="async"
              draggable="false"
            />
          ) : (
            <span className="imprint-listening-space__cover" aria-hidden="true" />
          )}
          <span className="imprint-listening-space__track-copy">
            <strong>{track.title}</strong>
            <small>{track.artist}</small>
            <small>{track.album}</small>
          </span>
        </div>
        <p className="imprint-listening-space__mode">
          <span>{t(policyLabelKey(policyPlan))}</span>
        </p>
      </header>

      <section className="imprint-listening-space__stage" aria-label={t("space.imprint.proof")}>
        <div className="imprint-listening-space__grid" aria-hidden="true" />
        <div className="imprint-listening-space__atmosphere" aria-hidden="true">
          <span className="imprint-listening-space__plate" data-plate="01" />
          <span className="imprint-listening-space__plate" data-plate="02" />
          <span className="imprint-listening-space__plate" data-plate="03" />
          {track.coverImage ? (
            <img
              className="imprint-listening-space__cover-master"
              src={track.coverImage}
              alt=""
              decoding="async"
              draggable="false"
            />
          ) : null}
          <div className="imprint-listening-space__proof-fragments">
            <span>PROOF 01</span>
            <span>PLATE {albumProof}</span>
            <span>00:00 / {proofTime(durationMs)}</span>
            <span>04 · {titleProof}</span>
          </div>
        </div>
        <div className="imprint-listening-space__proofs" aria-hidden="true">
          {frame.proofLayers.map((proof, index) => (
            <span
              className="imprint-listening-space__proof-layer"
              data-proof-number={proof.number}
              key={proof.id}
              style={{
                "--imprint-proof-index": index,
              } as ImprintVariableStyle}
            >
              <small>PROOF {String(proof.number).padStart(2, "0")}</small>
            </span>
          ))}
        </div>

        <div className="imprint-listening-space__history" aria-label={t("space.imprint.history")}>
          <div className="imprint-listening-space__history-list">
            {retiringHistory ? (
              <div
                className="imprint-listening-space__history-item imprint-listening-space__history-item--retiring"
                key={`retiring-${retiringHistory.item.id}`}
                style={{
                  ...historyStyle(
                    0,
                    Math.max(1, historyLayout.length + 1),
                    retiringHistory.item.templateLineIndex,
                    retiringHistory.item.copyNumber,
                    retiringHistory.slotIndex,
                  ),
                  "--imprint-retire-duration": `${retiringHistory.durationMs}ms`,
                } as ImprintVariableStyle}
                aria-hidden="true"
              >
                <span>{retiringHistory.item.line.text}</span>
              </div>
            ) : null}
            {historyLayout.map(({ item, slotIndex }, position) => (
              <div
                className="imprint-listening-space__history-item"
                data-copy-number={item.copyNumber}
                data-history-entering={enteringHistoryIdRef.current === item.id}
                key={item.id}
                style={historyStyle(
                  position,
                  historyLayout.length,
                  item.templateLineIndex,
                  item.copyNumber,
                  slotIndex,
                )}
              >
                <button
                  type="button"
                  data-copy-number={item.copyNumber}
                  onClick={() => onSeek(item.line.startMs)}
                  aria-label={t("space.imprint.seek", {
                    text: item.line.text,
                  })}
                >
                  {item.line.text}
                  {item.copyNumber > 1 ? (
                    <small>COPY {String(item.copyNumber).padStart(2, "0")}</small>
                  ) : null}
                </button>
              </div>
            ))}
          </div>
        </div>

        {frame.activeLine ? (
          <div
            className="imprint-listening-space__current"
            data-copy-number={frame.currentCopyNumber}
          >
            {activeCopies.length > 0 ? (
              <div className="imprint-listening-space__copy-stack" aria-hidden="true">
                {activeCopies.map((copy, index) => (
                  <span
                    className="imprint-listening-space__copy"
                    data-copy-label={`COPY ${String(copy.copyNumber).padStart(2, "0")}`}
                    key={`active-${copy.id}`}
                    style={{ "--imprint-copy-layer": index } as ImprintVariableStyle}
                  >
                    {copy.line.text}
                  </span>
                ))}
              </div>
            ) : null}
            <p
              className="imprint-listening-space__current-line"
              data-state="current"
              data-line-policy={frame.lineRenderPolicy}
              data-fallback-reason={frame.activeLine.fallbackReason}
              data-length={frame.activeLine.text.length > 34 ? "long" : "standard"}
              lang={detectLanguage(frame.activeLine.text)}
              ref={currentLineRef}
            >
              {useTokenNodes
                ? frame.currentTokens.map((token, index) => (
                    <span
                      className="imprint-listening-space__token"
                      data-state={token.state}
                      data-timing-source={token.timingSource}
                      key={token.id}
                      ref={(element) => registerToken(token.id, element)}
                      style={{
                        "--imprint-token-opacity": String(
                          token.state === "future"
                            ? 0
                            : 0.12 + token.progress * 0.88,
                        ),
                        "--imprint-token-blur": `${token.state === "future" ? 0 : (1 - token.progress) * 5}px`,
                        "--imprint-token-z": `${token.state === "future" ? 0 : (1 - token.progress) * 8}px`,
                        "--imprint-token-compression": String(
                          token.state === "future"
                            ? 1
                            : 0.97 + token.progress * 0.03,
                        ),
                      } as CSSProperties}
                    >
                      {tokenText[index]}
                    </span>
                  ))
                : frame.activeLine.text}
            </p>
            {showOriginalLyrics
              && showTranslation
              && frame.activeLine?.translation ? (
                <p
                  className="imprint-listening-space__translation"
                  lang="zh-CN"
                  ref={translationRef}
                >
                  {frame.activeLine.translation}
                </p>
              ) : null}
          </div>
        ) : gapResidue ? (
          <div className="imprint-listening-space__current imprint-listening-space__current--residue">
            <p
              className="imprint-listening-space__current-line imprint-listening-space__current-line--residue"
              data-state="past"
              data-length={gapResidue.line.text.length > 34 ? "long" : "standard"}
              lang={detectLanguage(gapResidue.line.text)}
              ref={residueLineRef}
            >
              {gapResidue.line.text}
            </p>
          </div>
        ) : timeline.renderPolicy !== "static" ? (
          <div className="imprint-listening-space__registration-stage" aria-hidden="true">
            <span>REGISTER 04</span>
            <i />
            <small>PLATE READY · {albumProof}</small>
          </div>
        ) : (
          <div className="imprint-listening-space__empty">
            <strong>{track.title}</strong>
            <small>{t(emptyMessageKey(imprintTrack.lyricsStatus))}</small>
          </div>
        )}

        <span className="imprint-listening-space__registration" data-mark="top" aria-hidden="true" />
        <span className="imprint-listening-space__registration" data-mark="bottom" aria-hidden="true" />
      </section>

      <p
        className="immersive-player__lyric-announcer"
        aria-live="polite"
        aria-atomic="true"
      >
        {currentText}
        {showOriginalLyrics
          && showTranslation
          && frame.activeLine?.translation
          ? `，${frame.activeLine.translation}`
          : ""}
      </p>
    </div>
  );
}

export const ImprintListeningSpace = memo(
  ImprintListeningSpaceComponent,
  (previous, next) =>
    previous.track === next.track
    && previous.playbackSessionId === next.playbackSessionId
    && previous.activeIndex === next.activeIndex
    && previous.elapsedMs === next.elapsedMs
    && previous.durationMs === next.durationMs
    && previous.isPlaying === next.isPlaying
    && previous.lyricsStatus === next.lyricsStatus
    && previous.showOriginalLyrics === next.showOriginalLyrics
    && previous.showTranslation === next.showTranslation
    && previous.animationIntensity === next.animationIntensity
    && previous.onSeek === next.onSeek,
);
