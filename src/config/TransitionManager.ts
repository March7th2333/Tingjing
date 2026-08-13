export const transitionNames = [
  "login-home",
  "home-wall",
  "wall-home",
  "wall-detail",
  "detail-player",
  "player-detail",
  "listening-space",
] as const;

export type TransitionName = (typeof transitionNames)[number];

export interface TransitionContext {
  readonly id: number;
  readonly name: TransitionName;
  readonly signal: AbortSignal;
  wait(durationMs: number): Promise<void>;
  afterPaint(frameCount?: number): Promise<void>;
  isCurrent(): boolean;
}

export interface TransitionSteps<Result = void> {
  prepare?: (context: TransitionContext) => void | Promise<void>;
  animate?: (context: TransitionContext) => void | Promise<void>;
  complete: (context: TransitionContext) => Result;
}

export type TransitionResult<Result> =
  | {
    status: "completed";
    value: Result;
  }
  | {
    status: "cancelled";
  };

export interface TransitionOptions {
  signal?: AbortSignal;
}

interface ActiveTransition {
  channel: TransitionChannel;
  controller: AbortController;
  id: number;
  name: TransitionName;
}

type TransitionChannel = "entry" | "navigation" | "player-space";

function transitionChannelFor(name: TransitionName): TransitionChannel {
  if (name === "login-home") {
    return "entry";
  }
  if (name === "listening-space") {
    return "player-space";
  }
  return "navigation";
}

function abortError() {
  const error = new Error("Transition cancelled");
  error.name = "AbortError";
  return error;
}

function canUseAnimationFrame() {
  return typeof window !== "undefined"
    && typeof window.requestAnimationFrame === "function";
}

/**
 * Serializes related spatial transitions without owning any React state.
 *
 * A run always performs prepare -> paint boundary -> animate -> complete.
 * Starting a new run aborts the previous run in the same channel. Login,
 * navigation and in-player space changes use separate channels so independent
 * lifecycles cannot cancel one another, while obsolete work inside each
 * surface still cannot commit after a newer transition starts.
 */
export class TransitionManager {
  private readonly activeByChannel = new Map<
    TransitionChannel,
    ActiveTransition
  >();
  private nextId = 0;

  async run<Result>(
    name: TransitionName,
    steps: TransitionSteps<Result>,
    options: TransitionOptions = {},
  ): Promise<TransitionResult<Result>> {
    if (options.signal?.aborted) {
      return { status: "cancelled" };
    }
    const channel = transitionChannelFor(name);
    this.cancelChannel(channel, "Superseded by a new spatial transition");

    const controller = new AbortController();
    const transition: ActiveTransition = {
      channel,
      controller,
      id: ++this.nextId,
      name,
    };
    this.activeByChannel.set(channel, transition);

    const externalSignal = options.signal;
    const handleExternalAbort = () => {
      controller.abort(externalSignal?.reason);
    };

    if (externalSignal?.aborted) {
      handleExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", handleExternalAbort, {
        once: true,
      });
    }

    const context: TransitionContext = {
      id: transition.id,
      name,
      signal: controller.signal,
      wait: (durationMs) => this.wait(durationMs, controller.signal),
      afterPaint: (frameCount = 1) =>
        this.afterPaint(controller.signal, frameCount),
      isCurrent: () => this.isCurrent(transition.id),
    };

    try {
      this.assertCurrent(transition);
      await this.awaitAbortable(
        steps.prepare?.(context),
        controller.signal,
      );
      this.assertCurrent(transition);

      await context.afterPaint();
      this.assertCurrent(transition);

      await this.awaitAbortable(
        steps.animate?.(context),
        controller.signal,
      );
      this.assertCurrent(transition);

      return {
        status: "completed",
        value: steps.complete(context),
      };
    } catch (error) {
      if (
        controller.signal.aborted
        || !this.isCurrent(transition.id)
      ) {
        return { status: "cancelled" };
      }
      controller.abort(error);
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", handleExternalAbort);
      if (this.activeByChannel.get(channel)?.id === transition.id) {
        this.activeByChannel.delete(channel);
      }
    }
  }

  cancel(reason: unknown = "Transition cancelled") {
    for (const active of this.activeByChannel.values()) {
      active.controller.abort(reason);
    }
    this.activeByChannel.clear();
  }

  cancelIfCurrent(
    transitionId: number,
    reason: unknown = "Transition cancelled",
  ) {
    const active = this.findActive(transitionId);
    if (!active) {
      return false;
    }
    this.activeByChannel.delete(active.channel);
    active.controller.abort(reason);
    return true;
  }

  isCurrent(id: number) {
    const active = this.findActive(id);
    return Boolean(active && !active.controller.signal.aborted);
  }

  wait(durationMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }

    return new Promise((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      }, Math.max(0, durationMs));

      const handleAbort = () => {
        globalThis.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", handleAbort);
        reject(abortError());
      };

      signal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  afterPaint(signal?: AbortSignal, frameCount = 1): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }

    const requestedPaints = Math.max(1, Math.floor(frameCount));
    // RAF callbacks run before paint. A second callback guarantees that the
    // prepared frame has actually been presented before animation starts.
    const frames = canUseAnimationFrame()
      ? requestedPaints + 1
      : requestedPaints;

    return new Promise((resolve, reject) => {
      let frameId: number | ReturnType<typeof globalThis.setTimeout> | null =
        null;
      let remaining = frames;

      const cleanup = () => {
        signal?.removeEventListener("abort", handleAbort);
      };

      const handleAbort = () => {
        if (frameId !== null) {
          if (canUseAnimationFrame()) {
            window.cancelAnimationFrame(frameId as number);
          } else {
            globalThis.clearTimeout(
              frameId as ReturnType<typeof globalThis.setTimeout>,
            );
          }
        }
        cleanup();
        reject(abortError());
      };

      const next = () => {
        if (signal?.aborted) {
          handleAbort();
          return;
        }

        remaining -= 1;
        if (remaining <= 0) {
          cleanup();
          resolve();
          return;
        }
        schedule();
      };

      const schedule = () => {
        frameId = canUseAnimationFrame()
          ? window.requestAnimationFrame(next)
          : globalThis.setTimeout(next, 0);
      };

      signal?.addEventListener("abort", handleAbort, { once: true });
      schedule();
    });
  }

  private assertCurrent(transition: ActiveTransition) {
    if (
      transition.controller.signal.aborted
      || !this.isCurrent(transition.id)
    ) {
      throw abortError();
    }
  }

  private cancelChannel(channel: TransitionChannel, reason: unknown) {
    const active = this.activeByChannel.get(channel);
    if (!active) {
      return;
    }
    this.activeByChannel.delete(channel);
    active.controller.abort(reason);
  }

  private findActive(id: number) {
    for (const active of this.activeByChannel.values()) {
      if (active.id === id) {
        return active;
      }
    }
    return null;
  }

  private awaitAbortable<Result>(
    value: void | Promise<Result>,
    signal: AbortSignal,
  ): Promise<void | Result> {
    if (signal.aborted) {
      return Promise.reject(abortError());
    }

    if (!value || typeof (value as Promise<Result>).then !== "function") {
      return Promise.resolve(value);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (
        callback: () => void,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", handleAbort);
        callback();
      };
      const handleAbort = () => {
        finish(() => reject(abortError()));
      };

      signal.addEventListener("abort", handleAbort, { once: true });
      Promise.resolve(value).then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
    });
  }
}

export const transitionManager = new TransitionManager();
