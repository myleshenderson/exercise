import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import manifest from "../../starkeep.manifest.json";
import type { DataLayer } from "./DataLayer";
import { createStarkeepDataLayer } from "./starkeep";
import { createFakeTransport, type FakeTable, type FakeTransport } from "./starkeep/fakeTransport";
import { starterDayId, starterExerciseId, starterLinkId } from "./starkeep/starterIds";
import { seedDays, seedExercises } from "./seed";

// What the Starkeep DataLayer sends and stores, read from the fake row API's
// tables and request log. The behavior both stores must share is in
// `./starkeep/dataLayerContract.ts`, which runs over the fake here and over a
// real data server in `npm run test:platform`.

const tables = manifest.infraRequirements.appSpecificSyncable.tables as FakeTable[];

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
  const inner = createStarkeepDataLayer(fake.transport);
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

const writes = (fake: FakeTransport) => fake.requests.filter((r) => r.method !== "GET");

describe("seedStarterData", () => {
  test("writes every starter row under its fixed id with ifAbsent, links before each day", async () => {
    const { db, fake } = setup();
    await db.seedStarterData();
    const legPress = await starterExerciseId("leg-press");
    const legDay = await starterDayId("leg-day");
    expect(fake.tables.exercises.find((r) => r.name === "Leg Press")).toEqual({
      id: legPress, name: "Leg Press", cue: "main driver", default_sets: 3, default_rep_low: 10, default_rep_high: 12,
      created_at: "2026-11-01T00:00:00.001Z", archived_at: null,
    });
    const link = await starterLinkId("leg-day", "leg-press");
    expect(fake.tables.workout_day_exercises.find((r) => r.id === link)).toEqual({
      id: link, workout_day_id: legDay, exercise_id: legPress, position: 0, target_sets: null,
    });
    expect(fake.tables.workout_days.map((r) => [r.name, r.position])).toEqual([["Leg Day", 0], ["Upper Day", 1]]);

    const posts = writes(fake);
    expect(posts.every((r) => r.method === "POST" && (r.body as { ifAbsent?: boolean }).ifAbsent === true)).toBe(true);
    const order = posts.map((r) => r.table);
    expect(order.lastIndexOf("exercises")).toBeLessThan(order.indexOf("workout_day_exercises"));
    expect(order.indexOf("workout_days")).toBe(seedExercises.length + seedDays[0].exerciseIds.length);
    expectNoForbiddenColumns(fake);
  });

  test("a user with a day of their own is not seeded", async () => {
    const { db, fake } = setup();
    await db.createDay("Mine");
    const before = writes(fake).length;
    await db.seedStarterData();
    expect(writes(fake)).toHaveLength(before);
  });

  test("once every starter day is there, even archived, a reseed writes nothing", async () => {
    const { db, fake } = setup();
    await db.seedStarterData();
    await db.deleteDay(await starterDayId("upper-day"));
    const before = writes(fake).length;
    await db.seedStarterData();
    expect(writes(fake)).toHaveLength(before);
  });

  test("a seed that stopped after the first day writes the rest, and skips what it already wrote", async () => {
    const fake = createFakeTransport(tables);
    const upperDay = await starterDayId("upper-day");
    let stopped = false;
    const db = createStarkeepDataLayer(async (path, init) => {
      if (!stopped && init.method === "POST" && typeof init.body === "string" && init.body.includes(upperDay) && path.endsWith("/workout_days")) {
        stopped = true;
        return new Response(JSON.stringify({ error: "network" }), { status: 503 });
      }
      return fake.transport(path, init);
    });
    await expect(db.seedStarterData()).rejects.toThrow(/network/);
    expect(fake.tables.workout_days.map((r) => r.name)).toEqual(["Leg Day"]);

    await db.seedStarterData();
    expect(fake.tables.workout_days.map((r) => r.name)).toEqual(["Leg Day", "Upper Day"]);
    expect(fake.tables.exercises).toHaveLength(seedExercises.length);
    expect(fake.tables.workout_day_exercises).toHaveLength(seedDays.flatMap((d) => d.exerciseIds).length);
  });
});

