import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createColorThemeVariables,
  createGrayscaleParticlePalette,
} from "../../config/colorThemes";
import { motionCssVariables } from "../../config/motion";
import { createPreviewLibrary } from "../../data/createPreviewLibrary";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  formatProviderName,
  formatProviderScanApp,
} from "../../i18n/formatters";
import type { MessageKey } from "../../i18n/messages";
import type { MusicLibrary, User } from "../../types/music";
import {
  isMusicProviderId,
  musicProviderOptions,
  musicProviders,
} from "../../providers/musicProviders";
import { SpotifyProviderError } from "../../providers/SpotifyMusicProvider";
import type {
  MusicProviderId,
  OAuthLoginSession,
  QrLoginSession,
} from "../../providers/MusicProvider";
import type { DailyListeningSummary } from "../../types/dailyListening";
import {
  formatDailyListeningDuration,
} from "../../types/dailyListening";
import { useColorTheme } from "../../theme/ColorThemeContext";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { LibraryHome } from "../library/LibraryHome";
import type { JourneyPhase } from "../library/LibraryHome";
import { ImmersivePlayer } from "../player/ImmersivePlayer";
import { PlaybackPrefetchService } from "../player/PlaybackPrefetchService";
import {
  dailyListeningStore,
  localDateKey,
} from "../player/DailyListeningStore";
import { playbackQueueController } from "../player/PlaybackQueueController";
import {
  requestImmersivePlaybackRestore,
  resetImmersivePlaybackSession,
} from "../player/playbackEvents";
import {
  playbackSessionStore,
  reconcileRestoredPlaybackSession,
} from "../player/PlaybackSessionStore";
import { ThemeSettings } from "../settings/ThemeSettings";
import { LanguageSelector } from "../settings/LanguageSelector";
import { usePlayerPreferences } from "../settings/playerPreferences";
import { AmbientCanvas } from "./AmbientCanvas";
import { BrandMark } from "./BrandMark";
import { homeEntranceTransition } from "./HomeEntranceTransition";
import { ScanTransition } from "./ScanTransition";
import type { ScanTransitionGeometry } from "./ScanTransition";
import {
  advanceQrProgress,
  qrPollIntervalMs,
  qrPollMaxConsecutiveFailures,
  qrPollRetryDelayMs,
  withQrPollRequestTimeout,
} from "./QrPollingPolicy";
import { SpotifyClientSetup } from "./SpotifyClientSetup";
import {
  createLoginTransitionVariables,
  loginTransitionController,
  type LoginSpaceGeometry,
  type LoginTransitionStage,
} from "./LoginTransitionController";
import {
  clearCachedWelcomeIdentity,
  readCachedWelcomeIdentity,
  writeCachedWelcomeIdentity,
  type CachedWelcomeIdentity,
  type WelcomeSessionState,
} from "./welcomeSession";
import "./welcome.css";

