import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatProviderName } from "../../i18n/formatters";
import type { MessageKey } from "../../i18n/messages";
import { useColorTheme } from "../../theme/ColorThemeContext";
import type { ColorThemePreference } from "../../types/colorTheme";
import type { User } from "../../types/music";
import type { MusicProviderId } from "../../providers/MusicProvider";
import {
  usePlayerPreferences,
  type AnimationIntensity,
  type ParticleQuality,
} from "./playerPreferences";
import { LanguageSelector } from "./LanguageSelector";
import "./theme-settings.css";

const appearanceOptions: Array<{
  value: ColorThemePreference;
  labelKey: MessageKey;
}> = [
  { value: "system", labelKey: "settings.appearance.system" },
  { value: "dark", labelKey: "settings.appearance.dark" },
  { value: "light", labelKey: "settings.appearance.light" },
];

const animationOptions: Array<{
  value: AnimationIntensity;
  labelKey: MessageKey;
}> = [
  { value: "low", labelKey: "settings.level.low" },
  { value: "standard", labelKey: "settings.level.standard" },
  { value: "high", labelKey: "settings.level.high" },
];

const particleOptions: Array<{
  value: ParticleQuality;
  labelKey: MessageKey;
}> = [
  { value: "auto", labelKey: "settings.particles.auto" },
  { value: "low", labelKey: "settings.level.low" },
  { value: "standard", labelKey: "settings.level.standard" },
  { value: "high", labelKey: "settings.level.high" },
];

interface ThemeSettingsProps {
  user?: User;
  providerId?: MusicProviderId;
  providerName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSwitchAccount?: () => void;
  onLogout?: () => Promise<void>;
}

function DefaultAvatar() {
  return (
    <svg
      className="theme-settings__avatar-fallback"
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <circle cx="16" cy="11" r="6" />
      <path d="M5.5 29c.8-7 4.3-10.5 10.5-10.5S25.7 22 26.5 29Z" />
    </svg>
  );
}

