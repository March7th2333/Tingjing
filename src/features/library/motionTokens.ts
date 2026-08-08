export const musicWallMotionTokens = {
  wallSpeed: 18,
  hoverScale: 1.065,
  hoverDepth: 30,
  tiltAmount: 5,
  transitionDuration: 360,
  hoverDuration: 220,
  returnDuration: 480,
  panelDuration: 480,
  wheelStrength: 0.72,
  dragSmoothing: 0.14,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  quietEasing: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

export const homeCarouselMotionTokens = {
  transitionDuration: 520,
  wheelPixelScale: 1.55,
  trackpadPixelScale: 1.18,
  wheelVelocityGain: 0.62,
  inertiaFriction: 0.91,
  snapStrength: 0.17,
  snapDamping: 0.72,
  inputIdleMs: 86,
  mouseMaximumSteps: 6,
  trackpadMaximumSteps: 10,
  dragMaximumSteps: 10,
  visibleBufferSteps: 3,
  settleVelocity: 18,
  settleDistance: 0.65,
  easing: "cubic-bezier(0.22, 0.82, 0.18, 1)",
  quietEasing: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

export const homeCategoryMotionTokens = {
  transitionDuration: 680,
  reducedTransitionDuration: 200,
  handoffProgress: 0.5,
  sideHandoffProgress: 0.6,
  centerSettleProgress: 0.82,
  sideSettleProgress: 0.9,
  centerShellMidDepth: -11,
  centerShellMidScale: 0.994,
  sideShellMidDepth: -16,
  sideShellMidScale: 0.988,
  centerArtworkShift: 6,
  sideArtworkShift: 8,
  easing: "cubic-bezier(0.32, 0.12, 0.2, 1)",
  quietEasing: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

/**
 * Home collection cover -> Music Wall uses an ambient/directory hand-off.
 * Collection artwork never owns a track card; the fixed pool forms from its
 * final coordinates while the same wall RAF begins underneath the medium.
 */
export const homeWallTransitionMotionTokens = {
  transitionDuration: 760,
  closeTransitionDuration: 820,
  reducedTransitionDuration: 200,
  // Scene ownership is monotonic in both directions. Keep these values in
  // sync with the matching percentages in library.css and the diagnostic
  // sampling schedule in LibraryHome.
  mediumOwnsViewportProgress: 0.28,
  wallReadableProgress: 0.42,
  wallHiddenOnReturnProgress: 0.46,
  homeRevealProgress: 0.52,
  sharedCoverHandoffProgress: 0.94,
  stableCommitProgress: 0.97,
  // The reversible click prelude and the single-click decision share one
  // clock, so the Portal continues from the exact pressed pose instead of
  // restarting after the double-click window closes.
  clickDecisionDuration: 220,
  returnBrakeDuration: 360,
  returnCardExitProgress: 0.44,
  lockDuration: 220,
  lockScale: 1.018,
  lockSideOpacity: 0.78,
  artworkMaxScale: 1.26,
  artworkReturnScale: 1.18,
  cardStaggerMs: 6,
  // The wall RAF starts with the opening coarse state. These progress values
  // only gate the first visible card band and its diagnostic sample: the
  // contrast field is already established before either becomes readable.
  wallMotionStartProgress: 0.26,
  firstReadableProgress: 0.42,
  cardFormDurationProgress: 0.42,
  openingInitialSpeedRatio: 0.55,
  portalParticipantBufferColumns: 1,
  sideOpacity: 0.08,
  wallStartScale: 0.94,
  easing: "cubic-bezier(0.32, 0, 0.18, 1)",
  quietEasing: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;
