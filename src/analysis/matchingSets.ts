import type { ExerciseRow, SessionRow, SessionSetRow } from "./rows";
import { compileIlike, uuidKey } from "./sqlSemantics";

/**
 * The shared core of `progression_for_exercise` and `sets_for_exercise`:
 * `session_sets join sessions join exercises where e.name ilike '%' ||
 * exercise_name || '%'`, with the caller's text unescaped (so `%`/`_` are
 * wildcards). Returns each matching set with its session date, in input order.
 * A null name matches nothing. Internal; not re-exported from `index.ts`.
 */
export function matchingSetsWithDate<S extends Pick<SessionSetRow, "session_id" | "exercise_id">>(
  tables: {
    sessions: readonly Pick<SessionRow, "id" | "performed_on">[];
    sessionSets: readonly S[];
    exercises: readonly Pick<ExerciseRow, "id" | "name">[];
  },
  exerciseName: string | null,
): { performed_on: string; set: S }[] {
  if (exerciseName == null) return [];
  const pattern = compileIlike(`%${exerciseName}%`);

  const sessionDate = new Map<string, string>();
  for (const s of tables.sessions) sessionDate.set(uuidKey(s.id), s.performed_on);
  const matchingExercises = new Set<string>();
  for (const e of tables.exercises) if (pattern.test(e.name)) matchingExercises.add(uuidKey(e.id));

  const out: { performed_on: string; set: S }[] = [];
  for (const ss of tables.sessionSets) {
    const performedOn = sessionDate.get(uuidKey(ss.session_id));
    if (performedOn === undefined || !matchingExercises.has(uuidKey(ss.exercise_id))) continue;
    out.push({ performed_on: performedOn, set: ss });
  }
  return out;
}
