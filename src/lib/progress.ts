import type { Session, SetEntry } from "../types";

export function setVolume(set: SetEntry): number {
  return set.weight * set.reps;
}

export interface SetSeriesPoint {
  performedOn: string;
  setVolumes: number[];
}

export function exerciseSetSeries(sessions: Session[], exerciseId: string): SetSeriesPoint[] {
  return sessions
    .filter((s) => s.exercises.some((e) => e.exerciseId === exerciseId))
    .slice()
    .sort((a, b) => (a.performedOn < b.performedOn ? -1 : a.performedOn > b.performedOn ? 1 : 0))
    .map((s) => ({
      performedOn: s.performedOn,
      setVolumes: s.exercises.find((e) => e.exerciseId === exerciseId)!.sets.map(setVolume),
    }));
}
