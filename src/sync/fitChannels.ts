/** FIT (or a zip holding one) to 1 Hz channels. FitError propagates. */
import { decodeFit, fitFromZip, toStreams } from "../fit/index.js";
import type { StreamChannel } from "../types.js";
import type { Channels } from "./types.js";

export function channelsFromFit(bytes: Uint8Array, container: "zip" | "fit"): Channels {
  const fit = container === "zip" ? fitFromZip(bytes) : bytes;
  const streams = toStreams(decodeFit(fit));
  const channels: Channels = {};
  for (const [name, values] of Object.entries(streams.channels) as [string, (number | null)[] | undefined][]) {
    if (name === "timestamp" || values === undefined) continue;
    channels[name as StreamChannel] = values;
  }
  return channels;
}
