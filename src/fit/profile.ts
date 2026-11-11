// The subset of the FIT profile this module keeps. Field numbers, scales and
// offsets were checked by the lead against @garmin/fitsdk 21.221.0 profile.js
// (the SDK itself is not a dependency; see AI-633).

/** Seconds between the Unix epoch and the FIT epoch, 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_OFFSET = 631065600;

export type FieldKind = "number" | "time" | "semicircles";

export interface FieldProfile {
  name: string;
  scale?: number;
  offset?: number;
  kind?: FieldKind;
}

export const MESG_SESSION = 18;
export const MESG_LAP = 19;
export const MESG_RECORD = 20;
export const MESG_EVENT = 21;
export const MESG_SET = 225;

const LAP_FIELDS: Record<number, FieldProfile> = {
  253: { name: "timestamp", kind: "time" },
  2: { name: "start_time", kind: "time" },
  7: { name: "total_elapsed_time", scale: 1000 },
  8: { name: "total_timer_time", scale: 1000 },
  9: { name: "total_distance", scale: 100 },
};

export const PROFILE: Record<number, Record<number, FieldProfile>> = {
  [MESG_RECORD]: {
    253: { name: "timestamp", kind: "time" },
    0: { name: "position_lat", kind: "semicircles" },
    1: { name: "position_long", kind: "semicircles" },
    2: { name: "altitude", scale: 5, offset: 500 },
    3: { name: "heart_rate" },
    4: { name: "cadence" },
    5: { name: "distance", scale: 100 },
    6: { name: "speed", scale: 1000 },
    7: { name: "power" },
    13: { name: "temperature" },
    73: { name: "enhanced_speed", scale: 1000 },
    78: { name: "enhanced_altitude", scale: 5, offset: 500 },
  },
  [MESG_LAP]: LAP_FIELDS,
  [MESG_SESSION]: {
    ...LAP_FIELDS,
    5: { name: "sport" },
    6: { name: "sub_sport" },
  },
  [MESG_EVENT]: {
    253: { name: "timestamp", kind: "time" },
    0: { name: "event" },
    1: { name: "event_type" },
  },
  [MESG_SET]: {
    254: { name: "timestamp", kind: "time" },
    0: { name: "duration", scale: 1000 },
    3: { name: "repetitions" },
    4: { name: "weight", scale: 16 },
    5: { name: "set_type" },
    6: { name: "start_time", kind: "time" },
    7: { name: "category" },
    8: { name: "category_subtype" },
  },
};

/** date_time values below this are relative (seconds since device power-on). */
export const FIT_MIN_ABSOLUTE_TIME = 0x10000000;

/** Field names of each kept message, all `null`; cloned per data message. */
export const TEMPLATES: Record<number, Record<string, null>> = Object.fromEntries(
  Object.entries(PROFILE).map(([global, fields]) => [
    global,
    Object.fromEntries(Object.values(fields).map((f) => [f.name, null])),
  ]),
);

/**
 * Apply scale/offset/kind to a raw (valid) value. A relative date_time (below
 * 0x10000000) has no absolute meaning and becomes `null`.
 */
export function applyProfile(raw: number, field: FieldProfile): number | null {
  switch (field.kind) {
    case "time":
      return raw < FIT_MIN_ABSOLUTE_TIME ? null : raw + FIT_EPOCH_OFFSET;
    case "semicircles":
      return (raw * 180) / 2 ** 31;
    default: {
      // (raw - offset*scale) / scale rounds once, so 3001 -> 100.2, not 100.20000000000005.
      const scale = field.scale ?? 1;
      return (raw - (field.offset ?? 0) * scale) / scale;
    }
  }
}
