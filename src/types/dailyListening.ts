import type { MusicProviderId } from "../providers/MusicProvider";

export type DailyListeningSource = "local" | "unavailable";

export interface DailyListeningSummary {
  providerId: MusicProviderId;
  accountId: string;
  localDate: string;
  durationMs: number | null;
  source: DailyListeningSource;
  updatedAt: number;
}

export interface DailyListeningDurationPart {
  value: string;
  unit: "H" | "MIN";
}

export function formatDailyListeningDuration(
  durationMs: number | null,
): DailyListeningDurationPart[] | null {
  if (durationMs === null || durationMs < 60_000) {
    return null;
  }

  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return [{ value: String(totalMinutes).padStart(2, "0"), unit: "MIN" }];
  }
  return [
    { value: String(hours).padStart(2, "0"), unit: "H" },
    { value: String(minutes).padStart(2, "0"), unit: "MIN" },
  ];
}
