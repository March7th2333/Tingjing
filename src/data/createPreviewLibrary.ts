import type { Album, MusicLibrary, Playlist, Track } from "../types/music";
import { mockTracks } from "./mockMusic";

function boundedPreviewCount(value: number) {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.max(1, Math.min(1_000, Math.round(value)));
}

interface PreviewLibraryOptions {
  tracksPerCollection?: number;
  repeatCover?: boolean;
  lyricLines?: number;
  brokenCover?: boolean;
  imprintWordTimings?: boolean;
  imprintMixedTimings?: boolean;
  imprintRepeats?: boolean;
  emptyLyrics?: boolean;
}

function splitPreviewTimingUnits(text: string) {
  const matches = Array.from(
    text.matchAll(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*|[^\s]/gu),
  );
  let cursor = 0;
  const units = matches.map((match) => {
    const start = match.index ?? cursor;
    const unit = text.slice(cursor, start) + match[0];
    cursor = start + match[0].length;
    return unit;
  });
  if (cursor < text.length && units.length > 0) {
    units[units.length - 1] += text.slice(cursor);
  }
  return units;
}

function createPreviewLyrics(
  track: Track,
  requestedLines: number,
  options: Pick<
    PreviewLibraryOptions,
    "imprintRepeats" | "imprintWordTimings"
    | "imprintMixedTimings"
  >,
) {
  const lineCount = Math.max(1, Math.min(180, Math.round(requestedLines)));
  const sourceLines =
    track.lyrics.length > 0
      ? track.lyrics
      : [{ atMs: 0, text: track.title }];

  return Array.from({ length: lineCount }, (_, index) => {
    const sourceLine = sourceLines[index % sourceLines.length];
    const serial = String(index + 1).padStart(3, "0");
    const usesWordTiming = options.imprintWordTimings
      || options.imprintMixedTimings;
    const lineIntervalMs = usesWordTiming ? 9_000 : 1_450;
    const atMs = index * lineIntervalMs;
    const text = options.imprintRepeats
      ? sourceLine.text
      : `${sourceLine.text} ${serial}`;
    const units = usesWordTiming
      ? splitPreviewTimingUnits(text)
      : [];
    const unitStepMs = units.length > 0
      ? Math.max(110, Math.floor(7_000 / units.length))
      : 0;
    return {
      atMs,
      text,
      translation: sourceLine.translation
        ? options.imprintRepeats
          ? sourceLine.translation
          : `${sourceLine.translation} ${serial}`
        : undefined,
      words: units.length > 0
        && (!options.imprintMixedTimings || index % 5 !== 4)
        ? units.map((unit, unitIndex) => ({
            text: unit,
            atMs: atMs + 240 + unitIndex * unitStepMs,
            durationMs: Math.min(180, Math.max(90, unitStepMs - 20)),
          }))
        : undefined,
    };
  });
}

export function createPreviewLibrary(
  requestedCount: number,
  options: PreviewLibraryOptions = {},
): MusicLibrary {
  const count = boundedPreviewCount(requestedCount);
  const tracksPerCollection = Math.max(
    1,
    Math.min(1_000, Math.round(options.tracksPerCollection ?? 1)),
  );
  const totalTrackCount = Math.min(1_000, count * tracksPerCollection);
  const tracks: Track[] = Array.from({ length: totalTrackCount }, (_, index) => {
    const collectionIndex = Math.floor(index / tracksPerCollection);
    const sourceIndex = options.repeatCover ? collectionIndex : index;
    const source = mockTracks[sourceIndex % mockTracks.length];
    const serial = String(index + 1).padStart(4, "0");
    const artist = `${source.artist} ${serial}`;
    const albumSerial = options.repeatCover
      ? String(collectionIndex + 1).padStart(4, "0")
      : serial;
    const albumId = `preview-album-${albumSerial}`;
    const clonedSource = structuredClone(source);
    const lyrics = options.emptyLyrics
      ? []
      : options.lyricLines === undefined
        ? clonedSource.lyrics
        : createPreviewLyrics(clonedSource, options.lyricLines, options);

    return {
      ...clonedSource,
      id: `preview-track-${serial}`,
      title: `${source.title} ${serial}`,
      artist,
      artists: [{ id: `preview-artist-${serial}`, name: artist }],
      album: `${source.album} ${albumSerial}`,
      albumId,
      durationMs: Math.max(
        clonedSource.durationMs,
        lyrics.at(-1)?.atMs ?? 0,
      ) + (
        options.imprintWordTimings || options.imprintMixedTimings
          ? 9_000
          : 4_200
      ),
      coverImage:
        options.brokenCover && index === 0
          ? "/__aural_preview_missing_cover__.jpg"
          : clonedSource.coverImage,
      lyrics,
    };
  });
  const playlists: Playlist[] = Array.from({ length: count }, (_, index) => {
    const start = index * tracksPerCollection;
    const collectionTracks = tracks.slice(
      start,
      Math.min(start + tracksPerCollection, tracks.length),
    );
    const track = collectionTracks[0] ?? tracks[index % tracks.length];
    const serial = String(index + 1).padStart(3, "0");
    return {
      id: `preview-playlist-${serial}`,
      number: serial,
      title: track.title,
      subtitle: track.translatedTitle,
      creator: track.artist,
      description: "",
      coverImage: track.coverImage,
      trackCount: collectionTracks.length,
      trackIds: collectionTracks.map(({ id }) => id),
    };
  });
  const albumGroups = new Map<string, Track[]>();
  tracks.forEach((track) => {
    const albumId = track.albumId ?? `preview-album-${track.id}`;
    const group = albumGroups.get(albumId) ?? [];
    group.push(track);
    albumGroups.set(albumId, group);
  });
  const albums: Album[] = Array.from(albumGroups, ([id, albumTracks]) => {
    const track = albumTracks[0];
    return {
      id,
      title: track.album,
      artist: track.artist,
      artistId: track.artists?.[0]?.id,
      coverImage: track.coverImage,
      trackCount: albumTracks.length,
      trackIds: albumTracks.map(({ id: trackId }) => trackId),
    };
  });

  return {
    user: {
      id: "web-preview",
      nickname: "WEB PREVIEW",
    },
    playlists,
    radios: [],
    albums,
    tracks,
    likedTrackIds: tracks.map((track) => track.id),
    syncedAt: Date.now(),
    source: "demo",
    truncated: totalTrackCount >= 1_000,
  };
}
