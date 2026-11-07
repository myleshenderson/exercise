import type {
  ExerciseRow,
  JsonValue,
  SchemeHistoryRow,
  SessionRow,
  SessionSetRow,
  WorkoutDayExerciseRow,
  WorkoutDayRow,
} from "./rows.js";
import {
  ascNullsLast,
  compareDates,
  compareText,
  compareUuids,
  dayNumber,
  roundRatio,
  timestampMicros,
  timestampToUtcDate,
  uuidEquals,
  uuidKey,
} from "./sqlSemantics.js";

export interface AdherenceForDayTables {
  sessions: readonly Pick<SessionRow, "id" | "performed_on" | "workout_day_id">[];
  sessionSets: readonly Pick<SessionSetRow, "session_id" | "exercise_id" | "weight" | "reps">[];
  /** Include soft-deleted days: the SQL joins them without filtering `deleted_at`. */
  workoutDays: readonly Pick<WorkoutDayRow, "id" | "name">[];
  exercises: readonly Pick<ExerciseRow, "id" | "name" | "default_sets" | "default_rep_low" | "default_rep_high">[];
  workoutDayExercises: readonly Pick<WorkoutDayExerciseRow, "workout_day_id" | "exercise_id" | "target_sets">[];
  schemeHistory: readonly Pick<SchemeHistoryRow, "workout_day_id" | "exercise_id" | "target_sets" | "recorded_at">[];
}

export interface AdherenceForDayParams {
  /** Only sessions for this day; null/omitted for all sessions. */
  for_workout_day_id?: string | null;
  /** Inclusive lower bound on `performed_on`, "YYYY-MM-DD". */
  start_date?: string | null;
  /** Inclusive upper bound on `performed_on`, "YYYY-MM-DD". */
  end_date?: string | null;
}

export type AdherenceStatus = "under" | "over" | "match";

export interface AdherenceForDayResult {
  session_id: string;
  performed_on: string;
  workout_day_id: string | null;
  workout_day_name: string | null;
  exercise_id: string;
  exercise_name: string | null;
  actual_sets: number;
  target_sets: number | null;
  sets_status: AdherenceStatus;
  actual_avg_reps: number;
  target_rep_low: number | null;
  target_rep_high: number | null;
  reps_status: AdherenceStatus;
  actual_top_weight: number;
  target_weight: number | null;
  weight_status: AdherenceStatus | null;
}

interface Group {
  session: AdherenceForDayTables["sessions"][number];
  exerciseId: string;
  sets: number;
  repsSum: bigint;
  topWeight: number;
}

/**
 * Actual logged sets per (session, exercise) compared against the scheme in
 * effect on the session date. Mirrors `public.adherence_for_day` in
 * `supabase/migrations/20260906152003_adherence_for_day_rpc.sql`.
 *
 * Postgres semantics reproduced:
 * - `sessions join session_sets` (set-less sessions produce nothing; sets
 *   whose session is missing are dropped), `left join` days and exercises.
 *   `workout_day_id` is the session's own column, `exercise_id` the set's.
 * - Target resolution: the latest scheme-history row for the session's
 *   (day, exercise) with `recorded_at::date <= performed_on`, where the cast
 *   is evaluated in session TimeZone UTC (the Supabase default). If such a
 *   row exists its `target_sets` wins even when null (a cleared scheme), so
 *   the exercise defaults apply rather than the current scheme. Otherwise the
 *   first `workoutDayExercises` row for the pair (`limit 1` without `order
 *   by`: input order here). History rows tied on `recorded_at` take the first
 *   in input order.
 * - `target_sets` = array length, else `default_sets`; rep range = min/max of
 *   element `reps`, else the exercise defaults; `target_weight` = max element
 *   `weight` (null without a scheme or when no element has a weight). Element
 *   values are read like `(elem->>'reps')::int` / `(elem->>'weight')::numeric`:
 *   missing/null keys are ignored, values those casts reject throw. A
 *   non-array scheme throws, as `jsonb_array_length` does. Not reproducible:
 *   a jsonb scalar `null` scheme (SQL raises) and a reps value stored as
 *   `8.0` (SQL raises) arrive from PostgREST as JSON `null` and `8`, so they
 *   are treated as SQL NULL and as 8.
 * - Statuses use SQL `case`: a comparison with a null target is not true, so
 *   it falls through to `'match'`; `weight_status` is null when
 *   `target_weight` is null. `reps_status` compares the exact average, while
 *   `actual_avg_reps` is `round(avg(reps), 1)`, half away from zero.
 * - `order by performed_on, session_id, exercise_name` (nulls last; text in
 *   the en_US collation, see `compareText`). Rows tied on all three (two
 *   exercises with the same or a null name in one session) have no SQL
 *   order; here they keep first-seen order of their sets.
 */
