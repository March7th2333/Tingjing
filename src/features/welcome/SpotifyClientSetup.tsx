import { useEffect, useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { spotifyClientIdStorageKey } from "../../providers/SpotifyMusicProvider";
import "./spotify-client-setup.css";

export const spotifyRedirectRegistrationUri = "http://127.0.0.1/callback";

function configuredClientId() {
  const bundled = import.meta.env.VITE_SPOTIFY_CLIENT_ID?.trim();
  if (bundled) {
    return bundled;
  }
  try {
    return window.localStorage.getItem(spotifyClientIdStorageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function SpotifyClientSetup() {
  const { t } = useLanguage();
  const [clientId, setClientId] = useState(configuredClientId);
  const bundled = Boolean(import.meta.env.VITE_SPOTIFY_CLIENT_ID?.trim());

  useEffect(() => {
    if (bundled) {
      return;
    }
    try {
      if (clientId.trim()) {
        window.localStorage.setItem(
          spotifyClientIdStorageKey,
          clientId.trim(),
        );
      } else {
        window.localStorage.removeItem(spotifyClientIdStorageKey);
      }
    } catch {
      // The value remains available for the current mounted session.
    }
  }, [bundled, clientId]);

  return (
    <section
      className="spotify-client-setup"
      aria-label={t("welcome.spotifySetup.aria")}
    >
      <div className="spotify-client-setup__topline">
        <span>SPOTIFY OAUTH / PKCE</span>
        <a
          href="https://developer.spotify.com/dashboard"
          target="_blank"
          rel="noreferrer"
        >
          DASHBOARD ↗
        </a>
      </div>
      {bundled ? (
        <p>{t("welcome.spotifySetup.configured")}</p>
      ) : (
        <label>
          <span>CLIENT ID</span>
          <input
            type="text"
            value={clientId}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("welcome.spotifySetup.placeholder")}
            onChange={(event) => setClientId(event.currentTarget.value)}
          />
        </label>
      )}
      <small>
        {t("welcome.spotifySetup.redirect")}
        <code>{spotifyRedirectRegistrationUri}</code>
      </small>
    </section>
  );
}
