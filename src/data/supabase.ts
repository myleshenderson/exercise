import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ATHLETE_SETTINGS, assertListLimit, assertProviderPayloads, type DataLayer, type DayLookup, type ExternalActivityFilter } from "./DataLayer.js";
import type {
  Exercise,
  WorkoutDay,
  Session,
  SetEntry,
  Program,
  ActivitySource,
  ExternalActivity,
  ExternalActivityInput,
  ActivityStream,
  ActivityStreamInput,
  StreamChannel,
  BodyWeight,
  BodyWeightInput,
  AthleteSettings,
  FtpHistoryEntry,
  FtpSource,
  DailyTrainingLoad,
  SyncState,
  SyncSource,
} from "../types.js";
import { getSupabase } from "./supabaseClient.js";
import { nextAvailablePositionByProgram, isDayAvailable } from "../lib/programAvailability.js";

interface ExerciseRow {
  id: string;
  name: string;
  cue: string;
  default_sets: number;
  default_rep_low: number;
  default_rep_high: number;
}

const toExercise = (r: ExerciseRow): Exercise => ({
  id: r.id,
  name: r.name,
  cue: r.cue,
  defaultSets: r.default_sets,
  defaultRepLow: r.default_rep_low,
  defaultRepHigh: r.default_rep_high,
});

// See exercise-c9l / 0014_seed_claims.sql: seed_claims(user_id) has a
// primary key, so concurrent callers racing to insert their own claim can
// only ever have one succeed. A 23505 (unique_violation) means someone else
// already claimed seeding for this user — not an error, just "don't seed".
export async function claimSeed(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from("seed_claims").insert({});
  if (error) {
    if (error.code === "23505") return false;
    throw error;
  }
  return true;
}

export async function createDay(client: SupabaseClient, name: string): Promise<WorkoutDay> {
  const { data, error } = await client.from("workout_days").insert({ name }).select("*").single();
  if (error) throw error;
  return {
    id: data.id, name: data.name, position: data.position, exerciseIds: [],
    programId: null, programPosition: null, programName: null, isAvailable: true,
  };
}

export async function updateDayName(client: SupabaseClient, dayId: string, name: string): Promise<void> {
  const { error } = await client.from("workout_days").update({ name }).eq("id", dayId);
  if (error) throw error;
}

export async function logExercise(
  client: SupabaseClient,
  sessionId: string,
  exerciseId: string,
  sets: SetEntry[],
): Promise<void> {
  const { error: deleteError } = await client
    .from("session_sets")
    .delete()
    .eq("session_id", sessionId)
    .eq("exercise_id", exerciseId);
  if (deleteError) throw deleteError;
  if (sets.length) {
    const { error: insertError } = await client.from("session_sets").insert(
      sets.map((s) => ({
        session_id: sessionId,
        exercise_id: exerciseId,
        set_number: s.setNumber,
        weight: s.weight,
        reps: s.reps,
      })),
    );
    if (insertError) throw insertError;
  }
}

export async function updateDayExercises(client: SupabaseClient, dayId: string, exerciseIds: string[]): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_day_exercises")
    .select("exercise_id, target_sets")
    .eq("workout_day_id", dayId);
  if (selectError) throw selectError;
  const targetsByExercise: Record<string, unknown> = {};
  for (const row of existing ?? []) {
    if (row.target_sets) targetsByExercise[row.exercise_id] = row.target_sets;
  }
  const { error: deleteError } = await client.from("workout_day_exercises").delete().eq("workout_day_id", dayId);
  if (deleteError) throw deleteError;
  if (exerciseIds.length) {
    const { error: insertError } = await client.from("workout_day_exercises").insert(
      exerciseIds.map((exercise_id, position) => ({
        workout_day_id: dayId,
        exercise_id,
        position,
        target_sets: targetsByExercise[exercise_id] ?? null,
      })),
    );
    if (insertError) throw insertError;
  }
}

export async function setDayExerciseTarget(
  client: SupabaseClient,
  dayId: string,
  exerciseId: string,
  sets: SetEntry[] | null,
): Promise<void> {
  const target_sets = sets && sets.length > 0 ? sets.map((s) => ({ weight: s.weight, reps: s.reps })) : null;
  const { error } = await client
    .from("workout_day_exercises")
    .update({ target_sets })
    .eq("workout_day_id", dayId)
    .eq("exercise_id", exerciseId);
  if (error) throw error;

  const { error: historyError } = await client.from("workout_day_exercise_scheme_history").insert({
    workout_day_id: dayId,
    exercise_id: exerciseId,
    target_sets,
  });
  if (historyError) throw historyError;
}

