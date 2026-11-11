/**
 * Garmin Personal API payloads, as far as this adapter reads them (AI-638). Every provider key
 * is optional because Garmin omits a key rather than sending null. Shapes follow the AI-627
 * payload facts (sections 1, 2 and 4), which override the OpenAPI spec where they disagree.
 */

/** One item of `GET /activitylist-service/activities/search/activities` (a bare array, newest first). */
export interface GarminListItem {
  activityId?: number;
  activityName?: string;
  activityType?: { typeId?: number; typeKey?: string; parentTypeId?: number };
  /** `YYYY-MM-DD HH:MM:SS`, UTC. */
  startTimeGMT?: string;
  /** `YYYY-MM-DD HH:MM:SS`, local wall clock with no zone. */
  startTimeLocal?: string;
  /** Start instant, epoch milliseconds. */
  beginTimestamp?: number;
  duration?: number;
  elapsedDuration?: number;
  movingDuration?: number;
  distance?: number;
  elevationGain?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  calories?: number;
  avgPower?: number;
  maxPower?: number;
  normPower?: number;
  trainingStressScore?: number;
  intensityFactor?: number;
  averageHR?: number;
  maxHR?: number;
  averageBikingCadenceInRevPerMinute?: number;
  /** The rest (maxAvgPower_*, powerTimeInZone_*, position, flags, ...) is kept in providerPayload untouched. */
  [key: string]: unknown;
}

/** `GET /activity-service/activity/{id}`; only the IANA zone is read. */
export interface GarminDetail {
  activityId?: number;
  timeZoneUnitDTO?: { timeZone?: string };
  [key: string]: unknown;
}

/** One weigh-in in `dailyWeightSummaries[].allWeightMetrics[]`. Masses are grams despite the spec. */
export interface GarminWeightEntry {
  samplePk?: number;
  /** Local wall clock encoded as epoch ms: never the instant. */
  date?: number;
  calendarDate?: string;
  /** The instant, epoch ms. */
  timestampGMT?: number;
  /** Grams. */
  weight?: number;
  bmi?: number | null;
  /** Percent. */
  bodyFat?: number | null;
  /** Percent. */
  bodyWater?: number | null;
  /** Grams. */
  boneMass?: number | null;
  /** Grams. */
  muscleMass?: number | null;
  sourceType?: string;
  [key: string]: unknown;
}

export interface GarminDailyWeightSummary {
  summaryDate?: string;
  numOfWeightEntries?: number;
  allWeightMetrics?: GarminWeightEntry[];
  [key: string]: unknown;
}

/** `GET /weight-service/weight/range/{start}/{end}?includeAll=true`. */
export interface GarminWeightRange {
  dailyWeightSummaries?: GarminDailyWeightSummary[];
  [key: string]: unknown;
}

/** sync_state.cursor of row `garmin_activities`. */
export type GarminActivitiesCursor = { mode: "backfill"; start: number } | { mode: "incremental" };

/** sync_state.cursor of row `garmin_weight`. */
export type GarminWeightCursor = { mode: "backfill"; year: number; emptyYears: number } | { mode: "incremental" };
