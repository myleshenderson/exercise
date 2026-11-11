/** The gap rule (AI-640, decision 9): a Strava ride is imported only when no Garmin or Peloton row covers it. Pure. */
import type { ExternalActivity } from "../../types.js";
import { PAIR_WINDOW_S } from "../pairing.js";

/**
 * The garmin or peloton row whose start is within ±PAIR_WINDOW_S of `startedAt` (the nearest
 * one), or null. Time overlap only: Peloton's strava_id is always null.
 */
export function coveredBy(startedAt: string, existing: readonly ExternalActivity[]): ExternalActivity | null {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return null;
  let best: ExternalActivity | null = null;
  let bestGap = Infinity;
  for (const a of existing) {
    if (a.source !== "garmin" && a.source !== "peloton") continue;
    const gap = Math.abs(Date.parse(a.startedAt) - t);
    if (gap <= PAIR_WINDOW_S * 1000 && gap < bestGap) {
      best = a;
      bestGap = gap;
    }
  }
  return best;
}
