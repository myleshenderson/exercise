import type { Session } from "../types";

export function totalVolume(session: Session): number {
  return session.exercises.reduce(
    (sum, ex) => sum + ex.sets.reduce((s, set) => s + set.weight * set.reps, 0),
    0,
  );
}
