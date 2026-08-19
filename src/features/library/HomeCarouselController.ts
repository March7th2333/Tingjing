/**
 * Pure carousel math shared by the React shell and the RAF renderer.
 *
 * The visible track uses a bounded window of unbounded logical positions.
 * A position keeps the same identity while it crosses the viewport; only
 * off-screen positions are added or removed when the window is rebased.
 */
export function positiveModulo(value: number, length: number) {
  if (length <= 0) {
    return 0;
  }

  return ((value % length) + length) % length;
}

export function normalizeCarouselTravel(delta: number) {
  if (!Number.isFinite(delta)) {
    return 0;
  }

  return Math.trunc(delta);
}

export function advanceCarouselLogicalIndex(
  currentIndex: number,
  delta: number,
) {
  const current = Number.isFinite(currentIndex)
    ? Math.trunc(currentIndex)
    : 0;
  return current + normalizeCarouselTravel(delta);
}

export function createCarouselSlotOffsets(
  itemCount: number,
  maximumTravelSteps: number,
  visibleBuffer = 3,
) {
  if (itemCount <= 0) {
    return [];
  }
  if (itemCount === 1) {
    return [0];
  }

  const radius = Math.max(
    1,
    Math.ceil(maximumTravelSteps) + Math.max(2, Math.ceil(visibleBuffer)),
  );
  return Array.from(
    { length: radius * 2 + 1 },
    (_, index) => index - radius,
  );
}

export function carouselLogicalItemKey(
  scope: string,
  logicalPosition: number,
  collectionId: string,
) {
  return `home-carousel-item:${scope}:${logicalPosition}:${collectionId}`;
}
