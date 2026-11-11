import type {
  Exercise,
  WorkoutDay,
  Session,
  SetEntry,
  Program,
  ActivitySource,
  ActivityEnvironment,
  ExternalActivity,
  ExternalActivityInput,
  ActivityStream,
  ActivityStreamInput,
  BodyWeight,
  BodyWeightInput,
  AthleteSettings,
  FtpHistoryEntry,
  DailyTrainingLoad,
  SyncState,
} from "../types.js";

/** athlete_settings' column defaults: what getAthleteSettings() returns when the user has no row. */
export const DEFAULT_ATHLETE_SETTINGS: Readonly<AthleteSettings> = Object.freeze({
  manualFtpW: null,
  lthrBpm: null,
  maxHrBpm: null,
  restingHrBpm: null,
  strengthSessionTss: 50,
  noPowerTssPerHour: 55,
  units: "imperial",
  weekStart: "monday",
});

export interface ExternalActivityFilter {
  from?: string; // inclusive lower bound on startedAt (ISO instant)
  to?: string; // inclusive upper bound on startedAt (ISO instant)
  source?: ActivitySource;
  environment?: ActivityEnvironment;
  /**
   * Caps the number of rows returned (newest first). Must be a non-negative
   * safe integer: 0 returns `[]` without a query; a negative, fractional, NaN or
   * non-finite value throws `RangeError("limit must be a non-negative integer")`
   * (see `assertListLimit`). Same contract in every backend.
   */
  limit?: number;
}

/** A live (not soft-deleted) workout day as the name lookups return it. */
export type DayLookup = Pick<WorkoutDay, "id" | "name" | "position" | "programId" | "programPosition">;

export interface DataLayer {
  listExercises(): Promise<Exercise[]>;
  getExercise(id: string): Promise<Exercise | null>;
  createExercise(input: Omit<Exercise, "id">): Promise<Exercise>;
  // Only fields present (non-undefined) in `patch` change. Throws when no
  // exercise has that id.
  updateExercise(id: string, patch: Partial<Omit<Exercise, "id">>): Promise<Exercise>;
  // Soft-deletes the exercise (it drops out of listExercises). The Starkeep
  // backend refuses (ExerciseInUseError) while the exercise is attached to a
  // day or has logged sets or scheme history; Supabase leaves that check to
  // its MCP caller (api/mcp.ts exerciseUsage).
  deleteExercise(id: string): Promise<void>;

  // Exact, case-sensitive name lookups over live (not soft-deleted) rows. With
  // several matches, the earliest created wins. null when nothing matches.
  findDayByName(name: string): Promise<DayLookup | null>;
  findExerciseByName(name: string): Promise<Exercise | null>;
  findProgramByName(name: string): Promise<Program | null>;

  // Atomically claims the right to run first-login seeding for the current
  // user: returns true for exactly one caller among any concurrent callers,
  // false for every other one (they must not seed). Guards against the
  // ensureSeeded() race — see exercise-c9l and 0014_seed_claims.sql.
  claimSeed(): Promise<boolean>;

  getWorkoutDays(): Promise<WorkoutDay[]>;
  getDayExercises(dayId: string): Promise<Exercise[]>;
  createDay(name: string): Promise<WorkoutDay>;
  deleteDay(id: string): Promise<void>;
  addExerciseToDay(dayId: string, exerciseId: string): Promise<void>;
  removeExerciseFromDay(dayId: string, exerciseId: string): Promise<void>;
  updateDayExercises(dayId: string, exerciseIds: string[]): Promise<void>;
  updateDayName(dayId: string, name: string): Promise<void>;
  createProgram(name: string): Promise<Program>;
  renameProgram(programId: string, name: string): Promise<void>;
  deleteProgram(programId: string): Promise<void>;
  addDayToProgram(dayId: string, programId: string): Promise<void>;
  removeDayFromProgram(dayId: string): Promise<void>;
  reorderProgramDays(programId: string, dayIds: string[]): Promise<void>;
  getDayExerciseTargets(dayId: string): Promise<Record<string, SetEntry[]>>;
  setDayExerciseTarget(dayId: string, exerciseId: string, sets: SetEntry[] | null): Promise<void>;
  getSchemeHistory(dayId: string, exerciseId: string): Promise<{ targetSets: SetEntry[] | null; recordedAt: string }[]>;

  getLastSetsForExercise(exerciseId: string, beforeDate: string): Promise<SetEntry[]>;

  startSession(workoutDayId: string | null, date: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  getLastSessionForDay(workoutDayId: string): Promise<Session | null>;
  getSessionForDayAndDate(workoutDayId: string, date: string): Promise<Session | null>;
  logExercise(sessionId: string, exerciseId: string, sets: SetEntry[]): Promise<void>;
  getExerciseHistory(exerciseId: string): Promise<Session[]>;
  listSessions(): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;

  // Ride analytics (AI-631). Activities never carry providerPayload on reads.
  listExternalActivities(f: ExternalActivityFilter): Promise<ExternalActivity[]>; // newest first
  getExternalActivity(id: string): Promise<ExternalActivity | null>;
  // Upserts on (user, source, sourceId); every column is replaced, omitted
  // optional fields become null/false. Returns the stored rows. Throws when a
  // row's providerPayload is null or undefined (the column is not null).
  upsertExternalActivities(rows: ExternalActivityInput[]): Promise<ExternalActivity[]>;
  getActivityStreams(activityId: string): Promise<ActivityStream[]>; // ordered by channel
  // Replaces the activity's streams: channels not passed are deleted (an empty
  // list deletes them all), the rest upsert on (activityId, channel).
  replaceActivityStreams(activityId: string, streams: ActivityStreamInput[]): Promise<void>;
  listBodyWeights(from: string, to: string): Promise<BodyWeight[]>; // measuredAt in [from, to], oldest first
  upsertBodyWeights(rows: BodyWeightInput[]): Promise<void>; // on (user, source, sourceId)
  getAthleteSettings(): Promise<AthleteSettings>; // DEFAULT_ATHLETE_SETTINGS when no row exists
  saveAthleteSettings(patch: Partial<AthleteSettings>): Promise<AthleteSettings>; // only defined fields change
  listFtpHistory(): Promise<FtpHistoryEntry[]>; // oldest effectiveFrom first
  // Inserts; a second entry with the same (effectiveFrom, source) is rejected.
  addFtpHistoryEntry(entry: Omit<FtpHistoryEntry, "id">): Promise<FtpHistoryEntry>;
  listDailyTrainingLoad(from: string, to: string): Promise<DailyTrainingLoad[]>; // date in [from, to], oldest first
  upsertDailyTrainingLoad(rows: DailyTrainingLoad[]): Promise<void>; // on (user, date)
  listSyncState(): Promise<SyncState[]>; // ordered by source
}

/** Validates `ExternalActivityFilter.limit`; `undefined` means no cap. Shared by the Supabase and mock backends. */
export function assertListLimit(limit: number | undefined): void {
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0)) {
    throw new RangeError("limit must be a non-negative integer");
  }
}

/**
 * provider_payload is `not null`, and PostgREST rejects a whole bulk upsert
 * (PGRST102) when one row omits a key the others carry, so a missing payload is
 * refused up front with a message that names the row.
 */
export function assertProviderPayloads(rows: readonly ExternalActivityInput[]): void {
  for (const r of rows) {
    if (r.providerPayload === undefined || r.providerPayload === null) {
      throw new Error(`external activity ${r.source}/${r.sourceId} has no providerPayload; it is required (provider_payload is not null)`);
    }
  }
}
