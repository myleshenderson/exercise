import type { ExerciseRow, SessionRow, SessionSetRow } from "./rows.js";
import { matchingSetsWithDate } from "./matchingSets.js";
import { compareDates, compareNumbers } from "./sqlSemantics.js";

export interface SetsForExerciseTables {
  sessions: readonly Pick<SessionRow, "id" | "performed_on">[];
  sessionSets: readonly Pick<SessionSetRow, "session_id" | "exercise_id" | "set_number" | "weight" | "reps">[];
  exercises: readonly Pick<ExerciseRow, "id" | "name">[];
}

export interface SetsForExerciseParams {
  exercise_name: string | null;
}

export interface SetsForExerciseResult {
  performed_on: string;
  set_number: number;
  weight: number;
  reps: number;
}

/**
 * Every individual set of exercises whose name matches `exercise_name`,
 * ungrouped. Mirrors `public.sets_for_exercise` in
 * `supabase/migrations/0010_sets_for_exercise_rpc.sql`.
 *
 * Postgres semantics reproduced:
 * - Same unescaped `ilike '%' || exercise_name || '%'` match as
 *   `progressionForExercise`; a null name matches nothing.
 * - Inner joins: a set whose session or exercise is not in the input is dropped.
 * - `order by performed_on, set_number`. Rows equal on both keys (e.g. set 1
 *   of two matching exercises, or of two sessions on one day) have no order
 *   in SQL; here they keep their order in `sessionSets` (stable sort).
 */
export function setsForExercise(
  tables: SetsForExerciseTables,
  params: SetsForExerciseParams,
): SetsForExerciseResult[] {
  return matchingSetsWithDate(tables, params.exercise_name)
    .map(({ performed_on, set: ss }) => ({ performed_on, set_number: ss.set_number, weight: ss.weight, reps: ss.reps }))
    .sort(
    (a, b) => compareDates(a.performed_on, b.performed_on) || compareNumbers(a.set_number, b.set_number),
  );
}
