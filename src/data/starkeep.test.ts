import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import manifest from "../../starkeep.manifest.json";
import type { DataLayer } from "./DataLayer";
import { createStarkeepDataLayer, ExerciseInUseError, RIDE_ANALYTICS_UNAVAILABLE, SEED_CLAIM_PREFIX } from "./starkeep";
import { DEFAULT_ATHLETE_SETTINGS } from "./DataLayer";
import { createFakeTransport, type FakeTransport } from "./starkeep/fakeTransport";
import { ensureSeeded } from "./ensureSeeded";
import { compareText } from "../analysis/sqlSemantics";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tables = manifest.infraRequirements.appSpecificSyncable.tables;

let clock = Date.parse("2026-11-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = Date.parse("2026-11-01T00:00:00.000Z");
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A Starkeep DataLayer over a fresh fake row API whose schema is the real
 * manifest, so an undeclared column fails the test. The clock moves one
 * millisecond before every DataLayer call, so `created_at` orders calls.
 */
function setup(fake: FakeTransport = createFakeTransport(tables)): { db: DataLayer; fake: FakeTransport } {
  const inner = createStarkeepDataLayer(fake.transport, { claimSettleMs: 0 });
  const db = Object.fromEntries(
    Object.entries(inner).map(([name, fn]) => [
      name,
      (...args: unknown[]) => {
        vi.setSystemTime(++clock);
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as DataLayer;
  return { db, fake };
}

const ex = (name: string) => ({ name, cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });

/** After any test: no request may write deleted_at or user_id, the two columns the app must never model. */
function expectNoForbiddenColumns(fake: FakeTransport) {
  for (const r of fake.requests) {
    const text = JSON.stringify(r.body ?? {}) + JSON.stringify(r.params);
    expect(text).not.toContain("deleted_at");
    expect(text).not.toContain("user_id");
  }
}

describe("claimSeed / first-use seeding", () => {
  test("claims once through an app_meta row, then refuses", async () => {
    const { db, fake } = setup();
    expect(await db.claimSeed()).toBe(true);
    expect(await db.claimSeed()).toBe(false);
    expect(fake.tables.app_meta).toEqual([
      { id: expect.stringMatching(new RegExp(`^${SEED_CLAIM_PREFIX}[0-9a-f-]{36}$`)), value: "2026-11-01T00:00:00.001Z" },
    ]);
  });

  test("concurrent claimants (separate DataLayers, one store) produce exactly one winner", async () => {
    const fake = createFakeTransport(tables);
    const results = await Promise.all([1, 2, 3, 4].map(() => setup(fake).db.claimSeed()));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.tables.app_meta.length).toBe(4); // all four got past the check: a real race
    expect(await setup(fake).db.claimSeed()).toBe(false);
  });

  test("a claim whose write landed but whose response failed still wins", async () => {
    const fake = createFakeTransport(tables);
    const transport: typeof fake.transport = async (path, init) => {
      const res = await fake.transport(path, init);
      if (init.method === "POST" && path.includes("app_meta")) return new Response("bad gateway", { status: 502 });
      return res;
    };
    const db = createStarkeepDataLayer(transport, { claimSettleMs: 0 });
    expect(await db.claimSeed()).toBe(true);
  });

  test("a claim whose write never landed rethrows", async () => {
    const fake = createFakeTransport(tables);
    const transport: typeof fake.transport = async (path, init) =>
      init.method === "POST" ? new Response(JSON.stringify({ error: "boom" }), { status: 500 }) : fake.transport(path, init);
    const db = createStarkeepDataLayer(transport, { claimSettleMs: 0 });
    await expect(db.claimSeed()).rejects.toThrow(/boom/);
  });

  test("ensureSeeded from two tabs (two DataLayers, one store) seeds once", async () => {
    const fake = createFakeTransport(tables);
    const a = setup(fake).db;
    const b = setup(fake).db;
    await Promise.all([ensureSeeded(a), ensureSeeded(b)]);
    await ensureSeeded(setup(fake).db);
    const days = await a.getWorkoutDays();
    expect(days.map((d) => d.name)).toEqual(["Leg Day", "Upper Day"]);
    expect(await a.listExercises()).toHaveLength(14);
    expect((await a.getDayExercises(days[0].id)).map((e) => e.name)[0]).toBe("Leg Press");
    expectNoForbiddenColumns(fake);
  });
});

describe("exercises", () => {
  test("create → read round trip; the client assigns a uuid and timestamps", async () => {
    const { db, fake } = setup();
    const created = await db.createExercise({ name: "Squat", cue: "deep", defaultSets: 5, defaultRepLow: 3, defaultRepHigh: 5 });
    expect(created.id).toMatch(UUID);
    expect(await db.getExercise(created.id)).toEqual(created);
    expect(fake.tables.exercises[0]).toEqual({
      id: created.id,
      name: "Squat",
      cue: "deep",
      default_sets: 5,
      default_rep_low: 3,
      default_rep_high: 5,
      created_at: "2026-11-01T00:00:00.001Z",
      archived_at: null,
    });
    expect(await db.getExercise("missing")).toBeNull();
  });

  test("listExercises orders by name and excludes archived rows", async () => {
    const { db, fake } = setup();
    await db.createExercise(ex("Row"));
    const curl = await db.createExercise(ex("Curl"));
    await db.createExercise(ex("Press"));
    await db.deleteExercise(curl.id);
    expect((await db.listExercises()).map((e) => e.name)).toEqual(["Press", "Row"]);
    // Archived, not removed: still readable by id, as supabase.ts's getExercise is.
    expect(await db.getExercise(curl.id)).not.toBeNull();
    expect(fake.tables.exercises.find((r) => r.id === curl.id)!.archived_at).toBe("2026-11-01T00:00:00.004Z");
    expectNoForbiddenColumns(fake);
  });

  test("listExercises orders names by compareText (Supabase's en_US collation), not row-API byte order", async () => {
    const { db } = setup();
    for (const name of ["bench", "Curl", "ab wheel", "Arnold press", "curl"]) await db.createExercise(ex(name));
    const names = (await db.listExercises()).map((e) => e.name);
    expect(names).toEqual(["ab wheel", "Arnold press", "bench", "curl", "Curl"]);
    expect(names).toEqual(names.slice().sort(compareText));
  });

  test("listExercises returns every row past the 500-row page limit", async () => {
    const { db, fake } = setup();
    for (let i = 0; i < 1203; i++) {
      fake.tables.exercises.push({
        id: `id-${String(i).padStart(5, "0")}`, name: `Ex ${String(i).padStart(5, "0")}`, cue: "",
        default_sets: 3, default_rep_low: 8, default_rep_high: 12,
        created_at: "2026-01-01T00:00:00.000Z", archived_at: null,
      });
    }
    const list = await db.listExercises();
    expect(list).toHaveLength(1203);
    expect(list[0].name).toBe("Ex 00000");
    expect(list[1202].name).toBe("Ex 01202");
    expect(fake.requests.filter((r) => r.table === "exercises")).toHaveLength(3);
  });

  test("updateExercise changes only the given fields and throws for a missing id", async () => {
    const { db } = setup();
    const e = await db.createExercise(ex("Squat"));
    const updated = await db.updateExercise(e.id, { cue: "brace", defaultRepHigh: 15 });
    expect(updated).toEqual({ ...e, cue: "brace", defaultRepHigh: 15 });
    expect(await db.getExercise(e.id)).toEqual(updated);
    expect(await db.updateExercise(e.id, {})).toEqual(updated);
    await expect(db.updateExercise("nope", { name: "x" })).rejects.toThrow(/not found/);
  });

  test("deleteExercise refuses while attached to a day", async () => {
    const { db } = setup();
    const e = await db.createExercise(ex("Squat"));
    const d = await db.createDay("Legs");
    await db.addExerciseToDay(d.id, e.id);
    const err = await db.deleteExercise(e.id).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ExerciseInUseError);
    expect((err as ExerciseInUseError).usage).toBe("day");
    expect((await db.listExercises()).map((x) => x.id)).toEqual([e.id]);
  });

  test("deleteExercise refuses with logged sets", async () => {
    const { db } = setup();
    const e = await db.createExercise(ex("Squat"));
    const s = await db.startSession(null, "2026-10-01");
    await db.logExercise(s.id, e.id, [{ setNumber: 1, weight: 100, reps: 5 }]);
    await expect(db.deleteExercise(e.id)).rejects.toMatchObject({ usage: "history" });
  });

  test("deleteExercise refuses with scheme history even after detaching", async () => {
    const { db } = setup();
    const e = await db.createExercise(ex("Squat"));
    const d = await db.createDay("Legs");
    await db.addExerciseToDay(d.id, e.id);
    await db.setDayExerciseTarget(d.id, e.id, [{ setNumber: 1, weight: 100, reps: 5 }]);
    await db.removeExerciseFromDay(d.id, e.id);
    await expect(db.deleteExercise(e.id)).rejects.toMatchObject({ usage: "history" });
  });
});

describe("find*ByName", () => {
  test("exact match over live rows; earliest created wins; null when absent", async () => {
    const { db } = setup();
    const e1 = await db.createExercise(ex("Squat"));
    await db.createExercise(ex("Squat"));
    expect(await db.findExerciseByName("Squat")).toEqual(e1);
    expect(await db.findExerciseByName("squat")).toBeNull();
    await db.deleteExercise(e1.id);
    expect((await db.findExerciseByName("Squat"))?.id).not.toBe(e1.id);

    const d = await db.createDay("Legs");
    expect(await db.findDayByName("Legs")).toEqual({ id: d.id, name: "Legs", position: 0, programId: null, programPosition: null });
    const p = await db.createProgram("Base");
    await db.addDayToProgram(d.id, p.id);
    expect(await db.findDayByName("Legs")).toMatchObject({ programId: p.id, programPosition: 0 });
    await db.deleteDay(d.id);
    expect(await db.findDayByName("Legs")).toBeNull();

    expect(await db.findProgramByName("Base")).toEqual(p);
    await db.deleteProgram(p.id);
    expect(await db.findProgramByName("Base")).toBeNull();
    expect(await db.findProgramByName("Nope")).toBeNull();
  });
});

describe("days", () => {
  test("createDay starts at position 0 (Postgres default) and getWorkoutDays orders by position then creation", async () => {
    const { db } = setup();
    const a = await db.createDay("A");
    const b = await db.createDay("B");
    const c = await db.createDay("C");
    expect(a).toEqual({
      id: a.id, name: "A", position: 0, exerciseIds: [],
      programId: null, programPosition: null, programName: null, isAvailable: true,
    });
    expect((await db.getWorkoutDays()).map((d) => d.id)).toEqual([a.id, b.id, c.id]);
    await db.deleteDay(b.id);
    await db.updateDayName(c.id, "C2");
    expect((await db.getWorkoutDays()).map((d) => d.name)).toEqual(["A", "C2"]);
  });

  test("addExerciseToDay appends; remove and updateDayExercises reorder; getDayExercises follows position", async () => {
    const { db, fake } = setup();
    const [e1, e2, e3] = [await db.createExercise(ex("One")), await db.createExercise(ex("Two")), await db.createExercise(ex("Three"))];
    const d = await db.createDay("Day");
    await db.addExerciseToDay(d.id, e1.id);
    await db.addExerciseToDay(d.id, e2.id);
    await db.addExerciseToDay(d.id, e3.id);
    expect(fake.tables.workout_day_exercises.map((l) => l.position)).toEqual([0, 1, 2]);
    expect((await db.getDayExercises(d.id)).map((e) => e.name)).toEqual(["One", "Two", "Three"]);

    await db.removeExerciseFromDay(d.id, e2.id);
    await db.addExerciseToDay(d.id, e2.id); // max(position) + 1 = 3
    expect((await db.getDayExercises(d.id)).map((e) => e.name)).toEqual(["One", "Three", "Two"]);

    await db.setDayExerciseTarget(d.id, e3.id, [{ setNumber: 1, weight: 50, reps: 10 }]);
    await db.updateDayExercises(d.id, [e3.id, e1.id]);
    expect((await db.getDayExercises(d.id)).map((e) => e.name)).toEqual(["Three", "One"]);
    expect((await db.getWorkoutDays())[0].exerciseIds).toEqual([e3.id, e1.id]);
    expect(fake.tables.workout_day_exercises.map((l) => l.position)).toEqual([0, 1]);
    // Targets survive a reorder.
    expect(await db.getDayExerciseTargets(d.id)).toEqual({ [e3.id]: [{ setNumber: 1, weight: 50, reps: 10 }] });
    expect(await db.getDayExercises("missing")).toEqual([]);
  });

  test("getWorkoutDays lists days past 500 with every link", async () => {
    const { db, fake } = setup();
    for (let i = 0; i < 520; i++) {
      fake.tables.workout_days.push({
        id: `d${String(i).padStart(4, "0")}`, name: `D${i}`, position: i, program_id: null, program_position: null,
        created_at: "2026-01-01T00:00:00.000Z", archived_at: null,
      });
      fake.tables.workout_day_exercises.push({ id: `l${i}`, workout_day_id: `d${String(i).padStart(4, "0")}`, exercise_id: `e${i}`, position: 0, target_sets: null });
    }
    const days = await db.getWorkoutDays();
    expect(days).toHaveLength(520);
    expect(days[519].exerciseIds).toEqual(["e519"]);
  });
});

describe("programs", () => {
  test("create, rename, add days at increasing positions, reorder, remove, delete", async () => {
    const { db } = setup();
    const p = await db.createProgram("Base");
    expect(p).toEqual({ id: expect.stringMatching(UUID), name: "Base" });
    await db.renameProgram(p.id, "Base 2");
    const [a, b, c] = [await db.createDay("A"), await db.createDay("B"), await db.createDay("C")];
    await db.addDayToProgram(a.id, p.id);
    await db.addDayToProgram(b.id, p.id);
    await db.addDayToProgram(c.id, p.id);

    let days = await db.getWorkoutDays();
    expect(days.map((d) => [d.name, d.programPosition, d.programName, d.isAvailable])).toEqual([
      ["A", 0, "Base 2", true],
      ["B", 1, "Base 2", false],
      ["C", 2, "Base 2", false],
    ]);

    await db.reorderProgramDays(p.id, [c.id, a.id, b.id]);
    days = await db.getWorkoutDays();
    expect(Object.fromEntries(days.map((d) => [d.name, d.programPosition]))).toEqual({ A: 1, B: 2, C: 0 });
    expect(days.find((d) => d.isAvailable)!.name).toBe("C");

    // A completed (non-empty) session moves availability on; an empty one does not.
    await db.startSession(c.id, "2026-10-01");
    expect((await db.getWorkoutDays()).find((d) => d.isAvailable)!.name).toBe("C");
    const s = await db.startSession(c.id, "2026-10-02");
    const e = await db.createExercise(ex("Squat"));
    await db.logExercise(s.id, e.id, [{ setNumber: 1, weight: 1, reps: 1 }]);
    expect((await db.getWorkoutDays()).find((d) => d.isAvailable)!.name).toBe("A");

    await db.removeDayFromProgram(b.id);
    days = await db.getWorkoutDays();
    expect(days.find((d) => d.name === "B")).toMatchObject({ programId: null, programPosition: null, programName: null, isAvailable: true });

    await db.deleteProgram(p.id);
    days = await db.getWorkoutDays();
    for (const d of days) expect(d).toMatchObject({ programId: null, programPosition: null, programName: null, isAvailable: true });
  });
});

describe("targets and scheme history", () => {
  test("set stores JSON text; get parses with 1-based set numbers; null clears; history keeps every change in order", async () => {
    const { db, fake } = setup();
    const e = await db.createExercise(ex("Squat"));
    const d = await db.createDay("Legs");
    await db.addExerciseToDay(d.id, e.id);
    await db.setDayExerciseTarget(d.id, e.id, [{ setNumber: 7, weight: 100, reps: 5 }, { setNumber: 8, weight: 105, reps: 3 }]);
    expect(fake.tables.workout_day_exercises[0].target_sets).toBe('[{"weight":100,"reps":5},{"weight":105,"reps":3}]');
    expect(await db.getDayExerciseTargets(d.id)).toEqual({
      [e.id]: [{ setNumber: 1, weight: 100, reps: 5 }, { setNumber: 2, weight: 105, reps: 3 }],
    });

    await db.setDayExerciseTarget(d.id, e.id, null);
    expect(await db.getDayExerciseTargets(d.id)).toEqual({});
    await db.setDayExerciseTarget(d.id, e.id, []);

    const history = await db.getSchemeHistory(d.id, e.id);
    expect(history).toEqual([
      { targetSets: [{ setNumber: 1, weight: 100, reps: 5 }, { setNumber: 2, weight: 105, reps: 3 }], recordedAt: "2026-11-01T00:00:00.004Z" },
      { targetSets: null, recordedAt: "2026-11-01T00:00:00.006Z" },
      { targetSets: null, recordedAt: "2026-11-01T00:00:00.008Z" },
    ]);
    expect(await db.getSchemeHistory(d.id, "other")).toEqual([]);
  });
});

describe("sessions", () => {
  test("startSession → logExercise → getSession round trip; logging again replaces", async () => {
    const { db, fake } = setup();
    const d = await db.createDay("Legs");
    const [e1, e2] = [await db.createExercise(ex("A")), await db.createExercise(ex("B"))];
    const s = await db.startSession(d.id, "2026-10-05");
    expect(s).toEqual({ id: expect.stringMatching(UUID), workoutDayId: d.id, performedOn: "2026-10-05", exercises: [] });
    await db.logExercise(s.id, e1.id, [{ setNumber: 2, weight: 60, reps: 8 }, { setNumber: 1, weight: 50, reps: 10 }]);
    await db.logExercise(s.id, e2.id, [{ setNumber: 1, weight: 20, reps: 12 }]);
    await db.logExercise(s.id, e1.id, [{ setNumber: 1, weight: 55, reps: 9 }]);
    const loaded = await db.getSession(s.id);
    expect(loaded!.exercises).toHaveLength(2);
    expect(loaded!.exercises.find((x) => x.exerciseId === e1.id)!.sets).toEqual([{ setNumber: 1, weight: 55, reps: 9 }]);
    expect(fake.tables.session_sets).toHaveLength(2);
    expect(await db.getSession("missing")).toBeNull();

    await db.logExercise(s.id, e2.id, []);
    expect((await db.getSession(s.id))!.exercises.map((x) => x.exerciseId)).toEqual([e1.id]);
  });

  test("getSession orders sets by set_number", async () => {
    const { db } = setup();
    const s = await db.startSession(null, "2026-10-05");
    await db.logExercise(s.id, "e", [{ setNumber: 3, weight: 3, reps: 3 }, { setNumber: 1, weight: 1, reps: 1 }, { setNumber: 2, weight: 2, reps: 2 }]);
    expect((await db.getSession(s.id))!.exercises[0].sets.map((x) => x.setNumber)).toEqual([1, 2, 3]);
  });

  test("getLastSetsForExercise: newest session strictly before the date, created_at breaking ties", async () => {
    const { db } = setup();
    const log = async (date: string, weight: number, exerciseId = "squat") => {
      const s = await db.startSession(null, date);
      await db.logExercise(s.id, exerciseId, [{ setNumber: 2, weight, reps: 5 }, { setNumber: 1, weight: weight - 1, reps: 5 }]);
    };
    await log("2026-10-01", 100);
    await log("2026-10-03", 110);
    await log("2026-10-03", 111); // same day, created later → wins
    await log("2026-10-05", 120); // on the date → excluded
    await log("2026-10-04", 999, "bench"); // other exercise
    expect(await db.getLastSetsForExercise("squat", "2026-10-05")).toEqual([
      { setNumber: 1, weight: 110, reps: 5 },
      { setNumber: 2, weight: 111, reps: 5 },
    ]);
    expect(await db.getLastSetsForExercise("squat", "2026-10-01")).toEqual([]);
    expect(await db.getLastSetsForExercise("nothing", "2027-01-01")).toEqual([]);
  });

  test("getLastSessionForDay skips empty sessions; getSessionForDayAndDate takes the newest created", async () => {
    const { db } = setup();
    const d = await db.createDay("Legs");
    const s1 = await db.startSession(d.id, "2026-10-01");
    await db.logExercise(s1.id, "e", [{ setNumber: 1, weight: 1, reps: 1 }]);
    await db.startSession(d.id, "2026-10-09"); // empty, newer
    expect((await db.getLastSessionForDay(d.id))!.id).toBe(s1.id);
    expect(await db.getLastSessionForDay("other")).toBeNull();

    const a = await db.startSession(d.id, "2026-10-10");
    const b = await db.startSession(d.id, "2026-10-10");
    expect((await db.getSessionForDayAndDate(d.id, "2026-10-10"))!.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
    expect(await db.getSessionForDayAndDate(d.id, "2026-12-31")).toBeNull();
  });

  test("getExerciseHistory returns sessions with that exercise, newest first", async () => {
    const { db } = setup();
    const s1 = await db.startSession(null, "2026-10-01");
    const s2 = await db.startSession(null, "2026-10-03");
    const s3 = await db.startSession(null, "2026-10-02");
    for (const s of [s1, s2, s3]) await db.logExercise(s.id, "squat", [{ setNumber: 1, weight: 1, reps: 1 }]);
    await db.logExercise(s2.id, "bench", [{ setNumber: 1, weight: 2, reps: 2 }]);
    const hist = await db.getExerciseHistory("squat");
    expect(hist.map((s) => s.id)).toEqual([s2.id, s3.id, s1.id]);
    expect(hist[0].exercises).toHaveLength(2);
    expect(await db.getExerciseHistory("none")).toEqual([]);
  });

  test("listSessions: newest first, same-date by creation, every session and set past 500", async () => {
    const { db, fake } = setup();
    const a = await db.startSession(null, "2026-10-01");
    const b = await db.startSession(null, "2026-10-02");
    const c = await db.startSession(null, "2026-10-01");
    expect((await db.listSessions()).map((s) => s.id)).toEqual([b.id, c.id, a.id]);

    for (let i = 0; i < 700; i++) {
      const id = `bulk-${String(i).padStart(4, "0")}`;
      fake.tables.sessions.push({ id, workout_day_id: null, performed_on: "2025-01-01", created_at: "2025-01-01T00:00:00.000Z" });
      fake.tables.session_sets.push({ id: `set-${i}`, session_id: id, exercise_id: "e", set_number: 1, weight: i, reps: 1 });
    }
    const all = await db.listSessions();
    expect(all).toHaveLength(703);
    expect(all.slice(3).every((s) => s.exercises[0].sets.length === 1)).toBe(true);
  });

  test("logExercise / updateDayExercises failing part-way keep the previous rows", async () => {
    const fake = createFakeTransport(tables);
    let failInserts = false;
    let inserts = 0;
    const transport: typeof fake.transport = async (path, init) => {
      if (failInserts && init.method === "POST" && ++inserts === 2) {
        return new Response(JSON.stringify({ error: "network" }), { status: 503 });
      }
      return fake.transport(path, init);
    };
    const db = createStarkeepDataLayer(transport, { claimSettleMs: 0 });
    const s = await db.startSession(null, "2026-10-01");
    await db.logExercise(s.id, "e", [{ setNumber: 1, weight: 10, reps: 1 }]);
    const d = await db.createDay("Day");
    await db.updateDayExercises(d.id, ["a", "b"]);
    await db.setDayExerciseTarget(d.id, "b", [{ setNumber: 1, weight: 5, reps: 5 }]);

    failInserts = true;
    await expect(db.logExercise(s.id, "e", [1, 2, 3].map((n) => ({ setNumber: n, weight: 99, reps: 9 })))).rejects.toThrow(/network/);
    expect((await db.getSession(s.id))!.exercises).toEqual([{ exerciseId: "e", sets: [{ setNumber: 1, weight: 10, reps: 1 }] }]);

    inserts = 0;
    await expect(db.updateDayExercises(d.id, ["b", "a", "c"])).rejects.toThrow(/network/);
    expect((await db.getWorkoutDays())[0].exerciseIds).toEqual(["a", "b"]);
    expect(await db.getDayExerciseTargets(d.id)).toEqual({ b: [{ setNumber: 1, weight: 5, reps: 5 }] });
  });

  test("deleteSession removes the session and cascades its sets", async () => {
    const { db, fake } = setup();
    const s = await db.startSession(null, "2026-10-01");
    const keep = await db.startSession(null, "2026-10-02");
    await db.logExercise(s.id, "e", [{ setNumber: 1, weight: 1, reps: 1 }]);
    await db.logExercise(keep.id, "e", [{ setNumber: 1, weight: 1, reps: 1 }]);
    await db.deleteSession(s.id);
    expect(await db.getSession(s.id)).toBeNull();
    expect(fake.tables.session_sets.map((r) => r.session_id)).toEqual([keep.id]);
    expect((await db.listSessions()).map((x) => x.id)).toEqual([keep.id]);
    expectNoForbiddenColumns(fake);
  });
});

describe("ride analytics (not declared on Starkeep yet)", () => {
  test("reads answer empty and writes reject, all without a transport request", async () => {
    const { db, fake } = setup();
    expect(await db.listExternalActivities({})).toEqual([]);
    expect(await db.getExternalActivity("a-1")).toBeNull();
    expect(await db.getActivityStreams("a-1")).toEqual([]);
    expect(await db.listBodyWeights("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z")).toEqual([]);
    expect(await db.getAthleteSettings()).toEqual(DEFAULT_ATHLETE_SETTINGS);
    expect(await db.listFtpHistory()).toEqual([]);
    expect(await db.listDailyTrainingLoad("2026-01-01", "2026-12-31")).toEqual([]);
    expect(await db.listSyncState()).toEqual([]);

    const writes = [
      db.upsertExternalActivities([{ source: "garmin", sourceId: "g", startedAt: "2026-11-01T00:00:00Z", sport: "cycling", environment: "outdoor", providerPayload: {} }]),
      db.replaceActivityStreams("a-1", [{ channel: "power", values: [1] }]),
      db.upsertBodyWeights([{ source: "garmin", sourceId: "1", measuredAt: "2026-11-01T00:00:00Z", weightKg: 80, providerPayload: {} }]),
      db.saveAthleteSettings({ units: "metric" }),
      db.addFtpHistoryEntry({ effectiveFrom: "2026-11-01T00:00:00Z", ftpW: 250, source: "manual", sourceRef: null }),
      db.upsertDailyTrainingLoad([{ date: "2026-11-01", tssTotal: 0, tssBySource: {}, ctl: 0, atl: 0, tsb: 0 }]),
    ];
    for (const w of writes) await expect(w).rejects.toThrow(RIDE_ANALYTICS_UNAVAILABLE);
    expect(RIDE_ANALYTICS_UNAVAILABLE).toBe("ride analytics is not available on Starkeep yet");
    expect(fake.requests).toEqual([]);
  });

  test("listExternalActivities enforces the DataLayer limit contract", async () => {
    const { db, fake } = setup();
    await expect(db.listExternalActivities({ limit: 1.5 })).rejects.toBeInstanceOf(RangeError);
    await expect(db.listExternalActivities({ limit: 0 })).resolves.toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  test("getAthleteSettings hands out a copy, not the shared defaults", async () => {
    const { db } = setup();
    const s = await db.getAthleteSettings();
    s.units = "metric";
    expect((await db.getAthleteSettings()).units).toBe("imperial");
  });
});