export async function createExercise(client: SupabaseClient, input: Omit<Exercise, "id">): Promise<Exercise> {
  const { data, error } = await client
    .from("exercises")
    .insert({
      name: input.name,
      cue: input.cue,
      default_sets: input.defaultSets,
      default_rep_low: input.defaultRepLow,
      default_rep_high: input.defaultRepHigh,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toExercise(data);
}

// Only columns present (non-undefined) in `patch` are sent to Postgres, so an omitted
// field is left untouched on the row rather than reset to a default or null.
export async function updateExercise(
  client: SupabaseClient,
  id: string,
  patch: Partial<Omit<Exercise, "id">>,
): Promise<Exercise> {
  const dbPatch: Record<string, unknown> = {};
  if (patch.name !== undefined) dbPatch.name = patch.name;
  if (patch.cue !== undefined) dbPatch.cue = patch.cue;
  if (patch.defaultSets !== undefined) dbPatch.default_sets = patch.defaultSets;
  if (patch.defaultRepLow !== undefined) dbPatch.default_rep_low = patch.defaultRepLow;
  if (patch.defaultRepHigh !== undefined) dbPatch.default_rep_high = patch.defaultRepHigh;
  const { data, error } = await client.from("exercises").update(dbPatch).eq("id", id).select("*").single();
  if (error) throw error;
  return toExercise(data);
}

export async function deleteDay(client: SupabaseClient, dayId: string): Promise<void> {
  const { error } = await client.from("workout_days").update({ deleted_at: new Date().toISOString() }).eq("id", dayId);
  if (error) throw error;
}

export async function listExercises(client: SupabaseClient): Promise<Exercise[]> {
  const { data, error } = await client.from("exercises").select("*").is("deleted_at", null).order("name");
  if (error) throw error;
  return (data ?? []).map(toExercise);
}

export async function deleteExercise(client: SupabaseClient, exerciseId: string): Promise<void> {
  const { error } = await client.from("exercises").update({ deleted_at: new Date().toISOString() }).eq("id", exerciseId);
  if (error) throw error;
}

export async function addExerciseToDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_day_exercises")
    .select("position")
    .eq("workout_day_id", dayId)
    .order("position", { ascending: false })
    .limit(1);
  if (selectError) throw selectError;
  const nextPosition = existing && existing.length > 0 ? (existing[0].position as number) + 1 : 0;
  const { error } = await client
    .from("workout_day_exercises")
    .insert({ workout_day_id: dayId, exercise_id: exerciseId, position: nextPosition });
  if (error) throw error;
}

export async function removeExerciseFromDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void> {
  const { error } = await client
    .from("workout_day_exercises")
    .delete()
    .eq("workout_day_id", dayId)
    .eq("exercise_id", exerciseId);
  if (error) throw error;
}

export async function createProgram(client: SupabaseClient, name: string): Promise<Program> {
  const { data, error } = await client.from("programs").insert({ name }).select("id, name").single();
  if (error) throw error;
  return { id: data.id, name: data.name };
}

export async function renameProgram(client: SupabaseClient, programId: string, name: string): Promise<void> {
  const { error } = await client.from("programs").update({ name }).eq("id", programId);
  if (error) throw error;
}

export async function deleteProgram(client: SupabaseClient, programId: string): Promise<void> {
  const { error } = await client.from("programs").update({ deleted_at: new Date().toISOString() }).eq("id", programId);
  if (error) throw error;
}

export async function addDayToProgram(client: SupabaseClient, dayId: string, programId: string): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_days")
    .select("program_position")
    .eq("program_id", programId)
    .order("program_position", { ascending: false })
    .limit(1);
  if (selectError) throw selectError;
  const nextPosition = existing && existing.length > 0 ? (existing[0].program_position as number) + 1 : 0;
  const { error } = await client
    .from("workout_days")
    .update({ program_id: programId, program_position: nextPosition })
    .eq("id", dayId);
  if (error) throw error;
}

export async function removeDayFromProgram(client: SupabaseClient, dayId: string): Promise<void> {
  const { error } = await client
    .from("workout_days")
    .update({ program_id: null, program_position: null })
    .eq("id", dayId);
  if (error) throw error;
}

// One update per day, not a delete-and-reinsert (contrast updateDayExercises):
// workout_days rows are the actual day identity that sessions reference by id,
// so they can never be recreated the way workout_day_exercises join rows can.
export async function reorderProgramDays(client: SupabaseClient, programId: string, dayIds: string[]): Promise<void> {
  // Two-phase write: a same-transaction-less loop of per-row updates would
  // collide with workout_days_program_position_uq mid-reorder (e.g. swapping
  // two days' positions makes the first update collide with the still-unmoved
  // second row) - parking every targeted row at a distinct negative position
  // first guarantees no collision in either phase, since negative positions
  // never collide with the final non-negative ones or each other.
  for (const [index, dayId] of dayIds.entries()) {
    const { error } = await client
      .from("workout_days")
      .update({ program_position: -(index + 1) })
      .eq("id", dayId)
      .eq("program_id", programId);
    if (error) throw error;
  }
  for (const [index, dayId] of dayIds.entries()) {
    const { error } = await client
      .from("workout_days")
      .update({ program_position: index })
      .eq("id", dayId)
      .eq("program_id", programId);
    if (error) throw error;
  }
}

export async function findDayByName(client: SupabaseClient, name: string): Promise<DayLookup | null> {
  const { data, error } = await client
    .from("workout_days")
    .select("id, name, position, program_id, program_position")
    .eq("name", name)
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    position: data.position,
    programId: data.program_id ?? null,
    programPosition: data.program_position ?? null,
  };
}

