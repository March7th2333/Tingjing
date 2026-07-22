import type { CSSProperties } from "react";
import {
  transitionManager,
  type TransitionContext,
  type TransitionResult,
} from "../../config/TransitionManager";
import {
  homeEntrancePerformanceMarks,
  markHomeEntrancePerformance,
} from "./HomeEntranceTransition";

export type LoginTransitionStage =
  | "idle"
  | "preparing"
  | "merging"
  | "opening"
  | "revealing"
  | "settling"
  | "complete";

export const loginTransitionMotion = {
  masterDurationMs: 1_500,
  openingAtMs: 200,
  revealingAtMs: 480,
  settlingAtMs: 1_150,
  reducedMasterDurationMs: 190,
  reducedOpeningAtMs: 24,
  reducedRevealingAtMs: 68,
  reducedSettlingAtMs: 148,
} as const;

type LoginTransitionVariables = CSSProperties &
  Record<
    | "--login-transition-merge"
    | "--login-transition-opening"
    | "--login-transition-reveal"
    | "--login-transition-settle"
    | "--login-transition-space"
    | "--login-transition-master"
    | "--login-portal-top"
    | "--login-portal-right"
    | "--login-portal-bottom"
    | "--login-portal-left"
    | "--login-portal-seed-width"
    | "--login-portal-seed-height"
    | "--login-portal-frame-x"
    | "--login-portal-frame-y"
    | "--login-portal-frame-scale-x"
    | "--login-portal-frame-scale-y",
    string
  >;

export interface LoginSpaceGeometry {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export function createLoginTransitionVariables(
  prefersReducedMotion: boolean,
  geometry?: LoginSpaceGeometry | null,
): LoginTransitionVariables {
  const masterDuration = prefersReducedMotion
    ? loginTransitionMotion.reducedMasterDurationMs
    : loginTransitionMotion.masterDurationMs;

  // Keep the legacy variables available to old selectors and instrumentation,
  // but make them proportional landmarks inside one master timeline. Visual
  // layers must use `--login-transition-master`; none of these values is a
  // serial wait boundary anymore.
  const mergeDuration = masterDuration * 0.2;
  const openingDuration = masterDuration * 0.3;
  const revealDuration = masterDuration * (4 / 15);
  const settleDuration = masterDuration * (7 / 30);

  return {
    "--login-transition-merge": String(mergeDuration) + "ms",
    "--login-transition-opening": String(openingDuration) + "ms",
    "--login-transition-reveal": String(revealDuration) + "ms",
    "--login-transition-settle": String(settleDuration) + "ms",
    "--login-transition-space": String(masterDuration) + "ms",
    "--login-transition-master": String(masterDuration) + "ms",
    "--login-portal-top": `${geometry?.top ?? 0}px`,
    "--login-portal-right": `${geometry?.right ?? 0}px`,
    "--login-portal-bottom": `${geometry?.bottom ?? 0}px`,
    "--login-portal-left": `${geometry?.left ?? 0}px`,
    "--login-portal-seed-width": `${geometry?.width ?? 1}px`,
    "--login-portal-seed-height": `${geometry?.height ?? 1}px`,
    "--login-portal-frame-x": `${-(geometry?.left ?? 0)}px`,
    "--login-portal-frame-y": `${-(geometry?.top ?? 0)}px`,
    "--login-portal-frame-scale-x": String(
      geometry
        ? geometry.viewportWidth / Math.max(1, geometry.width)
        : 1,
    ),
    "--login-portal-frame-scale-y": String(
      geometry
        ? geometry.viewportHeight / Math.max(1, geometry.height)
        : 1,
    ),
  };
}

interface LoginTransitionRunOptions<Result> {
  signal?: AbortSignal;
  prefersReducedMotion: boolean;
  prepare: (context: TransitionContext) => void | Promise<void>;
  onStage: (stage: LoginTransitionStage) => void;
  complete: (context: TransitionContext) => Result;
}

/**
 * Owns the login -> library lifecycle without animating through React.
 *
 * React only receives coarse lifecycle boundaries. The visual layers all run
 * from one compositor-owned master clock; stage names are milestones for
 * accessibility/performance telemetry and never restart CSS animation.
 */
export class LoginTransitionController {
  run<Result>({
    signal,
    prefersReducedMotion,
    prepare,
    onStage,
    complete,
  }: LoginTransitionRunOptions<Result>): Promise<TransitionResult<Result>> {
    const masterDuration = prefersReducedMotion
      ? loginTransitionMotion.reducedMasterDurationMs
      : loginTransitionMotion.masterDurationMs;
    const openingAt = prefersReducedMotion
      ? loginTransitionMotion.reducedOpeningAtMs
      : loginTransitionMotion.openingAtMs;
    const revealingAt = prefersReducedMotion
      ? loginTransitionMotion.reducedRevealingAtMs
      : loginTransitionMotion.revealingAtMs;
    const settlingAt = prefersReducedMotion
      ? loginTransitionMotion.reducedSettlingAtMs
      : loginTransitionMotion.settlingAtMs;

    return transitionManager.run(
      "login-home",
      {
        prepare: async (transition) => {
          await prepare(transition);
          if (!transition.signal.aborted) {
            onStage("merging");
          }
        },
        animate: async (transition) => {
          const markStage = async (
            delayMs: number,
            stage: LoginTransitionStage,
          ) => {
            await transition.wait(delayMs);
            if (transition.isCurrent()) {
              onStage(stage);
            }
          };

          await Promise.all([
            transition.wait(masterDuration),
            markStage(openingAt, "opening"),
            markStage(revealingAt, "revealing"),
            markStage(settlingAt, "settling"),
          ]);
          markHomeEntrancePerformance(
            homeEntrancePerformanceMarks.loginAnimationComplete,
          );
        },
        complete: (transition) => {
          // WelcomeScreen commits `phase`, runtime readiness and the final
          // login stage in one React batch. Imperatively writing `complete`
          // here used to create a real intermediate DOM state:
          //   phase=transitioning + loginTransition=complete
          // No reveal selector owned that combination, so the full Home could
          // fall back to its hidden entry transform for one frame.
          return complete(transition);
        },
      },
      { signal },
    );
  }
}

export const loginTransitionController = new LoginTransitionController();
