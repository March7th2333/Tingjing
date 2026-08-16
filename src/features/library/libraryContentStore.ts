import type { MusicLibrary, Track } from "../../types/music";
import {
  buildLibraryCollectionCatalog,
  type LibraryCollectionCatalog,
  type LibraryCollectionSummary,
  type LibrarySection,
} from "./libraryCollections";

const librarySections: LibrarySection[] = [
  "playlists",
  "radio",
  "albums",
  "artists",
];

function collectionKey(collection: LibraryCollectionSummary) {
  return `${collection.kind}:${collection.id}`;
}

export interface LibraryContentStore {
  catalog: LibraryCollectionCatalog;
  trackById: ReadonlyMap<string, Track>;
  tracksFor(collection: LibraryCollectionSummary): Track[];
  durationFor(collection: LibraryCollectionSummary): number;
}

/**
 * Builds the immutable, collection-oriented indexes once when a library is
 * synchronized. Category changes can then select stable arrays and metadata
 * without rebuilding track lists in the render path.
 */
export function createLibraryContentStore(
  library: MusicLibrary,
): LibraryContentStore {
  const catalog = buildLibraryCollectionCatalog(library);
  const trackById = new Map(
    library.tracks.map((track) => [track.id, track] as const),
  );
  const tracksByCollection = new Map<string, Track[]>();
  const durationByCollection = new Map<string, number>();

  for (const section of librarySections) {
    for (const collection of catalog[section]) {
      const tracks = collection.trackIds
        .map((trackId) => trackById.get(trackId))
        .filter((track): track is Track => Boolean(track));
      const key = collectionKey(collection);

      tracksByCollection.set(key, tracks);
      durationByCollection.set(
        key,
        tracks.reduce(
          (duration, track) => duration + track.durationMs,
          0,
        ),
      );
    }
  }

  return {
    catalog,
    trackById,
    tracksFor(collection) {
      return tracksByCollection.get(collectionKey(collection)) ?? [];
    },
    durationFor(collection) {
      return durationByCollection.get(collectionKey(collection)) ?? 0;
    },
  };
}