export async function findExerciseByName(client: SupabaseClient, name: string): Promise<Exercise | null> {
  const { data, error } = await client
    .from("exercises")
    .select("*")
    .eq("name", name)
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toExercise(data) : null;
}

export async function findProgramByName(client: SupabaseClient, name: string): Promise<Program | null> {
  const { data, error } = await client
    .from("programs")
    .select("id, name")
    .eq("name", name)
    .is("deleted_at", null)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, name: data.name } : null;
}

// ---------------------------------------------------------------------------
// Ride analytics (AI-631). Each function takes the client first (the
// claimSeed pattern). Under the service role auth.uid() is null, so the column
// default cannot fill user_id: the write helpers the wave 2 sync uses
// (upsertExternalActivities, replaceActivityStreams, upsertBodyWeights,
// addFtpHistoryEntry, upsertDailyTrainingLoad, upsertSyncState) take a userId
// and stamp it on every row; the DataLayer passes none and the default (the
// signed-in user) applies. The reads and saveAthleteSettings filter on no
// user and rely on RLS, so they are for a user's client only: under the
// service role they would see every user's rows.
//
// Bulk upserts collapse rows sharing a conflict key (last one wins) before
// sending: Postgres rejects a whole INSERT ... ON CONFLICT DO UPDATE batch
// that touches the same row twice.
// ---------------------------------------------------------------------------

/** Every external_activities column except provider_payload, which reads never return. */
export const EXTERNAL_ACTIVITY_COLUMNS = [
  "id", "source", "source_id", "started_at", "timezone", "sport", "sub_type", "environment", "title",
  "elapsed_s", "moving_s", "distance_m", "elevation_gain_m", "avg_speed_mps", "max_speed_mps",
  "avg_power_w", "max_power_w", "normalized_power_w", "intensity_factor", "tss", "work_kj", "calories",
  "avg_hr_bpm", "max_hr_bpm", "avg_cadence_rpm", "biggest_climb_m", "tss_source", "ftp_used_w", "ftp_source",
  "has_power", "has_hr", "power_curve", "best_efforts", "paired_activity_id", "synced_at",
].join(", ");

const BODY_WEIGHT_COLUMNS =
  "id, source, source_id, measured_at, weight_kg, bmi, body_fat_pct, body_water_pct, muscle_mass_kg, bone_mass_kg";
const ATHLETE_SETTINGS_COLUMNS =
  "manual_ftp_w, lthr_bpm, max_hr_bpm, resting_hr_bpm, strength_session_tss, no_power_tss_per_hour, units, week_start";
const FTP_HISTORY_COLUMNS = "id, effective_from, ftp_w, source, source_ref";
const DAILY_TRAINING_LOAD_COLUMNS = "date, tss_total, tss_by_source, ctl, atl, tsb";
const SYNC_STATE_COLUMNS =
  "source, cursor, last_run_at, last_success_at, items_fetched, items_upserted, last_error, backfill_complete, auth_status";

type DbRow = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const nullable = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const withUser = (row: DbRow, userId: string | undefined): DbRow => (userId === undefined ? row : { ...row, user_id: userId });

/** `rows` with one row per key, the last one for each key, in first-appearance order. */
function lastByKey<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

// [camelCase field, snake_case column] for every nullable double precision activity column.
const ACTIVITY_METRICS: [keyof ExternalActivity & keyof ExternalActivityInput, string][] = [
  ["elapsedS", "elapsed_s"], ["movingS", "moving_s"], ["distanceM", "distance_m"],
  ["elevationGainM", "elevation_gain_m"], ["avgSpeedMps", "avg_speed_mps"], ["maxSpeedMps", "max_speed_mps"],
  ["avgPowerW", "avg_power_w"], ["maxPowerW", "max_power_w"], ["normalizedPowerW", "normalized_power_w"],
  ["intensityFactor", "intensity_factor"], ["tss", "tss"], ["workKj", "work_kj"], ["calories", "calories"],
  ["avgHrBpm", "avg_hr_bpm"], ["maxHrBpm", "max_hr_bpm"], ["avgCadenceRpm", "avg_cadence_rpm"],
  ["biggestClimbM", "biggest_climb_m"],
];

export function toExternalActivity(r: DbRow): ExternalActivity {
  return {
    id: r.id as string,
    source: r.source as ActivitySource,
    sourceId: r.source_id as string,
    startedAt: r.started_at as string,
    timezone: (r.timezone as string | null) ?? null,
    sport: r.sport as string,
    subType: (r.sub_type as string | null) ?? null,
    environment: r.environment as ExternalActivity["environment"],
    title: (r.title as string | null) ?? null,
    elapsedS: num(r.elapsed_s),
    movingS: num(r.moving_s),
    distanceM: num(r.distance_m),
    elevationGainM: num(r.elevation_gain_m),
    avgSpeedMps: num(r.avg_speed_mps),
    maxSpeedMps: num(r.max_speed_mps),
    avgPowerW: num(r.avg_power_w),
    maxPowerW: num(r.max_power_w),
    normalizedPowerW: num(r.normalized_power_w),
    intensityFactor: num(r.intensity_factor),
    tss: num(r.tss),
    workKj: num(r.work_kj),
    calories: num(r.calories),
    avgHrBpm: num(r.avg_hr_bpm),
    maxHrBpm: num(r.max_hr_bpm),
    avgCadenceRpm: num(r.avg_cadence_rpm),
    biggestClimbM: num(r.biggest_climb_m),
    tssSource: (r.tss_source as ExternalActivity["tssSource"]) ?? null,
    ftpUsedW: num(r.ftp_used_w),
    ftpSource: (r.ftp_source as string | null) ?? null,
    hasPower: r.has_power === true,
    hasHr: r.has_hr === true,
    powerCurve: r.power_curve ?? null,
    bestEfforts: r.best_efforts ?? null,
    pairedActivityId: (r.paired_activity_id as string | null) ?? null,
    syncedAt: r.synced_at as string,
  };
}

