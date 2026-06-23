import type { DataLayer } from "./DataLayer";
import { seedExercises, seedDays, seedSessions } from "./seed";

// Populate a fresh (empty) data layer with the starter exercises, day templates,
// and history. No-ops if the user already has day templates. Backend-agnostic.
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

  const dayIdBySlug: Record<string, string> = {};
  for (const day of seedDays) {
    const created = await db.createDay(day.name);
    dayIdBySlug[day.id] = created.id;
    await db.updateDayExercises(
      created.id,
      day.exerciseIds.map((slug) => exIdBySlug[slug]),
    );
  }

  for (const s of seedSessions) {
    const dayId = s.workoutDayId ? dayIdBySlug[s.workoutDayId] : null;
    const session = await db.startSession(dayId, s.performedOn);
    for (const ex of s.exercises) {
      await db.logExercise(session.id, exIdBySlug[ex.exerciseId], ex.sets);
    }
  }
}
