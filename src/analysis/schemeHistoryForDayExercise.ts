import type { JsonValue, SchemeHistoryRow } from "./rows";
import { timestampMicros, uuidEquals } from "./sqlSemantics";

export interface SchemeHistoryForDayExerciseTables {
  schemeHistory: readonly Pick<SchemeHistoryRow, "workout_day_id" | "exercise_id" | "target_sets" | "recorded_at">[];
}

export interface SchemeHistoryForDayExerciseParams {
  workout_day_id: string;
  exercise_id: string;
}

export interface SchemeHistoryForDayExerciseResult {
  target_sets: JsonValue;
  recorded_at: string;
}

/**
 * Every scheme ever recorded for one (day, exercise) pair, oldest first.
 * Mirrors `public.scheme_history_for_day_exercise` in
 * `supabase/migrations/20260906151951_scheme_history.sql`.
 *
 * Postgres semantics reproduced: uuids compare by value (case-insensitive
 * text); `order by recorded_at` compares instants at microsecond precision
 * regardless of the offset in the text. Rows with identical `recorded_at`
 * have no SQL order; here they keep their input order (stable sort).
 * `recorded_at` is returned as passed in.
 */
export function schemeHistoryForDayExercise(
  tables: SchemeHistoryForDayExerciseTables,
  params: SchemeHistoryForDayExerciseParams,
): SchemeHistoryForDayExerciseResult[] {
  return tables.schemeHistory
    .filter((h) => uuidEquals(h.workout_day_id, params.workout_day_id) && uuidEquals(h.exercise_id, params.exercise_id))
    .map((h) => ({ row: { target_sets: h.target_sets, recorded_at: h.recorded_at }, at: timestampMicros(h.recorded_at) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map(({ row }) => row);
}