/** ftp_used_w is an integer column: whole watts. */
const roundFtp = (w: number | null | undefined): number | null => (w === null || w === undefined ? null : Math.round(w));

function fromExternalActivityInput(a: ExternalActivityInput, now: string): DbRow {
  const row: DbRow = {
    source: a.source,
    source_id: a.sourceId,
    started_at: a.startedAt,
    timezone: nullable(a.timezone),
    sport: a.sport,
    sub_type: nullable(a.subType),
    environment: a.environment,
    title: nullable(a.title),
    tss_source: nullable(a.tssSource),
    ftp_used_w: roundFtp(a.ftpUsedW),
    ftp_source: nullable(a.ftpSource),
    has_power: a.hasPower ?? false,
    has_hr: a.hasHr ?? false,
    power_curve: nullable(a.powerCurve),
    best_efforts: nullable(a.bestEfforts),
    paired_activity_id: nullable(a.pairedActivityId),
    provider_payload: a.providerPayload,
    synced_at: now,
    updated_at: now,
  };
  for (const [field, column] of ACTIVITY_METRICS) row[column] = nullable(a[field] as number | null | undefined);
  return row;
}

/** PostgREST's default response cap (`max-rows`); list reads page in steps of this size. */
export const PAGE_SIZE = 1000;

/**
 * Reads every page of an ordered query, `PAGE_SIZE` rows at a time, until a
 * page comes back empty or `limit` rows have been collected. The end is never
 * inferred from a short page, so a server whose `max-rows` is below
 * `PAGE_SIZE` still reads everything (a full read costs one extra, empty
 * request). `page(from, to)` must build a fresh query ending in
 * `.range(from, to)` (inclusive bounds) on each call: a supabase-js builder
 * mutates on `.range()`, so one is not reused across pages. `limit` follows
 * `assertListLimit` (DataLayer.ts); 0 returns `[]` with no query.
 */
export async function readPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  map: (r: DbRow) => T,
  limit?: number,
): Promise<T[]> {
  assertListLimit(limit);
  const out: T[] = [];
  let from = 0;
  while (limit === undefined || out.length < limit) {
    const want = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - out.length);
    const { data, error } = await page(from, from + want - 1);
    if (error) throw error;
    const rows = (data ?? []) as DbRow[];
    if (rows.length === 0) break;
    for (const r of rows) out.push(map(r));
    from += rows.length;
  }
  return limit === undefined ? out : out.slice(0, limit);
}

export async function listExternalActivities(client: SupabaseClient, f: ExternalActivityFilter): Promise<ExternalActivity[]> {
  const page = (start: number, end: number) => {
    let q = client.from("external_activities").select(EXTERNAL_ACTIVITY_COLUMNS);
    if (f.from !== undefined) q = q.gte("started_at", f.from);
    if (f.to !== undefined) q = q.lte("started_at", f.to);
    if (f.source !== undefined) q = q.eq("source", f.source);
    if (f.environment !== undefined) q = q.eq("environment", f.environment);
    // id breaks started_at ties so consecutive pages neither skip nor repeat a row.
    return q.order("started_at", { ascending: false }).order("id").range(start, end);
  };
  return readPages(page, toExternalActivity, f.limit);
}

