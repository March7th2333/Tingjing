import { memo } from "react";
import type { CSSProperties, SyntheticEvent } from "react";
import type { TrackPalette } from "../../types/music";

export type CoverAtmosphereState =
  | "browsing"
  | "prepared"
  | "opening"
  | "detail"
  | "closing";

type CoverAtmosphereStyle = CSSProperties &
  Record<
    | "--cover-atmosphere-background"
    | "--cover-atmosphere-ambient"
    | "--cover-atmosphere-accent",
    string
  >;

function hideBrokenLayer(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = true;
  event.currentTarget
    .closest<HTMLElement>(".cover-atmosphere")
    ?.setAttribute("data-cover-ready", "false");
}

function showReadyLayer(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.hidden = false;
  event.currentTarget
    .closest<HTMLElement>(".cover-atmosphere")
    ?.setAttribute("data-cover-ready", "true");
}

/**
 * Turns one intact cover into temporary light, texture and depth fields.
 * Every image layer keeps the original aspect and composition; no tiles or
 * random crops are created, so portraits and illustrations are never split.
 */
export const CoverAtmosphereRenderer = memo(
  function CoverAtmosphereRenderer({
    coverImage,
    palette,
    state,
  }: {
    coverImage?: string;
    palette: TrackPalette;
    state: CoverAtmosphereState;
  }) {
    const style: CoverAtmosphereStyle = {
      "--cover-atmosphere-background": palette.background,
      "--cover-atmosphere-ambient": palette.ambient,
      "--cover-atmosphere-accent": palette.accent,
    };

    return (
      <div
        className="cover-atmosphere"
        data-state={state}
        data-has-cover={Boolean(coverImage)}
        style={style}
        aria-hidden="true"
      >
        {coverImage && (
          <span className="cover-atmosphere__layer" data-layer="blur">
            <img
              src={coverImage}
              alt=""
              loading="eager"
              fetchPriority="high"
              decoding="async"
              draggable="false"
              onLoad={showReadyLayer}
              onError={hideBrokenLayer}
            />
          </span>
        )}
        <span className="cover-atmosphere__geometry" data-hint="frame" />
        <span className="cover-atmosphere__geometry" data-hint="axis" />
        <span className="cover-atmosphere__geometry" data-hint="field" />
      </div>
    );
  },
);
