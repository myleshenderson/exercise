import { createMockDataLayer } from "./mock";

const ex = (name: string) => ({ name, cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });

test("updateExercise changes only the given fields and throws for a missing id", async () => {
  const db = createMockDataLayer({ seed: false });
  const e = await db.createExercise(ex("Squat"));
  const updated = await db.updateExercise(e.id, { cue: "brace", defaultSets: 5, name: undefined });
  expect(updated).toEqual({ ...e, cue: "brace", defaultSets: 5 });
  expect(await db.getExercise(e.id)).toEqual(updated);
  await expect(db.updateExercise("nope", { name: "x" })).rejects.toThrow(/not found/);
});

test("deleteExercise drops the exercise from listExercises", async () => {
  const db = createMockDataLayer({ seed: false });
  const a = await db.createExercise(ex("A"));
  await db.createExercise(ex("B"));
  await db.deleteExercise(a.id);
  expect((await db.listExercises()).map((e) => e.name)).toEqual(["B"]);
  await db.deleteExercise("missing"); // no-op, like a zero-row update
});

test("findDayByName / findExerciseByName / findProgramByName: exact match or null, deleted rows excluded", async () => {
  const db = createMockDataLayer({ seed: false });
  const e = await db.createExercise(ex("Squat"));
  await db.createExercise(ex("Squat")); // first created wins
  expect(await db.findExerciseByName("Squat")).toEqual(e);
  expect(await db.findExerciseByName("squat")).toBeNull();
  await db.deleteExercise(e.id);
  expect((await db.findExerciseByName("Squat"))?.id).not.toBe(e.id);

  const d = await db.createDay("Legs");
  const p = await db.createProgram("Base");
  await db.addDayToProgram(d.id, p.id);
  expect(await db.findDayByName("Legs")).toEqual({ id: d.id, name: "Legs", position: d.position, programId: p.id, programPosition: 0 });
  expect(await db.findProgramByName("Base")).toEqual(p);
  await db.deleteDay(d.id);
  await db.deleteProgram(p.id);
  expect(await db.findDayByName("Legs")).toBeNull();
  expect(await db.findProgramByName("Base")).toBeNull();
});