export async function getExternalActivity(client: SupabaseClient, id: string): Promise<ExternalActivity | null> {
  const { data, error } = await client.from("external_activities").select(EXTERNAL_ACTIVITY_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toExternalActivity(data as unknown as DbRow) : null;
}

export async function upsertExternalActivities(
  client: SupabaseClient,
  rows: ExternalActivityInput[],
  userId?: string,
): Promise<ExternalActivity[]> {
  if (rows.length === 0) return [];
  assertProviderPayloads(rows);
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("external_activities")
    .upsert(
      lastByKey(rows, (r) => `${r.source}\u0000${r.sourceId}`).map((r) => withUser(fromExternalActivityInput(r, now), userId)),
      { onConflict: "user_id,source,source_id" },
    )
    .select(EXTERNAL_ACTIVITY_COLUMNS);
  if (error) throw error;
  return ((data ?? []) as unknown as DbRow[]).map(toExternalActivity);
}

export async function getActivityStreams(client: SupabaseClient, activityId: string): Promise<ActivityStream[]> {
  const { data, error } = await client
    .from("activity_streams")
    .select("activity_id, channel, start_offset_s, values")
    .eq("activity_id", activityId)
    .order("channel");
  if (error) throw error;
  return ((data ?? []) as DbRow[]).map((r) => ({
    activityId: r.activity_id as string,
    channel: r.channel as StreamChannel,
    startOffsetS: Number(r.start_offset_s),
    values: (r.values as (number | null)[]) ?? [],
  }));
}

export async function replaceActivityStreams(
  client: SupabaseClient,
  activityId: string,
  streams: ActivityStreamInput[],
  userId?: string,
): Promise<void> {
  // Replace, not merge: first drop the channels absent from the new set (all of
  // them when the set is empty), then upsert the rest. Channel names come from
  // a fixed enum, so the PostgREST in-list needs no quoting.
  const channels = [...new Set(streams.map((s) => s.channel))];
  let del = client.from("activity_streams").delete().eq("activity_id", activityId);
  if (channels.length > 0) del = del.not("channel", "in", `(${channels.join(",")})`);
  const { error: deleteError } = await del;
  if (deleteError) throw deleteError;
  if (streams.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await client.from("activity_streams").upsert(
    lastByKey(streams, (s) => s.channel).map((s) =>
      withUser(
        { activity_id: activityId, channel: s.channel, start_offset_s: s.startOffsetS ?? 0, values: s.values, updated_at: now },
        userId,
      ),
    ),
    { onConflict: "activity_id,channel" },
  );
  if (error) throw error;
}

const toBodyWeight = (r: DbRow): BodyWeight => ({
  id: r.id as string,
  source: r.source as BodyWeight["source"],
  sourceId: r.source_id as string,
  measuredAt: r.measured_at as string,
  weightKg: Number(r.weight_kg),
  bmi: num(r.bmi),
  bodyFatPct: num(r.body_fat_pct),
  bodyWaterPct: num(r.body_water_pct),
  muscleMassKg: num(r.muscle_mass_kg),
  boneMassKg: num(r.bone_mass_kg),
});

export async function listBodyWeights(client: SupabaseClient, from: string, to: string): Promise<BodyWeight[]> {
  return readPages(
    (start, end) =>
      client
        .from("body_weights")
        .select(BODY_WEIGHT_COLUMNS)
        .gte("measured_at", from)
        .lte("measured_at", to)
        .order("measured_at")
        .order("id")
        .range(start, end),
    toBodyWeight,
  );
}

export async function upsertBodyWeights(client: SupabaseClient, rows: BodyWeightInput[], userId?: string): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await client.from("body_weights").upsert(
    lastByKey(rows, (w) => `${w.source}\u0000${w.sourceId}`).map((w) =>
      withUser(
        {
          source: w.source,
          source_id: w.sourceId,
          measured_at: w.measuredAt,
          weight_kg: w.weightKg,
          bmi: nullable(w.bmi),
          body_fat_pct: nullable(w.bodyFatPct),
          body_water_pct: nullable(w.bodyWaterPct),
          muscle_mass_kg: nullable(w.muscleMassKg),
          bone_mass_kg: nullable(w.boneMassKg),
          provider_payload: w.providerPayload,
          updated_at: now,
        },
        userId,
      ),
    ),
    { onConflict: "user_id,source,source_id" },
  );
  if (error) throw error;
}

const toAthleteSettings = (r: DbRow): AthleteSettings => ({
  manualFtpW: num(r.manual_ftp_w),
  lthrBpm: num(r.lthr_bpm),
  maxHrBpm: num(r.max_hr_bpm),
  restingHrBpm: num(r.resting_hr_bpm),
  strengthSessionTss: Number(r.strength_session_tss),
  noPowerTssPerHour: Number(r.no_power_tss_per_hour),
  units: r.units as AthleteSettings["units"],
  weekStart: r.week_start as AthleteSettings["weekStart"],
});

const ATHLETE_SETTINGS_FIELDS: [keyof AthleteSettings, string][] = [
  ["manualFtpW", "manual_ftp_w"], ["lthrBpm", "lthr_bpm"], ["maxHrBpm", "max_hr_bpm"],
  ["restingHrBpm", "resting_hr_bpm"], ["strengthSessionTss", "strength_session_tss"],
  ["noPowerTssPerHour", "no_power_tss_per_hour"], ["units", "units"], ["weekStart", "week_start"],
];

export async function getAthleteSettings(client: SupabaseClient): Promise<AthleteSettings> {
  const { data, error } = await client.from("athlete_settings").select(ATHLETE_SETTINGS_COLUMNS).maybeSingle();
  if (error) throw error;
  return data ? toAthleteSettings(data as DbRow) : { ...DEFAULT_ATHLETE_SETTINGS };
}

/**
 * Upserts the caller's settings row with only the defined fields of `patch`:
 * on insert the other columns take their defaults, on conflict only the sent
 * columns are updated. An empty patch writes nothing.
 */
export async function saveAthleteSettings(client: SupabaseClient, patch: Partial<AthleteSettings>): Promise<AthleteSettings> {
  const row: DbRow = {};
  for (const [field, column] of ATHLETE_SETTINGS_FIELDS) if (patch[field] !== undefined) row[column] = patch[field];
  if (Object.keys(row).length === 0) return getAthleteSettings(client);
  row.updated_at = new Date().toISOString();
  const { data, error } = await client
    .from("athlete_settings")
    .upsert(row, { onConflict: "user_id" })
    .select(ATHLETE_SETTINGS_COLUMNS)
    .single();
  if (error) throw error;
  return toAthleteSettings(data as DbRow);
}

const toFtpHistoryEntry = (r: DbRow): FtpHistoryEntry => ({
  id: r.id as string,
  effectiveFrom: r.effective_from as string,
  ftpW: Number(r.ftp_w),
  source: r.source as FtpSource,
  sourceRef: (r.source_ref as string | null) ?? null,
});

export async function listFtpHistory(client: SupabaseClient): Promise<FtpHistoryEntry[]> {
  return readPages(
    (from, to) =>
      client.from("ftp_history").select(FTP_HISTORY_COLUMNS).order("effective_from").order("created_at").order("id").range(from, to),
    toFtpHistoryEntry,
  );
}

export async function addFtpHistoryEntry(
  client: SupabaseClient,
  entry: Omit<FtpHistoryEntry, "id">,
  userId?: string,
): Promise<FtpHistoryEntry> {
  const { data, error } = await client
    .from("ftp_history")
    .insert(
      withUser(
        { effective_from: entry.effectiveFrom, ftp_w: entry.ftpW, source: entry.source, source_ref: entry.sourceRef ?? null },
        userId,
      ),
    )
    .select(FTP_HISTORY_COLUMNS)
    .single();
  if (error) throw error;
  return toFtpHistoryEntry(data as DbRow);
}

const toDailyTrainingLoad = (r: DbRow): DailyTrainingLoad => ({
  date: r.date as string,
  tssTotal: Number(r.tss_total),
  tssBySource: (r.tss_by_source as DailyTrainingLoad["tssBySource"]) ?? {},
  ctl: Number(r.ctl),
  atl: Number(r.atl),
  tsb: Number(r.tsb),
});

export async function listDailyTrainingLoad(client: SupabaseClient, from: string, to: string): Promise<DailyTrainingLoad[]> {
  // date is unique per user (the upsert key is user_id,date), so it needs no tiebreaker.
  return readPages(
    (start, end) =>
      client
        .from("daily_training_load")
        .select(DAILY_TRAINING_LOAD_COLUMNS)
        .gte("date", from)
        .lte("date", to)
        .order("date")
        .range(start, end),
    toDailyTrainingLoad,
  );
}

export async function upsertDailyTrainingLoad(client: SupabaseClient, rows: DailyTrainingLoad[], userId?: string): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await client.from("daily_training_load").upsert(
    lastByKey(rows, (d) => d.date).map((d) =>
      withUser(
        { date: d.date, tss_total: d.tssTotal, tss_by_source: d.tssBySource, ctl: d.ctl, atl: d.atl, tsb: d.tsb, updated_at: now },
        userId,
      ),
    ),
    { onConflict: "user_id,date" },
  );
  if (error) throw error;
}

