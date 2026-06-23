import type { Session, SetEntry } from "../types";

export function findLastSetsForExercise(
  sessions: Session[],
  exerciseId: string,
  beforeDate: string,
): SetEntry[] {
  let best: Session | null = null;
  for (const s of sessions) {
    if (s.performedOn >= beforeDate) continue;
    if (!s.exercises.some((e) => e.exerciseId === exerciseId)) continue;
    // `>=` so that among equal dates the later-listed (later-recorded) session wins
    if (!best || s.performedOn >= best.performedOn) best = s;
  }
  return best ? best.exercises.find((e) => e.exerciseId === exerciseId)!.sets : [];
}
