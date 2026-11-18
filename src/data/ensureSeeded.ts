import type { DataLayer } from "./DataLayer.js";

// Dedupe overlapping calls for the same data layer. The auth listener fires
// several events (INITIAL_SESSION, SIGNED_IN, …) in quick succession; without
// this, concurrent runs each see an empty DB and all seed, creating duplicates.
const inFlight = new WeakMap<DataLayer, Promise<void>>();

// Populate a fresh (empty) data layer with the starter exercises and day
// templates. No history — "last time" fills in as the user logs real workouts.
// No-ops if the user already has day templates. Each backend guards the seed
// across tabs, reloads and devices itself (DataLayer.seedStarterData).
export function ensureSeeded(db: DataLayer): Promise<void> {
  const existing = inFlight.get(db);
  if (existing) return existing;
  const run = db.seedStarterData().catch((err) => {
    inFlight.delete(db); // drop the cached promise so a later call can retry
    throw err;
  });
  inFlight.set(db, run);
  return run;
}