export function adherenceForDay(
  tables: AdherenceForDayTables,
  params: AdherenceForDayParams = {},
): AdherenceForDayResult[] {
  const start = params.start_date == null ? null : dayNumber(params.start_date);
  const end = params.end_date == null ? null : dayNumber(params.end_date);
  const dayFilter = params.for_workout_day_id ?? null;

  const sessions = new Map<string, AdherenceForDayTables["sessions"][number]>();
  for (const s of tables.sessions) {
    if (dayFilter !== null && !uuidEquals(s.workout_day_id, dayFilter)) continue;
    const performed = dayNumber(s.performed_on);
    if (start !== null && performed < start) continue;
    if (end !== null && performed > end) continue;
    sessions.set(uuidKey(s.id), s);
  }

  const groups = new Map<string, Group>();
  for (const ss of tables.sessionSets) {
    const sessionKey = uuidKey(ss.session_id);
    const session = sessions.get(sessionKey);
    if (session === undefined) continue;
    const key = `${sessionKey}|${uuidKey(ss.exercise_id)}`;
    const g = groups.get(key);
    if (g === undefined) {
      groups.set(key, { session, exerciseId: ss.exercise_id, sets: 1, repsSum: BigInt(ss.reps), topWeight: ss.weight });
    } else {
      g.sets += 1;
      g.repsSum += BigInt(ss.reps);
      g.topWeight = Math.max(g.topWeight, ss.weight);
    }
  }

  const days = new Map(tables.workoutDays.map((d) => [uuidKey(d.id), d]));
  const exercises = new Map(tables.exercises.map((e) => [uuidKey(e.id), e]));
  const lookup = schemeLookup(tables);

  const rows: AdherenceForDayResult[] = [];
  for (const g of groups.values()) {
    const { session } = g;
    const day = session.workout_day_id == null ? undefined : days.get(uuidKey(session.workout_day_id));
    const exercise = exercises.get(uuidKey(g.exerciseId));
    const scheme = lookup(session.workout_day_id, g.exerciseId, session.performed_on);
    const elements = schemeElements(scheme);

    const targetSets = elements === null ? (exercise?.default_sets ?? null) : elements.length;
    const reps = (elements ?? []).map((el) => elementInt(el, "reps")).filter((n): n is number => n !== null);
    const weights = (elements ?? []).map((el) => elementNumeric(el, "weight")).filter((n): n is number => n !== null);
    const targetRepLow = reps.length > 0 ? Math.min(...reps) : (exercise?.default_rep_low ?? null);
    const targetRepHigh = reps.length > 0 ? Math.max(...reps) : (exercise?.default_rep_high ?? null);
    const targetWeight = weights.length > 0 ? Math.max(...weights) : null;

    const count = BigInt(g.sets);
    // avg(reps) < low  <=>  sum < low * count, kept exact.
    const repsStatus: AdherenceStatus =
      targetRepLow !== null && g.repsSum < BigInt(targetRepLow) * count
        ? "under"
        : targetRepHigh !== null && g.repsSum > BigInt(targetRepHigh) * count
          ? "over"
          : "match";

    rows.push({
      session_id: session.id,
      performed_on: session.performed_on,
      workout_day_id: session.workout_day_id,
      workout_day_name: day?.name ?? null,
      exercise_id: g.exerciseId,
      exercise_name: exercise?.name ?? null,
      actual_sets: g.sets,
      target_sets: targetSets,
      sets_status: compareStatus(g.sets, targetSets) ?? "match",
      actual_avg_reps: roundRatio(g.repsSum, count, 1),
      target_rep_low: targetRepLow,
      target_rep_high: targetRepHigh,
      reps_status: repsStatus,
      actual_top_weight: g.topWeight,
      target_weight: targetWeight,
      weight_status: targetWeight === null ? null : (compareStatus(g.topWeight, targetWeight) ?? "match"),
    });
  }

  return rows.sort(
    (a, b) =>
      compareDates(a.performed_on, b.performed_on) ||
      compareUuids(a.session_id, b.session_id) ||
      ascNullsLast(a.exercise_name, b.exercise_name, compareText),
  );
}