const toSyncState = (r: DbRow): SyncState => ({
  source: r.source as SyncSource,
  cursor: r.cursor ?? null,
  lastRunAt: (r.last_run_at as string | null) ?? null,
  lastSuccessAt: (r.last_success_at as string | null) ?? null,
  itemsFetched: Number(r.items_fetched),
  itemsUpserted: Number(r.items_upserted),
  lastError: (r.last_error as string | null) ?? null,
  backfillComplete: r.backfill_complete === true,
  authStatus: r.auth_status as SyncState["authStatus"],
});

export async function listSyncState(client: SupabaseClient): Promise<SyncState[]> {
  const { data, error } = await client.from("sync_state").select(SYNC_STATE_COLUMNS).order("source");
  if (error) throw error;
  return ((data ?? []) as DbRow[]).map(toSyncState);
}

const SYNC_STATE_FIELDS: [Exclude<keyof SyncState, "source">, string][] = [
  ["cursor", "cursor"], ["lastRunAt", "last_run_at"], ["lastSuccessAt", "last_success_at"],
  ["itemsFetched", "items_fetched"], ["itemsUpserted", "items_upserted"], ["lastError", "last_error"],
  ["backfillComplete", "backfill_complete"], ["authStatus", "auth_status"],
];

/**
 * Service-role only (clients have select on sync_state, nothing else), so
 * not on the DataLayer: the wave 2 sync records a run with it. Upserts on
 * (user_id, source); only the defined fields of `row` change.
 */
export async function upsertSyncState(
  client: SupabaseClient,
  row: Pick<SyncState, "source"> & Partial<Omit<SyncState, "source">>,
  userId: string,
): Promise<SyncState> {
  const payload: DbRow = { user_id: userId, source: row.source };
  for (const [field, column] of SYNC_STATE_FIELDS) if (row[field] !== undefined) payload[column] = row[field];
  payload.updated_at = new Date().toISOString();
  const { data, error } = await client
    .from("sync_state")
    .upsert(payload, { onConflict: "user_id,source" })
    .select(SYNC_STATE_COLUMNS)
    .single();
  if (error) throw error;
  return toSyncState(data as DbRow);
}

