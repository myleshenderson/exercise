/** A Strava archive activity file (FIT, GPX or TCX, optionally gzipped) to 1 Hz channels (AI-640). Pure. */
import { gunzipSync } from "fflate";
import { channelsFromFitWithStart } from "../fitChannels.js";
import { fitStartOffsetS } from "../garmin/runActivities.js";
import type { Channels } from "../types.js";
import { gpxToChannels } from "./gpx.js";
import { tcxToChannels } from "./tcx.js";

export interface StravaStream {
  channels: Channels;
  /** Seconds from startedAt to slot 0 (non-zero only for a FIT whose first record trails the start). */
  offsetS: number;
  /** False when a FIT's first record is more than MAX_FIT_START_OFFSET_S from startedAt (offsetS is then 0). */
  offsetOk: boolean;
}

/** The file kind from its name, or null for an unsupported one. */
export function streamKind(filename: string): { kind: "fit" | "gpx" | "tcx"; gzipped: boolean } | null {
  const m = /\.(fit|gpx|tcx)(\.gz)?$/i.exec(filename.trim());
  return m ? { kind: m[1].toLowerCase() as "fit" | "gpx" | "tcx", gzipped: m[2] !== undefined } : null;
}

/**
 * Channels for one ride, or null when the kind is unsupported, the file does not parse, or it
 * holds no channel. Never throws.
 */
export function stravaStream(filename: string, bytes: Uint8Array, startedAt: string): StravaStream | null {
  const kind = streamKind(filename);
  if (!kind) return null;
  try {
    const data = kind.gzipped ? gunzipSync(bytes) : bytes;
    let result: StravaStream;
    if (kind.kind === "fit") {
      const { channels, startTime } = channelsFromFitWithStart(data, "fit");
      const offset = fitStartOffsetS(startedAt, startTime);
      result = { channels, offsetS: offset.offsetS, offsetOk: offset.ok };
    } else {
      const xml = new TextDecoder("utf-8").decode(data);
      result = { channels: kind.kind === "gpx" ? gpxToChannels(xml, startedAt) : tcxToChannels(xml, startedAt), offsetS: 0, offsetOk: true };
    }
    return Object.keys(result.channels).length > 0 ? result : null;
  } catch {
    return null;
  }
}
