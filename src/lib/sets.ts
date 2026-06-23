import type { SetEntry } from "../types";

export function expandLine(weight: number, sets: number, reps: number): SetEntry[] {
  return Array.from({ length: sets }, (_, i) => ({
    setNumber: i + 1,
    weight,
    reps,
  }));
}

export function formatSets(sets: SetEntry[]): string {
  if (sets.length === 0) return "";
  const sameWeight = sets.every((s) => s.weight === sets[0].weight);
  const sameReps = sets.every((s) => s.reps === sets[0].reps);
  if (sameWeight && sameReps) {
    return `${sets[0].weight} × ${sets.length} × ${sets[0].reps}`;
  }
  if (sameWeight) {
    return `${sets[0].weight} × (${sets.map((s) => s.reps).join(", ")})`;
  }
  return sets.map((s) => `${s.weight}×${s.reps}`).join(", ");
}
