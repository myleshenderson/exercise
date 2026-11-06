import type { ExerciseRow, SessionRow, SessionSetRow, WorkoutDayRow } from "./rows";
import {
  ascNullsLast,
  compareDates,
  compareNumbers,
  compareUuids,
  compileIlike,
  dayNumber,
  groupByUuid,
  uuidKey,
} from "./sqlSemantics";

export interface GetWorkoutHistoryTables {
  sessions: readonly Pick<SessionRow, "id" | "performed_on" | "workout_day_id">[];
  /** Include soft-deleted days: the SQL joins them without filtering `deleted_at`. */
  workoutDays: readonly Pick<WorkoutDayRow, "id" | "name">[];
  sessionSets: readonly Pick<SessionSetRow, "session_id" | "exercise_id" | "set_number" | "weight" | "reps">[];
  exercises: readonly Pick<ExerciseRow, "id" | "name">[];
}

export interface GetWorkoutHistoryParams {
  /** Inclusive lower bound on `performed_on`, "YYYY-MM-DD"; null/omitted for none. */
  start_date?: string | null;
  /** Inclusive upper bound on `performed_on`, "YYYY-MM-DD"; null/omitted for none. */
  end_date?: string | null;
  /** Case-insensitive literal substring of the exercise name; null/omitted for none. */
  exercise_name?: string | null;
}

export interface GetWorkoutHistoryResult {
  session_id: string;
  performed_on: string;
  workout_day_id: string | null;
  workout_day_name: string | null;
  exercise_id: string | null;
  exercise_name: string | null;
  set_number: number | null;
  weight: number | null;
  reps: number | null;
}

/**
 * Raw, unaggregated session history: one row per logged set, plus one
 * all-null-set row for a session with no sets. Mirrors
 * `public.get_workout_history` as redefined in
 * `supabase/migrations/0011_workout_history_filters.sql` (originally
 * `0008_full_dump_rpc.sql`).
 *
 * Postgres semantics reproduced:
 * - `sessions left join workout_days left join session_sets left join
 *   exercises`: `workout_day_id`/`workout_day_name` come from the joined day
 *   row (null if it is not in the input), `exercise_id`/`exercise_name` from
 *   the joined exercise row.
 * - `exercise_name` is escaped (`\`, `%`, `_`) before being wrapped in `%`, so
 *   it is a literal case-insensitive substring match. When given, rows with
 *   no exercise (set-less sessions, sets whose exercise is missing) are
 *   excluded, because `null ilike ...` is not true.
 * - `order by performed_on, s.id, ss.set_number`: uuids compare by value,
 *   `set_number` nulls sort last. Rows equal on all three keys (same set
 *   number for two exercises in one session) have no SQL order; here they
 *   keep their order in `sessionSets` (stable sort).
 */
export function getWorkoutHistory(
  tables: GetWorkoutHistoryTables,
  params: GetWorkoutHistoryParams = {},
): GetWorkoutHistoryResult[] {
  const start = params.start_date == null ? null : dayNumber(params.start_date);
  const end = params.end_date == null ? null : dayNumber(params.end_date);
  const pattern =
    params.exercise_name == null
      ? null
      : compileIlike(`%${params.exercise_name.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);

  const days = new Map(tables.workoutDays.map((d) => [uuidKey(d.id), d]));
  const exercises = new Map(tables.exercises.map((e) => [uuidKey(e.id), e]));
  const setsBySession = groupByUuid(tables.sessionSets, (ss) => ss.session_id);

  const rows: GetWorkoutHistoryResult[] = [];
  for (const s of tables.sessions) {
    const performed = dayNumber(s.performed_on);
    if (start !== null && performed < start) continue;
    if (end !== null && performed > end) continue;
    const day = s.workout_day_id == null ? undefined : days.get(uuidKey(s.workout_day_id));
    const base = {
      session_id: s.id,
      performed_on: s.performed_on,
      workout_day_id: day?.id ?? null,
      workout_day_name: day?.name ?? null,
    };
    const sets = setsBySession.get(uuidKey(s.id)) ?? [];
    if (sets.length === 0) {
      if (pattern !== null) continue;
      rows.push({ ...base, exercise_id: null, exercise_name: null, set_number: null, weight: null, reps: null });
      continue;
    }
    for (const ss of sets) {
      const exercise = exercises.get(uuidKey(ss.exercise_id));
      if (pattern !== null && (exercise === undefined || !pattern.test(exercise.name))) continue;
      rows.push({
        ...base,
        exercise_id: exercise?.id ?? null,
        exercise_name: exercise?.name ?? null,
        set_number: ss.set_number,
        weight: ss.weight,
        reps: ss.reps,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      compareDates(a.performed_on, b.performed_on) ||
      compareUuids(a.session_id, b.session_id) ||
      ascNullsLast(a.set_number, b.set_number, compareNumbers),
  );
}
