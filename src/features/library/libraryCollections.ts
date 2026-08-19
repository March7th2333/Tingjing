import type {
  Album,
  ArtistRef,
  MusicLibrary,
  Track,
} from "../../types/music";

export type LibraryCollectionKind =
  | "playlist"
  | "radio"
  | "album"
  | "artist";
export type LibrarySection = "playlists" | "radio" | "albums" | "artists";

export interface LibraryCollectionSummary {
  id: string;
  kind: LibraryCollectionKind;
  number: string;
  title: string;
  subtitle?: string;
  creator: string;
  coverImage?: string;
  trackCount: number;
  trackIds: string[];
  searchText: string;
  isPartial?: boolean;
}

export interface LibraryCollectionCatalog {
  playlists: LibraryCollectionSummary[];
  radio: LibraryCollectionSummary[];
  albums: LibraryCollectionSummary[];
  artists: LibraryCollectionSummary[];
  trackSearchById: ReadonlyMap<string, string>;
  stats: {
    playlistCount: number;
    albumCount: number;
    artistCount: number;
    trackCount: number;
  };
}

interface AlbumGroup {
  album: Album;
  trackIds: Set<string>;
  coverImage?: string;
  firstSeen: number;
}

interface ArtistGroup {
  id: string;
  name: string;
  trackIds: Set<string>;
  albumNames: Set<string>;
  coverImage?: string;
  firstSeen: number;
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}

export function normalizeLibrarySearch(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\u3000]+/g, "");
}

