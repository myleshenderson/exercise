import { createMockDataLayer } from "./mock";

test("getWorkoutDays returns seeded days in order", async () => {
  const db = createMockDataLayer();
  const days = await db.getWorkoutDays();
  expect(days.map((d) => d.name)).toEqual(["Leg Day", "Upper Day"]);
});

test("getDayExercises returns exercises for a day, ordered", async () => {
  const db = createMockDataLayer();
  const ex = await db.getDayExercises("leg-day");
  expect(ex[0].name).toBe("Leg Press");
  expect(ex).toHaveLength(6);
});

test("getLastSetsForExercise returns seeded prior sets", async () => {
  const db = createMockDataLayer();
  const sets = await db.getLastSetsForExercise("leg-press", "2026-06-22");
  expect(sets[0].weight).toBe(150);
});

test("startSession + logExercise persists and is retrievable", async () => {
  const db = createMockDataLayer();
  const session = await db.startSession("leg-day", "2026-06-22");
  await db.logExercise(session.id, "leg-press", [{ setNumber: 1, weight: 155, reps: 10 }]);
  const reloaded = await db.getSession(session.id);
  expect(reloaded!.exercises[0].sets[0].weight).toBe(155);
});

test("logged set becomes 'last time' for a later date", async () => {
  const db = createMockDataLayer();
  const session = await db.startSession("leg-day", "2026-06-22");
  await db.logExercise(session.id, "leg-press", [{ setNumber: 1, weight: 160, reps: 10 }]);
  const sets = await db.getLastSetsForExercise("leg-press", "2026-06-23");
  expect(sets[0].weight).toBe(160);
});

test("getLastSessionForDay returns the most recent non-empty session for a day", async () => {
  const db = createMockDataLayer();
  const last = await db.getLastSessionForDay("leg-day");
  expect(last?.performedOn).toBe("2026-06-18"); // seeded Leg Day session
});

test("getLastSessionForDay ignores freshly-started empty sessions", async () => {
  const db = createMockDataLayer();
  await db.startSession("upper-day", "2026-06-25"); // empty, newer
  const last = await db.getLastSessionForDay("upper-day");
  expect(last?.performedOn).toBe("2026-06-20"); // still the seeded non-empty one
});

test("createMockDataLayer({ seed: false }) starts empty", async () => {
  const db = createMockDataLayer({ seed: false });
  expect(await db.getWorkoutDays()).toEqual([]);
  expect(await db.listExercises()).toEqual([]);
});
