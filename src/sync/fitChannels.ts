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