export function createSupabaseDataLayer(): DataLayer {
  const supabase = getSupabase();

  async function fetchExercise(id: string): Promise<Exercise | null> {
    const { data } = await supabase.from("exercises").select("*").eq("id", id).maybeSingle();
    return data ? toExercise(data) : null;
  }

  /**
   * Session ids newest first (optionally only those before `beforeDate`), paged
   * past the PostgREST row cap. id breaks performed_on/created_at ties so
   * consecutive pages neither skip nor repeat a row.
   */
  function readSessionIdsNewestFirst(beforeDate?: string): Promise<string[]> {
    return readPages(
      (from, to) => {
        let q = supabase.from("sessions").select("id");
        if (beforeDate !== undefined) q = q.lt("performed_on", beforeDate);
        return q
          .order("performed_on", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, to);
      },
      (r) => r.id as string,
    );
  }

  async function loadSession(id: string): Promise<Session | null> {
    const { data: s } = await supabase.from("sessions").select("*").eq("id", id).maybeSingle();
    if (!s) return null;
    const { data: sets } = await supabase
      .from("session_sets")
      .select("*")
      .eq("session_id", id)
      .order("set_number");
    const byExercise: Record<string, SetEntry[]> = {};
    for (const row of sets ?? []) {
      (byExercise[row.exercise_id] ??= []).push({
        setNumber: row.set_number,
        weight: Number(row.weight),
        reps: row.reps,
      });
    }
    return {
      id: s.id,
      workoutDayId: s.workout_day_id,
      performedOn: s.performed_on,
      exercises: Object.entries(byExercise).map(([exerciseId, exSets]) => ({ exerciseId, sets: exSets })),
    };
  }

  return {
    claimSeed: () => claimSeed(supabase),
    listExercises: () => listExercises(supabase),
    getExercise: (id) => fetchExercise(id),
    createExercise: (input) => createExercise(supabase, input),
    updateExercise: (id, patch) => updateExercise(supabase, id, patch),
    deleteExercise: (id) => deleteExercise(supabase, id),
    findDayByName: (name) => findDayByName(supabase, name),
    findExerciseByName: (name) => findExerciseByName(supabase, name),
    findProgramByName: (name) => findProgramByName(supabase, name),
    async getWorkoutDays() {
      const { data } = await supabase.from("workout_days").select("*").is("deleted_at", null).order("position");
      const rows = data ?? [];

      const { data: programRows } = await supabase.from("programs").select("id, name").is("deleted_at", null);
      const programsById = new Map((programRows ?? []).map((p) => [p.id as string, p.name as string]));

      const { data: doneRows } = await supabase
        .from("sessions")
        .select("id, workout_day_id, session_sets!inner(id)")
        .not("workout_day_id", "is", null);
      const completed = new Set((doneRows ?? []).map((r) => r.workout_day_id as string));

      const availabilityInput = rows.map((d) => ({
        id: d.id as string,
        programId: d.program_id && programsById.has(d.program_id) ? (d.program_id as string) : null,
        programPosition: d.program_position as number | null,
      }));
      const nextByProgram = nextAvailablePositionByProgram(availabilityInput, completed);

      const days: WorkoutDay[] = [];
      for (const [i, d] of rows.entries()) {
        const { data: links } = await supabase
          .from("workout_day_exercises")
          .select("exercise_id, position")
          .eq("workout_day_id", d.id)
          .order("position");
        const effective = availabilityInput[i];
        days.push({
          id: d.id,
          name: d.name,
          position: d.position,
          exerciseIds: (links ?? []).map((l) => l.exercise_id),
          programId: effective.programId,
          programPosition: effective.programId ? (d.program_position as number) : null,
          programName: effective.programId ? programsById.get(effective.programId)! : null,
          isAvailable: isDayAvailable(effective, nextByProgram),
        });
      }
      return days;
    },
    async getDayExercises(dayId) {
      const { data: links } = await supabase
        .from("workout_day_exercises")
        .select("exercise_id, position")
        .eq("workout_day_id", dayId)
        .order("position");
      const out: Exercise[] = [];
      for (const l of links ?? []) {
        const ex = await fetchExercise(l.exercise_id);
        if (ex) out.push(ex);
      }
      return out;
    },
    createDay: (name) => createDay(supabase, name),
    deleteDay: (id) => deleteDay(supabase, id),
    addExerciseToDay: (dayId, exerciseId) => addExerciseToDay(supabase, dayId, exerciseId),
    removeExerciseFromDay: (dayId, exerciseId) => removeExerciseFromDay(supabase, dayId, exerciseId),
    updateDayExercises: (dayId, exerciseIds) => updateDayExercises(supabase, dayId, exerciseIds),
    updateDayName: (dayId, name) => updateDayName(supabase, dayId, name),
    createProgram: (name) => createProgram(supabase, name),
    renameProgram: (programId, name) => renameProgram(supabase, programId, name),
    deleteProgram: (programId) => deleteProgram(supabase, programId),
    addDayToProgram: (dayId, programId) => addDayToProgram(supabase, dayId, programId),
    removeDayFromProgram: (dayId) => removeDayFromProgram(supabase, dayId),
    reorderProgramDays: (programId, dayIds) => reorderProgramDays(supabase, programId, dayIds),
    async getDayExerciseTargets(dayId) {
      const { data } = await supabase
        .from("workout_day_exercises")
        .select("exercise_id, target_sets")
        .eq("workout_day_id", dayId);
      const out: Record<string, SetEntry[]> = {};
      for (const row of data ?? []) {
        const raw = row.target_sets as { weight: number; reps: number }[] | null;
        if (raw && raw.length > 0) {
          out[row.exercise_id] = raw.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps }));
        }
      }
      return out;
    },
    setDayExerciseTarget: (dayId, exerciseId, sets) => setDayExerciseTarget(supabase, dayId, exerciseId, sets),
    async getSchemeHistory(dayId, exerciseId) {
      const { data, error } = await supabase
        .from("workout_day_exercise_scheme_history")
        .select("target_sets, recorded_at")
        .eq("workout_day_id", dayId)
        .eq("exercise_id", exerciseId)
        .order("recorded_at");
      if (error) throw error;
      return (data ?? []).map((row) => {
        const raw = row.target_sets as { weight: number; reps: number }[] | null;
        const targetSets = raw && raw.length > 0 ? raw.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps })) : null;
        return { targetSets, recordedAt: row.recorded_at as string };
      });
    },
    async getLastSetsForExercise(exerciseId, beforeDate) {
      // A failed read yields no earlier sessions (and so no last sets), as before paging:
      // the callers have no catch and must keep rendering.
      const ids = await readSessionIdsNewestFirst(beforeDate).catch((): string[] => []);
      for (const id of ids) {
        const { data: sets } = await supabase
          .from("session_sets")
          .select("*")
          .eq("session_id", id)
          .eq("exercise_id", exerciseId)
          .order("set_number");
        if (sets && sets.length) {
          return sets.map((row) => ({ setNumber: row.set_number, weight: Number(row.weight), reps: row.reps }));
        }
      }
      return [];
    },
    async startSession(workoutDayId, date) {
      const { data, error } = await supabase
        .from("sessions")
        .insert({ workout_day_id: workoutDayId, performed_on: date })
        .select("*")
        .single();
      if (error) throw error;
      return { id: data.id, workoutDayId: data.workout_day_id, performedOn: data.performed_on, exercises: [] };
    },
    getSession: (id) => loadSession(id),
    async getLastSessionForDay(workoutDayId) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .eq("workout_day_id", workoutDayId)
        .order("performed_on", { ascending: false })
        .order("created_at", { ascending: false });
      for (const sess of s ?? []) {
        const full = await loadSession(sess.id);
        if (full && full.exercises.length > 0) return full;
      }
      return null;
    },
    async getSessionForDayAndDate(workoutDayId, date) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .eq("workout_day_id", workoutDayId)
        .eq("performed_on", date)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!s) return null;
      return loadSession(s.id);
    },
    logExercise: (sessionId, exerciseId, sets) => logExercise(supabase, sessionId, exerciseId, sets),
    async getExerciseHistory(exerciseId) {
      // The result is sorted below; ordering by id only makes the pages deterministic.
      // A failed read yields an empty history, as before paging: the callers have no catch.
      const sessionIds = await readPages(
        (from, to) =>
          supabase.from("session_sets").select("session_id").eq("exercise_id", exerciseId).order("id").range(from, to),
        (r) => r.session_id as string,
      ).catch((): string[] => []);
      const ids = [...new Set(sessionIds)];
      const sessions: Session[] = [];
      for (const id of ids) {
        const sess = await loadSession(id);
        if (sess) sessions.push(sess);
      }
      return sessions.sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
    async listSessions() {
      // A failed read yields no sessions, as before paging: the callers have no catch.
      // A row shifted between pages can be read twice, so ids are de-duplicated (first wins).
      const ids = [...new Set(await readSessionIdsNewestFirst().catch((): string[] => []))];
      const sessions: Session[] = [];
      for (const id of ids) {
        const sess = await loadSession(id);
        if (sess) sessions.push(sess);
      }
      return sessions;
    },
    async deleteSession(id) {
      const { error } = await supabase.from("sessions").delete().eq("id", id);
      if (error) throw error;
    },
    listExternalActivities: (f) => listExternalActivities(supabase, f),
    getExternalActivity: (id) => getExternalActivity(supabase, id),
    upsertExternalActivities: (rows) => upsertExternalActivities(supabase, rows),
    getActivityStreams: (activityId) => getActivityStreams(supabase, activityId),
    replaceActivityStreams: (activityId, streams) => replaceActivityStreams(supabase, activityId, streams),
    listBodyWeights: (from, to) => listBodyWeights(supabase, from, to),
    upsertBodyWeights: (rows) => upsertBodyWeights(supabase, rows),
    getAthleteSettings: () => getAthleteSettings(supabase),
    saveAthleteSettings: (patch) => saveAthleteSettings(supabase, patch),
    listFtpHistory: () => listFtpHistory(supabase),
    addFtpHistoryEntry: (entry) => addFtpHistoryEntry(supabase, entry),
    listDailyTrainingLoad: (from, to) => listDailyTrainingLoad(supabase, from, to),
    upsertDailyTrainingLoad: (rows) => upsertDailyTrainingLoad(supabase, rows),
    listSyncState: () => listSyncState(supabase),
  };
}
