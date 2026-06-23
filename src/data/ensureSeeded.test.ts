import { createMockDataLayer } from "./mock";
import { ensureSeeded } from "./ensureSeeded";

test("does nothing when the user already has days", async () => {
  const db = createMockDataLayer(); // seeded: 2 days already
  await ensureSeeded(db);
  expect((await db.getWorkoutDays()).length).toBe(2);
});

test("seeds exercises and day templates but no workout history", async () => {
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

  // No history seeded — "last time" is empty on day one.
  const legPress = exercises.find((e) => e.name === "Leg Press")!;
  expect(await db.getLastSetsForExercise(legPress.id, "2026-06-22")).toEqual([]);
});

test("is idempotent (running twice does not duplicate)", async () => {
  const db = createMockDataLayer({ seed: false });
  await ensureSeeded(db);
  await ensureSeeded(db);
  expect((await db.getWorkoutDays()).length).toBe(2);
});
