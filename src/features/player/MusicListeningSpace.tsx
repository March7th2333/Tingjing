import { memo } from "react";
import type {
  LyricLine,
  NormalizedLyricDocument,
  Track,
} from "../../types/music";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  detectLyricLanguage,
  LyricRevealEngine,
} from "./LyricRevealEngine";

interface MusicListeningSpaceProps {
  track: Track;
  lyrics: NormalizedLyricDocument;
  activeIndex: number;
  elapsedMs: number;
  isPlaying: boolean;
  showOriginalLyrics: boolean;
  showTranslation: boolean;
}

function getPrimaryText(
  line: LyricLine,
  showOriginalLyrics: boolean,
) {
  if (!showOriginalLyrics && line.translation) {
    return line.translation;
  }

  return line.text;
}

export const MusicListeningSpace = memo(function MusicListeningSpace({
  lyrics,
  activeIndex,
  elapsedMs,
  isPlaying,
  showOriginalLyrics,
  showTranslation,
}: MusicListeningSpaceProps) {
  const { t } = useLanguage();
  const lines = lyrics.lines;
  const safeActiveIndex = activeIndex >= 0 && activeIndex < lines.length
    ? activeIndex
    : -1;
  const currentLine: LyricLine = safeActiveIndex >= 0
    ? lines[safeActiveIndex]
    : { atMs: elapsedMs, text: "", translation: undefined };
  const previousLine = safeActiveIndex >= 0
    ? lines[safeActiveIndex - 1]
    : undefined;
  const nextLine = safeActiveIndex >= 0
    ? lines[safeActiveIndex + 1]
    : lines[0];
  const currentText = getPrimaryText(
    currentLine,
    showOriginalLyrics,
  );
  const currentLanguage = detectLyricLanguage(currentText);
  const previousText = previousLine
    ? getPrimaryText(previousLine, showOriginalLyrics)
    : "\u00A0";
  const nextText = nextLine
    ? getPrimaryText(nextLine, showOriginalLyrics)
    : "\u00A0";

  return (
    <div
      className="immersive-player__lyrics music-listening-space"
      data-listening-space="music"
      aria-label={t("space.music.aria")}
    >
      <p
        className="immersive-lyric"
        data-state="previous"
        data-language={detectLyricLanguage(previousText)}
        aria-hidden="true"
        lang={detectLyricLanguage(previousText)}
      >
        {previousText}
      </p>

      <div className="immersive-player__current-line">
        <p
          className="immersive-lyric"
          data-state="current"
          data-language={currentLanguage}
          lang={currentLanguage}
        >
          <LyricRevealEngine
            active
            elapsedMs={elapsedMs}
            isPlaying={isPlaying}
            lang={currentLanguage}
            line={currentLine}
            nextLine={nextLine}
            text={currentText}
          />
        </p>
        {showOriginalLyrics
          && showTranslation
          && currentLine.translation && (
          <span
            className="immersive-player__lyric-translation"
            lang="zh-CN"
          >
            {currentLine.translation}
          </span>
        )}
      </div>

      <p
        className="immersive-lyric"
        data-state="next"
        data-language={detectLyricLanguage(nextText)}
        aria-hidden="true"
        lang={detectLyricLanguage(nextText)}
      >
        {nextText}
      </p>

      <p
        className="immersive-player__lyric-announcer"
        aria-live="polite"
        aria-atomic="true"
      >
        {currentText}
        {showOriginalLyrics
          && showTranslation
          && currentLine.translation
          ? `，${currentLine.translation}`
          : ""}
      </p>
    </div>
  );
});
