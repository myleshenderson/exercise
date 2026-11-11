import { FitError } from "./errors.js";
import type { ChannelName, FitActivity, FitMessages, FitRecord } from "./types.js";

/** Longest activity laid out at 1 Hz (7 days); guards against a stray timestamp. */
export const MAX_SPAN_SECONDS = 7 * 24 * 3600;

const CHANNELS: Record<ChannelName, (r: FitRecord, second: number) => number | null> = {
  timestamp: (_r, second) => second,
  lat: (r) => r.position_lat,
  lng: (r) => r.position_long,
  distance: (r) => r.distance,
  speed: (r) => r.enhanced_speed ?? r.speed,
  altitude: (r) => r.enhanced_altitude ?? r.altitude,
  power: (r) => r.power,
  cadence: (r) => r.cadence,
  heart_rate: (r) => r.heart_rate,
  temperature: (r) => r.temperature,
};

/**
 * Lay `record` messages out as 1 Hz channels. Slot i is second i after the
 * earliest record (normally the first). Sub-second times are floored; two
 * records in the same second keep the later one; a second with no record is
 * `null` in every channel (never interpolated). Channels that are all `null`
 * are omitted. Records without a timestamp are dropped.
 */
export function toStreams(m: FitMessages): FitActivity {
  const timed = m.records.filter((r) => r.timestamp !== null);
  const base = { laps: m.laps, sets: m.sets, session: m.sessions[0] ?? null };
  if (timed.length === 0) return { startTime: null, channels: {}, ...base };

  let start = Infinity;
  let end = -Infinity;
  for (const r of timed) {
    const s = Math.floor(r.timestamp as number);
    if (s < start) start = s;
    if (s > end) end = s;
  }
  if (end - start + 1 > MAX_SPAN_SECONDS) {
    throw new FitError(`record times span ${end - start + 1} s, more than ${MAX_SPAN_SECONDS} s`);
  }
  const slots: (FitRecord | undefined)[] = new Array(end - start + 1);
  for (const r of timed) slots[Math.floor(r.timestamp as number) - start] = r;

  const channels: FitActivity["channels"] = {};
  for (const name of Object.keys(CHANNELS) as ChannelName[]) {
    const pick = CHANNELS[name];
    const values: (number | null)[] = new Array(slots.length);
    let any = false;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i];
      const v = r ? pick(r, start + i) : null;
      values[i] = v;
      if (v !== null) any = true;
    }
    if (any) channels[name] = values;
  }
  return { startTime: new Date(start * 1000).toISOString(), channels, ...base };
}
