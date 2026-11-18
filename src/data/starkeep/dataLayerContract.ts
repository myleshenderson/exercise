/**
 * Test-only: the Starkeep DataLayer's behavior, written once and run over two
 * stores.
 *
 * - `src/data/starkeep.contract.test.ts` runs it over the in-memory fake row
 *   API (`fakeTransport.ts`), as part of `npm test`.
 * - `starkeep/platform/dataLayer.platform.ts` runs it over a real local data
 *   server from starkeep-core's tier-2 harness, as `npm run test:platform`.
 *
 * Every assertion goes through the DataLayer or through the row client over
 * the same transport, never through the fake's tables or request log. A test
 * here therefore passes against the fake only if it also holds on the data
 * server, and a run of `test:platform` shows when the fake has drifted.
 *
 * Tests that need the fake's internals (request counts, exact column values,
 * injected failures, thousands of rows) stay in `src/data/starkeep.test.ts`
 * and `src/data/starkeep.rideAnalytics.test.ts`.
 */
import { describe, expect, test } from "vitest";
import type { DataLayer } from "../DataLayer.js";
import type { ExternalActivityInput } from "../../types.js";
import { ensureSeeded } from "../ensureSeeded.js";
import { seedDays, seedExercises } from "../seed.js";
import { createStarkeepDataLayer, ExerciseInUseError } from "../starkeep.js";
import { createRowClient, type RowClient, type Transport } from "./rows.js";

/** A store with nothing in it, reached through one transport. */
export type OpenStore = () => Promise<Transport>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ex = (name: string) => ({ name, cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 });

/**
 * Wait until the clock has moved past its current millisecond, so a row
 * written after this has a later `created_at` than every row written before.
 * The DataLayer orders ties by `created_at`, and a real data server can
 * answer two writes within one millisecond.
 */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** A DataLayer whose every call starts in a later millisecond than the last. */
