/**
 * Peloton adapter types (AI-639). Pure: no I/O. Payload shapes follow the AI-627 payload-facts
 * comment, sections 6 to 12; only the fields the adapter reads are typed, the rest pass through.
 */

/** An encrypted secret as stored in provider_credentials (every field base64, keyId hex). */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  /** First 8 hex characters of SHA-256(key): detects a changed CREDENTIALS_KEY. */
  keyId: string;
}

/** Symmetric encryption of a secret string. The Node implementation is src/sync/credentials.ts. */
export interface SecretBox {
  encrypt(plain: string): Promise<EncryptedSecret>;
  decrypt(e: EncryptedSecret): Promise<string>;
}

/** The class a workout followed (`joins=ride,ride.instructor`). Freestyle rides carry a stub. */
export interface PelotonRide {
  id?: string | null;
  title?: string | null;
  duration?: number | null;
  pedaling_start_offset?: number | null;
  [key: string]: unknown;
}

/** A workouts-list item (section 7). Times are epoch seconds. */
export interface PelotonWorkout {
  id: string;
  fitness_discipline: string;
  start_time: number;
  end_time?: number | null;
  /** POSIX zone on bike rows (`Etc/GMT+5` = UTC−5) or IANA on app rows. */
  timezone?: string | null;
  is_outdoor?: boolean | null;
  title?: string | null;
  workout_type?: string | null;
  /** Joules. */
  total_work?: number | null;
  /** The user's display unit (miles for an imperial user). Not used: the graph says its unit. */
  distance?: number | null;
  calories?: number | null;
  ride?: PelotonRide | null;
  [key: string]: unknown;
}

export interface PelotonFtpInfo {
  ftp: number;
  ftp_source: string;
  ftp_workout_id: string | null;
}

/** `/api/workout/{id}?joins=ride,ride.instructor,user` (section 8): the list item plus ftp_info. */
export interface PelotonWorkoutDetail extends PelotonWorkout {
  ftp_info?: PelotonFtpInfo | null;
}

export interface PelotonWorkoutsPage {
  data: PelotonWorkout[];
  page: number;
  page_count: number;
  total?: number;
  limit?: number;
  [key: string]: unknown;
}

export interface PelotonMe {
  id: string;
  [key: string]: unknown;
}

export interface PelotonGraphMetric {
  slug: string;
  display_unit?: string | null;
  values: (number | null)[];
  average_value?: number | null;
  max_value?: number | null;
  [key: string]: unknown;
}

export interface PelotonGraphSummary {
  slug: string;
  display_unit?: string | null;
  value: number | null;
  [key: string]: unknown;
}

/** `/api/workout/{id}/performance_graph?every_n=1` (section 9). */
export interface PelotonPerformanceGraph {
  duration?: number | null;
  seconds_since_pedaling_start: number[];
  metrics: PelotonGraphMetric[];
  summaries?: PelotonGraphSummary[];
  average_summaries?: PelotonGraphSummary[];
  [key: string]: unknown;
}

/** `/api/ride/{rideId}/details` (section 11). */
export interface PelotonRideDetails {
  is_ftp_test?: boolean | null;
  [key: string]: unknown;
}

/** The 18 columns of workout_history.csv, exactly as section 10 names them. */
export const PELOTON_CSV_COLUMNS = [
  "Workout Timestamp",
  "Live/On-Demand",
  "Instructor Name",
  "Length (minutes)",
  "Fitness Discipline",
  "Type",
  "Title",
  "Class Timestamp",
  "Total Output",
  "Avg. Watts",
  "Avg. Resistance",
  "Avg. Cadence (RPM)",
  "Avg. Speed (mph)",
  "Distance (mi)",
  "Calories Burned",
  "Avg. Heartrate",
  "Avg. Incline",
  "Avg. Pace (min/mi)",
] as const;

export type PelotonCsvColumn = (typeof PELOTON_CSV_COLUMNS)[number];

/** One CSV row, every value the raw string ("" when empty or absent). */
export type PelotonCsvRow = Record<PelotonCsvColumn, string>;

/** The `sync_state` cursor of row `peloton`. */
export type PelotonCursor = { mode: "backfill"; page: number; retry: string[] } | { mode: "incremental"; retry: string[] };