function compareStatus(actual: number, target: number | null): AdherenceStatus | null {
  if (target === null) return null;
  return actual < target ? "under" : actual > target ? "over" : "match";
}

/**
 * Builds the per-(day, exercise) target resolver: latest history row whose
 * `recorded_at::date` (UTC) is on or before the session date, else the first
 * matching `workout_day_exercises` row's current scheme.
 */
function schemeLookup(
  tables: AdherenceForDayTables,
): (workoutDayId: string | null, exerciseId: string, performedOn: string) => JsonValue {
  const pairKey = (dayId: string, exerciseId: string) => `${uuidKey(dayId)}|${uuidKey(exerciseId)}`;
  const historyByPair = new Map<string, { at: bigint; day: number; targetSets: JsonValue }[]>();
  for (const h of tables.schemeHistory) {
    const key = pairKey(h.workout_day_id, h.exercise_id);
    const entry = { at: timestampMicros(h.recorded_at), day: dayNumber(timestampToUtcDate(h.recorded_at)), targetSets: h.target_sets ?? null };
    const list = historyByPair.get(key);
    if (list) list.push(entry);
    else historyByPair.set(key, [entry]);
  }
  const currentByPair = new Map<string, JsonValue>();
  for (const wde of tables.workoutDayExercises) {
    const key = pairKey(wde.workout_day_id, wde.exercise_id);
    if (!currentByPair.has(key)) currentByPair.set(key, wde.target_sets ?? null);
  }

  return (workoutDayId, exerciseId, performedOn) => {
    if (workoutDayId == null) return null; // `sh.workout_day_id = null` never matches
    const key = pairKey(workoutDayId, exerciseId);
    const performed = dayNumber(performedOn);
    let latest: { at: bigint; targetSets: JsonValue } | null = null;
    for (const h of historyByPair.get(key) ?? []) {
      if (h.day > performed) continue;
      if (latest === null || h.at > latest.at) latest = h;
    }
    if (latest !== null) return latest.targetSets;
    return currentByPair.get(key) ?? null;
  };
}

function schemeElements(scheme: JsonValue): JsonValue[] | null {
  if (scheme === null || scheme === undefined) return null;
  if (!Array.isArray(scheme)) throw new Error("cannot get array length of a non-array");
  return scheme;
}

/** `elem->>key` as text; null for a non-object element or a missing/null key. */
function elementText(el: JsonValue, key: string): string | null {
  if (el === null || typeof el !== "object" || Array.isArray(el)) return null;
  const v = el[key];
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** `(elem->>key)::int`: throws where Postgres raises "invalid input syntax for type integer". */
function elementInt(el: JsonValue, key: string): number | null {
  const text = elementText(el, key);
  if (text === null) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new Error(`invalid input syntax for type integer: "${text}"`);
  return Number(text);
}

/** `(elem->>key)::numeric`: throws where Postgres raises "invalid input syntax for type numeric". */
function elementNumeric(el: JsonValue, key: string): number | null {
  const text = elementText(el, key);
  if (text === null) return null;
  if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(text)) {
    throw new Error(`invalid input syntax for type numeric: "${text}"`);
  }
  return Number(text);
}