function ordered(db: DataLayer): DataLayer {
  return Object.fromEntries(
    Object.entries(db).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        await nextMillisecond();
        return (fn as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as DataLayer;
}

export function describeDataLayerContract(label: string, openStore: OpenStore): void {
  async function setup(): Promise<{ db: DataLayer; rows: RowClient; transport: Transport }> {
    const transport = await openStore();
    return { db: ordered(createStarkeepDataLayer(transport)), rows: createRowClient(transport), transport };
  }

  describe(`Starkeep DataLayer contract (${label})`, () => {
    describe("first-use seeding", () => {
      test("seeds the starter exercises and days once", async () => {
        const { db } = await setup();
        await ensureSeeded(db);
        const days = await db.getWorkoutDays();
        expect(days.map((d) => d.name)).toEqual(seedDays.map((d) => d.name));
        expect((await db.listExercises()).map((e) => e.name).sort()).toEqual(seedExercises.map((e) => e.name).sort());
        expect((await db.getDayExercises(days[0].id)).map((e) => e.name)).toEqual(
          seedDays[0].exerciseIds.map((slug) => seedExercises.find((e) => e.id === slug)!.name),
        );
      });

      test("two DataLayers seeding one store at once leave one copy", async () => {
        const transport = await openStore();
        const a = createStarkeepDataLayer(transport);
        const b = createStarkeepDataLayer(transport);
        await Promise.all([ensureSeeded(a), ensureSeeded(b)]);
        await ensureSeeded(createStarkeepDataLayer(transport));
        expect((await a.getWorkoutDays()).map((d) => d.name)).toEqual(seedDays.map((d) => d.name));
        expect(await a.listExercises()).toHaveLength(seedExercises.length);
      });

      test("a reseed leaves a starter exercise the user deleted deleted", async () => {
        const transport = await openStore();
        const db = createStarkeepDataLayer(transport);
        await ensureSeeded(db);
        const fly = (await db.findExerciseByName("Pectoral Fly"))!;
        await db.deleteExercise(fly.id);
        // A new DataLayer, as after a reload: its in-memory guard is empty.
        await ensureSeeded(createStarkeepDataLayer(transport));
        const names = (await db.listExercises()).map((e) => e.name);
        expect(names).not.toContain("Pectoral Fly");
        expect(names).toHaveLength(seedExercises.length - 1);
      });
    });

    describe("exercises", () => {
      test("create → read round trip with a uuid id; a missing id reads as null", async () => {
        const { db } = await setup();
        const created = await db.createExercise({ name: "Squat", cue: "deep", defaultSets: 5, defaultRepLow: 3, defaultRepHigh: 5 });
        expect(created.id).toMatch(UUID);
        expect(await db.getExercise(created.id)).toEqual(created);
        expect(await db.getExercise("missing")).toBeNull();
      });

      test("listExercises orders by Supabase's collation and leaves out archived rows, which stay readable by id", async () => {
        const { db } = await setup();
        for (const name of ["bench", "Curl", "ab wheel", "Arnold press", "curl"]) await db.createExercise(ex(name));
        const row = await db.createExercise(ex("Row"));
        await db.deleteExercise(row.id);
        expect((await db.listExercises()).map((e) => e.name)).toEqual(["ab wheel", "Arnold press", "bench", "curl", "Curl"]);
        expect(await db.getExercise(row.id)).toEqual(row);
      });

      test("updateExercise changes only the given fields", async () => {
        const { db } = await setup();
        const e = await db.createExercise(ex("Squat"));
        const updated = await db.updateExercise(e.id, { cue: "brace", defaultRepHigh: 15 });
        expect(updated).toEqual({ ...e, cue: "brace", defaultRepHigh: 15 });
        expect(await db.getExercise(e.id)).toEqual(updated);
        expect(await db.updateExercise(e.id, {})).toEqual(updated);
      });

      test("updateExercise of a missing id throws not found and writes no row", async () => {
        const { db, rows } = await setup();
        await expect(db.updateExercise("nope", { name: "x" })).rejects.toThrow(/not found/);
        expect(await rows.selectAll("exercises")).toEqual([]);
      });

      test("deleteExercise refuses while the exercise is on a day, has logged sets, or has scheme history", async () => {
        const { db } = await setup();
        const onDay = await db.createExercise(ex("On a day"));
        const day = await db.createDay("Legs");
        await db.addExerciseToDay(day.id, onDay.id);
        const err = await db.deleteExercise(onDay.id).catch((x: unknown) => x);
        expect(err).toBeInstanceOf(ExerciseInUseError);
        expect((err as ExerciseInUseError).usage).toBe("day");

        const logged = await db.createExercise(ex("Logged"));
        const s = await db.startSession(null, "2026-10-01");
        await db.logExercise(s.id, logged.id, [{ setNumber: 1, weight: 100, reps: 5 }]);
        await expect(db.deleteExercise(logged.id)).rejects.toMatchObject({ usage: "history" });

        const schemed = await db.createExercise(ex("Schemed"));
        await db.addExerciseToDay(day.id, schemed.id);
        await db.setDayExerciseTarget(day.id, schemed.id, [{ setNumber: 1, weight: 100, reps: 5 }]);
        await db.removeExerciseFromDay(day.id, schemed.id);
        await expect(db.deleteExercise(schemed.id)).rejects.toMatchObject({ usage: "history" });
      });
    });

    test("find*ByName: exact match over live rows, earliest created first, null when absent", async () => {
      const { db } = await setup();
      const e1 = await db.createExercise(ex("Squat"));
      const e2 = await db.createExercise(ex("Squat"));
      expect(await db.findExerciseByName("Squat")).toEqual(e1);
      expect(await db.findExerciseByName("squat")).toBeNull();
      await db.deleteExercise(e1.id);
      expect(await db.findExerciseByName("Squat")).toEqual(e2);

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
    });

    describe("days", () => {
      test("getWorkoutDays orders by position, then creation; delete and rename show", async () => {
        const { db } = await setup();
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

      test("add appends, remove takes one exercise off, updateDayExercises reorders and keeps targets", async () => {
        const { db } = await setup();
        const [e1, e2, e3] = [await db.createExercise(ex("One")), await db.createExercise(ex("Two")), await db.createExercise(ex("Three"))];
        const d = await db.createDay("Day");
        const other = await db.createDay("Other");
        for (const e of [e1, e2, e3]) await db.addExerciseToDay(d.id, e.id);
        await db.addExerciseToDay(other.id, e2.id);
        expect((await db.getDayExercises(d.id)).map((e) => e.name)).toEqual(["One", "Two", "Three"]);

        await db.removeExerciseFromDay(d.id, e2.id);
        expect((await db.getDayExercises(d.id)).map((e) => e.name)).toEqual(["One", "Three"]);
        // Only that day's link goes.
        expect((await db.getDayExercises(other.id)).map((e) => e.name)).toEqual(["Two"]);
        await db.addExerciseToDay(d.id, e2.id);
        expect((await db.getDayExercises(d.id)).map((e) => e.name)).toEqual(["One", "Three", "Two"]);

        await db.setDayExerciseTarget(d.id, e3.id, [{ setNumber: 1, weight: 50, reps: 10 }]);
        await db.updateDayExercises(d.id, [e3.id, e1.id]);
        expect((await db.getDayExercises(d.id)).map((e) => e.name)).toEqual(["Three", "One"]);
        expect((await db.getWorkoutDays()).find((x) => x.id === d.id)!.exerciseIds).toEqual([e3.id, e1.id]);
        expect(await db.getDayExerciseTargets(d.id)).toEqual({ [e3.id]: [{ setNumber: 1, weight: 50, reps: 10 }] });
        expect(await db.getDayExercises("missing")).toEqual([]);
      });
    });

    describe("programs", () => {
      test("create, rename, add days, reorder, completion moves availability, remove, delete", async () => {
        const { db } = await setup();
        const p = await db.createProgram("Base");
        expect(p).toEqual({ id: expect.stringMatching(UUID), name: "Base" });
        await db.renameProgram(p.id, "Base 2");
        const [a, b, c] = [await db.createDay("A"), await db.createDay("B"), await db.createDay("C")];
        for (const d of [a, b, c]) await db.addDayToProgram(d.id, p.id);

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
        for (const d of await db.getWorkoutDays()) {
          expect(d).toMatchObject({ programId: null, programPosition: null, programName: null, isAvailable: true });
        }
      });
    });

    test("a day's scheme: set, read with 1-based set numbers, clear, and every change in the history", async () => {
      const { db } = await setup();
      const e = await db.createExercise(ex("Squat"));
      const d = await db.createDay("Legs");
      const other = await db.createDay("Other");
      await db.addExerciseToDay(d.id, e.id);
      await db.addExerciseToDay(other.id, e.id);
      await db.setDayExerciseTarget(d.id, e.id, [{ setNumber: 7, weight: 100, reps: 5 }, { setNumber: 8, weight: 105, reps: 3 }]);
      expect(await db.getDayExerciseTargets(d.id)).toEqual({
        [e.id]: [{ setNumber: 1, weight: 100, reps: 5 }, { setNumber: 2, weight: 105, reps: 3 }],
      });
      // Only that day's link changes.
      expect(await db.getDayExerciseTargets(other.id)).toEqual({});

      await db.setDayExerciseTarget(d.id, e.id, null);
      expect(await db.getDayExerciseTargets(d.id)).toEqual({});

      const history = await db.getSchemeHistory(d.id, e.id);
      expect(history.map((h) => h.targetSets)).toEqual([
        [{ setNumber: 1, weight: 100, reps: 5 }, { setNumber: 2, weight: 105, reps: 3 }],
        null,
      ]);
      expect(history[0].recordedAt < history[1].recordedAt).toBe(true);
      expect(await db.getSchemeHistory(d.id, "other")).toEqual([]);
    });

    describe("sessions", () => {
      test("start → log → read; logging again replaces; logging nothing removes the exercise", async () => {
        const { db } = await setup();
        const d = await db.createDay("Legs");
        const [e1, e2] = [await db.createExercise(ex("A")), await db.createExercise(ex("B"))];
        const s = await db.startSession(d.id, "2026-10-05");
        expect(s).toEqual({ id: expect.stringMatching(UUID), workoutDayId: d.id, performedOn: "2026-10-05", exercises: [] });
        await db.logExercise(s.id, e1.id, [{ setNumber: 2, weight: 60, reps: 8 }, { setNumber: 1, weight: 50, reps: 10 }]);
        await db.logExercise(s.id, e2.id, [{ setNumber: 1, weight: 20, reps: 12 }]);
        await db.logExercise(s.id, e1.id, [{ setNumber: 1, weight: 55, reps: 9 }]);
        const loaded = (await db.getSession(s.id))!;
        expect(loaded.exercises.find((x) => x.exerciseId === e1.id)!.sets).toEqual([{ setNumber: 1, weight: 55, reps: 9 }]);
        expect(loaded.exercises.find((x) => x.exerciseId === e2.id)!.sets).toEqual([{ setNumber: 1, weight: 20, reps: 12 }]);
        expect(await db.getSession("missing")).toBeNull();

        await db.logExercise(s.id, e2.id, []);
        expect((await db.getSession(s.id))!.exercises.map((x) => x.exerciseId)).toEqual([e1.id]);
      });

      test("getSession orders sets by set number", async () => {
        const { db } = await setup();
        const s = await db.startSession(null, "2026-10-05");
        await db.logExercise(s.id, "e", [{ setNumber: 3, weight: 3, reps: 3 }, { setNumber: 1, weight: 1, reps: 1 }, { setNumber: 2, weight: 2, reps: 2 }]);
        expect((await db.getSession(s.id))!.exercises[0].sets.map((x) => x.setNumber)).toEqual([1, 2, 3]);
      });

      test("getLastSetsForExercise: the newest session before the date, later creation breaking ties", async () => {
        const { db } = await setup();
        const log = async (date: string, weight: number, exerciseId = "squat") => {
          const s = await db.startSession(null, date);
          await db.logExercise(s.id, exerciseId, [{ setNumber: 2, weight, reps: 5 }, { setNumber: 1, weight: weight - 1, reps: 5 }]);
        };
        await log("2026-10-01", 100);
        await log("2026-10-03", 110);
        await log("2026-10-03", 111);
        await log("2026-10-05", 120);
        await log("2026-10-04", 999, "bench");
        expect(await db.getLastSetsForExercise("squat", "2026-10-05")).toEqual([
          { setNumber: 1, weight: 110, reps: 5 },
          { setNumber: 2, weight: 111, reps: 5 },
        ]);
        expect(await db.getLastSetsForExercise("squat", "2026-10-01")).toEqual([]);
      });

      test("getLastSessionForDay skips empty sessions; getSessionForDayAndDate takes the newest created", async () => {
        const { db } = await setup();
        const d = await db.createDay("Legs");
        const s1 = await db.startSession(d.id, "2026-10-01");
        await db.logExercise(s1.id, "e", [{ setNumber: 1, weight: 1, reps: 1 }]);
        await db.startSession(d.id, "2026-10-09");
        expect((await db.getLastSessionForDay(d.id))!.id).toBe(s1.id);
        expect(await db.getLastSessionForDay("other")).toBeNull();

        await db.startSession(d.id, "2026-10-10");
        const b = await db.startSession(d.id, "2026-10-10");
        expect((await db.getSessionForDayAndDate(d.id, "2026-10-10"))!.id).toBe(b.id);
        expect(await db.getSessionForDayAndDate(d.id, "2026-12-31")).toBeNull();
      });

      test("getExerciseHistory: the sessions with that exercise, newest first", async () => {
        const { db } = await setup();
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

      test("listSessions: newest first, same date by later creation", async () => {
        const { db } = await setup();
        const a = await db.startSession(null, "2026-10-01");
        const b = await db.startSession(null, "2026-10-02");
        const c = await db.startSession(null, "2026-10-01");
        expect((await db.listSessions()).map((s) => s.id)).toEqual([b.id, c.id, a.id]);
      });

      test("deleteSession removes the session and its sets, and leaves other sessions alone", async () => {
        const { db, rows } = await setup();
        const s = await db.startSession(null, "2026-10-01");
        const keep = await db.startSession(null, "2026-10-02");
        await db.logExercise(s.id, "e", [{ setNumber: 1, weight: 1, reps: 1 }, { setNumber: 2, weight: 1, reps: 1 }]);
        await db.logExercise(keep.id, "e", [{ setNumber: 1, weight: 1, reps: 1 }]);
        await db.deleteSession(s.id);
        expect(await db.getSession(s.id)).toBeNull();
        expect((await db.listSessions()).map((x) => x.id)).toEqual([keep.id]);
        const sets = await rows.selectAll<{ session_id: string }>("session_sets", { select: ["session_id"] });
        expect(sets.map((r) => r.session_id)).toEqual([keep.id]);
      });
    });

    describe("ride analytics", () => {
      const NOW = "2026-11-11T12:00:00.000Z";
      const ride = (sourceId: string): ExternalActivityInput => ({
        source: "garmin",
        sourceId,
        startedAt: NOW,
        sport: "cycling",
        environment: "outdoor",
        providerPayload: { trainingStressScore: 99 },
      });

      test("replaceActivityStreams drops the channels not passed, keeps the rest, and touches no other activity", async () => {
        const { db, rows } = await setup();
        const [a1, a2] = await db.upsertExternalActivities([ride("g-1"), ride("g-2")]);
        await db.replaceActivityStreams(a1.id, [
          { channel: "power", values: [100] },
          { channel: "heart_rate", values: [140] },
          { channel: "cadence", values: [90] },
        ]);
        await db.replaceActivityStreams(a2.id, [{ channel: "heart_rate", values: [150] }]);
        const [{ created_at: powerCreated }] = await rows.selectAll<{ created_at: string }>("activity_streams", {
          where: { id: `${a1.id}:power` },
          select: ["created_at"],
        });

        await db.replaceActivityStreams(a1.id, [{ channel: "power", values: [110] }]);
        expect(await db.getActivityStreams(a1.id)).toEqual([{ activityId: a1.id, channel: "power", startOffsetS: 0, values: [110] }]);
        const [{ created_at: keptCreated }] = await rows.selectAll<{ created_at: string }>("activity_streams", {
          where: { id: `${a1.id}:power` },
          select: ["created_at"],
        });
        expect(keptCreated).toBe(powerCreated);
        expect((await db.getActivityStreams(a2.id)).map((s) => s.channel)).toEqual(["heart_rate"]);

        await db.replaceActivityStreams(a1.id, []);
        expect(await db.getActivityStreams(a1.id)).toEqual([]);
        expect((await db.getActivityStreams(a2.id)).map((s) => s.channel)).toEqual(["heart_rate"]);
      });

      test("saveAthleteSettings changes only the given fields of the one settings row", async () => {
        const { db } = await setup();
        const first = await db.saveAthleteSettings({ manualFtpW: 250 });
        expect(first.manualFtpW).toBe(250);
        const second = await db.saveAthleteSettings({ weekStart: "sunday" });
        expect(second).toEqual({ ...first, weekStart: "sunday" });
        expect(await db.getAthleteSettings()).toEqual(second);
      });
    });
  });
}
