import "./spotify-attribution.css";

interface SpotifyAttributionProps {
  actionLabel?: "OPEN SPOTIFY" | "PLAY ON SPOTIFY" | "LISTEN ON SPOTIFY";
  compact?: boolean;
  disabled?: boolean;
  onOpen: () => void;
}

/**
 * Spotify metadata must always retain an official brand attribution and a
 * direct route back to Spotify. The artwork itself stays separate from this
 * control so the logo is never placed over a cover.
 */
export function SpotifyAttribution({
  actionLabel = "OPEN SPOTIFY",
  compact = false,
  disabled = false,
  onOpen,
}: SpotifyAttributionProps) {
  return (
    <button
      className="spotify-attribution"
      type="button"
      data-compact={compact}
      disabled={disabled}
      aria-label={actionLabel}
      onClick={onOpen}
    >
      <span className="spotify-attribution__mark" aria-hidden="true">
        <img
          className="spotify-attribution__logo spotify-attribution__logo--light"
          src="/spotify/full-logo-black.svg"
          alt=""
        />
        <img
          className="spotify-attribution__logo spotify-attribution__logo--dark"
          src="/spotify/full-logo-white.svg"
          alt=""
        />
      </span>
      {!compact && <span>{actionLabel}</span>}
    </button>
  );
}
