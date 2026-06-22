import type { Session, SetEntry } from "../types";

export function findLastSetsForExercise(
  sessions: Session[],
  exerciseId: string,
  beforeDate: string,
): SetEntry[] {
  const candidates = sessions
    .filter((s) => s.performedOn < beforeDate)
    .filter((s) => s.exercises.some((e) => e.exerciseId === exerciseId))
    .sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
  const latest = candidates[0];
  if (!latest) return [];
  return latest.exercises.find((e) => e.exerciseId === exerciseId)!.sets;
}
