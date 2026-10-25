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

test("claimSeed succeeds once then refuses further callers", async () => {
  const db = createMockDataLayer({ seed: false });
  expect(await db.claimSeed()).toBe(true);
  expect(await db.claimSeed()).toBe(false);
  expect(await db.claimSeed()).toBe(false);
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

test("deleteDay removes only the targeted day", async () => {
  const db = createMockDataLayer({ seed: false });
  const dayA = await db.createDay("A");
  const dayB = await db.createDay("B");
  await db.deleteDay(dayA.id);
  const days = await db.getWorkoutDays();
  expect(days.map((d) => d.id)).toEqual([dayB.id]);
});

test("deleteDay clears any scheme recorded for that day", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "Back Squat", cue: "", defaultSets: 5, defaultRepLow: 5, defaultRepHigh: 5 });
  const day = await db.createDay("Day 1");
  await db.updateDayExercises(day.id, [ex.id]);
  await db.setDayExerciseTarget(day.id, ex.id, [{ setNumber: 1, weight: 225, reps: 5 }]);
  await db.deleteDay(day.id);
  expect(await db.getDayExerciseTargets(day.id)).toEqual({});
});

test("addExerciseToDay appends an exercise to the day's exercise list", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex1 = await db.createExercise({ name: "A", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });
  const ex2 = await db.createExercise({ name: "B", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });
  const day = await db.createDay("Day 1");
  await db.addExerciseToDay(day.id, ex1.id);
  await db.addExerciseToDay(day.id, ex2.id);
  const exercises = await db.getDayExercises(day.id);
  expect(exercises.map((e) => e.id)).toEqual([ex1.id, ex2.id]);
});

test("addExerciseToDay does not duplicate an exercise already on the day", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "A", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });
  const day = await db.createDay("Day 1");
  await db.addExerciseToDay(day.id, ex.id);
  await db.addExerciseToDay(day.id, ex.id);
  const exercises = await db.getDayExercises(day.id);
  expect(exercises.map((e) => e.id)).toEqual([ex.id]);
});

test("removeExerciseFromDay removes only the targeted exercise from the day", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex1 = await db.createExercise({ name: "A", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });
  const ex2 = await db.createExercise({ name: "B", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });
  const day = await db.createDay("Day 1");
  await db.updateDayExercises(day.id, [ex1.id, ex2.id]);
  await db.removeExerciseFromDay(day.id, ex1.id);
  const exercises = await db.getDayExercises(day.id);
  expect(exercises.map((e) => e.id)).toEqual([ex2.id]);
});

test("removeExerciseFromDay clears that exercise's scheme on the day", async () => {
  const db = createMockDataLayer({ seed: false });
  const ex = await db.createExercise({ name: "A", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });
  const day = await db.createDay("Day 1");
  await db.updateDayExercises(day.id, [ex.id]);
  await db.setDayExerciseTarget(day.id, ex.id, [{ setNumber: 1, weight: 100, reps: 10 }]);
  await db.removeExerciseFromDay(day.id, ex.id);
  expect(await db.getDayExerciseTargets(day.id)).toEqual({});
});

test("createProgram creates a program and returns it", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Leg Day Progression");
  expect(program).toEqual({ id: expect.any(String), name: "Leg Day Progression" });
});

test("addDayToProgram assigns a day to a program at position 0, then appends subsequent days", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Week 1");
  const d2 = await db.createDay("Week 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);

  const days = await db.getWorkoutDays();
  const day1 = days.find((d) => d.id === d1.id)!;
  const day2 = days.find((d) => d.id === d2.id)!;
  expect(day1.programId).toBe(program.id);
  expect(day1.programPosition).toBe(0);
  expect(day2.programPosition).toBe(1);
});

test("a program's first day is available; the rest are not, until it's completed", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Week 1");
  const d2 = await db.createDay("Week 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);

  let days = await db.getWorkoutDays();
  expect(days.find((d) => d.id === d1.id)?.isAvailable).toBe(true);
  expect(days.find((d) => d.id === d2.id)?.isAvailable).toBe(false);

  const session = await db.startSession(d1.id, "2026-06-01");
  await db.logExercise(session.id, "some-exercise", [{ setNumber: 1, weight: 100, reps: 10 }]);

  days = await db.getWorkoutDays();
  expect(days.find((d) => d.id === d1.id)?.isAvailable).toBe(false);
  expect(days.find((d) => d.id === d2.id)?.isAvailable).toBe(true);
});

test("an untracked day is always available and carries no program fields", async () => {
  const db = createMockDataLayer({ seed: false });
  const d = await db.createDay("Standalone");
  const days = await db.getWorkoutDays();
  const day = days.find((x) => x.id === d.id)!;
  expect(day.isAvailable).toBe(true);
  expect(day.programId).toBeNull();
  expect(day.programName).toBeNull();
  expect(day.programPosition).toBeNull();
});

test("getWorkoutDays reports the program's name on each member day", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Week 1");
  await db.addDayToProgram(d1.id, program.id);
  const days = await db.getWorkoutDays();
  expect(days.find((d) => d.id === d1.id)?.programName).toBe("Prep Phase");
});

test("removeDayFromProgram reverts a day to untracked (always available)", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Week 1");
  const d2 = await db.createDay("Week 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);
  await db.removeDayFromProgram(d1.id);

  const days = await db.getWorkoutDays();
  const day1 = days.find((d) => d.id === d1.id)!;
  expect(day1.programId).toBeNull();
  expect(day1.isAvailable).toBe(true);
  // d2 is now the sole member and still at its own stored position (1) —
  // still the program's lowest position, so still available.
  expect(days.find((d) => d.id === d2.id)?.isAvailable).toBe(true);
});

test("renameProgram renames an existing program", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Prep Phase");
  await db.renameProgram(program.id, "Prep Phase (v2)");
  const d1 = await db.createDay("Week 1");
  await db.addDayToProgram(d1.id, program.id);
  const days = await db.getWorkoutDays();
  expect(days.find((d) => d.id === d1.id)?.programName).toBe("Prep Phase (v2)");
});

test("deleteProgram soft-deletes: member days keep their program_id but revert to untracked behavior", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Week 1");
  const d2 = await db.createDay("Week 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);

  await db.deleteProgram(program.id);

  const days = await db.getWorkoutDays();
  const day1 = days.find((d) => d.id === d1.id)!;
  const day2 = days.find((d) => d.id === d2.id)!;
  // Both untouched-membership days become "always available" once their
  // program is gone, and no longer report a program name.
  expect(day1.isAvailable).toBe(true);
  expect(day2.isAvailable).toBe(true);
  expect(day1.programName).toBeNull();
});

test("reorderProgramDays rewrites program_position from the given order", async () => {
  const db = createMockDataLayer({ seed: false });
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Week 1");
  const d2 = await db.createDay("Week 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);

  await db.reorderProgramDays(program.id, [d2.id, d1.id]);

  const days = await db.getWorkoutDays();
  expect(days.find((d) => d.id === d2.id)?.programPosition).toBe(0);
  expect(days.find((d) => d.id === d1.id)?.programPosition).toBe(1);
  // reordering changes which day is "first" and therefore available.
  expect(days.find((d) => d.id === d2.id)?.isAvailable).toBe(true);
  expect(days.find((d) => d.id === d1.id)?.isAvailable).toBe(false);
});