function albumIdentity(title: string, artist: string) {
  return `${normalize(title)}\u0000${normalize(artist)}`;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function fallbackArtists(track: Track): ArtistRef[] {
  return track.artist
    .split(/\s*\/\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function createDerivedAlbum(track: Track, index: number): AlbumGroup {
  const id = track.albumId
    ? track.albumId
    : `derived-album:${encodeURIComponent(
        albumIdentity(track.album, track.artist),
      )}`;

  return {
    album: {
      id,
      title: track.album || "未知专辑",
      artist: track.artist || "未知艺人",
      artistId: track.artists?.[0]?.id,
      coverImage: track.coverImage,
      trackCount: 0,
      trackIds: [],
    },
    trackIds: new Set<string>(),
    coverImage: track.coverImage,
    firstSeen: index,
  };
}

function buildAlbumCollections(library: MusicLibrary) {
  const groups = new Map<string, AlbumGroup>();
  const keyByAlbumId = new Map<string, string>();
  const keyByIdentity = new Map<string, string>();

  library.albums.forEach((album, index) => {
    const key = `album:${album.id}`;
    const group: AlbumGroup = {
      album,
      trackIds: new Set(album.trackIds),
      coverImage: album.coverImage,
      firstSeen: index,
    };

    groups.set(key, group);
    keyByAlbumId.set(album.id, key);
    keyByIdentity.set(albumIdentity(album.title, album.artist), key);
  });

  library.tracks.forEach((track, index) => {
    const identity = albumIdentity(track.album, track.artist);
    const existingKey =
      (track.albumId ? keyByAlbumId.get(track.albumId) : undefined)
      ?? keyByIdentity.get(identity);
    const key =
      existingKey
      ?? (track.albumId
        ? `album:${track.albumId}`
        : `album:${identity}:${track.album === "未知专辑" ? track.id : ""}`);
    let group = groups.get(key);

    if (!group) {
      group = createDerivedAlbum(track, library.albums.length + index);
      groups.set(key, group);
      if (track.albumId) {
        keyByAlbumId.set(track.albumId, key);
      }
      keyByIdentity.set(identity, key);
    }

    group.trackIds.add(track.id);
    group.coverImage ??= track.coverImage;
  });

  return [...groups.values()]
    .sort((left, right) => left.firstSeen - right.firstSeen)
    .map((group, index): LibraryCollectionSummary => {
      const trackIds = unique([
        ...group.album.trackIds,
        ...group.trackIds,
      ]);

      return {
        id: group.album.id,
        kind: "album",
        number: String(index + 1).padStart(3, "0"),
        title: group.album.title,
        subtitle: group.album.releaseDate,
        creator: group.album.artist,
        coverImage: group.coverImage,
        trackCount: Math.max(group.album.trackCount, trackIds.length),
        trackIds,
        searchText: "",
        isPartial: library.truncated,
      };
    });
}

function buildArtistCollections(library: MusicLibrary) {
  const groups = new Map<string, ArtistGroup>();

  library.tracks.forEach((track, trackIndex) => {
    const artists =
      track.artists && track.artists.length > 0
        ? track.artists
        : fallbackArtists(track);

    artists.forEach((artist) => {
      const key = artist.id
        ? `artist:${artist.id}`
        : `artist-name:${normalize(artist.name)}`;
      let group = groups.get(key);

      if (!group) {
        group = {
          id: artist.id ?? key,
          name: artist.name,
          trackIds: new Set<string>(),
          albumNames: new Set<string>(),
          coverImage: track.coverImage,
          firstSeen: trackIndex,
        };
        groups.set(key, group);
      }

      group.trackIds.add(track.id);
      if (track.album && track.album !== "未知专辑") {
        group.albumNames.add(track.album);
      }
      group.coverImage ??= track.coverImage;
    });
  });

  return [...groups.values()]
    .sort((left, right) => {
      const countDifference = right.trackIds.size - left.trackIds.size;
      return countDifference || left.firstSeen - right.firstSeen;
    })
    .map((group, index): LibraryCollectionSummary => ({
      id: group.id,
      kind: "artist",
      number: String(index + 1).padStart(3, "0"),
      title: group.name,
      subtitle: `${group.albumNames.size} ALBUM${
        group.albumNames.size === 1 ? "" : "S"
      }`,
      creator: group.name,
      coverImage: group.coverImage,
      trackCount: group.trackIds.size,
      trackIds: [...group.trackIds],
      searchText: "",
      isPartial: library.truncated,
    }));
}

function withSearchText(
  collections: LibraryCollectionSummary[],
) {
  return collections.map((collection) => ({
    ...collection,
    searchText: normalizeLibrarySearch(
      [
        collection.title,
        collection.subtitle,
        collection.creator,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  }));
}

export function collectionsForSection(
  catalog: LibraryCollectionCatalog,
  section: LibrarySection,
) {
  return catalog[section];
}

export function searchCurrentSection(
  query: string,
  section: LibrarySection,
  catalog: LibraryCollectionCatalog,
) {
  const normalizedQuery = normalizeLibrarySearch(query);
  const source = collectionsForSection(catalog, section);

  if (!normalizedQuery) {
    return source;
  }

  return source.filter((collection) => {
    if (collection.searchText.includes(normalizedQuery)) {
      return true;
    }

    return collection.trackIds.some((trackId) =>
      catalog.trackSearchById.get(trackId)?.includes(normalizedQuery)
    );
  });
}

export function buildLibraryCollectionCatalog(
  library: MusicLibrary,
): LibraryCollectionCatalog {
  const trackById = new Map(
    library.tracks.map((track) => [track.id, track]),
  );
  const trackSearchById = new Map(
    library.tracks.map((track) => [
      track.id,
      normalizeLibrarySearch(
        [
          track.title,
          track.translatedTitle,
          track.artist,
          track.album,
        ]
          .filter(Boolean)
          .join(" "),
      ),
    ]),
  );
  const playlists = withSearchText(library.playlists.map(
    (playlist, index): LibraryCollectionSummary => {
      // Playlist occurrences are ordered data. The same track may be added
      // more than once and each occurrence must retain its source index for
      // playback queue identity.
      const trackIds = [...playlist.trackIds];
      const firstTrackId = trackIds.find((trackId) => trackById.has(trackId));
      const firstTrack = firstTrackId
        ? trackById.get(firstTrackId)
        : undefined;

      return {
        id: playlist.id,
        kind: "playlist",
        number: playlist.number || String(index + 1).padStart(3, "0"),
        title: playlist.title,
        subtitle: playlist.subtitle,
        creator: playlist.creator,
        coverImage: playlist.coverImage ?? firstTrack?.coverImage,
        trackCount: Math.max(playlist.trackCount ?? 0, trackIds.length),
        trackIds,
        searchText: "",
      };
    },
  ));
  const radio = withSearchText(library.radios.map(
    (station): LibraryCollectionSummary => ({
      id: station.id,
      kind: "radio",
      number: station.number,
      title: station.title,
      subtitle: station.subtitle,
      creator: station.creator,
      coverImage: station.coverImage,
      trackCount: station.trackCount,
      trackIds: [...station.trackIds],
      searchText: "",
    }),
  ));
  const albums = withSearchText(buildAlbumCollections(library));
  const artists = withSearchText(buildArtistCollections(library));

  return {
    playlists,
    radio,
    albums,
    artists,
    trackSearchById,
    stats: {
      playlistCount: playlists.length,
      albumCount: albums.length,
      artistCount: artists.length,
      trackCount: Math.max(
        library.tracks.length,
        library.likedTrackIds.length,
      ),
    },
  };
}
