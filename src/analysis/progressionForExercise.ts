import type { ExerciseRow, SessionRow, SessionSetRow } from "./rows";
import { matchingSetsWithDate } from "./matchingSets";
import { addDecimal, compareDates, mulDecimalInt, roundDecimal, toDecimal, type Decimal } from "./sqlSemantics";

export interface ProgressionForExerciseTables {
  sessions: readonly Pick<SessionRow, "id" | "performed_on">[];
  sessionSets: readonly Pick<SessionSetRow, "session_id" | "exercise_id" | "weight" | "reps">[];
  exercises: readonly Pick<ExerciseRow, "id" | "name">[];
}

export interface ProgressionForExerciseParams {
  exercise_name: string | null;
}

export interface ProgressionForExerciseResult {
  performed_on: string;
  sets: number;
  top_weight: number;
  volume: number;
}

/**
 * Per-day aggregate of every set of exercises whose name matches
 * `exercise_name`. Mirrors `public.progression_for_exercise` in
 * `supabase/migrations/0005_analysis_rpc.sql`.
 *
 * Postgres semantics reproduced:
 * - `e.name ilike '%' || exercise_name || '%'` with the caller's text
 *   unescaped, so `%` and `_` in it act as wildcards and backslash escapes
 *   (a trailing backslash escapes the appended `%`). A null name matches nothing.
 * - Inner joins: a set whose session or exercise is not in the input is dropped.
 * - `round(sum(weight * reps))` is computed in exact decimal arithmetic and
 *   rounded half away from zero, like `round(numeric)`.
 * - Rows are ordered by `performed_on`, which is unique per output row.
 * - Soft-deleted exercises are not excluded (the SQL does not filter `deleted_at`).
 */
export function progressionForExercise(
  tables: ProgressionForExerciseTables,
  params: ProgressionForExerciseParams,
): ProgressionForExerciseResult[] {
  const byDate = new Map<string, { sets: number; topWeight: number; volume: Decimal }>();
  for (const { performed_on: performedOn, set: ss } of matchingSetsWithDate(tables, params.exercise_name)) {
    const product = mulDecimalInt(toDecimal(ss.weight), ss.reps);
    const group = byDate.get(performedOn);
    if (group === undefined) {
      byDate.set(performedOn, { sets: 1, topWeight: ss.weight, volume: product });
    } else {
      group.sets += 1;
      group.topWeight = Math.max(group.topWeight, ss.weight);
      group.volume = addDecimal(group.volume, product);
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => compareDates(a, b))
    .map(([performed_on, g]) => ({
      performed_on,
      sets: g.sets,
      top_weight: g.topWeight,
      volume: roundDecimal(g.volume),
    }));
}
