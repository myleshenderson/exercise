import { createMockDataLayer } from "./mock";
import { ensureSeeded } from "./ensureSeeded";

test("does nothing when the user already has days", async () => {
  const db = createMockDataLayer(); // seeded: 2 days already
  await ensureSeeded(db);
  expect((await db.getWorkoutDays()).length).toBe(2);
});

test("seeds exercises, days, and history into an empty data layer", async () => {
  const db = createMockDataLayer({ seed: false });
  await ensureSeeded(db);

  const days = await db.getWorkoutDays();
  expect(days.map((d) => d.name)).toEqual(["Leg Day", "Upper Day"]);

  const exercises = await db.listExercises();
  expect(exercises.length).toBe(14);

  const legDay = days.find((d) => d.name === "Leg Day")!;
  const legExercises = await db.getDayExercises(legDay.id);
  expect(legExercises[0].name).toBe("Leg Press");
  expect(legExercises.length).toBe(6);

  // history seeded: Leg Press last time was 150
  const legPress = exercises.find((e) => e.name === "Leg Press")!;
  const lastSets = await db.getLastSetsForExercise(legPress.id, "2026-06-22");
  expect(lastSets[0].weight).toBe(150);
});

test("is idempotent (running twice does not duplicate)", async () => {
  const db = createMockDataLayer({ seed: false });
  await ensureSeeded(db);
  await ensureSeeded(db);
  expect((await db.getWorkoutDays()).length).toBe(2);
});
