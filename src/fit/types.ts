/**
 * Decoded FIT messages. Field names follow the FIT profile. Scale and offset
 * are applied; date_time fields (`timestamp`, `start_time`) are Unix seconds;
 * positions are degrees. A field that is absent or holds its base type's
 * invalid value is `null`. Array fields (e.g. `set.category`) keep their first
 * element.
 */
export interface FitRecord {
  timestamp: number | null;
  position_lat: number | null;
  position_long: number | null;
  altitude: number | null;
  heart_rate: number | null;
  cadence: number | null;
  distance: number | null;
  speed: number | null;
  power: number | null;
  temperature: number | null;
  enhanced_speed: number | null;
  enhanced_altitude: number | null;
}

export interface FitLap {
  timestamp: number | null;
  start_time: number | null;
  total_elapsed_time: number | null;
  total_timer_time: number | null;
  total_distance: number | null;
}

export interface FitSession extends FitLap {
  sport: number | null;
  sub_sport: number | null;
}

export interface FitEvent {
  timestamp: number | null;
  event: number | null;
  event_type: number | null;
}

export interface FitSet {
  timestamp: number | null;
  duration: number | null;
  repetitions: number | null;
  weight: number | null;
  set_type: number | null;
  start_time: number | null;
  category: number | null;
  category_subtype: number | null;
}

export interface FitMessages {
  records: FitRecord[];
  laps: FitLap[];
  sessions: FitSession[];
  events: FitEvent[];
  sets: FitSet[];
}

export type ChannelName =
  | "timestamp"
  | "lat"
  | "lng"
  | "distance"
  | "speed"
  | "altitude"
  | "power"
  | "cadence"
  | "heart_rate"
  | "temperature";

/**
 * 1 Hz streams. Index i is second i after `startTime`; `timestamp` holds Unix
 * seconds. A second with no record is `null` in every channel. A channel with
 * no non-null value is omitted.
 */
export interface FitActivity {
  startTime: string | null;
  channels: Partial<Record<ChannelName, (number | null)[]>>;
  laps: FitLap[];
  sets: FitSet[];
  session: FitSession | null;
}