export function ThemeSettings({
  user,
  providerId,
  providerName,
  open,
  onOpenChange,
  onSwitchAccount,
  onLogout,
}: ThemeSettingsProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isConfirmingLogout, setIsConfirmingLogout] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { preference, setPreference } = useColorTheme();
  const { language, t } = useLanguage();
  const [playerPreferences, updatePlayerPreferences] =
    usePlayerPreferences();
  const hasAvatar = Boolean(user?.avatarUrl) && !avatarFailed;
  const isOpen = open ?? internalOpen;
  const connectedProviderName = providerId
    ? formatProviderName(
        language,
        providerId,
        providerName?.trim() || t("settings.account.generic"),
      )
    : providerName?.trim() || t("settings.account.generic");
  const hasConnectedProvider = Boolean(user && providerId && providerName?.trim());
  const logoutLabel = t("settings.account.logoutProvider", {
    provider: connectedProviderName,
  });

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.avatarUrl]);

  useEffect(() => {
    if (!isOpen) {
      setIsConfirmingLogout(false);
    }
  }, [isOpen]);

  const setOpen = useCallback((nextOpen: boolean) => {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, setOpen]);

  return (
    <div
      className="theme-settings"
      data-open={isOpen}
      ref={containerRef}
    >
      <button
        className="theme-settings__trigger"
        type="button"
        ref={triggerRef}
        aria-label={t("settings.account.open")}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="theme-settings-panel"
        onClick={() => setOpen(!isOpen)}
      >
        {hasAvatar ? (
          <img
            className="theme-settings__avatar"
            src={user?.avatarUrl}
            alt=""
            decoding="async"
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <DefaultAvatar />
        )}
      </button>

      <aside
        className="theme-settings__panel"
        id="theme-settings-panel"
        role="dialog"
        aria-label={t("settings.account.dialog")}
        aria-hidden={!isOpen}
        inert={!isOpen}
      >
        <header className="theme-settings__profile">
          <span className="theme-settings__profile-avatar" aria-hidden="true">
            {hasAvatar ? (
              <img
                src={user?.avatarUrl}
                alt=""
                decoding="async"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <DefaultAvatar />
            )}
          </span>
          <span className="theme-settings__profile-copy">
            <strong>{user?.nickname ?? connectedProviderName}</strong>
            <small>
              {hasConnectedProvider
                ? t("settings.account.connected", {
                    provider: connectedProviderName,
                  })
                : t("settings.account.disconnected")}
            </small>
          </span>
        </header>

        <section className="theme-settings__group">
          <span className="theme-settings__label">
            {t("settings.appearance.label")}
          </span>
          <div
            className="theme-settings__segments"
            data-columns="3"
            role="radiogroup"
            aria-label={t("settings.appearance.aria")}
          >
            {appearanceOptions.map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={preference === option.value}
                data-active={preference === option.value}
                key={option.value}
                onClick={() => setPreference(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </section>

        <LanguageSelector className="theme-settings__language" />

        <section className="theme-settings__setting-list">
          <button
            className="theme-settings__switch-row"
            type="button"
            role="switch"
            aria-checked={playerPreferences.showTranslation}
            onClick={() =>
              updatePlayerPreferences({
                showTranslation: !playerPreferences.showTranslation,
              })
            }
          >
            <span>{t("settings.lyrics.translation")}</span>
            <span className="theme-settings__switch" aria-hidden="true" />
          </button>
        </section>

        <section className="theme-settings__group">
          <span className="theme-settings__label">
            {t("settings.animation.label")}
          </span>
          <div
            className="theme-settings__segments"
            data-columns="3"
            role="radiogroup"
            aria-label={t("settings.animation.aria")}
          >
            {animationOptions.map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={
                  playerPreferences.animationIntensity === option.value
                }
                data-active={
                  playerPreferences.animationIntensity === option.value
                }
                key={option.value}
                onClick={() =>
                  updatePlayerPreferences({
                    animationIntensity: option.value,
                  })
                }
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </section>

        <section className="theme-settings__group">
          <span className="theme-settings__label">
            {t("settings.particles.label")}
          </span>
          <div
            className="theme-settings__segments"
            data-columns="4"
            role="radiogroup"
            aria-label={t("settings.particles.aria")}
          >
            {particleOptions.map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={
                  playerPreferences.particleQuality === option.value
                }
                data-active={
                  playerPreferences.particleQuality === option.value
                }
                key={option.value}
                onClick={() =>
                  updatePlayerPreferences({ particleQuality: option.value })
                }
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </section>

        <section className="theme-settings__setting-list">
          <button
            className="theme-settings__switch-row"
            type="button"
            role="switch"
            aria-checked={playerPreferences.audioResponseEnabled}
            onClick={() =>
              updatePlayerPreferences({
                audioResponseEnabled:
                  !playerPreferences.audioResponseEnabled,
              })
            }
          >
            <span>{t("settings.audioResponse")}</span>
            <span className="theme-settings__switch" aria-hidden="true" />
          </button>
        </section>

        {(onSwitchAccount || onLogout) && (
          <section className="theme-settings__account-actions">
            {onSwitchAccount && (
              <button
                className="theme-settings__account-action"
                type="button"
                disabled={isLoggingOut}
                onClick={() => {
                  setOpen(false);
                  onSwitchAccount();
                }}
              >
                <span>{t("settings.account.switch")}</span>
                <span aria-hidden="true">→</span>
              </button>
            )}

            {onLogout && !isConfirmingLogout && (
              <button
                className="theme-settings__logout"
                type="button"
                disabled={isLoggingOut}
                onClick={() => setIsConfirmingLogout(true)}
              >
                <span>
                  {isLoggingOut
                    ? t("settings.account.loggingOut")
                    : hasConnectedProvider
                      ? logoutLabel
                      : t("settings.account.logoutCurrent")}
                </span>
                <span aria-hidden="true">→</span>
              </button>
            )}

            {onLogout && isConfirmingLogout && (
              <div
                className="theme-settings__logout-confirm"
                role="alertdialog"
                aria-labelledby="theme-settings-logout-title"
                aria-describedby="theme-settings-logout-description"
              >
                <strong id="theme-settings-logout-title">
                  {t("settings.account.logoutConfirm")}
                </strong>
                <p id="theme-settings-logout-description">
                  {t("settings.account.logoutDescription")}
                </p>
                <div>
                  <button
                    type="button"
                    disabled={isLoggingOut}
                    onClick={() => setIsConfirmingLogout(false)}
                  >
                    {t("settings.account.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={isLoggingOut}
                    onClick={() => {
                      setIsLoggingOut(true);
                      void onLogout()
                        .then(() => setOpen(false))
                        .catch(() => undefined)
                        .finally(() => setIsLoggingOut(false));
                    }}
                  >
                    {isLoggingOut
                      ? t("settings.account.loggingOut")
                      : t("settings.account.logout")}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}
