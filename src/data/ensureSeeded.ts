import type { DataLayer } from "./DataLayer";
import { seedExercises, seedDays } from "./seed";

// Populate a fresh (empty) data layer with the starter exercises and day
// templates. No history — "last time" fills in as the user logs real workouts.
// No-ops if the user already has day templates. Backend-agnostic.
export async function ensureSeeded(db: DataLayer): Promise<void> {
  const existing = await db.getWorkoutDays();
  if (existing.length > 0) return;

  const exIdBySlug: Record<string, string> = {};
  for (const ex of seedExercises) {
    const created = await db.createExercise({
      name: ex.name,
      cue: ex.cue,
      defaultSets: ex.defaultSets,
      defaultRepLow: ex.defaultRepLow,
      defaultRepHigh: ex.defaultRepHigh,
    });
    exIdBySlug[ex.id] = created.id;
  }

  for (const day of seedDays) {
    const created = await db.createDay(day.name);
    await db.updateDayExercises(
      created.id,
      day.exerciseIds.map((slug) => exIdBySlug[slug]),
    );
  }
}
