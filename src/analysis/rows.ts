/**
 * Plain row types mirroring the Postgres tables the analysis RPCs read, as
 * PostgREST returns them (snake_case columns, `date` as "YYYY-MM-DD",
 * `timestamptz` as an ISO-8601 string, `numeric`/`int` as JSON numbers,
 * `jsonb` as parsed JSON). `user_id` is deliberately omitted: the functions in
 * `src/analysis/` do no user scoping, so callers must pass only one user's rows.
 *
 * Table definitions: supabase/migrations/0001_init.sql, 0007_target_sets.sql,
 * 20260906151951_scheme_history.sql, 20260906170000_workout_days_soft_delete.sql,
 * 20260906180000_exercises_soft_delete.sql, 20260906180100_day_sequencing.sql.
 */

/** Any parsed `jsonb` value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** `public.exercises` */
export interface ExerciseRow {
  id: string;
  name: string;
  cue: string;
  default_sets: number;
  default_rep_low: number;
  default_rep_high: number;
  created_at: string;
  deleted_at: string | null;
}

/** `public.programs` */
export interface ProgramRow {
  id: string;
  name: string;
  deleted_at: string | null;
  created_at: string;
}

/** `public.workout_days` */
export interface WorkoutDayRow {
  id: string;
  name: string;
  position: number;
  created_at: string;
  deleted_at: string | null;
  program_id: string | null;
  program_position: number | null;
}

/** `public.workout_day_exercises`; `target_sets` is a `{weight, reps}[]` scheme or null. */
export interface WorkoutDayExerciseRow {
  id: string;
  workout_day_id: string;
  exercise_id: string;
  position: number;
  target_sets: JsonValue;
}

/** `public.sessions` */
export interface SessionRow {
  id: string;
  workout_day_id: string | null;
  /** Postgres `date`, "YYYY-MM-DD". */
  performed_on: string;
  created_at: string;
}

/** `public.session_sets` */
export interface SessionSetRow {
  id: string;
  session_id: string;
  exercise_id: string;
  set_number: number;
  weight: number;
  reps: number;
}

/** `public.workout_day_exercise_scheme_history` */
export interface SchemeHistoryRow {
  id: string;
  workout_day_id: string;
  exercise_id: string;
  target_sets: JsonValue;
  /** Postgres `timestamptz`, ISO-8601 with offset. */
  recorded_at: string;
}