describe("exercises", () => {
  test("createExercise stores the row with a client uuid and timestamp", async () => {
    const { db, fake } = setup();
    const created = await db.createExercise({ name: "Squat", cue: "deep", defaultSets: 5, defaultRepLow: 3, defaultRepHigh: 5 });
    expect(fake.tables.exercises[0]).toEqual({
      id: created.id, name: "Squat", cue: "deep", default_sets: 5, default_rep_low: 3, default_rep_high: 5,
      created_at: "2026-11-01T00:00:00.001Z", archived_at: null,
    });
  });

  test("deleteExercise archives the row rather than removing it", async () => {
    const { db, fake } = setup();
    const curl = await db.createExercise(ex("Curl"));
    await db.deleteExercise(curl.id);
    expect(fake.tables.exercises.find((r) => r.id === curl.id)!.archived_at).toBe("2026-11-01T00:00:00.002Z");
    expectNoForbiddenColumns(fake);
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

  test("updateExercise reads once and patches once, with no read after the patch", async () => {
    const { db, fake } = setup();
    const e = await db.createExercise(ex("Squat"));
    const before = fake.requests.length;
    expect(await db.updateExercise(e.id, { cue: "brace" })).toEqual({ ...e, cue: "brace" });
    expect(fake.requests.slice(before).map((r) => `${r.method} ${r.table}`)).toEqual(["GET exercises", "PATCH exercises"]);
  });

  test("updateExercise throws not found when the row goes between the read and the patch", async () => {
    const fake = createFakeTransport(tables);
    const db = createStarkeepDataLayer(async (path, init) => {
      if (init.method === "PATCH") fake.tables.exercises = [];
      return fake.transport(path, init);
    });
    const e = await db.createExercise(ex("Squat"));
    await expect(db.updateExercise(e.id, { name: "x" })).rejects.toThrow(`Exercise ${e.id} not found`);
  });
});

describe("days", () => {
  test("addExerciseToDay stores increasing positions; updateDayExercises renumbers from 0", async () => {
    const { db, fake } = setup();
    const d = await db.createDay("Day");
    for (const id of ["a", "b", "c"]) await db.addExerciseToDay(d.id, id);
    expect(fake.tables.workout_day_exercises.map((l) => l.position)).toEqual([0, 1, 2]);
    await db.updateDayExercises(d.id, ["c", "a"]);
    expect(fake.tables.workout_day_exercises.map((l) => [l.exercise_id, l.position])).toEqual([["c", 0], ["a", 1]]);
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

test("setDayExerciseTarget stores JSON text without set numbers, and history rows carry recorded_at", async () => {
  const { db, fake } = setup();
  const d = await db.createDay("Legs");
  await db.addExerciseToDay(d.id, "e");
  await db.setDayExerciseTarget(d.id, "e", [{ setNumber: 7, weight: 100, reps: 5 }, { setNumber: 8, weight: 105, reps: 3 }]);
  expect(fake.tables.workout_day_exercises[0].target_sets).toBe('[{"weight":100,"reps":5},{"weight":105,"reps":3}]');
  expect(fake.tables.workout_day_exercise_scheme_history[0]).toMatchObject({
    target_sets: '[{"weight":100,"reps":5},{"weight":105,"reps":3}]',
    recorded_at: "2026-11-01T00:00:00.003Z",
  });
});

describe("sessions", () => {
  test("logging again replaces the exercise's set rows", async () => {
    const { db, fake } = setup();
    const s = await db.startSession(null, "2026-10-05");
    await db.logExercise(s.id, "a", [{ setNumber: 1, weight: 50, reps: 10 }, { setNumber: 2, weight: 60, reps: 8 }]);
    await db.logExercise(s.id, "a", [{ setNumber: 1, weight: 55, reps: 9 }]);
    expect(fake.tables.session_sets.map((r) => r.weight)).toEqual([55]);
  });

  test("listSessions returns every session and set past 500", async () => {
    const { db, fake } = setup();
    for (let i = 0; i < 700; i++) {
      const id = `bulk-${String(i).padStart(4, "0")}`;
      fake.tables.sessions.push({ id, workout_day_id: null, performed_on: "2025-01-01", created_at: "2025-01-01T00:00:00.000Z" });
      fake.tables.session_sets.push({ id: `set-${i}`, session_id: id, exercise_id: "e", set_number: 1, weight: i, reps: 1 });
    }
    const all = await db.listSessions();
    expect(all).toHaveLength(700);
    expect(all.every((s) => s.exercises[0].sets.length === 1)).toBe(true);
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
    const db = createStarkeepDataLayer(transport);
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

  test("deleteSession deletes each set, then the session, every one by id", async () => {
    const { db, fake } = setup();
    const s = await db.startSession(null, "2026-10-01");
    await db.logExercise(s.id, "e", [{ setNumber: 1, weight: 1, reps: 1 }, { setNumber: 2, weight: 1, reps: 1 }]);
    const before = fake.requests.length;
    await db.deleteSession(s.id);
    const deletes = fake.requests.slice(before).filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.table)).toEqual(["session_sets", "session_sets", "sessions"]);
    for (const r of deletes) expect(Object.keys((r.body as { where: object }).where)).toEqual(["id"]);
    expectNoForbiddenColumns(fake);
  });
});