type LoginStage =
  | "idle"
  | "restoring"
  | "creating"
  | "waiting"
  | "scanned"
  | "syncing"
  | "expired"
  | "empty"
  | "error";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parsePreviewListeningMinutes(value: string | null) {
  if (value === null || value.trim() === "") {
    return null;
  }
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

export function WelcomeScreen() {
  const [welcomePreview] = useState<{
    state: "validating" | "returning-user" | "reconnect-required";
    nickname: string;
    providerId: MusicProviderId;
    avatarUrl?: string;
    dailyListeningMinutes: number | null;
    dailyListeningStatus: "ready" | "loading" | "error";
  } | null>(() => {
    if ("__TAURI_INTERNALS__" in window) {
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("preview") !== "welcome") {
      return null;
    }
    const session = params.get("session");
    const dailyListeningMinutes = parsePreviewListeningMinutes(
      params.get("listeningMinutes"),
    );
    return {
      state: session === "reconnect"
        ? "reconnect-required"
        : session === "validating"
          ? "validating"
          : "returning-user",
      nickname: params.get("nickname") ?? "WEB PREVIEW",
      providerId: params.get("provider") === "spotify"
        ? "spotify"
        : params.get("provider") === "qq"
          ? "qq"
          : "netease",
      avatarUrl: params.get("avatar") === "broken"
        ? "http://127.0.0.1:9/missing-avatar.jpg"
        : params.get("avatar") || undefined,
      dailyListeningMinutes,
      dailyListeningStatus: params.get("listeningStatus") === "loading"
        ? "loading"
        : params.get("listeningStatus") === "error"
          ? "error"
          : "ready",
    };
  });
  const [initialIdentity] = useState<CachedWelcomeIdentity | null>(() =>
    welcomePreview
      ? {
          version: 1,
          providerId: welcomePreview.providerId,
          user: {
            id: "welcome-preview",
            nickname: welcomePreview.nickname,
            avatarUrl: welcomePreview.avatarUrl,
          },
          syncedAt: Date.now(),
          hasLocalLibrary: welcomePreview.state === "returning-user",
        }
      : readCachedWelcomeIdentity()
  );
  const [musicProviderId, setMusicProviderId] = useState<MusicProviderId>(
    () => {
      if (initialIdentity) {
        return initialIdentity.providerId;
      }
      try {
        const stored = window.localStorage.getItem("tingjing:music-provider");
        return isMusicProviderId(stored) ? stored : "netease";
      } catch {
        return "netease";
      }
    },
  );
  const [isQrOpen, setIsQrOpen] = useState(false);
  const [loginStage, setLoginStage] = useState<LoginStage>("idle");
  const [loginMessage, setLoginMessage] = useState("");
  const [qrSession, setQrSession] = useState<QrLoginSession | null>(null);
  const [oauthSession, setOAuthSession] =
    useState<OAuthLoginSession | null>(null);
  const [library, setLibrary] = useState<MusicLibrary | null>(null);
  const [welcomeSessionState, setWelcomeSessionState] =
    useState<WelcomeSessionState>(
      initialIdentity ? "validating" : "signed-out",
    );
  const [sessionUser, setSessionUser] = useState<User | null>(
    initialIdentity?.user ?? null,
  );
  const [sessionProviderId, setSessionProviderId] =
    useState<MusicProviderId | null>(initialIdentity?.providerId ?? null);
  const [dailyListeningSummary, setDailyListeningSummary] =
    useState<DailyListeningSummary | null>(() =>
      initialIdentity
        ? dailyListeningStore.getSummary(
            initialIdentity.providerId,
            initialIdentity.user.id,
          )
        : null
    );
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const [syncMessageIndex, setSyncMessageIndex] = useState(0);
  const [phase, setPhase] = useState<JourneyPhase>("welcome");
  const [libraryRuntimeReady, setLibraryRuntimeReady] = useState(false);
  const [loginTransitionStage, setLoginTransitionStage] =
    useState<LoginTransitionStage>("idle");
  const [scanGeometry, setScanGeometry] =
    useState<ScanTransitionGeometry | null>(null);
  const [loginSpaceGeometry, setLoginSpaceGeometry] =
    useState<LoginSpaceGeometry | null>(null);
  const qrVisualRef = useRef<HTMLDivElement>(null);
  const brandMarkRef = useRef<HTMLDivElement>(null);
  const brandPortalRef = useRef<HTMLSpanElement>(null);
  const welcomeRef = useRef<HTMLElement>(null);
  const loginTransitionStageRef = useRef<LoginTransitionStage>("idle");
  const loginTransitionAbortRef = useRef<AbortController | null>(null);
  const libraryCommittedRef = useRef(false);
  const playbackRestoreAttemptedRef = useRef<string | null>(null);
  const queueOwnerRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollPendingRef = useRef<number | null>(null);
  const pollAttemptGenerationRef = useRef(0);
  const syncStartedRef = useRef(false);
  const restoreStartedRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const preservedAccountRef = useRef<{
    providerId: MusicProviderId;
    user: User;
    library: MusicLibrary | null;
  } | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const [, setPlayerPreferences] = usePlayerPreferences();
  const { theme, resolvedThemeId } = useColorTheme();
  const { language, t } = useLanguage();
  const musicProvider = musicProviders[musicProviderId];
  const isOAuthProvider = musicProvider.capabilities.login === "oauth-pkce";
  const runtimeProviderId = sessionProviderId ?? musicProviderId;
  const runtimeProvider = musicProviders[runtimeProviderId];
  const musicProviderName = formatProviderName(
    language,
    musicProvider.id,
    musicProvider.displayName,
  );
  const musicProviderScanApp = formatProviderScanApp(
    language,
    musicProvider.id,
    musicProvider.scanAppName,
  );
  const syncMessages = useMemo(
    () => [
      t("welcome.sync.profile"),
      t("welcome.sync.collections"),
      t("welcome.sync.artwork"),
      t("welcome.sync.space"),
    ],
    [t],
  );
  const localizedProviderError = useCallback((
    error: unknown,
    fallbackKey: MessageKey,
  ) => {
    if (error instanceof SpotifyProviderError) {
      if (
        error.code === "SPOTIFY_CLIENT_ID_MISSING"
        || error.code === "SPOTIFY_CLIENT_ID_INVALID"
      ) {
        return t("welcome.error.spotifyClientId");
      }
      if (error.code === "SPOTIFY_DESKTOP_REQUIRED") {
        return t("welcome.error.spotifyDesktop");
      }
      if (
        error.code.includes("AUTH")
        || error.code.includes("OAUTH")
        || error.code.includes("RECONNECT")
        || error.code.includes("STATE")
      ) {
        return t("welcome.error.spotifyAuth");
      }
    }
    const detail = errorMessage(error).trim();
    return language === "zh-CN" && detail
      ? detail
      : t(fallbackKey);
  }, [language, t]);
  const [playbackPrefetchService] = useState(
    () => new PlaybackPrefetchService(),
  );

  useLayoutEffect(() => {
    const accountId = sessionUser?.id ?? library?.user.id ?? null;
    if (isSwitchingAccount || !accountId) {
      if (playbackPrefetchService.getContext()) {
        playbackPrefetchService.clearContext(
          isSwitchingAccount
            ? "Account switch is in progress"
            : "No authenticated music account",
        );
      }
      return;
    }
    playbackPrefetchService.setContext({
      providerId: runtimeProviderId,
      accountId,
      provider: runtimeProvider,
    });
  }, [
    isSwitchingAccount,
    library?.user.id,
    playbackPrefetchService,
    runtimeProvider,
    runtimeProviderId,
    sessionUser?.id,
  ]);
  const isWebLibraryPreview = useMemo(
    () =>
      !("__TAURI_INTERNALS__" in window)
      && new URLSearchParams(window.location.search).get("preview")
        === "library",
    [],
  );
  const webPreviewCount = useMemo(() => {
    const count = Number(
      new URLSearchParams(window.location.search).get("count") ?? 20,
    );
    return Number.isFinite(count) ? count : 20;
  }, []);
  const webPreviewOptions = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const tracksPerCollection = Number(params.get("tracks") ?? 1);
    const lyricLines = Number(params.get("lyricLines"));
    return {
      tracksPerCollection: Number.isFinite(tracksPerCollection)
        ? tracksPerCollection
        : 1,
      repeatCover: params.get("repeatCover") === "1",
      brokenCover: params.get("brokenCover") === "1",
      imprintWordTimings: params.get("imprintWords") === "1",
      imprintMixedTimings: params.get("imprintMixed") === "1",
      imprintRepeats: params.get("imprintRepeats") === "1",
      emptyLyrics: params.get("emptyLyrics") === "1",
      lyricLines:
        params.has("lyricLines") && Number.isFinite(lyricLines)
          ? lyricLines
          : undefined,
    };
  }, []);
  const particlePalette = useMemo(
    () => createGrayscaleParticlePalette(theme),
    [theme],
  );
  const previewDailyListeningSummary = useMemo<DailyListeningSummary | null>(
    () => {
      if (!welcomePreview || !sessionUser || !sessionProviderId) {
        return null;
      }
      return {
        providerId: sessionProviderId,
        accountId: sessionUser.id,
        localDate: localDateKey(Date.now()),
        durationMs: welcomePreview.dailyListeningMinutes === null
          ? null
          : welcomePreview.dailyListeningMinutes * 60_000,
        source: welcomePreview.dailyListeningMinutes === null
          ? "unavailable"
          : "local",
        updatedAt: Date.now(),
      };
    }, [sessionProviderId, sessionUser, welcomePreview],
  );

  useEffect(() => {
    const accountId = sessionUser?.id;
    const providerId = sessionProviderId;

    if (!accountId || !providerId || welcomePreview) {
      setDailyListeningSummary(null);
      return;
    }

    const readLocal = () => dailyListeningStore.getSummary(
      providerId,
      accountId,
    );
    const publishLocal = (localSummary: DailyListeningSummary) => {
      if (
        localSummary.providerId !== providerId
        || localSummary.accountId !== accountId
        || localSummary.localDate !== localDateKey(Date.now())
      ) {
        return;
      }
      setDailyListeningSummary(localSummary);
    };

    publishLocal(readLocal());
    const unsubscribe = dailyListeningStore.subscribe(publishLocal);
    return unsubscribe;
  }, [sessionProviderId, sessionUser?.id, welcomePreview]);

  const bindWelcomeRef = useCallback((node: HTMLElement | null) => {
    welcomeRef.current = node;
    if (node) {
      node.dataset.loginTransition = loginTransitionStageRef.current;
    }
  }, []);

  const applyLoginTransitionStage = useCallback((
    stage: LoginTransitionStage,
    commitToReact = false,
  ) => {
    loginTransitionStageRef.current = stage;
    if (welcomeRef.current) {
      welcomeRef.current.dataset.loginTransition = stage;
    }
    if (commitToReact) {
      setLoginTransitionStage(stage);
    }
  }, []);

  useLayoutEffect(() => {
    if (
      phase !== "library"
      || loginTransitionStage !== "complete"
      || !welcomeRef.current
    ) {
      return;
    }

    // React has already committed the full-size Library phase when this runs.
    // Only now may the imperative compositor stage become `complete`; this
    // prevents a transitioning/complete frame from falling back to the hidden
    // portal base style.
    welcomeRef.current.dataset.loginTransition = "complete";
  }, [loginTransitionStage, phase]);

  const clearPollTimer = useCallback(() => {
    pollAttemptGenerationRef.current += 1;
    // An invalidated native request may never settle. Its generation guard
    // already prevents stale results from committing; release the shared
    // in-flight slot as well so StrictMode cleanup or a refreshed QR attempt
    // cannot inherit a permanently pending poll.
    pollPendingRef.current = null;
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const enterLibrary = useCallback((nextLibrary: MusicLibrary) => {
    const qrBounds = qrVisualRef.current?.getBoundingClientRect();
    const markBounds = brandMarkRef.current?.getBoundingClientRect();
    const portalBounds = brandPortalRef.current?.getBoundingClientRect();
    let nextScanGeometry: ScanTransitionGeometry | null = null;
    let nextLoginSpaceGeometry: LoginSpaceGeometry | null = null;

    if (portalBounds && portalBounds.width > 0 && portalBounds.height > 0) {
      const viewportWidth = Math.max(1, window.innerWidth);
      const viewportHeight = Math.max(1, window.innerHeight);
      nextLoginSpaceGeometry = {
        top: Math.max(0, portalBounds.top),
        right: Math.max(0, viewportWidth - portalBounds.right),
        bottom: Math.max(0, viewportHeight - portalBounds.bottom),
        left: Math.max(0, portalBounds.left),
        width: portalBounds.width,
        height: portalBounds.height,
        viewportWidth,
        viewportHeight,
      };
    }

    if (qrBounds && markBounds && qrBounds.width > 0) {
      const targetSize = portalBounds?.width
        ?? Math.max(18, Math.min(34, markBounds.width * 0.18));
      const targetCenterX = portalBounds
        ? portalBounds.left + portalBounds.width / 2
        : markBounds.left + markBounds.width * 0.745;
      const targetCenterY = portalBounds
        ? portalBounds.top + portalBounds.height / 2
        : markBounds.top + markBounds.height * 0.275;
      const sourceCenterX = qrBounds.left + qrBounds.width / 2;
      const sourceCenterY = qrBounds.top + qrBounds.height / 2;

      nextScanGeometry = {
        fromLeft: qrBounds.left,
        fromTop: qrBounds.top,
        fromSize: qrBounds.width,
        travelX: targetCenterX - sourceCenterX,
        travelY: targetCenterY - sourceCenterY,
        targetScale: targetSize / qrBounds.width,
      };
    }

    loginTransitionAbortRef.current?.abort("Login transition superseded");
    const transitionAbort = new AbortController();
    loginTransitionAbortRef.current = transitionAbort;
    libraryCommittedRef.current = false;
    setLibraryRuntimeReady(false);
    homeEntranceTransition.resetPerformanceMarks();
    applyLoginTransitionStage("preparing", true);

    return loginTransitionController.run({
      signal: transitionAbort.signal,
      prefersReducedMotion,
      prepare: async (transition) => {
        await homeEntranceTransition.preloadAssets(nextLibrary, transition);
        if (transition.signal.aborted) {
          return;
        }

        setLibrary(nextLibrary);
        setScanGeometry(nextScanGeometry);
        setLoginSpaceGeometry(nextLoginSpaceGeometry);
        await homeEntranceTransition.waitUntilReady(nextLibrary, transition);
      },
      onStage: (stage) => {
        if (stage === "merging") {
          applyLoginTransitionStage(stage, true);
          setPhase("transitioning");
          return;
        }
        // Intermediate compositor stages intentionally stay outside React.
        // React does not own the data attribute, so a parent re-render cannot
        // rewind it to "merging" and restart the Logo/space animations.
        applyLoginTransitionStage(stage);
      },
      complete: () => {
        if (libraryCommittedRef.current) {
          return;
        }
        libraryCommittedRef.current = true;
        loginTransitionStageRef.current = "complete";
        setLoginTransitionStage("complete");
        setScanGeometry(null);
        // Commit the LibraryHome contract in the same React batch as the
        // stable outer phase. Delaying this through another RAF/idle callback
        // made the already-visible Home perform a second entrance commit.
        setLibraryRuntimeReady(true);
        setPhase("library");
      },
    }).then((result) => {
      if (loginTransitionAbortRef.current !== transitionAbort) {
        return result;
      }
      loginTransitionAbortRef.current = null;
      if (result.status === "cancelled") {
        syncStartedRef.current = false;
        setLibrary(null);
        setLoginStage("idle");
        setPhase("welcome");
        setLibraryRuntimeReady(false);
        applyLoginTransitionStage("idle", true);
        setScanGeometry(null);
        setLoginSpaceGeometry(null);
      }
      return result;
    }).catch((error) => {
      if (loginTransitionAbortRef.current !== transitionAbort) {
        throw error;
      }
      loginTransitionAbortRef.current = null;
      libraryCommittedRef.current = false;
      setLibrary(null);
      setPhase("welcome");
      setLibraryRuntimeReady(false);
      applyLoginTransitionStage("idle", true);
      setScanGeometry(null);
      setLoginSpaceGeometry(null);
      throw error;
    });
  }, [applyLoginTransitionStage, prefersReducedMotion]);

  const syncMusicLibrary = useCallback(async (restoredUser?: User) => {
    if (syncStartedRef.current) {
      return false;
    }

    const syncGeneration = ++sessionGenerationRef.current;
    const providerAtStart = musicProvider;
    const providerIdAtStart = musicProviderId;
    syncStartedRef.current = true;
    clearPollTimer();
    setLoginStage("syncing");
    setLoginMessage(syncMessages[0]);
    setSyncMessageIndex(0);

    try {
      const nextLibrary = await providerAtStart.syncLibrary();
      if (syncGeneration !== sessionGenerationRef.current) {
        return false;
      }

      const nextUser = nextLibrary.user ?? restoredUser;
      const nextQueueOwner = `${providerIdAtStart}:${nextUser.id}`;
      if (
        queueOwnerRef.current
        && queueOwnerRef.current !== nextQueueOwner
      ) {
        playbackQueueController.clear();
      }
      queueOwnerRef.current = nextQueueOwner;
      const identity: CachedWelcomeIdentity = {
        version: 1,
        providerId: providerIdAtStart,
        user: nextUser,
        syncedAt: nextLibrary.syncedAt,
        hasLocalLibrary: true,
      };
      try {
        writeCachedWelcomeIdentity(identity);
      } catch {
        // The current session still carries the user when storage is disabled.
      }

      const previousAccount = preservedAccountRef.current;
      preservedAccountRef.current = null;
      setLibrary(nextLibrary);
      setSessionUser(nextUser);
      setSessionProviderId(providerIdAtStart);
      setWelcomeSessionState("returning-user");
      setIsSwitchingAccount(false);
      setIsQrOpen(false);
      setQrSession(null);
      setOAuthSession(null);
      setLoginStage("idle");
      setLoginMessage("");

      if (
        previousAccount
        && previousAccount.providerId !== providerIdAtStart
      ) {
        void musicProviders[previousAccount.providerId]
          .disconnect()
          .catch(() => undefined);
      }
      return true;
    } catch (error) {
      if (syncGeneration !== sessionGenerationRef.current) {
        return false;
      }
      setLoginStage("error");
      setLoginMessage(localizedProviderError(error, "welcome.error.sync"));
      if (!preservedAccountRef.current && sessionUser) {
        setWelcomeSessionState("reconnect-required");
      }
      return false;
    } finally {
      if (syncGeneration === sessionGenerationRef.current) {
        syncStartedRef.current = false;
      }
    }
  }, [
    clearPollTimer,
    localizedProviderError,
    musicProvider,
    musicProviderId,
    sessionUser,
    syncMessages,
  ]);

  const createQrLogin = useCallback(async () => {
    clearPollTimer();
    syncStartedRef.current = false;
    setIsQrOpen(true);
    setLoginStage("creating");
    setLoginMessage(isOAuthProvider
      ? t("welcome.oauth.opening")
      : t("welcome.qr.creating", { provider: musicProviderName }));
    setQrSession(null);
    setOAuthSession(null);

    try {
      if (!isSwitchingAccount) {
        await Promise.all(
          musicProviderOptions
            .filter((provider) => provider.id !== musicProvider.id)
            .map((provider) => provider.disconnect().catch(() => undefined)),
        );
      }
      if (isOAuthProvider) {
        if (!musicProvider.beginOAuthLogin) {
          throw new Error("Spotify OAuth is not available in this build.");
        }
        const session = await musicProvider.beginOAuthLogin();
        setOAuthSession(session);
        setLoginStage("waiting");
        setLoginMessage(t("welcome.oauth.waiting"));
      } else {
        const session = await musicProvider.createQrLogin();
        setQrSession(session);
        setLoginStage("waiting");
        setLoginMessage(t("welcome.qr.scanWith", {
          app: musicProviderScanApp,
        }));
      }
    } catch (error) {
      setLoginStage("error");
      setLoginMessage(localizedProviderError(error, "welcome.error.createQr"));
    }
  }, [
    clearPollTimer,
    isOAuthProvider,
    isSwitchingAccount,
    localizedProviderError,
    musicProvider,
    musicProviderName,
    musicProviderScanApp,
    t,
  ]);

  useEffect(() => {
    if (!isWebLibraryPreview || restoreStartedRef.current) {
      return;
    }

    restoreStartedRef.current = true;
    const previewLibrary = createPreviewLibrary(
      webPreviewCount,
      webPreviewOptions,
    );
    setLibrary(previewLibrary);
    setSessionUser(previewLibrary.user);
    setSessionProviderId(musicProviderId);
    setWelcomeSessionState("returning-user");
    setLoginStage("idle");
    setLoginMessage("");
    applyLoginTransitionStage("complete", true);
    setLibraryRuntimeReady(true);
    setPhase("library");
  }, [
    applyLoginTransitionStage,
    isWebLibraryPreview,
    musicProviderId,
    webPreviewCount,
    webPreviewOptions,
  ]);

  useEffect(() => {
    if (!welcomePreview || restoreStartedRef.current) {
      return;
    }

    restoreStartedRef.current = true;
    const previewLibrary = createPreviewLibrary(
      webPreviewCount,
      webPreviewOptions,
    );
    const previewUser: User = {
      ...previewLibrary.user,
      id: "welcome-preview",
      nickname: welcomePreview.nickname,
      avatarUrl: welcomePreview.avatarUrl,
    };
    setSessionUser(previewUser);
    setSessionProviderId(welcomePreview.providerId);
    setMusicProviderId(welcomePreview.providerId);
    setLoginStage(
      welcomePreview.state === "validating" ? "restoring" : "idle",
    );
    if (welcomePreview.state === "returning-user") {
      setLibrary({ ...previewLibrary, user: previewUser });
      setWelcomeSessionState("returning-user");
      setLoginMessage("");
    } else if (welcomePreview.state === "validating") {
      setLibrary(null);
      setWelcomeSessionState("validating");
      setLoginMessage("");
    } else {
      setLibrary(null);
      setWelcomeSessionState("reconnect-required");
      setLoginMessage(t("welcome.session.invalid"));
    }
  }, [t, webPreviewCount, webPreviewOptions, welcomePreview]);

  useEffect(() => {
    if (restoreStartedRef.current || phase !== "welcome") {
      return;
    }

    restoreStartedRef.current = true;
    if (!initialIdentity) {
      setWelcomeSessionState("signed-out");
      setLoginStage("idle");
      setLoginMessage("");
      return;
    }

    const restoreGeneration = ++sessionGenerationRef.current;
    setWelcomeSessionState("validating");
    setLoginStage("restoring");
    setLoginMessage("");

    void musicProvider.restoreSession()
      .then(async (result) => {
        if (restoreGeneration !== sessionGenerationRef.current) {
          return;
        }
        if (!result.connected) {
          setLoginStage("idle");
          setWelcomeSessionState("reconnect-required");
          setLoginMessage(t("welcome.session.invalid"));
          return;
        }

        if (result.user) {
          setSessionUser(result.user);
        }
        await syncMusicLibrary(result.user);
      })
      .catch((error) => {
        if (restoreGeneration !== sessionGenerationRef.current) {
          return;
        }
        setLoginStage("idle");
        setWelcomeSessionState("reconnect-required");
        setLoginMessage(localizedProviderError(
          error,
          "welcome.session.verifyFailed",
        ));
      });
  }, [
    initialIdentity,
    localizedProviderError,
    musicProvider,
    phase,
    syncMusicLibrary,
    t,
  ]);

  useEffect(() => {
    if (
      (!qrSession && !oauthSession)
      || !isQrOpen
      || phase !== "welcome"
    ) {
      clearPollTimer();
      return;
    }

    const attemptGeneration = ++pollAttemptGenerationRef.current;
    let consecutiveFailures = 0;
    let visibleQrProgress: "waiting" | "scanned" = "waiting";

    const isCurrentAttempt = () =>
      pollAttemptGenerationRef.current === attemptGeneration;

    const schedulePoll = (delayMs: number) => {
      if (!isCurrentAttempt()) {
        return;
      }
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
      pollTimerRef.current = window.setTimeout(() => {
        pollTimerRef.current = null;
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (
        !isCurrentAttempt()
        || pollPendingRef.current === attemptGeneration
      ) {
        return;
      }

      pollPendingRef.current = attemptGeneration;
      let continuePolling = true;
      let nextDelayMs = qrPollIntervalMs;
      try {
        if (oauthSession) {
          if (!musicProvider.checkOAuthLogin) {
            throw new Error("Spotify OAuth polling is not available.");
          }
          const status = await musicProvider.checkOAuthLogin(oauthSession.key);
          if (!isCurrentAttempt()) {
            return;
          }
          consecutiveFailures = 0;
          if (status.state === "expired" || status.state === "error") {
            continuePolling = false;
            clearPollTimer();
            setLoginStage(status.state === "expired" ? "expired" : "error");
            setLoginMessage(status.state === "expired"
              ? t("welcome.qr.stage.expired")
              : t("welcome.error.spotifyAuth"));
          } else if (status.state === "authorized") {
            continuePolling = false;
            clearPollTimer();
            setLoginMessage(t("welcome.oauth.authorized"));
            await syncMusicLibrary(status.user);
          } else {
            setLoginStage("waiting");
            setLoginMessage(t("welcome.oauth.waiting"));
          }
        } else {
          const status = await withQrPollRequestTimeout(
            musicProvider.checkQrLogin(qrSession!.key),
          );
          if (!isCurrentAttempt()) {
            return;
          }
          consecutiveFailures = 0;
          if (status.state === "expired") {
            continuePolling = false;
            clearPollTimer();
            setLoginStage("expired");
            setLoginMessage(t("welcome.qr.stage.expired"));
          } else if (status.state === "authorized") {
            continuePolling = false;
            clearPollTimer();
            setLoginMessage(t("welcome.qr.authorized"));
            await syncMusicLibrary(status.user);
          } else {
            visibleQrProgress = advanceQrProgress(
              visibleQrProgress,
              status.state,
            );
            if (visibleQrProgress === "scanned") {
              setLoginStage("scanned");
              setLoginMessage(t("welcome.qr.scannedMessage", {
                app: musicProviderScanApp,
              }));
            } else {
              setLoginStage("waiting");
              setLoginMessage(t("welcome.qr.scanWith", {
                app: musicProviderScanApp,
              }));
            }
          }
        }
      } catch (error) {
        if (!isCurrentAttempt()) {
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= qrPollMaxConsecutiveFailures) {
          continuePolling = false;
          clearPollTimer();
          setLoginStage("error");
          setLoginMessage(localizedProviderError(
            error,
            "welcome.error.checkQr",
          ));
        } else {
          // A brief network or native invoke failure must not discard a QR
          // authorization that the phone has already completed. Keep the
          // furthest visible state and retry with a bounded backoff.
          setLoginMessage(localizedProviderError(
            error,
            "welcome.error.checkQr",
          ));
          nextDelayMs = qrPollRetryDelayMs(consecutiveFailures);
        }
      } finally {
        if (pollPendingRef.current === attemptGeneration) {
          pollPendingRef.current = null;
        }
        if (continuePolling && isCurrentAttempt()) {
          schedulePoll(nextDelayMs);
        }
      }
    };

    schedulePoll(0);

    return clearPollTimer;
  }, [
    clearPollTimer,
    isQrOpen,
    localizedProviderError,
    musicProvider,
    musicProviderScanApp,
    oauthSession,
    phase,
    qrSession,
    syncMusicLibrary,
    t,
  ]);

  useEffect(() => {
    if (loginStage !== "syncing" || phase !== "welcome") {
      return;
    }

    const timer = window.setInterval(() => {
      setSyncMessageIndex((index) => {
        const next = Math.min(index + 1, syncMessages.length - 1);
        setLoginMessage(syncMessages[next]);
        return next;
      });
    }, 1_150);

    return () => window.clearInterval(timer);
  }, [loginStage, phase, syncMessages]);

  useEffect(() => {
    if (phase !== "library" || !libraryRuntimeReady) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      homeEntranceTransition.markInteractive();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [libraryRuntimeReady, phase]);

  useEffect(() => {
    if (
      isWebLibraryPreview
      || phase !== "library"
      || !libraryRuntimeReady
      || !library
      || !sessionUser
      || !sessionProviderId
      || isSwitchingAccount
    ) {
      return;
    }
    const ownerKey = `${sessionProviderId}:${sessionUser.id}`;
    if (playbackRestoreAttemptedRef.current === ownerKey) {
      return;
    }
    playbackRestoreAttemptedRef.current = ownerKey;
    const stored = playbackSessionStore.load({
      providerId: sessionProviderId,
      accountId: sessionUser.id,
    });
    if (!stored) {
      return;
    }
    const restored = reconcileRestoredPlaybackSession(
      stored,
      library.tracks,
    );
    setPlayerPreferences({
      listeningSpace: restored.listeningSpace,
      playbackOrder: restored.queue.snapshot.order,
      repeatMode: restored.queue.snapshot.repeatMode,
      volume: restored.volume,
      muted: restored.muted,
    });
    const frameId = window.requestAnimationFrame(() => {
      requestImmersivePlaybackRestore(restored);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    isSwitchingAccount,
    isWebLibraryPreview,
    library,
    libraryRuntimeReady,
    phase,
    sessionProviderId,
    sessionUser,
    setPlayerPreferences,
  ]);

  useEffect(
    () => () => {
      clearPollTimer();
      loginTransitionAbortRef.current?.abort("Welcome screen unmounted");
      loginTransitionAbortRef.current = null;
    },
    [clearPollTimer],
  );

  const logout = useCallback(async () => {
    playbackPrefetchService.clearContext("Account logout requested");
    if (sessionProviderId && sessionUser?.id) {
      playbackSessionStore.clear({
        providerId: sessionProviderId,
        accountId: sessionUser.id,
      });
    }
    playbackRestoreAttemptedRef.current = null;
    const providerToDisconnect = sessionProviderId
      ? musicProviders[sessionProviderId]
      : musicProvider;
    try {
      const providersToDisconnect = new Set([providerToDisconnect]);
      if (musicProvider !== providerToDisconnect) {
        providersToDisconnect.add(musicProvider);
      }
      await Promise.allSettled(
        Array.from(providersToDisconnect, (provider) => provider.disconnect()),
      );
    } finally {
      sessionGenerationRef.current += 1;
      dailyListeningStore.deactivate(
        sessionProviderId ?? undefined,
        sessionUser?.id,
      );
      resetImmersivePlaybackSession();
      playbackQueueController.clear();
      queueOwnerRef.current = null;
      preservedAccountRef.current = null;
      loginTransitionAbortRef.current?.abort("Account disconnected");
      loginTransitionAbortRef.current = null;
      clearPollTimer();
      syncStartedRef.current = false;
      try {
        clearCachedWelcomeIdentity();
      } catch {
        // Runtime state is still cleared when persistent storage is unavailable.
      }
      setLibrary(null);
      setSessionUser(null);
      setSessionProviderId(null);
      setWelcomeSessionState("signed-out");
      setIsSwitchingAccount(false);
      setAccountPanelOpen(false);
      setQrSession(null);
      setOAuthSession(null);
      setIsQrOpen(false);
      setLoginStage("idle");
      setLoginMessage("");
      applyLoginTransitionStage("idle", true);
      setScanGeometry(null);
      setLoginSpaceGeometry(null);
      setPhase("welcome");
      setLibraryRuntimeReady(false);
      libraryCommittedRef.current = false;
    }
  }, [
    applyLoginTransitionStage,
    clearPollTimer,
    musicProvider,
    playbackPrefetchService,
    sessionProviderId,
    sessionUser?.id,
  ]);

  const isBusy =
    loginStage === "restoring"
    || loginStage === "creating"
    || loginStage === "syncing";

  const selectMusicProvider = useCallback(
    (nextProviderId: MusicProviderId) => {
      if (nextProviderId === musicProvider.id || isBusy) {
        return;
      }

      clearPollTimer();
      setQrSession(null);
      setOAuthSession(null);
      setIsQrOpen(false);
      setLoginStage("idle");
      setLoginMessage("");
      if (!preservedAccountRef.current) {
        try {
          window.localStorage.setItem(
            "tingjing:music-provider",
            nextProviderId,
          );
        } catch {
          // The selected provider remains active for the current session.
        }
      }
      syncStartedRef.current = false;
      setMusicProviderId(nextProviderId);
    },
    [clearPollTimer, isBusy, musicProvider.id],
  );

  const beginAccountSwitch = useCallback(() => {
    if (!sessionUser || !sessionProviderId || isBusy) {
      return;
    }
    preservedAccountRef.current = {
      providerId: sessionProviderId,
      user: sessionUser,
      library,
    };
    playbackPrefetchService.clearContext("Account switch requested");
    loginTransitionAbortRef.current?.abort("Account switch requested");
    loginTransitionAbortRef.current = null;
    clearPollTimer();
    setAccountPanelOpen(false);
    setIsSwitchingAccount(true);
    setMusicProviderId(sessionProviderId);
    setQrSession(null);
    setOAuthSession(null);
    setIsQrOpen(false);
    setLoginStage("idle");
    setLoginMessage("");
    setLibraryRuntimeReady(false);
    setPhase("welcome");
    applyLoginTransitionStage("idle", true);
  }, [
    applyLoginTransitionStage,
    clearPollTimer,
    isBusy,
    library,
    playbackPrefetchService,
    sessionProviderId,
    sessionUser,
  ]);

  const cancelAccountSwitch = useCallback(() => {
    const preserved = preservedAccountRef.current;
    if (!preserved) {
      return;
    }

    sessionGenerationRef.current += 1;
    clearPollTimer();
    if (musicProviderId !== preserved.providerId) {
      void musicProviders[musicProviderId].disconnect().catch(() => undefined);
    }
    syncStartedRef.current = false;
    preservedAccountRef.current = null;
    setMusicProviderId(preserved.providerId);
    setSessionProviderId(preserved.providerId);
    setSessionUser(preserved.user);
    setLibrary(preserved.library);
    setWelcomeSessionState("returning-user");
    setIsSwitchingAccount(false);
    setQrSession(null);
    setOAuthSession(null);
    setIsQrOpen(false);
    setLoginStage("idle");
    setLoginMessage("");
    playbackPrefetchService.setContext({
      providerId: preserved.providerId,
      accountId: preserved.user.id,
      provider: musicProviders[preserved.providerId],
    });
  }, [clearPollTimer, musicProviderId, playbackPrefetchService]);

  const enterCurrentLibrary = useCallback(async () => {
    if (!library || welcomeSessionState !== "returning-user") {
      return;
    }
    setAccountPanelOpen(false);
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    await enterLibrary(library);
  }, [enterLibrary, library, welcomeSessionState]);

  const qrDataUrl = qrSession
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSession.qrSvg)}`
    : "";

  const accountSettings = useMemo(
    () => sessionUser && sessionProviderId
      ? (
          <ThemeSettings
            user={sessionUser}
            providerId={sessionProviderId}
            providerName={musicProviders[sessionProviderId].displayName}
            open={accountPanelOpen}
            onOpenChange={setAccountPanelOpen}
            onSwitchAccount={beginAccountSwitch}
            onLogout={logout}
          />
        )
      : null,
    [
      accountPanelOpen,
      beginAccountSwitch,
      logout,
      sessionProviderId,
      sessionUser,
    ],
  );

  const showLoginChoice =
    welcomeSessionState === "signed-out" || isSwitchingAccount;
  const showReturningUser = !showLoginChoice && Boolean(sessionUser);
  const returningNickname = sessionUser?.nickname.trim() ?? "";
  const resolvedDailyListeningSummary =
    previewDailyListeningSummary ?? dailyListeningSummary;
  const resolvedDailyListeningStatus =
    welcomePreview?.dailyListeningStatus ?? "ready";
  const dailyListeningParts = formatDailyListeningDuration(
    resolvedDailyListeningStatus === "ready"
      ? resolvedDailyListeningSummary?.durationMs ?? null
      : null,
  );
  const hasDailyListening = dailyListeningParts !== null;
  const dailyListeningUnavailable = resolvedDailyListeningStatus === "error";
  const displayedLoginMessage = (() => {
    if (loginStage === "creating") {
      return isOAuthProvider
        ? t("welcome.oauth.opening")
        : t("welcome.qr.creating", { provider: musicProviderName });
    }
    if (loginStage === "waiting") {
      return isOAuthProvider
        ? t("welcome.oauth.waiting")
        : t("welcome.qr.scanWith", { app: musicProviderScanApp });
    }
    if (loginStage === "scanned") {
      return t("welcome.qr.scannedMessage", { app: musicProviderScanApp });
    }
    if (loginStage === "syncing") {
      return syncMessages[syncMessageIndex] ?? syncMessages[0];
    }
    if (loginStage === "expired") {
      return t("welcome.qr.stage.expired");
    }
    if (loginStage === "empty") {
      return t("welcome.qr.stage.empty");
    }
    return loginMessage;
  })();

  return (
    <main
      className="welcome"
      ref={bindWelcomeRef}
      style={{
        ...motionCssVariables,
        ...createLoginTransitionVariables(
          prefersReducedMotion,
          loginSpaceGeometry,
        ),
        ...createColorThemeVariables(theme),
      }}
      data-phase={phase}
      data-color-theme={resolvedThemeId}
      data-login-stage={loginStage}
      data-session-state={welcomeSessionState}
      data-switching-account={isSwitchingAccount}
      data-selected-provider={musicProvider.id}
    >
      <div className="welcome__library-environment" aria-hidden="true" />
      <AmbientCanvas
        active={
          phase === "welcome"
          && loginTransitionStage !== "preparing"
        }
        palette={particlePalette}
        paletteTransitionMs={theme.transitionDuration}
      />
      <div className="welcome__ambient-light" aria-hidden="true" />

      <header
        className="welcome__header"
        aria-hidden={phase !== "welcome"}
        inert={phase !== "welcome"}
      >
        <span className="welcome__wordmark">TINGJING</span>
        <span className="welcome__header-tools">
          <span className="welcome__edition">MUSIC EDIT / 012</span>
          <LanguageSelector
            className="welcome__language-selector"
            compact
            showLabel={false}
          />
        </span>
      </header>

      <section
        className="welcome__content"
        aria-labelledby="welcome-title"
        aria-hidden={phase !== "welcome"}
      >
        <div className="welcome__logo-wrap">
          <BrandMark
            markRef={brandMarkRef}
            portalRef={brandPortalRef}
          />
        </div>

        <div className="welcome__introduction">
          {showReturningUser ? (
            <>
              <p className="welcome__eyebrow">WELCOME BACK</p>
              <div className="welcome__returning-heading">
                <h1 id="welcome-title">
                  {returningNickname
                    ? t("welcome.returning.title")
                    : t("welcome.returning.titlePlain")}
                </h1>
                {returningNickname && (
                  <p className="welcome__returning-name">
                    {returningNickname}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="welcome__eyebrow">NEW MUSIC PLAYER</p>
              <h1 id="welcome-title">{t("welcome.new.title")}</h1>
              <p className="welcome__description">
                {t("welcome.new.description")}
              </p>
            </>
          )}
        </div>

        {showReturningUser && (
          <section
            className="welcome__daily-listening"
            data-has-data={hasDailyListening}
            data-scope="local"
            data-status={resolvedDailyListeningStatus}
            aria-label={t("welcome.daily.aria")}
            aria-live="polite"
          >
            <p className="welcome__daily-listening-label">
              {t("welcome.daily.label")}
            </p>
            {resolvedDailyListeningStatus === "loading" ? (
              <p
                className="welcome__daily-listening-placeholder"
                aria-label={t("welcome.daily.loading")}
              >
                <span>--</span><small>H</small>
                <span>--</span><small>MIN</small>
              </p>
            ) : dailyListeningUnavailable ? (
              <p className="welcome__daily-listening-empty">
                {t("welcome.daily.unavailable")}
              </p>
            ) : dailyListeningParts ? (
              <p className="welcome__daily-listening-value">
                {dailyListeningParts.map((part) => (
                  <span
                    className="welcome__daily-listening-part"
                    key={part.unit}
                  >
                    <strong>{part.value}</strong>
                    <span>{part.unit}</span>
                  </span>
                ))}
              </p>
            ) : (
              <p className="welcome__daily-listening-empty">
                {t("welcome.daily.empty")}
              </p>
            )}
          </section>
        )}

        <div className="welcome__actions">
          {showLoginChoice ? (
            <>
              <div
                className="provider-selector"
                role="radiogroup"
                aria-label={t("welcome.provider.select")}
              >
                {musicProviderOptions.map((provider) => (
                  <button
                    className="provider-selector__option"
                    type="button"
                    role="radio"
                    aria-checked={provider.id === musicProvider.id}
                    data-active={provider.id === musicProvider.id}
                    disabled={phase !== "welcome" || isBusy}
                    key={provider.id}
                    onClick={() => selectMusicProvider(provider.id)}
                  >
                    {formatProviderName(
                      language,
                      provider.id,
                      provider.displayName,
                    )}
                  </button>
                ))}
              </div>
              {musicProvider.id === "spotify" && <SpotifyClientSetup />}
              <button
                className="button button--primary"
                type="button"
                aria-expanded={isQrOpen}
                aria-controls="provider-login-panel"
                disabled={phase !== "welcome" || isBusy}
                onClick={() => {
                  if (!isQrOpen || loginStage === "idle") {
                    void createQrLogin();
                  } else {
                    clearPollTimer();
                    setIsQrOpen(false);
                    setQrSession(null);
                    setOAuthSession(null);
                    setLoginStage("idle");
                    setLoginMessage("");
                  }
                }}
              >
                <span>
                  {loginStage === "creating"
                    ? t("welcome.provider.connecting", {
                        provider: musicProviderName,
                      })
                    : isQrOpen
                      ? isOAuthProvider
                        ? t("common.close")
                        : t("welcome.provider.collapseQr")
                      : t("welcome.provider.connect", {
                          provider: musicProviderName,
                        })}
                </span>
                <span className="button__arrow" aria-hidden="true">↗</span>
              </button>
              {isSwitchingAccount && (
                <button
                  className="welcome__return-account"
                  type="button"
                  disabled={loginStage === "syncing"}
                  onClick={cancelAccountSwitch}
                >
                  {t("welcome.provider.returnCurrent")}
                </button>
              )}
            </>
          ) : welcomeSessionState === "validating" ? (
            <div
              className="welcome__validation-status"
              role="status"
              aria-live="polite"
            >
              <span>{t("welcome.session.validating")}</span>
              <span
                className="welcome__validation-line"
                aria-hidden="true"
              />
            </div>
          ) : (
            <button
              className="button button--primary welcome__enter-space"
              type="button"
              aria-expanded={isQrOpen}
              aria-controls={
                welcomeSessionState === "reconnect-required"
                  ? "provider-login-panel"
                  : undefined
              }
              disabled={
                phase !== "welcome"
                || (welcomeSessionState === "returning-user" && !library)
                || isBusy
              }
              onClick={() => {
                if (welcomeSessionState === "reconnect-required") {
                  if (isQrOpen) {
                    clearPollTimer();
                    setIsQrOpen(false);
                    setQrSession(null);
                    setOAuthSession(null);
                    setLoginStage("idle");
                  } else {
                    void createQrLogin();
                  }
                  return;
                }
                void enterCurrentLibrary();
              }}
            >
              <span>
                {welcomeSessionState === "reconnect-required"
                    ? isQrOpen
                      ? t("welcome.session.collapseReconnect")
                      : t("welcome.session.reconnect")
                    : t("welcome.session.continue")}
              </span>
              <span className="button__arrow" aria-hidden="true">→</span>
            </button>
          )}
        </div>

        <div
          className="login-reveal"
          id="provider-login-panel"
          data-open={isQrOpen}
          aria-hidden={!isQrOpen}
        >
          <div className="login-reveal__inner">
            <div
              className="provider-qr"
              ref={qrVisualRef}
              data-oauth={isOAuthProvider}
              data-loading={
                isOAuthProvider
                  ? !oauthSession || loginStage === "syncing"
                  : !qrSession || loginStage === "syncing"
              }
              aria-label={
                loginStage === "syncing"
                  ? t("welcome.qr.syncingAria", {
                      provider: musicProviderName,
                    })
                  : isOAuthProvider
                    ? t("welcome.oauth.label")
                    : t("welcome.qr.label", {
                        provider: musicProviderName,
                      })
              }
            >
              {isOAuthProvider && oauthSession && loginStage !== "syncing" ? (
                <img
                  className="provider-qr__spotify-logo"
                  src="/spotify/full-logo-black.svg"
                  alt="Spotify"
                />
              ) : qrDataUrl && loginStage !== "syncing" ? (
                <img
                  src={qrDataUrl}
                  alt={t("welcome.qr.label", {
                    provider: musicProviderName,
                  })}
                />
              ) : (
                <span className="provider-qr__loader" aria-hidden="true" />
              )}
            </div>

            <div className="login-reveal__copy">
              <div className="login-reveal__heading">
                <span className="login-reveal__pulse" aria-hidden="true" />
                <span>
                  {
                    loginStage === "syncing"
                      ? t("welcome.qr.stage.syncing")
                      : loginStage === "scanned"
                        ? t("welcome.qr.stage.scanned")
                        : loginStage === "expired"
                          ? t("welcome.qr.stage.expired")
                          : loginStage === "error"
                            ? t("welcome.qr.stage.error")
                            : loginStage === "empty"
                              ? t("welcome.qr.stage.empty")
                              : isOAuthProvider
                                ? t("welcome.oauth.label")
                                : t("welcome.qr.stage.waiting")
                  }
                </span>
              </div>
              <p>
                {displayedLoginMessage || (isOAuthProvider
                  ? t("welcome.oauth.waiting")
                  : t("welcome.qr.scanWith", {
                      app: musicProviderScanApp,
                    }))}
              </p>
              <small>
                {
                  loginStage === "syncing"
                    ? `${syncMessageIndex + 1} / ${syncMessages.length}`
                    : isOAuthProvider
                      ? t("welcome.oauth.localOnly")
                      : t("welcome.qr.localOnly")
                }
              </small>
              {(loginStage === "expired" || loginStage === "error") && (
                <button
                  className="mock-scan-success"
                  type="button"
                  onClick={() => void createQrLogin()}
                >
                  {isOAuthProvider
                    ? t("welcome.session.reconnect")
                    : t("welcome.qr.refresh")}
                  <span aria-hidden="true">→</span>
                </button>
              )}
              {loginStage === "empty" && (
                <button
                  className="mock-scan-success"
                  type="button"
                  onClick={() => void syncMusicLibrary()}
                >
                  {t("welcome.qr.resync")}
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </div>
        </div>

        <p className="welcome__status" role="status" aria-live="polite">
          {phase === "transitioning"
            ? t("welcome.status.opening")
            : displayedLoginMessage || "\u00A0"}
        </p>
      </section>

      {phase === "transitioning" && scanGeometry && (
        <ScanTransition geometry={scanGeometry} />
      )}

      <div
        className="welcome__space-reveal"
        aria-hidden={phase !== "library"}
      >
        <div className="welcome__library-reveal">
          <LibraryHome
            phase={libraryRuntimeReady ? "library" : "welcome"}
            library={library}
            musicProvider={runtimeProvider}
            providerId={runtimeProviderId}
            playbackPrefetchService={playbackPrefetchService}
          />
        </div>
        <span className="welcome__space-reveal-frame" />
      </div>
      {accountSettings}
      <ImmersivePlayer
        user={library?.user}
        providerId={runtimeProviderId}
        providerName={runtimeProvider.displayName}
        onLogout={logout}
        playbackPrefetchService={playbackPrefetchService}
      />

      <footer className="welcome__footer" aria-hidden={phase !== "welcome"}>
        <span>{musicProviderName.toUpperCase()} / BLACK + WHITE</span>
        <span aria-hidden="true">012</span>
        <span>2026</span>
      </footer>
    </main>
  );
}
