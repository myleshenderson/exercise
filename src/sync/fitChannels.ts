/** FIT (or a zip holding one) to 1 Hz channels. FitError propagates. */
import { decodeFit, fitFromZip, toStreams } from "../fit/index.js";
import type { StreamChannel } from "../types.js";
import type { Channels } from "./types.js";

export function channelsFromFit(bytes: Uint8Array, container: "zip" | "fit"): Channels {
  return channelsFromFitWithStart(bytes, container).channels;
}

/**
 * The channels plus the instant of slot 0 (ISO, the first timed record), or null when the FIT
 * holds no timed record (AI-645).
 */
export function channelsFromFitWithStart(
  bytes: Uint8Array,
  container: "zip" | "fit",
): { channels: Channels; startTime: string | null } {
  const fit = container === "zip" ? fitFromZip(bytes) : bytes;
  const streams = toStreams(decodeFit(fit));
  const channels: Channels = {};
  for (const [name, values] of Object.entries(streams.channels) as [string, (number | null)[] | undefined][]) {
    if (name === "timestamp" || values === undefined) continue;
    channels[name as StreamChannel] = values;
  }
  return { channels, startTime: streams.startTime };
}

/** A FIT whose first record is further than this from beginTimestamp has a corrupt header (AI-645). */
export const MAX_FIT_START_OFFSET_S = 3600;

/**
 * Seconds from the activity's start to the FIT's first record, floored; 0 without a FIT start.
 * `ok` is false when the gap exceeds MAX_FIT_START_OFFSET_S (the offset is then 0).
 */
export function fitStartOffsetS(startedAt: string, fitStartTime: string | null): { offsetS: number; ok: boolean } {
  if (fitStartTime === null) return { offsetS: 0, ok: true };
  const offsetS = Math.floor((Date.parse(fitStartTime) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(offsetS) || Math.abs(offsetS) > MAX_FIT_START_OFFSET_S) return { offsetS: 0, ok: false };
  return { offsetS, ok: true };
}
