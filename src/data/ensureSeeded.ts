import type { DataLayer } from "./DataLayer";
import { seedExercises, seedDays } from "./seed";

// Dedupe overlapping calls for the same data layer. The auth listener fires
// several events (INITIAL_SESSION, SIGNED_IN, …) in quick succession; without
// this, concurrent runs each see an empty DB and all seed, creating duplicates.
const inFlight = new WeakMap<DataLayer, Promise<void>>();

// Populate a fresh (empty) data layer with the starter exercises and day
// templates. No history — "last time" fills in as the user logs real workouts.
// No-ops if the user already has day templates. Backend-agnostic.
export function ensureSeeded(db: DataLayer): Promise<void> {
  const existing = inFlight.get(db);
  if (existing) return existing;
  const run = seedIfEmpty(db).catch((err) => {
    inFlight.delete(db); // drop the cached promise so a later call can retry
    throw err;
  });
  inFlight.set(db, run);
  return run;
}

async function seedIfEmpty(db: DataLayer): Promise<void> {
  // The in-flight guard above only dedupes calls within this JS runtime; it
  // does nothing across separate tabs, reloads, or logins. claimSeed() is
  // the DB-enforced guard that actually prevents concurrent seeding
  // (exercise-c9l) — only the caller that wins the claim proceeds.
  if (!(await db.claimSeed())) return;

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
