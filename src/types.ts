export interface Exercise {
  id: string;
  name: string;
  cue: string;
  defaultSets: number;
  defaultRepLow: number;
  defaultRepHigh: number;
}

export interface Program {
  id: string;
  name: string;
}

export interface WorkoutDay {
  id: string;
  name: string;
  position: number;
  exerciseIds: string[]; // ordered
  programId: string | null;
  programPosition: number | null;
  programName: string | null; // null when programId is null, or when the program is soft-deleted
  isAvailable: boolean; // always true when programId is null; for a programmed day, true only for that program's current suggested day
}

export interface SetEntry {
  setNumber: number; // 1-based
  weight: number;
  reps: number;
}

export interface SessionExercise {
  exerciseId: string;
  sets: SetEntry[];
}

export interface Session {
  id: string;
  workoutDayId: string | null;
  performedOn: string; // "YYYY-MM-DD"
  exercises: SessionExercise[];
}

// ---------------------------------------------------------------------------
// Ride analytics (AI-631, epic AI-627). Timestamps are ISO 8601 UTC instants;
// `date` fields are "YYYY-MM-DD" local calendar days. Provider payloads are
// written (input types) but never read back.
// ---------------------------------------------------------------------------

export type ActivitySource = "garmin" | "peloton" | "strava_export";
export type ActivityEnvironment = "indoor" | "outdoor";
export type TssSource = "power" | "estimated_flat";
export type StreamChannel =
  | "power"
  | "heart_rate"
  | "cadence"
  | "speed"
  | "distance"
  | "altitude"
  | "lat"
  | "lng"
  | "temperature"
  | "resistance";

export interface ExternalActivity {
  id: string;
  source: ActivitySource;
  sourceId: string;
  startedAt: string;
  timezone: string | null; // IANA name as the provider gives it
  sport: string; // "cycling" for now
  subType: string | null; // Garmin typeKey, Peloton fitness_discipline
  environment: ActivityEnvironment;
  title: string | null;
  elapsedS: number | null;
  movingS: number | null;
  distanceM: number | null;
  elevationGainM: number | null;
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  avgPowerW: number | null;
  maxPowerW: number | null;
  normalizedPowerW: number | null; // ours, never the provider's
  intensityFactor: number | null; // ours, never the provider's
  tss: number | null; // ours, never the provider's
  workKj: number | null;
  calories: number | null;
  avgHrBpm: number | null;
  maxHrBpm: number | null;
  avgCadenceRpm: number | null;
  biggestClimbM: number | null;
  tssSource: TssSource | null;
  ftpUsedW: number | null;
  ftpSource: string | null;
  hasPower: boolean;
  hasHr: boolean;
  powerCurve: unknown;
  bestEfforts: unknown;
  pairedActivityId: string | null;
  syncedAt: string;
}

type ExternalActivityRequired = "source" | "sourceId" | "startedAt" | "sport" | "environment";

/** An upsert row: identity and the required columns, every other field optional (omitted = null/false). */
export type ExternalActivityInput = Pick<ExternalActivity, ExternalActivityRequired> &
  Partial<Omit<ExternalActivity, ExternalActivityRequired | "id" | "syncedAt">> & {
    providerPayload: unknown; // the provider's own summary object, unmodified
  };

export interface ActivityStream {
  activityId: string;
  channel: StreamChannel;
  startOffsetS: number;
  values: (number | null)[]; // values[i] is second i after startedAt + startOffsetS; null = missing second
}

export type ActivityStreamInput = Omit<ActivityStream, "activityId" | "startOffsetS"> & { startOffsetS?: number };

export interface BodyWeight {
  id: string;
  source: "garmin";
  sourceId: string; // Garmin samplePk
  measuredAt: string; // from timestampGMT
  weightKg: number;
  bmi: number | null;
  bodyFatPct: number | null;
  bodyWaterPct: number | null;
  muscleMassKg: number | null;
  boneMassKg: number | null;
}

export type BodyWeightInput = Pick<BodyWeight, "source" | "sourceId" | "measuredAt" | "weightKg"> &
  Partial<Pick<BodyWeight, "bmi" | "bodyFatPct" | "bodyWaterPct" | "muscleMassKg" | "boneMassKg">> & {
    providerPayload: unknown;
  };

export interface AthleteSettings {
  manualFtpW: number | null; // null = use eFTP
  lthrBpm: number | null;
  maxHrBpm: number | null;
  restingHrBpm: number | null;
  strengthSessionTss: number;
  noPowerTssPerHour: number;
  units: "imperial" | "metric";
  weekStart: "monday" | "sunday";
}

export type FtpSource = "manual" | "peloton_test" | "peloton_manual" | "estimated";

export interface FtpHistoryEntry {
  id: string;
  effectiveFrom: string;
  ftpW: number;
  source: FtpSource;
  sourceRef: string | null; // Peloton workout id
}

export type TrainingLoadSource = "garmin" | "peloton" | "strava_export" | "strength";

export interface DailyTrainingLoad {
  date: string; // local calendar day
  tssTotal: number;
  tssBySource: Partial<Record<TrainingLoadSource, number>>;
  ctl: number;
  atl: number;
  tsb: number; // ctl - atl of the same day
}

export type SyncSource = "garmin_activities" | "garmin_weight" | "peloton";

export interface SyncState {
  source: SyncSource;
  cursor: unknown;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  itemsFetched: number;
  itemsUpserted: number;
  lastError: string | null;
  backfillComplete: boolean;
  authStatus: "ok" | "reconnect_required";
}
