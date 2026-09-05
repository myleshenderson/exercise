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

test("updateDayName renames a day", async () => {
  const db = createMockDataLayer();
  await db.updateDayName("leg-day", "Leg Day Renamed");
  const days = await db.getWorkoutDays();
  expect(days.find((d) => d.id === "leg-day")?.name).toBe("Leg Day Renamed");
});

test("listSessions returns sessions newest-first", async () => {
  const db = createMockDataLayer();
  const sessions = await db.listSessions();
  expect(sessions.map((s) => s.id)).toEqual(["seed-upper", "seed-leg"]);
});

test("listSessions puts a just-started session ahead of earlier same-date sessions", async () => {
  const db = createMockDataLayer({ seed: false });
  const d = await db.createDay("X");
  const s1 = await db.startSession(d.id, "2026-06-10");
  const s2 = await db.startSession(d.id, "2026-06-10");
  const sessions = await db.listSessions();
  expect(sessions.map((s) => s.id)).toEqual([s2.id, s1.id]);
});

test("deleteSession removes only the targeted session", async () => {
  const db = createMockDataLayer();
  await db.deleteSession("seed-leg");
  expect(await db.getSession("seed-leg")).toBeNull();
  expect(await db.getSession("seed-upper")).not.toBeNull();
  expect((await db.listSessions()).map((s) => s.id)).toEqual(["seed-upper"]);
});

test("getLastSessionForDay returns the later session on same-day ties", async () => {
  const db = createMockDataLayer({ seed: false });
  const d = await db.createDay("X");
  const ex = await db.createExercise({ name: "E", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });
  const s1 = await db.startSession(d.id, "2026-06-10");
  await db.logExercise(s1.id, ex.id, [{ setNumber: 1, weight: 100, reps: 10 }]);
  const s2 = await db.startSession(d.id, "2026-06-10");
  await db.logExercise(s2.id, ex.id, [{ setNumber: 1, weight: 120, reps: 10 }]);
  const last = await db.getLastSessionForDay(d.id);
  expect(last?.id).toBe(s2.id);
});

test("setDayExerciseTarget scopes a scheme to one day, not the exercise globally", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "Back Squat", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  const dayA = await db.createDay("Day 1");
  const dayB = await db.createDay("Day 5");
  await db.updateDayExercises(dayA.id, [ex.id]);
  await db.updateDayExercises(dayB.id, [ex.id]);

  const dayAScheme = [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
  ];
  const dayBScheme = [
    { setNumber: 1, weight: 275, reps: 5 },
    { setNumber: 2, weight: 275, reps: 3 },
    { setNumber: 3, weight: 315, reps: 1 },
  ];
  await db.setDayExerciseTarget(dayA.id, ex.id, dayAScheme);
  await db.setDayExerciseTarget(dayB.id, ex.id, dayBScheme);

  expect(await db.getDayExerciseTargets(dayA.id)).toEqual({ [ex.id]: dayAScheme });
  expect(await db.getDayExerciseTargets(dayB.id)).toEqual({ [ex.id]: dayBScheme });
});

test("setDayExerciseTarget with null removes a previously-defined scheme", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "Back Squat", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  const day = await db.createDay("Day 1");
  await db.updateDayExercises(day.id, [ex.id]);
  await db.setDayExerciseTarget(day.id, ex.id, [{ setNumber: 1, weight: 225, reps: 5 }]);
  expect(await db.getDayExerciseTargets(day.id)).toEqual({ [ex.id]: [{ setNumber: 1, weight: 225, reps: 5 }] });

  await db.setDayExerciseTarget(day.id, ex.id, null);
  expect(await db.getDayExerciseTargets(day.id)).toEqual({});
});

test("getDayExerciseTargets returns {} for a day with no schemes defined", async () => {
  const db = createMockDataLayer();
  expect(await db.getDayExerciseTargets("leg-day")).toEqual({});
});

test("updateDayExercises drops a scheme for an exercise removed from the day", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "Back Squat", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  const day = await db.createDay("Day 1");
  await db.updateDayExercises(day.id, [ex.id]);
  await db.setDayExerciseTarget(day.id, ex.id, [{ setNumber: 1, weight: 225, reps: 5 }]);

  await db.updateDayExercises(day.id, []); // remove the exercise from the day
  expect(await db.getDayExerciseTargets(day.id)).toEqual({});
});

test("setDayExerciseTarget records a scheme-history entry on write", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "Back Squat", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  const day = await db.createDay("Day 1");
  const scheme = [{ setNumber: 1, weight: 225, reps: 5 }];

  await db.setDayExerciseTarget(day.id, ex.id, scheme);

  const history = await db.getSchemeHistory(day.id, ex.id);
  expect(history).toHaveLength(1);
  expect(history[0].targetSets).toEqual(scheme);
  expect(typeof history[0].recordedAt).toBe("string");
});

test("setDayExerciseTarget appends a new history entry on every write, in order, including clears", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "Back Squat", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  const day = await db.createDay("Day 1");

  await db.setDayExerciseTarget(day.id, ex.id, [{ setNumber: 1, weight: 225, reps: 5 }]);
  await db.setDayExerciseTarget(day.id, ex.id, [{ setNumber: 1, weight: 245, reps: 5 }]);
  await db.setDayExerciseTarget(day.id, ex.id, null);

  const history = await db.getSchemeHistory(day.id, ex.id);
  expect(history.map((h) => h.targetSets)).toEqual([
    [{ setNumber: 1, weight: 225, reps: 5 }],
    [{ setNumber: 1, weight: 245, reps: 5 }],
    null,
  ]);
});

test("getSchemeHistory returns [] for a day/exercise pair with no recorded schemes", async () => {
  const db = createMockDataLayer({ seed: false });
  expect(await db.getSchemeHistory("nope", "nope")).toEqual([]);
});

test("updateDayExercises preserves a scheme for an exercise that stays on the day", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex1 = await db.createExercise({ name: "Back Squat", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  const day = await db.createDay("Day 1");
  await db.updateDayExercises(day.id, [ex1.id]);
  await db.setDayExerciseTarget(day.id, ex1.id, [{ setNumber: 1, weight: 225, reps: 5 }]);

  const ex2 = await db.createExercise({ name: "Bench Press", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  await db.updateDayExercises(day.id, [ex1.id, ex2.id]); // add a second exercise alongside it

  expect(await db.getDayExerciseTargets(day.id)).toEqual({
    [ex1.id]: [{ setNumber: 1, weight: 225, reps: 5 }],
  });
});
