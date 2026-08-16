import type { QrLoginState } from "../../providers/MusicProvider";

export type VisibleQrProgress = "waiting" | "scanned";

export const qrPollIntervalMs = 1_450;
export const qrPollMaxConsecutiveFailures = 6;
export const qrPollRequestTimeoutMs = 5_000;

export class QrPollRequestTimeoutError extends Error {
  constructor() {
    super("扫码状态检查超时，正在重新连接。");
    this.name = "QrPollRequestTimeoutError";
  }
}

/**
 * A native QR status command should return immediately because it only reads
 * the provider-owned session state. Guard the IPC promise so one lost native
 * reply cannot permanently occupy WelcomeScreen's in-flight slot and stop the
 * self-scheduling poll loop.
 */
export async function withQrPollRequestTimeout<T>(
  request: Promise<T>,
  timeoutMs = qrPollRequestTimeoutMs,
) {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(new QrPollRequestTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

export function advanceQrProgress(
  current: VisibleQrProgress,
  providerState: QrLoginState,
): VisibleQrProgress {
  if (current === "scanned" || providerState === "scanned") {
    return "scanned";
  }
  return "waiting";
}

export function qrPollRetryDelayMs(consecutiveFailures: number) {
  const exponent = Math.max(0, Math.min(2, consecutiveFailures - 1));
  return Math.min(5_000, qrPollIntervalMs * (2 ** exponent));
}
