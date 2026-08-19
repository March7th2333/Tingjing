import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  getListeningSpaceDefinition,
  ListeningSpaceRegistry,
} from "../../listening-spaces/ListeningSpaceRegistry";
import { useLanguage } from "../../i18n/LanguageContext";
import type { MessageKey } from "../../i18n/messages";
import type { ColorThemeId, ColorThemePreference } from "../../types/colorTheme";
import type { User } from "../../types/music";
import type { PlayerPreferences } from "../settings/playerPreferences";
import {
  PlaybackQueueController,
  playbackQueueController,
} from "./PlaybackQueueController";
import type {
  PlaybackOrder,
  PlaybackQueueItem,
  RepeatMode,
} from "./PlaybackQueueController";
import "./player-control-panel.css";

export type PlayerPanelRoute = "root" | "listening-spaces" | "queue";

export type PlayerPreferenceChange = <Key extends keyof PlayerPreferences>(
  key: Key,
  value: PlayerPreferences[Key],
) => void;

export interface PlayerControlPanelProps {
  id?: string;
  open: boolean;
  route: PlayerPanelRoute;
  preferences: PlayerPreferences;
  resolvedThemeId: ColorThemeId;
  themePreference: ColorThemePreference;
  user?: User | null;
  providerName: string;
  queueController?: PlaybackQueueController;
  onRouteChange: (route: PlayerPanelRoute) => void;
  onRequestClose: () => void;
  onPreferenceChange: PlayerPreferenceChange;
  onThemePreferenceChange: (preference: ColorThemePreference) => void;
  onActivateQueueItem: (item: PlaybackQueueItem) => void;
  onAccountManage?: () => void;
  onInteraction?: () => void;
}

const queueRowHeight = 68;
const queueOverscan = 4;
const queueViewportHeight = 272;
const queueVisibleCount = Math.ceil(queueViewportHeight / queueRowHeight)
  + queueOverscan * 2;

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

const orderLabelKey: Record<PlaybackOrder, MessageKey> = {
  sequential: "player.panel.order.sequential",
  shuffle: "player.panel.order.shuffle",
};

const repeatLabelKey: Record<RepeatMode, MessageKey> = {
  off: "player.panel.repeat.off",
  all: "player.panel.repeat.all",
  one: "player.panel.repeat.one",
};

const intensityLabelKey: Record<
  PlayerPreferences["animationIntensity"],
  MessageKey
> = {
  low: "player.panel.level.low",
  standard: "player.panel.level.standard",
  high: "player.panel.level.high",
};

const qualityLabelKey: Record<
  PlayerPreferences["particleQuality"],
  MessageKey
> = {
  auto: "player.panel.level.auto",
  low: "player.panel.level.low",
  standard: "player.panel.level.standard",
  high: "player.panel.level.high",
};

interface EditorialSwitchProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

const EditorialSwitch = memo(function EditorialSwitch({
  checked,
  label,
  onToggle,
}: EditorialSwitchProps) {
  return (
    <button
      className="player-control-panel__switch-row"
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
    >
      <span>{label}</span>
      <span className="player-control-panel__switch-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
});

function QueueCover({ item }: { item: PlaybackQueueItem }) {
  const label = item.track.coverLabel || item.track.title.slice(0, 1);

  return (
    <span className="player-control-panel__queue-cover" aria-hidden="true">
      {item.track.coverImage ? (
        <img src={item.track.coverImage} alt="" loading="lazy" decoding="async" />
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
}

interface QueueRowProps {
  item: PlaybackQueueItem;
  index: number;
  count: number;
  actionOpen: boolean;
  dragging: boolean;
  onToggleActions: (queueItemId: string) => void;
  onPlay: (queueItemId: string) => void;
  onMove: (queueItemId: string, targetIndex: number, label: string) => void;
  onRemove: (queueItemId: string, label: string) => void;
  onDragStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    queueItemId: string,
    index: number,
  ) => void;
  onDragMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

const QueueRow = memo(function QueueRow({
  item,
  index,
  count,
  actionOpen,
  dragging,
  onToggleActions,
  onPlay,
  onMove,
  onRemove,
  onDragStart,
  onDragMove,
  onDragEnd,
}: QueueRowProps) {
  const { t } = useLanguage();
  const rowStyle = {
    "--queue-row-y": `${index * queueRowHeight}px`,
  } as CSSProperties;

  return (
    <article
      className="player-control-panel__queue-row"
      data-actions-open={actionOpen}
      data-dragging={dragging}
      style={rowStyle}
    >
      <button
        className="player-control-panel__drag-handle"
        type="button"
        aria-label={t("player.queue.drag", { title: item.track.title })}
        onPointerDown={(event) => onDragStart(event, item.queueItemId, index)}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span aria-hidden="true">≡</span>
      </button>
      <QueueCover item={item} />
      <span className="player-control-panel__queue-copy">
        <strong>{item.track.title}</strong>
        <small>{item.track.artist}</small>
      </span>
      <time>{formatDuration(item.track.durationMs)}</time>
      <button
        className="player-control-panel__row-menu-button"
        type="button"
        aria-label={t("player.queue.actions", { title: item.track.title })}
        aria-haspopup="menu"
        aria-expanded={actionOpen}
        onClick={() => onToggleActions(item.queueItemId)}
      >
        ···
      </button>
      <div
        className="player-control-panel__row-menu"
        role="menu"
        aria-hidden={!actionOpen}
        inert={!actionOpen}
      >
        <button type="button" role="menuitem" onClick={() => onPlay(item.queueItemId)}>
          {t("player.queue.playNow")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={index === 0}
          onClick={() => onMove(
            item.queueItemId,
            0,
            t("player.queue.movedNext", { title: item.track.title }),
          )}
        >
          {t("player.queue.playNext")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={index === 0}
          onClick={() => onMove(
            item.queueItemId,
            index - 1,
            t("player.queue.movedUp", { title: item.track.title }),
          )}
        >
          {t("player.queue.moveUp")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={index >= count - 1}
          onClick={() => onMove(
            item.queueItemId,
            index + 1,
            t("player.queue.movedDown", { title: item.track.title }),
          )}
        >
          {t("player.queue.moveDown")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => onRemove(item.queueItemId, item.track.title)}
        >
          {t("player.queue.remove")}
        </button>
      </div>
    </article>
  );
});

export const PlayerControlPanel = memo(function PlayerControlPanel({
  id = "immersive-player-settings",
  open,
  route,
  preferences,
  resolvedThemeId,
  themePreference,
  user,
  providerName,
  queueController = playbackQueueController,
  onRouteChange,
  onRequestClose,
  onPreferenceChange,
  onThemePreferenceChange,
  onActivateQueueItem,
  onAccountManage,
  onInteraction,
}: PlayerControlPanelProps) {
  const { t } = useLanguage();
  const queueSnapshot = useSyncExternalStore(
    queueController.subscribe,
    queueController.getSnapshot,
    queueController.getSnapshot,
  );
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const [virtualStart, setVirtualStart] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const rootEntryRef = useRef<HTMLButtonElement>(null);
  const listeningEntryRef = useRef<HTMLButtonElement>(null);
  const queueEntryRef = useRef<HTMLButtonElement>(null);
  const spaceBackRef = useRef<HTMLButtonElement>(null);
  const queueBackRef = useRef<HTMLButtonElement>(null);
  const queueViewportRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const returnRouteRef = useRef<PlayerPanelRoute>("root");
  const dragRef = useRef<{
    pointerId: number;
    queueItemId: string;
    sourceIndex: number;
    targetIndex: number;
    startY: number;
    element: HTMLElement;
    frame: number | null;
    deltaY: number;
  } | null>(null);

  const currentSpace = getListeningSpaceDefinition(preferences.listeningSpace);
  const volumePercent = Math.round(preferences.volume * 100);
  const queueSummary = `${t(orderLabelKey[queueSnapshot.order])}${
    queueSnapshot.manuallyAdjusted
      ? ` · ${t("player.panel.adjusted")}`
      : ""
  } · ${t("player.panel.upcomingCount", {
    count: queueSnapshot.upcoming.length,
  })}`;

  const navigate = useCallback((nextRoute: PlayerPanelRoute) => {
    returnRouteRef.current = route;
    setOpenActionId(null);
    onRouteChange(nextRoute);
    onInteraction?.();
  }, [onInteraction, onRouteChange, route]);

  useLayoutEffect(() => {
    if (!open) return;

    const frame = window.requestAnimationFrame(() => {
      if (route === "root") {
        if (returnRouteRef.current === "queue") queueEntryRef.current?.focus();
        else if (returnRouteRef.current === "listening-spaces") listeningEntryRef.current?.focus();
        else rootEntryRef.current?.focus();
        return;
      }
      if (route === "listening-spaces") spaceBackRef.current?.focus();
      else queueBackRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open, route]);

  useEffect(() => {
    if (open) return;
    setOpenActionId(null);
    setDraggingId(null);
    returnRouteRef.current = "root";
  }, [open]);

  useEffect(() => {
    const maximumStart = Math.max(
      0,
      queueSnapshot.upcoming.length - queueVisibleCount,
    );
    setVirtualStart((current) => Math.min(current, maximumStart));
  }, [queueSnapshot.upcoming.length]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
    }
    if (dragRef.current?.frame !== null && dragRef.current?.frame !== undefined) {
      window.cancelAnimationFrame(dragRef.current.frame);
    }
  }, []);

  const handlePanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();

    if (openActionId) {
      setOpenActionId(null);
      return;
    }
    if (route !== "root") {
      returnRouteRef.current = route;
      onRouteChange("root");
      return;
    }
    onRequestClose();
  }, [onRequestClose, onRouteChange, openActionId, route]);

  const changeOrder = useCallback((order: PlaybackOrder) => {
    queueController.setOrder(order);
    onPreferenceChange("playbackOrder", order);
    setAnnouncement(t("player.queue.orderChanged", {
      order: t(orderLabelKey[order]),
    }));
    onInteraction?.();
  }, [onInteraction, onPreferenceChange, queueController, t]);

  const changeRepeatMode = useCallback((repeatMode: RepeatMode) => {
    queueController.setRepeatMode(repeatMode);
    onPreferenceChange("repeatMode", repeatMode);
    setAnnouncement(t("player.queue.repeatChanged", {
      repeat: t(repeatLabelKey[repeatMode]),
    }));
    onInteraction?.();
  }, [onInteraction, onPreferenceChange, queueController, t]);

  const changeVolume = useCallback((volume: number) => {
    const normalizedVolume = Math.max(0, Math.min(1, volume));
    onPreferenceChange("volume", normalizedVolume);
    if (normalizedVolume > 0 && preferences.muted) {
      onPreferenceChange("muted", false);
    }
    setAnnouncement(t("player.queue.volume", {
      value: Math.round(normalizedVolume * 100),
    }));
    onInteraction?.();
  }, [onInteraction, onPreferenceChange, preferences.muted, t]);

  const toggleMuted = useCallback(() => {
    const nextMuted = !preferences.muted;
    onPreferenceChange("muted", nextMuted);
    setAnnouncement(nextMuted
      ? t("player.queue.muted")
      : t("player.queue.unmuted", { value: volumePercent }));
    onInteraction?.();
  }, [onInteraction, onPreferenceChange, preferences.muted, t, volumePercent]);

  const activateQueueEntry = useCallback((queueItemId: string) => {
    const item = queueController.playEntry(queueItemId);
    setOpenActionId(null);
    if (!item) {
      setAnnouncement(t("player.queue.notFound"));
      return;
    }
    setAnnouncement(t("player.queue.playing", { title: item.track.title }));
    onActivateQueueItem(item);
    onInteraction?.();
  }, [onActivateQueueItem, onInteraction, queueController, t]);

  const moveQueueEntry = useCallback((
    queueItemId: string,
    targetIndex: number,
    label: string,
  ) => {
    const moved = queueController.move(queueItemId, targetIndex);
    setOpenActionId(null);
    setAnnouncement(moved ? label : t("player.queue.unchanged"));
    onInteraction?.();
  }, [onInteraction, queueController, t]);

  const removeQueueEntry = useCallback((queueItemId: string, title: string) => {
    const removed = queueController.remove(queueItemId);
    setOpenActionId(null);
    setAnnouncement(removed
      ? t("player.queue.removed", { title })
      : t("player.queue.notInQueue"));
    onInteraction?.();
  }, [onInteraction, queueController, t]);

  const handleQueueScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scrollTop = queueViewportRef.current?.scrollTop ?? 0;
      const nextStart = Math.max(0, Math.floor(scrollTop / queueRowHeight) - queueOverscan);
      setVirtualStart((current) => current === nextStart ? current : nextStart);
    });
  }, []);

  const startDrag = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    queueItemId: string,
    sourceIndex: number,
  ) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const row = event.currentTarget.closest<HTMLElement>(
      ".player-control-panel__queue-row",
    );
    if (!row) return;
    dragRef.current = {
      pointerId: event.pointerId,
      queueItemId,
      sourceIndex,
      targetIndex: sourceIndex,
      startY: event.clientY,
      element: row,
      frame: null,
      deltaY: 0,
    };
    setDraggingId(queueItemId);
    setOpenActionId(null);
    onInteraction?.();
  }, [onInteraction]);

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.deltaY = event.clientY - drag.startY;
    drag.targetIndex = Math.max(
      0,
      Math.min(
        queueSnapshot.upcoming.length - 1,
        drag.sourceIndex + Math.round(drag.deltaY / queueRowHeight),
      ),
    );
    if (drag.frame !== null) return;
    drag.frame = window.requestAnimationFrame(() => {
      const activeDrag = dragRef.current;
      if (!activeDrag) return;
      activeDrag.frame = null;
      activeDrag.element.style.setProperty("--queue-drag-y", `${activeDrag.deltaY}px`);
    });
  }, [queueSnapshot.upcoming.length]);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    drag.element.style.removeProperty("--queue-drag-y");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDraggingId(null);
    const moved = queueController.move(drag.queueItemId, drag.targetIndex);
    setAnnouncement(moved
      ? t("player.queue.movedTo", { position: drag.targetIndex + 1 })
      : t("player.queue.unchanged"));
  }, [queueController, t]);

  const virtualEnd = Math.min(
    queueSnapshot.upcoming.length,
    virtualStart + queueVisibleCount,
  );
  const visibleUpcoming = useMemo(
    () => queueSnapshot.upcoming.slice(virtualStart, virtualEnd),
    [queueSnapshot.upcoming, virtualEnd, virtualStart],
  );

  return (
    <aside
      className="player-control-panel"
      id={id}
      ref={panelRef}
      role="dialog"
      aria-label={t("player.panel.aria")}
      aria-modal="false"
      aria-hidden={!open}
      inert={!open}
      data-open={open}
      data-route={route}
      onKeyDown={handlePanelKeyDown}
      onPointerDown={onInteraction}
    >
      <header className="player-control-panel__header">
        <div>
          <strong>PLAYBACK</strong>
          <span>{user ? `${user.nickname} · ${providerName}` : providerName}</span>
        </div>
        <button type="button" aria-label={t("player.panel.close")} onClick={onRequestClose}>
          CLOSE ×
        </button>
      </header>

      <div className="player-control-panel__viewport">
        <section
          className="player-control-panel__page player-control-panel__page--root"
          data-active={route === "root"}
          aria-hidden={route !== "root"}
          inert={route !== "root"}
        >
          <div className="player-control-panel__root-scroll">
            <nav className="player-control-panel__directory" aria-label={t("player.panel.directory")}>
              <button
                ref={(node) => {
                  rootEntryRef.current = node;
                  listeningEntryRef.current = node;
                }}
                type="button"
                onClick={() => navigate("listening-spaces")}
              >
                <span className="player-control-panel__directory-number">01</span>
                <span className="player-control-panel__directory-copy">
                  <strong>{t("player.panel.spaces")}</strong>
                  <small>{t("player.panel.currentSpace", {
                    title: currentSpace.title,
                  })}</small>
                </span>
                <span className="player-control-panel__directory-arrow" aria-hidden="true">→</span>
              </button>
              <button ref={queueEntryRef} type="button" onClick={() => navigate("queue")}>
                <span className="player-control-panel__directory-number">02</span>
                <span className="player-control-panel__directory-copy">
                  <strong>{t("player.panel.queue")}</strong>
                  <small>{queueSummary}</small>
                </span>
                <span className="player-control-panel__directory-arrow" aria-hidden="true">→</span>
              </button>
            </nav>

            <section
              className="player-control-panel__output"
              aria-labelledby={`${id}-output-label`}
            >
              <div className="player-control-panel__output-heading">
                <span className="player-control-panel__label" id={`${id}-output-label`}>
                  {t("player.panel.volume")}
                </span>
                <output htmlFor={`${id}-volume`}>
                  {preferences.muted
                    ? t("player.panel.mutedValue", { value: volumePercent })
                    : `${volumePercent}%`}
                </output>
              </div>
              <div className="player-control-panel__volume-row">
                <input
                  id={`${id}-volume`}
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={volumePercent}
                  aria-label={t("player.panel.volume")}
                  aria-valuetext={preferences.muted
                    ? t("player.panel.mutedAria", { value: volumePercent })
                    : `${volumePercent}%`}
                  onChange={(event) => changeVolume(Number(event.currentTarget.value) / 100)}
                />
                <button
                  type="button"
                  aria-label={preferences.muted
                    ? t("player.panel.unmute")
                    : t("player.panel.muted")}
                  aria-pressed={preferences.muted}
                  data-active={preferences.muted}
                  onClick={toggleMuted}
                >
                  {preferences.muted
                    ? t("player.panel.unmute")
                    : t("player.panel.muted")}
                </button>
              </div>
            </section>

            <EditorialSwitch
              label={t("player.panel.translation")}
              checked={preferences.showTranslation}
              onToggle={() => onPreferenceChange("showTranslation", !preferences.showTranslation)}
            />

            <section className="player-control-panel__atmosphere" aria-labelledby={`${id}-atmosphere-label`}>
              <span className="player-control-panel__label" id={`${id}-atmosphere-label`}>{t("player.panel.atmosphere")}</span>

              <div className="player-control-panel__scale-row">
                <span>{t("player.panel.appearance")}</span>
                <div className="player-control-panel__editorial-scale" role="radiogroup" aria-label={t("player.panel.themeAria")}>
                {(["dark", "light"] as const).map((themeId) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={resolvedThemeId === themeId}
                    data-active={resolvedThemeId === themeId}
                    key={themeId}
                    onClick={() => onThemePreferenceChange(themeId)}
                  >
                    {themeId === "dark"
                      ? t("player.panel.dark")
                      : t("player.panel.light")}
                  </button>
                ))}
                </div>
              </div>

              <div className="player-control-panel__scale-row">
                <span>{t("player.panel.motion")}</span>
                <div className="player-control-panel__editorial-scale" role="radiogroup" aria-label={t("player.panel.motionAria")}>
                {(["low", "standard", "high"] as const).map((value) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={preferences.animationIntensity === value}
                    data-active={preferences.animationIntensity === value}
                    key={value}
                    onClick={() => onPreferenceChange("animationIntensity", value)}
                  >
                    {t(intensityLabelKey[value])}
                  </button>
                ))}
                </div>
              </div>

              <div className="player-control-panel__scale-row">
                <span>{t("player.panel.particleQuality")}</span>
                <div className="player-control-panel__editorial-scale" role="radiogroup" aria-label={t("player.panel.particleQuality")}>
                {(["auto", "low", "standard", "high"] as const).map((value) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={preferences.particleQuality === value}
                    data-active={preferences.particleQuality === value}
                    key={value}
                    onClick={() => onPreferenceChange("particleQuality", value)}
                  >
                    {t(qualityLabelKey[value])}
                  </button>
                ))}
                </div>
              </div>

              {themePreference === "system" && (
                <small className="player-control-panel__system-note">{t("player.panel.fixAppearance")}</small>
              )}

              <EditorialSwitch
                label={t("player.panel.particles")}
                checked={preferences.particlesEnabled}
                onToggle={() => onPreferenceChange("particlesEnabled", !preferences.particlesEnabled)}
              />
              <EditorialSwitch
                label={t("player.panel.audioResponse")}
                checked={preferences.audioResponseEnabled}
                onToggle={() => onPreferenceChange("audioResponseEnabled", !preferences.audioResponseEnabled)}
              />
            </section>

            <button
              className="player-control-panel__account"
              type="button"
              disabled={!onAccountManage}
              onClick={onAccountManage}
            >
              <span>
                <strong>{t("player.panel.account")}</strong>
                <small>{user
                  ? providerName
                  : t("player.panel.synced", { provider: providerName })}</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>

        <section
          className="player-control-panel__page player-control-panel__page--spaces"
          data-active={route === "listening-spaces"}
          aria-hidden={route !== "listening-spaces"}
          inert={route !== "listening-spaces"}
        >
          <header className="player-control-panel__secondary-header">
            <button ref={spaceBackRef} type="button" onClick={() => navigate("root")}>← {t("common.back")}</button>
            <strong>LISTENING SPACE</strong>
          </header>
          <div className="player-control-panel__space-list" role="radiogroup" aria-label={t("player.panel.spaces")}>
            {ListeningSpaceRegistry.map((space) => {
              const active = preferences.listeningSpace === space.id;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-current={active ? "true" : undefined}
                  data-active={active}
                  key={space.id}
                  onClick={() => onPreferenceChange("listeningSpace", space.id)}
                >
                  <span className="player-control-panel__space-number">{space.number}</span>
                  <span><strong>{space.title}</strong><small>{t(space.descriptionKey)}</small></span>
                  <span className="player-control-panel__space-check" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>

        <section
          className="player-control-panel__page player-control-panel__page--queue"
          data-active={route === "queue"}
          aria-hidden={route !== "queue"}
          inert={route !== "queue"}
        >
          <header className="player-control-panel__secondary-header player-control-panel__queue-header">
            <button ref={queueBackRef} type="button" onClick={() => navigate("root")}>← {t("common.back")}</button>
            <strong>PLAYING QUEUE</strong>
          </header>

          <div className="player-control-panel__queue-sticky">
            <div className="player-control-panel__queue-mode-row">
              <span>{t("player.panel.order")}</span>
              <div className="player-control-panel__editorial-scale player-control-panel__order" role="radiogroup" aria-label={t("player.panel.order")}>
                {(["sequential", "shuffle"] as const).map((order) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={queueSnapshot.order === order}
                    data-active={queueSnapshot.order === order}
                    key={order}
                    onClick={() => changeOrder(order)}
                  >
                    {t(orderLabelKey[order])}
                  </button>
                ))}
              </div>
            </div>
            <div className="player-control-panel__queue-mode-row">
              <span>{t("player.panel.repeat")}</span>
              <div className="player-control-panel__editorial-scale player-control-panel__repeat" role="radiogroup" aria-label={t("player.panel.repeat")}>
                {(["off", "all", "one"] as const).map((repeatMode) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={queueSnapshot.repeatMode === repeatMode}
                    data-active={queueSnapshot.repeatMode === repeatMode}
                    key={repeatMode}
                    onClick={() => changeRepeatMode(repeatMode)}
                  >
                    {t(repeatLabelKey[repeatMode])}
                  </button>
                ))}
              </div>
            </div>
            <span className="player-control-panel__queue-source">
              {queueSnapshot.context?.collectionTitle ?? t("player.panel.session")} · {queueSummary}
            </span>
            {queueSnapshot.current && (
              <article className="player-control-panel__current" aria-current="true">
                <span className="player-control-panel__eyebrow">{t("player.panel.nowPlaying")}</span>
                <div>
                  <QueueCover item={queueSnapshot.current} />
                  <span><strong>{queueSnapshot.current.track.title}</strong><small>{queueSnapshot.current.track.artist}</small></span>
                  <time>{formatDuration(queueSnapshot.current.track.durationMs)}</time>
                </div>
              </article>
            )}
          </div>

          <div className="player-control-panel__queue-count">{t("player.panel.upNext", {
            count: queueSnapshot.upcoming.length,
          })}</div>
          {queueSnapshot.upcoming.length === 0 ? (
            <p className="player-control-panel__queue-empty">{t("player.panel.queueEmpty")}</p>
          ) : (
            <div
              className="player-control-panel__queue-viewport"
              ref={queueViewportRef}
              onScroll={handleQueueScroll}
            >
              <div
                className="player-control-panel__queue-canvas"
                style={{ height: queueSnapshot.upcoming.length * queueRowHeight }}
              >
                {visibleUpcoming.map((item, offset) => {
                  const index = virtualStart + offset;
                  return (
                    <QueueRow
                      key={item.queueItemId}
                      item={item}
                      index={index}
                      count={queueSnapshot.upcoming.length}
                      actionOpen={openActionId === item.queueItemId}
                      dragging={draggingId === item.queueItemId}
                      onToggleActions={(queueItemId) => setOpenActionId((current) => current === queueItemId ? null : queueItemId)}
                      onPlay={activateQueueEntry}
                      onMove={moveQueueEntry}
                      onRemove={removeQueueEntry}
                      onDragStart={startDrag}
                      onDragMove={moveDrag}
                      onDragEnd={endDrag}
                    />
                  );
                })}
              </div>
            </div>
          )}

          <footer className="player-control-panel__queue-actions">
            <button
              type="button"
              disabled={queueSnapshot.sourceItems.length === 0}
              onClick={() => {
                queueController.restoreModeOrder();
                setAnnouncement(t("player.queue.restored", {
                  order: t(orderLabelKey[queueSnapshot.order]),
                }));
              }}
            >
              {queueSnapshot.order === "shuffle"
                ? t("player.panel.restoreShuffle")
                : t("player.panel.restoreSequential")}
            </button>
            <button
              type="button"
              disabled={queueSnapshot.upcoming.length === 0}
              onClick={() => {
                queueController.clearUpcoming();
                setAnnouncement(t("player.queue.cleared"));
              }}
            >
              {t("player.panel.clearUpcoming")}
            </button>
          </footer>
        </section>
      </div>
      <p className="player-control-panel__live" aria-live="polite" aria-atomic="true">{announcement}</p>
    </aside>
  );
});
