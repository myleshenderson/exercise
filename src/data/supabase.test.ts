import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DataLayer } from "./DataLayer";
import { createSupabaseStub, type SupabaseStub } from "./supabaseStub";
import {
  claimSeed,
  createDay,
  updateDayName,
  updateDayExercises,
  setDayExerciseTarget,
  createExercise,
  deleteDay,
  addExerciseToDay,
  removeExerciseFromDay,
  createProgram,
  renameProgram,
  deleteProgram,
  addDayToProgram,
  removeDayFromProgram,
  reorderProgramDays,
  logExercise,
  createSupabaseDataLayer,
  EXTERNAL_ACTIVITY_COLUMNS,
  upsertExternalActivities,
  replaceActivityStreams,
  upsertBodyWeights,
  addFtpHistoryEntry,
  upsertDailyTrainingLoad,
  upsertSyncState,
} from "./supabase";

// createSupabaseDataLayer() takes its client from getSupabase(); the contract
// tests below swap in a fresh recording stub per test. supabase.ts itself has
// no injection seam and is not modified for testing (AI-614).
const clientHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./supabaseClient", () => ({ getSupabase: () => clientHolder.client }));

interface Row {
  id: string;
  [key: string]: unknown;
}

type Mode = "list" | "single" | "maybeSingle";

// A minimal fake query builder covering exactly the .from(table)... chains
// src/data/supabase.ts's write functions issue: select/insert/update/delete,
// .eq (repeatable), .order, .limit, .single, .maybeSingle. No RLS — that's
// covered at the MCP layer in api/mcp.test.ts, not here.
function makeFakeClient(tables: Record<string, Row[]>): SupabaseClient {
  let seq = 0;

  function builder(table: Row[], op: "select" | "insert" | "update" | "delete", payload?: unknown, tableName?: string) {
    const filters: Array<[string, unknown]> = [];
    let orderCol: string | undefined;
    let orderAsc = true;
    let limitN: number | undefined;
    let mode: Mode = "list";

    function matched(rows: Row[]): Row[] {
      let out = rows.filter((r) => filters.every(([col, val]) => r[col] === val));
      if (orderCol) {
        const col = orderCol;
        const dir = orderAsc ? 1 : -1;
        out = out.slice().sort((a, b) => ((a[col] as number) - (b[col] as number)) * dir);
      }
      if (limitN !== undefined) out = out.slice(0, limitN);
      return out;
    }

    function finish(rows: Row[]) {
      if (mode === "single") {
        return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "no rows found" } };
      }
      if (mode === "maybeSingle") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    function run() {
      if (op === "select") return finish(matched(table));
      if (op === "delete") {
        for (const row of matched(table)) {
          const idx = table.indexOf(row);
          if (idx !== -1) table.splice(idx, 1);
        }
        return { data: null, error: null };
      }
      if (op === "update") {
        const targets = matched(table);
        // Mirror workout_days_program_position_uq (a real, immediately-enforced
        // partial unique index on (program_id, program_position) where
        // program_id is not null): reject an update that would leave two
        // distinct rows sharing a non-null program_id and equal
        // program_position. Scoped to workout_days only, and only to this one
        // constraint - not a general constraint-enforcement engine.
        if (tableName === "workout_days") {
          for (const row of targets) {
            const merged = { ...row, ...(payload as Record<string, unknown>) };
            if (merged.program_id != null) {
              const conflict = table.some(
                (other) =>
                  other !== row &&
                  other.program_id === merged.program_id &&
                  other.program_position === merged.program_position,
              );
              if (conflict) {
                return {
                  data: null,
                  error: { code: "23505", message: 'duplicate key value violates unique constraint "workout_days_program_position_uq"' },
                };
              }
            }
          }
        }
        for (const row of targets) Object.assign(row, payload as Record<string, unknown>);
        return finish(targets);
      }
      const inputs = Array.isArray(payload) ? payload : [payload];
      const inserted = (inputs as Array<Record<string, unknown>>).map((input) => {
        const row: Row = { id: `id-${++seq}`, position: 0, ...input };
        table.push(row);
        return row;
      });
      return finish(inserted);
    }

    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending ?? true;
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      single: () => {
        mode = "single";
        return api;
      },
      maybeSingle: () => {
        mode = "maybeSingle";
        return api;
      },
      then: (onfulfilled?: ((v: ReturnType<typeof run>) => unknown) | null, onrejected?: ((e: unknown) => unknown) | null) =>
        Promise.resolve(run()).then(onfulfilled, onrejected),
    };
    return api;
  }

  return {
    from: (tableName: string) => {
      const table = (tables[tableName] ??= []);
      return {
        select: () => builder(table, "select", undefined, tableName),
        insert: (payload: unknown) => builder(table, "insert", payload, tableName),
        update: (payload: unknown) => builder(table, "update", payload, tableName),
        delete: () => builder(table, "delete", undefined, tableName),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as SupabaseClient;
}

// claimSeed only issues a bare insert (no select/order/eq chaining), so a
// tiny purpose-built fake — rather than makeFakeClient, which has no notion
// of a unique-constraint violation — is enough to cover its three outcomes.
function makeClaimClient(errors: Array<{ code?: string; message: string } | null>): SupabaseClient {
  let call = 0;
  return {
    from: () => ({
      insert: () => Promise.resolve({ data: null, error: errors[Math.min(call++, errors.length - 1)] }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as SupabaseClient;
}

describe("claimSeed", () => {
  test("returns true when this caller's insert wins the claim", async () => {
    const client = makeClaimClient([null]);
    expect(await claimSeed(client)).toBe(true);
  });

  test("returns false on a unique violation — another caller already claimed it", async () => {
    const client = makeClaimClient([{ code: "23505", message: "duplicate key value violates unique constraint" }]);
    expect(await claimSeed(client)).toBe(false);
  });

  test("rethrows any other error", async () => {
    const client = makeClaimClient([{ code: "42501", message: "permission denied for table seed_claims" }]);
    await expect(claimSeed(client)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("createDay", () => {
  test("inserts a workout_days row and returns it with an empty exercise list, untracked", async () => {
    const tables: Record<string, Row[]> = { workout_days: [] };
    const client = makeFakeClient(tables);
    const day = await createDay(client, "Push Day");
    expect(day).toEqual({
      id: expect.any(String), name: "Push Day", position: 0, exerciseIds: [],
      programId: null, programPosition: null, programName: null, isAvailable: true,
    });
    expect(tables.workout_days).toHaveLength(1);
  });
});

describe("updateDayName", () => {
  test("updates the name column on the matching row", async () => {
    const tables: Record<string, Row[]> = { workout_days: [{ id: "day-1", name: "Push" }] };
    const client = makeFakeClient(tables);
    await updateDayName(client, "day-1", "Push (renamed)");
    expect(tables.workout_days[0].name).toBe("Push (renamed)");
  });
});

describe("updateDayExercises", () => {
  test("preserves target_sets for a surviving exercise across the delete-and-reinsert", async () => {
    const tables: Record<string, Row[]> = {
      workout_day_exercises: [
        { id: "wde-1", workout_day_id: "day-1", exercise_id: "ex-1", position: 0, target_sets: [{ weight: 225, reps: 5 }] },
      ],
    };
    const client = makeFakeClient(tables);
    await updateDayExercises(client, "day-1", ["ex-1", "ex-2"]);
    const row1 = tables.workout_day_exercises.find((r) => r.exercise_id === "ex-1");
    const row2 = tables.workout_day_exercises.find((r) => r.exercise_id === "ex-2");
    expect(row1?.target_sets).toEqual([{ weight: 225, reps: 5 }]);
    expect(row2?.target_sets).toBeNull();
  });

  test("drops rows for exercises no longer in the list", async () => {
    const tables: Record<string, Row[]> = {
      workout_day_exercises: [
        { id: "wde-1", workout_day_id: "day-1", exercise_id: "ex-1", position: 0 },
        { id: "wde-2", workout_day_id: "day-1", exercise_id: "ex-2", position: 1 },
      ],
    };
    const client = makeFakeClient(tables);
    await updateDayExercises(client, "day-1", ["ex-2"]);
    expect(tables.workout_day_exercises.map((r) => r.exercise_id)).toEqual(["ex-2"]);
  });
});

describe("setDayExerciseTarget", () => {
  test("sets target_sets on the matching row", async () => {
    const tables: Record<string, Row[]> = {
      workout_day_exercises: [{ id: "wde-1", workout_day_id: "day-1", exercise_id: "ex-1", position: 0, target_sets: null }],
    };
    const client = makeFakeClient(tables);
    await setDayExerciseTarget(client, "day-1", "ex-1", [{ setNumber: 1, weight: 100, reps: 10 }]);
    expect(tables.workout_day_exercises[0].target_sets).toEqual([{ weight: 100, reps: 10 }]);
  });

  test("clears target_sets when passed null", async () => {
    const tables: Record<string, Row[]> = {
      workout_day_exercises: [
        { id: "wde-1", workout_day_id: "day-1", exercise_id: "ex-1", position: 0, target_sets: [{ weight: 100, reps: 10 }] },
      ],
    };
    const client = makeFakeClient(tables);
    await setDayExerciseTarget(client, "day-1", "ex-1", null);
    expect(tables.workout_day_exercises[0].target_sets).toBeNull();
  });
});

describe("createExercise", () => {
  test("inserts an exercises row and returns it mapped to the app's Exercise shape", async () => {
    const tables: Record<string, Row[]> = { exercises: [] };
    const client = makeFakeClient(tables);
    const exercise = await createExercise(client, {
      name: "Bench Press",
      cue: "elbows tucked",
      defaultSets: 4,
      defaultRepLow: 6,
      defaultRepHigh: 10,
    });
    expect(exercise).toEqual({
      id: expect.any(String),
      name: "Bench Press",
      cue: "elbows tucked",
      defaultSets: 4,
      defaultRepLow: 6,
      defaultRepHigh: 10,
    });
  });
});

describe("deleteDay", () => {
  test("soft-deletes by setting deleted_at, leaving the row in place", async () => {
    const tables: Record<string, Row[]> = { workout_days: [{ id: "day-1", name: "Push", deleted_at: null }] };
    const client = makeFakeClient(tables);
    await deleteDay(client, "day-1");
    expect(tables.workout_days).toHaveLength(1);
    expect(tables.workout_days[0].deleted_at).toEqual(expect.any(String));
  });
});

describe("addExerciseToDay", () => {
  test("appends at position 0 when the day has no exercises yet", async () => {
    const tables: Record<string, Row[]> = { workout_day_exercises: [] };
    const client = makeFakeClient(tables);
    await addExerciseToDay(client, "day-1", "ex-1");
    expect(tables.workout_day_exercises).toEqual([
      { id: expect.any(String), workout_day_id: "day-1", exercise_id: "ex-1", position: 0 },
    ]);
  });

  test("appends after the current highest position", async () => {
    const tables: Record<string, Row[]> = {
      workout_day_exercises: [
        { id: "wde-1", workout_day_id: "day-1", exercise_id: "ex-1", position: 0 },
        { id: "wde-2", workout_day_id: "day-1", exercise_id: "ex-2", position: 1 },
      ],
    };
    const client = makeFakeClient(tables);
    await addExerciseToDay(client, "day-1", "ex-3");
    expect(tables.workout_day_exercises[2]).toMatchObject({
      workout_day_id: "day-1",
      exercise_id: "ex-3",
      position: 2,
    });
  });
});

describe("removeExerciseFromDay", () => {
  test("removes only the matching workout_day_exercises row", async () => {
    const tables: Record<string, Row[]> = {
      workout_day_exercises: [
        { id: "wde-1", workout_day_id: "day-1", exercise_id: "ex-1", position: 0 },
        { id: "wde-2", workout_day_id: "day-1", exercise_id: "ex-2", position: 1 },
      ],
    };
    const client = makeFakeClient(tables);
    await removeExerciseFromDay(client, "day-1", "ex-1");
    expect(tables.workout_day_exercises.map((r) => r.exercise_id)).toEqual(["ex-2"]);
  });
});

describe("createProgram", () => {
  test("inserts a programs row and returns it", async () => {
    const tables: Record<string, Row[]> = { programs: [] };
    const client = makeFakeClient(tables);
    const program = await createProgram(client, "Prep Phase");
    expect(program).toEqual({ id: expect.any(String), name: "Prep Phase" });
    expect(tables.programs).toHaveLength(1);
  });
});

describe("renameProgram", () => {
  test("updates the name column on the matching row", async () => {
    const tables: Record<string, Row[]> = { programs: [{ id: "prog-1", name: "Prep Phase" }] };
    const client = makeFakeClient(tables);
    await renameProgram(client, "prog-1", "Prep Phase (v2)");
    expect(tables.programs[0].name).toBe("Prep Phase (v2)");
  });
});

describe("deleteProgram", () => {
  test("soft-deletes by setting deleted_at, leaving the row and its days' assignments in place", async () => {
    const tables: Record<string, Row[]> = {
      programs: [{ id: "prog-1", name: "Prep Phase", deleted_at: null }],
      workout_days: [{ id: "day-1", name: "Week 1", program_id: "prog-1", program_position: 0 }],
    };
    const client = makeFakeClient(tables);
    await deleteProgram(client, "prog-1");
    expect(tables.programs[0].deleted_at).toEqual(expect.any(String));
    expect(tables.workout_days[0].program_id).toBe("prog-1");
    expect(tables.workout_days[0].program_position).toBe(0);
  });
});

describe("addDayToProgram", () => {
  test("assigns program_id and program_position 0 when the program has no days yet", async () => {
    const tables: Record<string, Row[]> = {
      workout_days: [{ id: "day-1", name: "Week 1", program_id: null, program_position: null }],
    };
    const client = makeFakeClient(tables);
    await addDayToProgram(client, "day-1", "prog-1");
    expect(tables.workout_days[0]).toMatchObject({ program_id: "prog-1", program_position: 0 });
  });

  test("appends after the current highest program_position", async () => {
    const tables: Record<string, Row[]> = {
      workout_days: [
        { id: "day-1", name: "Week 1", program_id: "prog-1", program_position: 0 },
        { id: "day-2", name: "Week 2", program_id: null, program_position: null },
      ],
    };
    const client = makeFakeClient(tables);
    await addDayToProgram(client, "day-2", "prog-1");
    expect(tables.workout_days[1]).toMatchObject({ program_id: "prog-1", program_position: 1 });
  });
});

describe("removeDayFromProgram", () => {
  test("clears program_id and program_position on the matching row only", async () => {
    const tables: Record<string, Row[]> = {
      workout_days: [
        { id: "day-1", name: "Week 1", program_id: "prog-1", program_position: 0 },
        { id: "day-2", name: "Week 2", program_id: "prog-1", program_position: 1 },
      ],
    };
    const client = makeFakeClient(tables);
    await removeDayFromProgram(client, "day-1");
    expect(tables.workout_days[0]).toMatchObject({ program_id: null, program_position: null });
    expect(tables.workout_days[1]).toMatchObject({ program_id: "prog-1", program_position: 1 });
  });
});

describe("reorderProgramDays", () => {
  test("rewrites program_position from the given order, for that program's days only", async () => {
    const tables: Record<string, Row[]> = {
      workout_days: [
        { id: "day-1", name: "Week 1", program_id: "prog-1", program_position: 0 },
        { id: "day-2", name: "Week 2", program_id: "prog-1", program_position: 1 },
      ],
    };
    const client = makeFakeClient(tables);
    await reorderProgramDays(client, "prog-1", ["day-2", "day-1"]);
    expect(tables.workout_days.find((r) => r.id === "day-2")?.program_position).toBe(0);
    expect(tables.workout_days.find((r) => r.id === "day-1")?.program_position).toBe(1);
  });

  // Regression test for the collision this function used to hit on almost
  // every real reorder: swapping day-1 (position 0) and day-2 (position 1)
  // via a naive single-phase write updates day-2 to position 0 first, which
  // the fake client's uniqueness check (mirroring
  // workout_days_program_position_uq) rejects because day-1 is still at
  // position 0. The two-phase parking write must not hit that collision.
  test("swaps two already-assigned days' positions without a uniqueness collision", async () => {
    const tables: Record<string, Row[]> = {
      workout_days: [
        { id: "day-1", name: "Week 1", program_id: "prog-1", program_position: 0 },
        { id: "day-2", name: "Week 2", program_id: "prog-1", program_position: 1 },
      ],
    };
    const client = makeFakeClient(tables);
    await expect(reorderProgramDays(client, "prog-1", ["day-2", "day-1"])).resolves.toBeUndefined();
    expect(tables.workout_days.find((r) => r.id === "day-2")?.program_position).toBe(0);
    expect(tables.workout_days.find((r) => r.id === "day-1")?.program_position).toBe(1);
  });
});

// logExercise only issues a delete followed by an optional insert against
// session_sets (no select/order/eq-result chaining beyond that), so a tiny
// purpose-built fake — rather than makeFakeClient, which has no way to force
// an error — is enough to cover each step failing.
function makeLogExerciseClient(errors: { delete?: { message: string }; insert?: { message: string } }): {
  client: SupabaseClient;
  inserted: unknown[];
} {
  const inserted: unknown[] = [];
  const client = {
    from: () => ({
      delete: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ error: errors.delete ?? null }),
        }),
      }),
      insert: (payload: unknown) => {
        inserted.push(payload);
        return Promise.resolve({ error: errors.insert ?? null });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as SupabaseClient;
  return { client, inserted };
}

describe("logExercise", () => {
  test("replaces a session's logged sets for an exercise via delete-then-insert", async () => {
    const tables: Record<string, Row[]> = {
      session_sets: [{ id: "ss-1", session_id: "session-1", exercise_id: "ex-1", set_number: 1, weight: 90, reps: 12 }],
    };
    const client = makeFakeClient(tables);
    await logExercise(client, "session-1", "ex-1", [{ setNumber: 1, weight: 100, reps: 10 }]);
    expect(tables.session_sets).toHaveLength(1);
    expect(tables.session_sets[0]).toMatchObject({ session_id: "session-1", exercise_id: "ex-1", set_number: 1, weight: 100, reps: 10 });
  });

  test("throws when the delete fails, without attempting the insert", async () => {
    const { client, inserted } = makeLogExerciseClient({ delete: { message: "simulated postgres failure" } });
    await expect(logExercise(client, "session-1", "ex-1", [{ setNumber: 1, weight: 100, reps: 10 }])).rejects.toMatchObject({
      message: "simulated postgres failure",
    });
    expect(inserted).toHaveLength(0);
  });

  test("throws when the insert fails", async () => {
    const { client } = makeLogExerciseClient({ insert: { message: "simulated postgres failure" } });
    await expect(logExercise(client, "session-1", "ex-1", [{ setNumber: 1, weight: 100, reps: 10 }])).rejects.toMatchObject({
      message: "simulated postgres failure",
    });
  });
});

// ---------------------------------------------------------------------------
// DataLayer contract tests over a recording stub (AI-614).
//
// Each test drives createSupabaseDataLayer() through the DataLayer interface,
// queues the canned { data, error } replies Supabase would send, and asserts
// both the query chain the layer issued (table, verb, filters, payload) and
// the domain object it returned, the way starkeep.test.ts asserts the row-API
// requests over fakeTransport.
// ---------------------------------------------------------------------------

const NOW = "2026-11-08T12:00:00.000Z";
const FAIL = { message: "simulated postgres failure", code: "XX000" };

function setup(): { db: DataLayer; stub: SupabaseStub } {
  const stub = createSupabaseStub();
  clientHolder.client = stub.client;
  return { db: createSupabaseDataLayer(), stub };
}

const exerciseRow = (id: string, name: string) => ({
  id,
  name,
  cue: `${name} cue`,
  default_sets: 3,
  default_rep_low: 8,
  default_rep_high: 12,
  deleted_at: null,
});
const exercise = (id: string, name: string) => ({
  id,
  name,
  cue: `${name} cue`,
  defaultSets: 3,
  defaultRepLow: 8,
  defaultRepHigh: 12,
});

describe("Supabase DataLayer contract", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    clientHolder.client = null;
  });

  describe("claimSeed", () => {
    test("inserts an empty seed_claims row and wins", async () => {
      const { db, stub } = setup();
      expect(await db.claimSeed()).toBe(true);
      expect(stub.queries).toEqual([{ table: "seed_claims", op: "insert", payload: {}, steps: [{ method: "insert", args: [{}] }] }]);
    });

    test("loses on 23505 and rethrows anything else", async () => {
      const { db, stub } = setup();
      stub.reply({ error: { code: "23505", message: "duplicate key" } }, { error: FAIL });
      expect(await db.claimSeed()).toBe(false);
      await expect(db.claimSeed()).rejects.toBe(FAIL);
    });
  });

  describe("exercises", () => {
    test("listExercises reads live rows ordered by name and maps them", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [exerciseRow("ex-1", "Bench"), exerciseRow("ex-2", "Squat")] });
      expect(await db.listExercises()).toEqual([exercise("ex-1", "Bench"), exercise("ex-2", "Squat")]);
      expect(stub.queries[0]).toMatchObject({ table: "exercises", op: "select" });
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["*"] },
        { method: "is", args: ["deleted_at", null] },
        { method: "order", args: ["name"] },
      ]);
    });

    test("listExercises returns [] for null data and throws on error", async () => {
      const { db, stub } = setup();
      stub.reply({ data: null }, { error: FAIL });
      expect(await db.listExercises()).toEqual([]);
      await expect(db.listExercises()).rejects.toBe(FAIL);
    });

    test("getExercise looks up by id and returns null when absent", async () => {
      const { db, stub } = setup();
      stub.reply({ data: exerciseRow("ex-1", "Bench") }, { data: null });
      expect(await db.getExercise("ex-1")).toEqual(exercise("ex-1", "Bench"));
      expect(await db.getExercise("nope")).toBeNull();
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["*"] },
        { method: "eq", args: ["id", "ex-1"] },
        { method: "maybeSingle", args: [] },
      ]);
    });

    test("createExercise inserts the snake_case row and maps the returned one", async () => {
      const { db, stub } = setup();
      stub.reply({ data: exerciseRow("ex-9", "Row") });
      const input = { name: "Row", cue: "Row cue", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 };
      expect(await db.createExercise(input)).toEqual(exercise("ex-9", "Row"));
      expect(stub.queries).toHaveLength(1);
      expect(stub.queries[0]).toMatchObject({
        table: "exercises",
        op: "insert",
        payload: { name: "Row", cue: "Row cue", default_sets: 3, default_rep_low: 8, default_rep_high: 12 },
      });
      expect(stub.queries[0].steps.slice(1)).toEqual([
        { method: "select", args: ["*"] },
        { method: "single", args: [] },
      ]);
    });

    test("createExercise throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.createExercise({ name: "Row", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 })).rejects.toBe(FAIL);
    });

    test("updateExercise sends only the fields present in the patch, filtered by id", async () => {
      const { db, stub } = setup();
      stub.reply({ data: { ...exerciseRow("ex-1", "Bench"), cue: "new cue" } }, { data: exerciseRow("ex-1", "Bench") });
      expect(await db.updateExercise("ex-1", { cue: "new cue" })).toEqual({ ...exercise("ex-1", "Bench"), cue: "new cue" });
      expect(stub.queries[0]).toMatchObject({ table: "exercises", op: "update", payload: { cue: "new cue" } });
      expect(stub.filters(stub.queries[0])).toEqual([["eq", "id", "ex-1"]]);
      expect(stub.queries[0].steps.slice(-2)).toEqual([
        { method: "select", args: ["*"] },
        { method: "single", args: [] },
      ]);

      await db.updateExercise("ex-1", { name: "Bench", cue: "c", defaultSets: 5, defaultRepLow: 3, defaultRepHigh: 5 });
      expect(stub.queries[1].payload).toEqual({ name: "Bench", cue: "c", default_sets: 5, default_rep_low: 3, default_rep_high: 5 });
    });

    test("updateExercise throws when Supabase reports no row (single() error)", async () => {
      const { db, stub } = setup();
      stub.reply({ error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } });
      await expect(db.updateExercise("missing", { name: "x" })).rejects.toMatchObject({ code: "PGRST116" });
    });

    test("deleteExercise soft-deletes by setting deleted_at, with no in-use check in this layer", async () => {
      const { db, stub } = setup();
      await db.deleteExercise("ex-1");
      // One query only: the in-use guard lives in api/mcp.ts, not here (DataLayer.ts deleteExercise comment).
      expect(stub.queries).toEqual([
        {
          table: "exercises",
          op: "update",
          payload: { deleted_at: NOW },
          steps: [
            { method: "update", args: [{ deleted_at: NOW }] },
            { method: "eq", args: ["id", "ex-1"] },
          ],
        },
      ]);
    });

    test("deleteExercise throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.deleteExercise("ex-1")).rejects.toBe(FAIL);
    });
  });

  describe("name lookups", () => {
    const lookupSteps = (columns: string, name: string) => [
      { method: "select", args: [columns] },
      { method: "eq", args: ["name", name] },
      { method: "is", args: ["deleted_at", null] },
      { method: "order", args: ["created_at"] },
      { method: "limit", args: [1] },
      { method: "maybeSingle", args: [] },
    ];

    test("findDayByName returns the earliest live match, mapping null program fields", async () => {
      const { db, stub } = setup();
      stub.reply({ data: { id: "day-1", name: "Push", position: 2, program_id: undefined, program_position: undefined } });
      expect(await db.findDayByName("Push")).toEqual({ id: "day-1", name: "Push", position: 2, programId: null, programPosition: null });
      expect(stub.queries[0]).toMatchObject({ table: "workout_days", op: "select" });
      expect(stub.queries[0].steps).toEqual(lookupSteps("id, name, position, program_id, program_position", "Push"));
    });

    test("findDayByName keeps program fields, returns null on no match, throws on error", async () => {
      const { db, stub } = setup();
      stub.reply({ data: { id: "day-2", name: "Pull", position: 0, program_id: "prog-1", program_position: 3 } }, { data: null }, { error: FAIL });
      expect(await db.findDayByName("Pull")).toEqual({ id: "day-2", name: "Pull", position: 0, programId: "prog-1", programPosition: 3 });
      expect(await db.findDayByName("None")).toBeNull();
      await expect(db.findDayByName("x")).rejects.toBe(FAIL);
    });

    test("findExerciseByName maps the match, null otherwise, throws on error", async () => {
      const { db, stub } = setup();
      stub.reply({ data: exerciseRow("ex-1", "Bench") }, { data: null }, { error: FAIL });
      expect(await db.findExerciseByName("Bench")).toEqual(exercise("ex-1", "Bench"));
      expect(stub.queries[0]).toMatchObject({ table: "exercises", op: "select" });
      expect(stub.queries[0].steps).toEqual(lookupSteps("*", "Bench"));
      expect(await db.findExerciseByName("None")).toBeNull();
      await expect(db.findExerciseByName("x")).rejects.toBe(FAIL);
    });

    test("findProgramByName maps the match, null otherwise, throws on error", async () => {
      const { db, stub } = setup();
      stub.reply({ data: { id: "prog-1", name: "Prep", deleted_at: null } }, { data: null }, { error: FAIL });
      expect(await db.findProgramByName("Prep")).toEqual({ id: "prog-1", name: "Prep" });
      expect(stub.queries[0]).toMatchObject({ table: "programs", op: "select" });
      expect(stub.queries[0].steps).toEqual(lookupSteps("id, name", "Prep"));
      expect(await db.findProgramByName("None")).toBeNull();
      await expect(db.findProgramByName("x")).rejects.toBe(FAIL);
    });
  });

  describe("days", () => {
    test("getWorkoutDays joins programs, completion and exercise links into WorkoutDay", async () => {
      const { db, stub } = setup();
      stub.reply(
        {
          data: [
            { id: "day-a", name: "Solo", position: 0, program_id: null, program_position: null },
            { id: "day-b", name: "Wk1", position: 1, program_id: "prog-1", program_position: 0 },
            { id: "day-c", name: "Wk2", position: 2, program_id: "prog-1", program_position: 1 },
            { id: "day-d", name: "Orphan", position: 3, program_id: "prog-gone", program_position: 0 },
          ],
        },
        { data: [{ id: "prog-1", name: "Prep" }] },
        { data: [{ id: "s-1", workout_day_id: "day-b", session_sets: [{ id: "ss-1" }] }] },
        { data: [{ exercise_id: "ex-1", position: 0 }, { exercise_id: "ex-2", position: 1 }] },
        { data: null },
        { data: [{ exercise_id: "ex-3", position: 0 }] },
        { data: [] },
      );
      expect(await db.getWorkoutDays()).toEqual([
        { id: "day-a", name: "Solo", position: 0, exerciseIds: ["ex-1", "ex-2"], programId: null, programPosition: null, programName: null, isAvailable: true },
        { id: "day-b", name: "Wk1", position: 1, exerciseIds: [], programId: "prog-1", programPosition: 0, programName: "Prep", isAvailable: false },
        { id: "day-c", name: "Wk2", position: 2, exerciseIds: ["ex-3"], programId: "prog-1", programPosition: 1, programName: "Prep", isAvailable: true },
        // A day whose program is soft-deleted (absent from the live programs read) reads as unprogrammed.
        { id: "day-d", name: "Orphan", position: 3, exerciseIds: [], programId: null, programPosition: null, programName: null, isAvailable: true },
      ]);
      expect(stub.queries.map((q) => [q.table, ...stub.filters(q)])).toEqual([
        ["workout_days", ["is", "deleted_at", null]],
        ["programs", ["is", "deleted_at", null]],
        ["sessions", ["not", "workout_day_id", "is", null]],
        ["workout_day_exercises", ["eq", "workout_day_id", "day-a"]],
        ["workout_day_exercises", ["eq", "workout_day_id", "day-b"]],
        ["workout_day_exercises", ["eq", "workout_day_id", "day-c"]],
        ["workout_day_exercises", ["eq", "workout_day_id", "day-d"]],
      ]);
      expect(stub.queries[2].steps[0]).toEqual({ method: "select", args: ["id, workout_day_id, session_sets!inner(id)"] });
    });

    test("getWorkoutDays tolerates null reads", async () => {
      const { db, stub } = setup();
      expect(await db.getWorkoutDays()).toEqual([]);
      expect(stub.queries).toHaveLength(3);
    });

    test("getDayExercises resolves links in position order, skipping missing exercises", async () => {
      const { db, stub } = setup();
      stub.reply(
        { data: [{ exercise_id: "ex-2", position: 0 }, { exercise_id: "ex-gone", position: 1 }, { exercise_id: "ex-1", position: 2 }] },
        { data: exerciseRow("ex-2", "Squat") },
        { data: null },
        { data: exerciseRow("ex-1", "Bench") },
      );
      expect(await db.getDayExercises("day-1")).toEqual([exercise("ex-2", "Squat"), exercise("ex-1", "Bench")]);
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["exercise_id, position"] },
        { method: "eq", args: ["workout_day_id", "day-1"] },
        { method: "order", args: ["position"] },
      ]);
      expect(stub.queries.slice(1).map((q) => stub.filters(q))).toEqual([[["eq", "id", "ex-2"]], [["eq", "id", "ex-gone"]], [["eq", "id", "ex-1"]]]);
    });

    test("getDayExercises returns [] when the day has no links", async () => {
      const { db, stub } = setup();
      expect(await db.getDayExercises("day-1")).toEqual([]);
      expect(stub.queries).toHaveLength(1);
    });

    test("createDay inserts the name and returns an untracked day with no exercises", async () => {
      const { db, stub } = setup();
      stub.reply({ data: { id: "day-9", name: "Legs", position: 4 } });
      expect(await db.createDay("Legs")).toEqual({
        id: "day-9", name: "Legs", position: 4, exerciseIds: [],
        programId: null, programPosition: null, programName: null, isAvailable: true,
      });
      expect(stub.queries[0]).toEqual({
        table: "workout_days",
        op: "insert",
        payload: { name: "Legs" },
        steps: [
          { method: "insert", args: [{ name: "Legs" }] },
          { method: "select", args: ["*"] },
          { method: "single", args: [] },
        ],
      });
    });

    test("createDay throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.createDay("Legs")).rejects.toBe(FAIL);
    });

    test("updateDayName updates name on the row with that id", async () => {
      const { db, stub } = setup();
      await db.updateDayName("day-1", "Push 2");
      expect(stub.queries[0]).toMatchObject({ table: "workout_days", op: "update", payload: { name: "Push 2" } });
      expect(stub.filters(stub.queries[0])).toEqual([["eq", "id", "day-1"]]);
    });

    test("updateDayName throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.updateDayName("day-1", "x")).rejects.toBe(FAIL);
    });

    test("deleteDay soft-deletes by setting deleted_at on the row with that id", async () => {
      const { db, stub } = setup();
      await db.deleteDay("day-1");
      expect(stub.queries).toHaveLength(1);
      expect(stub.queries[0]).toMatchObject({ table: "workout_days", op: "update", payload: { deleted_at: NOW } });
      expect(stub.filters(stub.queries[0])).toEqual([["eq", "id", "day-1"]]);
    });

    test("deleteDay throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.deleteDay("day-1")).rejects.toBe(FAIL);
    });
  });

  describe("day exercises", () => {
    test("addExerciseToDay appends after the highest position", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [{ position: 4 }] });
      await db.addExerciseToDay("day-1", "ex-7");
      expect(stub.queries[0]).toMatchObject({ table: "workout_day_exercises", op: "select" });
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["position"] },
        { method: "eq", args: ["workout_day_id", "day-1"] },
        { method: "order", args: ["position", { ascending: false }] },
        { method: "limit", args: [1] },
      ]);
      expect(stub.queries[1]).toMatchObject({
        table: "workout_day_exercises",
        op: "insert",
        payload: { workout_day_id: "day-1", exercise_id: "ex-7", position: 5 },
      });
    });

    test("addExerciseToDay starts at position 0 on an empty day", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [] });
      await db.addExerciseToDay("day-1", "ex-7");
      expect(stub.queries[1].payload).toEqual({ workout_day_id: "day-1", exercise_id: "ex-7", position: 0 });
    });

    test("addExerciseToDay throws on a failed read (no insert) and on a failed insert", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.addExerciseToDay("day-1", "ex-7")).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(1);
      stub.reply({ data: [] }, { error: FAIL });
      await expect(db.addExerciseToDay("day-1", "ex-7")).rejects.toBe(FAIL);
      expect(stub.queries.map((q) => q.op)).toEqual(["select", "select", "insert"]);
    });

    test("removeExerciseFromDay deletes the one (day, exercise) link", async () => {
      const { db, stub } = setup();
      await db.removeExerciseFromDay("day-1", "ex-1");
      expect(stub.queries[0]).toMatchObject({ table: "workout_day_exercises", op: "delete" });
      expect(stub.filters(stub.queries[0])).toEqual([
        ["eq", "workout_day_id", "day-1"],
        ["eq", "exercise_id", "ex-1"],
      ]);
    });

    test("removeExerciseFromDay throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.removeExerciseFromDay("day-1", "ex-1")).rejects.toBe(FAIL);
    });

    test("updateDayExercises reorders by delete-and-reinsert, carrying target_sets over", async () => {
      const { db, stub } = setup();
      const target = [{ weight: 100, reps: 5 }];
      stub.reply({ data: [{ exercise_id: "ex-1", target_sets: target }, { exercise_id: "ex-2", target_sets: null }] });
      await db.updateDayExercises("day-1", ["ex-2", "ex-1", "ex-3"]);
      expect(stub.queries.map((q) => [q.table, q.op, ...stub.filters(q)])).toEqual([
        ["workout_day_exercises", "select", ["eq", "workout_day_id", "day-1"]],
        ["workout_day_exercises", "delete", ["eq", "workout_day_id", "day-1"]],
        ["workout_day_exercises", "insert"],
      ]);
      expect(stub.queries[0].steps[0]).toEqual({ method: "select", args: ["exercise_id, target_sets"] });
      expect(stub.queries[2].payload).toEqual([
        { workout_day_id: "day-1", exercise_id: "ex-2", position: 0, target_sets: null },
        { workout_day_id: "day-1", exercise_id: "ex-1", position: 1, target_sets: target },
        { workout_day_id: "day-1", exercise_id: "ex-3", position: 2, target_sets: null },
      ]);
    });

    test("updateDayExercises with an empty list only deletes", async () => {
      const { db, stub } = setup();
      await db.updateDayExercises("day-1", []);
      expect(stub.queries.map((q) => q.op)).toEqual(["select", "delete"]);
    });

    test.each([
      ["select", [{ error: FAIL }], ["select"]],
      ["delete", [{ data: [] }, { error: FAIL }], ["select", "delete"]],
      ["insert", [{ data: [] }, {}, { error: FAIL }], ["select", "delete", "insert"]],
    ])("updateDayExercises throws when the %s fails and stops there", async (_step, replies, ops) => {
      const { db, stub } = setup();
      stub.reply(...replies);
      await expect(db.updateDayExercises("day-1", ["ex-1"])).rejects.toBe(FAIL);
      expect(stub.queries.map((q) => q.op)).toEqual(ops);
    });
  });

  describe("schemes", () => {
    test("getDayExerciseTargets maps target_sets to numbered SetEntry lists, skipping empty ones", async () => {
      const { db, stub } = setup();
      stub.reply({
        data: [
          { exercise_id: "ex-1", target_sets: [{ weight: 100, reps: 5 }, { weight: 110, reps: 3 }] },
          { exercise_id: "ex-2", target_sets: [] },
          { exercise_id: "ex-3", target_sets: null },
        ],
      });
      expect(await db.getDayExerciseTargets("day-1")).toEqual({
        "ex-1": [
          { setNumber: 1, weight: 100, reps: 5 },
          { setNumber: 2, weight: 110, reps: 3 },
        ],
      });
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["exercise_id, target_sets"] },
        { method: "eq", args: ["workout_day_id", "day-1"] },
      ]);
    });

    test("getDayExerciseTargets returns {} for null data", async () => {
      const { db } = setup();
      expect(await db.getDayExerciseTargets("day-1")).toEqual({});
    });

    test("setDayExerciseTarget updates the link and appends a scheme history row", async () => {
      const { db, stub } = setup();
      await db.setDayExerciseTarget("day-1", "ex-1", [
        { setNumber: 1, weight: 100, reps: 5 },
        { setNumber: 2, weight: 110, reps: 3 },
      ]);
      const target_sets = [{ weight: 100, reps: 5 }, { weight: 110, reps: 3 }];
      expect(stub.queries[0]).toMatchObject({ table: "workout_day_exercises", op: "update", payload: { target_sets } });
      expect(stub.filters(stub.queries[0])).toEqual([
        ["eq", "workout_day_id", "day-1"],
        ["eq", "exercise_id", "ex-1"],
      ]);
      // Append-only: always an insert, never an update of an earlier history row.
      expect(stub.queries[1]).toEqual({
        table: "workout_day_exercise_scheme_history",
        op: "insert",
        payload: { workout_day_id: "day-1", exercise_id: "ex-1", target_sets },
        steps: [{ method: "insert", args: [{ workout_day_id: "day-1", exercise_id: "ex-1", target_sets }] }],
      });
    });

    test.each([[null], [[]]])("setDayExerciseTarget clears with %j and records the clear in history", async (sets) => {
      const { db, stub } = setup();
      await db.setDayExerciseTarget("day-1", "ex-1", sets);
      expect(stub.queries.map((q) => [q.table, q.payload])).toEqual([
        ["workout_day_exercises", { target_sets: null }],
        ["workout_day_exercise_scheme_history", { workout_day_id: "day-1", exercise_id: "ex-1", target_sets: null }],
      ]);
    });

    test("setDayExerciseTarget throws on a failed update without writing history", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.setDayExerciseTarget("day-1", "ex-1", null)).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(1);
    });

    test("setDayExerciseTarget throws on a failed history insert", async () => {
      const { db, stub } = setup();
      stub.reply({}, { error: FAIL });
      await expect(db.setDayExerciseTarget("day-1", "ex-1", null)).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(2);
    });

    test("getSchemeHistory reads the (day, exercise) history oldest first and maps it", async () => {
      const { db, stub } = setup();
      stub.reply({
        data: [
          { target_sets: [{ weight: 100, reps: 5 }], recorded_at: "2026-11-01T00:00:00Z" },
          { target_sets: null, recorded_at: "2026-11-02T00:00:00Z" },
          { target_sets: [], recorded_at: "2026-11-03T00:00:00Z" },
        ],
      });
      expect(await db.getSchemeHistory("day-1", "ex-1")).toEqual([
        { targetSets: [{ setNumber: 1, weight: 100, reps: 5 }], recordedAt: "2026-11-01T00:00:00Z" },
        { targetSets: null, recordedAt: "2026-11-02T00:00:00Z" },
        { targetSets: null, recordedAt: "2026-11-03T00:00:00Z" },
      ]);
      expect(stub.queries[0]).toMatchObject({ table: "workout_day_exercise_scheme_history", op: "select" });
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["target_sets, recorded_at"] },
        { method: "eq", args: ["workout_day_id", "day-1"] },
        { method: "eq", args: ["exercise_id", "ex-1"] },
        { method: "order", args: ["recorded_at"] },
      ]);
    });

    test("getSchemeHistory returns [] for null data and throws on error", async () => {
      const { db, stub } = setup();
      stub.reply({ data: null }, { error: FAIL });
      expect(await db.getSchemeHistory("day-1", "ex-1")).toEqual([]);
      await expect(db.getSchemeHistory("day-1", "ex-1")).rejects.toBe(FAIL);
    });
  });

  describe("programs", () => {
    test("createProgram inserts the name and returns the program", async () => {
      const { db, stub } = setup();
      stub.reply({ data: { id: "prog-1", name: "Prep" } });
      expect(await db.createProgram("Prep")).toEqual({ id: "prog-1", name: "Prep" });
      expect(stub.queries[0]).toEqual({
        table: "programs",
        op: "insert",
        payload: { name: "Prep" },
        steps: [
          { method: "insert", args: [{ name: "Prep" }] },
          { method: "select", args: ["id, name"] },
          { method: "single", args: [] },
        ],
      });
    });

    test("createProgram throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.createProgram("Prep")).rejects.toBe(FAIL);
    });

    test("renameProgram updates name on the row with that id", async () => {
      const { db, stub } = setup();
      await db.renameProgram("prog-1", "Prep 2");
      expect(stub.queries[0]).toMatchObject({ table: "programs", op: "update", payload: { name: "Prep 2" } });
      expect(stub.filters(stub.queries[0])).toEqual([["eq", "id", "prog-1"]]);
    });

    test("renameProgram throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.renameProgram("prog-1", "x")).rejects.toBe(FAIL);
    });

    test("deleteProgram soft-deletes the program only, leaving its days' assignments alone", async () => {
      const { db, stub } = setup();
      await db.deleteProgram("prog-1");
      expect(stub.queries).toHaveLength(1);
      expect(stub.queries[0]).toMatchObject({ table: "programs", op: "update", payload: { deleted_at: NOW } });
      expect(stub.filters(stub.queries[0])).toEqual([["eq", "id", "prog-1"]]);
    });

    test("deleteProgram throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.deleteProgram("prog-1")).rejects.toBe(FAIL);
    });

    test("addDayToProgram assigns the day after the program's highest program_position", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [{ program_position: 2 }] });
      await db.addDayToProgram("day-1", "prog-1");
      expect(stub.queries[0]).toMatchObject({ table: "workout_days", op: "select" });
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["program_position"] },
        { method: "eq", args: ["program_id", "prog-1"] },
        { method: "order", args: ["program_position", { ascending: false }] },
        { method: "limit", args: [1] },
      ]);
      expect(stub.queries[1]).toMatchObject({
        table: "workout_days",
        op: "update",
        payload: { program_id: "prog-1", program_position: 3 },
      });
      expect(stub.filters(stub.queries[1])).toEqual([["eq", "id", "day-1"]]);
    });

    test("addDayToProgram starts an empty program at position 0", async () => {
      const { db, stub } = setup();
      await db.addDayToProgram("day-1", "prog-1");
      expect(stub.queries[1].payload).toEqual({ program_id: "prog-1", program_position: 0 });
    });

    test("addDayToProgram throws on a failed read (no update) and on a failed update", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.addDayToProgram("day-1", "prog-1")).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(1);
      stub.reply({ data: [] }, { error: FAIL });
      await expect(db.addDayToProgram("day-1", "prog-1")).rejects.toBe(FAIL);
      expect(stub.queries.map((q) => q.op)).toEqual(["select", "select", "update"]);
    });

    test("removeDayFromProgram clears program_id and program_position on that day", async () => {
      const { db, stub } = setup();
      await db.removeDayFromProgram("day-1");
      expect(stub.queries[0]).toMatchObject({
        table: "workout_days",
        op: "update",
        payload: { program_id: null, program_position: null },
      });
      expect(stub.filters(stub.queries[0])).toEqual([["eq", "id", "day-1"]]);
    });

    test("removeDayFromProgram throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.removeDayFromProgram("day-1")).rejects.toBe(FAIL);
    });

    test("reorderProgramDays parks every day at a negative position, then writes the final order", async () => {
      const { db, stub } = setup();
      await db.reorderProgramDays("prog-1", ["day-b", "day-a"]);
      expect(stub.queries.map((q) => [q.table, q.op, q.payload, ...stub.filters(q)])).toEqual([
        ["workout_days", "update", { program_position: -1 }, ["eq", "id", "day-b"], ["eq", "program_id", "prog-1"]],
        ["workout_days", "update", { program_position: -2 }, ["eq", "id", "day-a"], ["eq", "program_id", "prog-1"]],
        ["workout_days", "update", { program_position: 0 }, ["eq", "id", "day-b"], ["eq", "program_id", "prog-1"]],
        ["workout_days", "update", { program_position: 1 }, ["eq", "id", "day-a"], ["eq", "program_id", "prog-1"]],
      ]);
    });

    test("reorderProgramDays stops at the first failed parking write", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.reorderProgramDays("prog-1", ["day-b", "day-a"])).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(1);
    });

    test("reorderProgramDays throws on a failed final write", async () => {
      const { db, stub } = setup();
      stub.reply({}, {}, { error: FAIL });
      await expect(db.reorderProgramDays("prog-1", ["day-b", "day-a"])).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(3);
    });
  });

  describe("sessions", () => {
    const sessionRow = (id: string, day: string | null, date: string) => ({ id, workout_day_id: day, performed_on: date });
    const setRow = (exerciseId: string, n: number, weight: number | string, reps: number) => ({
      exercise_id: exerciseId,
      set_number: n,
      weight,
      reps,
    });

    test("startSession inserts the day and date and returns an empty session", async () => {
      const { db, stub } = setup();
      stub.reply({ data: sessionRow("s-1", "day-1", "2026-11-08") });
      expect(await db.startSession("day-1", "2026-11-08")).toEqual({
        id: "s-1", workoutDayId: "day-1", performedOn: "2026-11-08", exercises: [],
      });
      expect(stub.queries[0]).toEqual({
        table: "sessions",
        op: "insert",
        payload: { workout_day_id: "day-1", performed_on: "2026-11-08" },
        steps: [
          { method: "insert", args: [{ workout_day_id: "day-1", performed_on: "2026-11-08" }] },
          { method: "select", args: ["*"] },
          { method: "single", args: [] },
        ],
      });
    });

    test("startSession throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.startSession(null, "2026-11-08")).rejects.toBe(FAIL);
    });

    test("getSession groups sets by exercise and coerces numeric weight", async () => {
      const { db, stub } = setup();
      stub.reply(
        { data: sessionRow("s-1", "day-1", "2026-11-08") },
        { data: [setRow("ex-1", 1, "100.5", 5), setRow("ex-2", 1, 50, 10), setRow("ex-1", 2, 100, 4)] },
      );
      expect(await db.getSession("s-1")).toEqual({
        id: "s-1",
        workoutDayId: "day-1",
        performedOn: "2026-11-08",
        exercises: [
          { exerciseId: "ex-1", sets: [{ setNumber: 1, weight: 100.5, reps: 5 }, { setNumber: 2, weight: 100, reps: 4 }] },
          { exerciseId: "ex-2", sets: [{ setNumber: 1, weight: 50, reps: 10 }] },
        ],
      });
      expect(stub.queries.map((q) => [q.table, ...q.steps.map((s) => [s.method, ...s.args])])).toEqual([
        ["sessions", ["select", "*"], ["eq", "id", "s-1"], ["maybeSingle"]],
        ["session_sets", ["select", "*"], ["eq", "session_id", "s-1"], ["order", "set_number"]],
      ]);
    });

    test("getSession returns null for an unknown id without reading sets", async () => {
      const { db, stub } = setup();
      expect(await db.getSession("nope")).toBeNull();
      expect(stub.queries).toHaveLength(1);
    });

    test("getSession of a session with no sets has no exercises", async () => {
      const { db, stub } = setup();
      stub.reply({ data: sessionRow("s-1", null, "2026-11-08") });
      expect(await db.getSession("s-1")).toEqual({ id: "s-1", workoutDayId: null, performedOn: "2026-11-08", exercises: [] });
    });

    test("getLastSetsForExercise walks earlier sessions newest first to the first with sets", async () => {
      const { db, stub } = setup();
      stub.reply(
        { data: [{ id: "s-3", performed_on: "2026-11-05" }, { id: "s-2", performed_on: "2026-11-03" }, { id: "s-1", performed_on: "2026-11-01" }] },
        { data: [] },
        { data: [setRow("ex-1", 1, "80", 8)] },
      );
      expect(await db.getLastSetsForExercise("ex-1", "2026-11-08")).toEqual([{ setNumber: 1, weight: 80, reps: 8 }]);
      expect(stub.queries).toHaveLength(3);
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["id, performed_on"] },
        { method: "lt", args: ["performed_on", "2026-11-08"] },
        { method: "order", args: ["performed_on", { ascending: false }] },
        { method: "order", args: ["created_at", { ascending: false }] },
      ]);
      expect(stub.filters(stub.queries[2])).toEqual([
        ["eq", "session_id", "s-2"],
        ["eq", "exercise_id", "ex-1"],
      ]);
    });

    test("getLastSetsForExercise returns [] when no earlier session has sets", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [{ id: "s-1", performed_on: "2026-11-01" }] }, { data: null });
      expect(await db.getLastSetsForExercise("ex-1", "2026-11-08")).toEqual([]);
      expect(await db.getLastSetsForExercise("ex-1", "2026-11-08")).toEqual([]);
    });

    test("getLastSessionForDay returns the newest session of that day that has sets", async () => {
      const { db, stub } = setup();
      stub.reply(
        { data: [{ id: "s-2" }, { id: "s-1" }] },
        { data: sessionRow("s-2", "day-1", "2026-11-05") },
        { data: [] },
        { data: sessionRow("s-1", "day-1", "2026-11-01") },
        { data: [setRow("ex-1", 1, 60, 10)] },
      );
      expect(await db.getLastSessionForDay("day-1")).toEqual({
        id: "s-1", workoutDayId: "day-1", performedOn: "2026-11-01",
        exercises: [{ exerciseId: "ex-1", sets: [{ setNumber: 1, weight: 60, reps: 10 }] }],
      });
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["id"] },
        { method: "eq", args: ["workout_day_id", "day-1"] },
        { method: "order", args: ["performed_on", { ascending: false }] },
        { method: "order", args: ["created_at", { ascending: false }] },
      ]);
    });

    test("getLastSessionForDay returns null when the day has no logged session", async () => {
      const { db } = setup();
      expect(await db.getLastSessionForDay("day-1")).toBeNull();
    });

    test("getSessionForDayAndDate loads the latest session for that day and date", async () => {
      const { db, stub } = setup();
      stub.reply({ data: { id: "s-1" } }, { data: sessionRow("s-1", "day-1", "2026-11-08") }, { data: [] });
      expect(await db.getSessionForDayAndDate("day-1", "2026-11-08")).toEqual({
        id: "s-1", workoutDayId: "day-1", performedOn: "2026-11-08", exercises: [],
      });
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["id"] },
        { method: "eq", args: ["workout_day_id", "day-1"] },
        { method: "eq", args: ["performed_on", "2026-11-08"] },
        { method: "order", args: ["created_at", { ascending: false }] },
        { method: "limit", args: [1] },
        { method: "maybeSingle", args: [] },
      ]);
    });

    test("getSessionForDayAndDate returns null when there is none", async () => {
      const { db, stub } = setup();
      expect(await db.getSessionForDayAndDate("day-1", "2026-11-08")).toBeNull();
      expect(stub.queries).toHaveLength(1);
    });

    test("logExercise replaces the (session, exercise) sets via delete then insert", async () => {
      const { db, stub } = setup();
      await db.logExercise("s-1", "ex-1", [
        { setNumber: 1, weight: 100, reps: 5 },
        { setNumber: 2, weight: 105, reps: 4 },
      ]);
      expect(stub.queries[0]).toMatchObject({ table: "session_sets", op: "delete" });
      expect(stub.filters(stub.queries[0])).toEqual([
        ["eq", "session_id", "s-1"],
        ["eq", "exercise_id", "ex-1"],
      ]);
      expect(stub.queries[1]).toMatchObject({
        table: "session_sets",
        op: "insert",
        payload: [
          { session_id: "s-1", exercise_id: "ex-1", set_number: 1, weight: 100, reps: 5 },
          { session_id: "s-1", exercise_id: "ex-1", set_number: 2, weight: 105, reps: 4 },
        ],
      });
    });

    test("logExercise with no sets only clears", async () => {
      const { db, stub } = setup();
      await db.logExercise("s-1", "ex-1", []);
      expect(stub.queries.map((q) => q.op)).toEqual(["delete"]);
    });

    test("logExercise throws on a failed delete (no insert) and on a failed insert", async () => {
      const { db, stub } = setup();
      const sets = [{ setNumber: 1, weight: 100, reps: 5 }];
      stub.reply({ error: FAIL });
      await expect(db.logExercise("s-1", "ex-1", sets)).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(1);
      stub.reply({}, { error: FAIL });
      await expect(db.logExercise("s-1", "ex-1", sets)).rejects.toBe(FAIL);
      expect(stub.queries.map((q) => q.op)).toEqual(["delete", "delete", "insert"]);
    });

    test("getExerciseHistory loads each distinct session once, newest first", async () => {
      const { db, stub } = setup();
      stub.reply(
        { data: [{ session_id: "s-1" }, { session_id: "s-1" }, { session_id: "s-2" }, { session_id: "s-gone" }] },
        { data: sessionRow("s-1", "day-1", "2026-11-01") },
        { data: [setRow("ex-1", 1, 50, 10)] },
        { data: sessionRow("s-2", "day-1", "2026-11-05") },
        { data: [setRow("ex-1", 1, 55, 10)] },
        { data: null },
      );
      const history = await db.getExerciseHistory("ex-1");
      expect(history.map((s) => [s.id, s.performedOn])).toEqual([
        ["s-2", "2026-11-05"],
        ["s-1", "2026-11-01"],
      ]);
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["session_id"] },
        { method: "eq", args: ["exercise_id", "ex-1"] },
      ]);
      expect(stub.queries.filter((q) => q.table === "sessions").map((q) => stub.filters(q))).toEqual([
        [["eq", "id", "s-1"]],
        [["eq", "id", "s-2"]],
        [["eq", "id", "s-gone"]],
      ]);
    });

    test("getExerciseHistory returns [] for an exercise never logged", async () => {
      const { db } = setup();
      expect(await db.getExerciseHistory("ex-1")).toEqual([]);
    });

    test("listSessions loads every session in the read order", async () => {
      const { db, stub } = setup();
      stub.reply(
        { data: [{ id: "s-2" }, { id: "s-gone" }, { id: "s-1" }] },
        { data: sessionRow("s-2", null, "2026-11-05") },
        {},
        { data: null },
        { data: sessionRow("s-1", "day-1", "2026-11-01") },
        {},
      );
      expect((await db.listSessions()).map((s) => s.id)).toEqual(["s-2", "s-1"]);
      expect(stub.queries[0].steps).toEqual([
        { method: "select", args: ["id"] },
        { method: "order", args: ["performed_on", { ascending: false }] },
        { method: "order", args: ["created_at", { ascending: false }] },
      ]);
    });

    test("listSessions returns [] when there are none", async () => {
      const { db } = setup();
      expect(await db.listSessions()).toEqual([]);
    });

    test("deleteSession hard-deletes the session row by id", async () => {
      const { db, stub } = setup();
      await db.deleteSession("s-1");
      expect(stub.queries).toEqual([
        { table: "sessions", op: "delete", steps: [{ method: "delete", args: [] }, { method: "eq", args: ["id", "s-1"] }] },
      ]);
    });

    test("deleteSession throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ error: FAIL });
      await expect(db.deleteSession("s-1")).rejects.toBe(FAIL);
    });
  });
});

// ---------------------------------------------------------------------------
// Ride analytics (AI-631): table, columns, filters, onConflict and user_id
// stamping for every new function, through the DataLayer where it is wired
// and directly for the service-role userId variants.
// ---------------------------------------------------------------------------

const USER = "user-1";

const activityRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  source: "garmin",
  source_id: `g-${id}`,
  started_at: "2026-11-01T14:00:00+00:00",
  timezone: "Etc/GMT+5",
  sport: "cycling",
  sub_type: "road_biking",
  environment: "outdoor",
  title: "Morning ride",
  elapsed_s: 3600,
  moving_s: 3500,
  distance_m: 30000,
  elevation_gain_m: 250,
  avg_speed_mps: 8.5,
  max_speed_mps: 15,
  avg_power_w: 200,
  max_power_w: 600,
  normalized_power_w: 215,
  intensity_factor: 0.86,
  tss: 74,
  work_kj: 720,
  calories: 750,
  avg_hr_bpm: null,
  max_hr_bpm: null,
  avg_cadence_rpm: 88,
  biggest_climb_m: 80,
  tss_source: "power",
  ftp_used_w: 250,
  ftp_source: "manual",
  has_power: true,
  has_hr: false,
  power_curve: { "60": 320 },
  best_efforts: null,
  paired_activity_id: null,
  synced_at: NOW,
  ...over,
});

const activity = (id: string) => ({
  id,
  source: "garmin",
  sourceId: `g-${id}`,
  startedAt: "2026-11-01T14:00:00+00:00",
  timezone: "Etc/GMT+5",
  sport: "cycling",
  subType: "road_biking",
  environment: "outdoor",
  title: "Morning ride",
  elapsedS: 3600,
  movingS: 3500,
  distanceM: 30000,
  elevationGainM: 250,
  avgSpeedMps: 8.5,
  maxSpeedMps: 15,
  avgPowerW: 200,
  maxPowerW: 600,
  normalizedPowerW: 215,
  intensityFactor: 0.86,
  tss: 74,
  workKj: 720,
  calories: 750,
  avgHrBpm: null,
  maxHrBpm: null,
  avgCadenceRpm: 88,
  biggestClimbM: 80,
  tssSource: "power",
  ftpUsedW: 250,
  ftpSource: "manual",
  hasPower: true,
  hasHr: false,
  powerCurve: { "60": 320 },
  bestEfforts: null,
  pairedActivityId: null,
  syncedAt: NOW,
});

const NULL_METRICS = {
  timezone: null, sub_type: null, title: null, elapsed_s: null, moving_s: null, distance_m: null,
  elevation_gain_m: null, avg_speed_mps: null, max_speed_mps: null, avg_power_w: null, max_power_w: null,
  normalized_power_w: null, intensity_factor: null, tss: null, work_kj: null, calories: null, avg_hr_bpm: null,
  max_hr_bpm: null, avg_cadence_rpm: null, biggest_climb_m: null, tss_source: null, ftp_used_w: null,
  ftp_source: null, power_curve: null, best_efforts: null, paired_activity_id: null,
};

describe("Supabase DataLayer contract: ride analytics", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    clientHolder.client = null;
  });

  describe("external_activities", () => {
    test("the read column list never includes provider_payload", () => {
      expect(EXTERNAL_ACTIVITY_COLUMNS).not.toContain("provider_payload");
      expect(EXTERNAL_ACTIVITY_COLUMNS.split(", ")).toEqual(Object.keys(activityRow("x")));
    });

    test("listExternalActivities with no filter: newest first, mapped", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [activityRow("a-1")] });
      expect(await db.listExternalActivities({})).toEqual([activity("a-1")]);
      expect(stub.queries).toEqual([
        {
          table: "external_activities",
          op: "select",
          steps: [
            { method: "select", args: [EXTERNAL_ACTIVITY_COLUMNS] },
            { method: "order", args: ["started_at", { ascending: false }] },
            { method: "order", args: ["id"] },
            { method: "range", args: [0, 999] },
          ],
        },
        {
          table: "external_activities",
          op: "select",
          steps: [
            { method: "select", args: [EXTERNAL_ACTIVITY_COLUMNS] },
            { method: "order", args: ["started_at", { ascending: false }] },
            { method: "order", args: ["id"] },
            { method: "range", args: [1, 1000] },
          ],
        },
      ]);
    });

    test("listExternalActivities applies every filter and the limit", async () => {
      const { db, stub } = setup();
      await db.listExternalActivities({
        from: "2026-10-01T00:00:00Z",
        to: "2026-11-01T00:00:00Z",
        source: "peloton",
        environment: "indoor",
        limit: 20,
      });
      const [q] = stub.queries;
      expect(stub.filters(q)).toEqual([
        ["gte", "started_at", "2026-10-01T00:00:00Z"],
        ["lte", "started_at", "2026-11-01T00:00:00Z"],
        ["eq", "source", "peloton"],
        ["eq", "environment", "indoor"],
      ]);
      expect(q.steps.slice(-3)).toEqual([
        { method: "order", args: ["started_at", { ascending: false }] },
        { method: "order", args: ["id"] },
        { method: "range", args: [0, 19] },
      ]);
    });

    const page = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => activityRow(`a-${offset + i}`));
    const ranges = (stub: SupabaseStub) => stub.queries.map((q) => q.steps.filter((s) => s.method === "range").map((s) => s.args));

    test("listExternalActivities pages past the 1000-row cap: a full page asks for the next, with the same filters and order, until an empty page", async () => {
      const { db, stub } = setup();
      stub.reply({ data: page(1000) }, { data: page(3, 1000) }, { data: [] });
      const out = await db.listExternalActivities({ source: "garmin" });
      expect(out).toHaveLength(1003);
      expect(out[1000]).toEqual(activity("a-1000"));
      expect(ranges(stub)).toEqual([[[0, 999]], [[1000, 1999]], [[1003, 2002]]]);
      expect(stub.queries[1].steps.slice(0, -1)).toEqual(stub.queries[0].steps.slice(0, -1));
      expect(stub.filters(stub.queries[1])).toEqual([["eq", "source", "garmin"]]);
    });

    test("listExternalActivities stops at an empty page, not a short one", async () => {
      const { db, stub } = setup();
      stub.reply({ data: page(999) }, { data: [] });
      expect(await db.listExternalActivities({})).toHaveLength(999);
      expect(ranges(stub)).toEqual([[[0, 999]], [[999, 1998]]]);
    });

    test("listExternalActivities reads everything when the server's max-rows is below PAGE_SIZE", async () => {
      const { db, stub } = setup();
      stub.reply({ data: page(500) }, { data: page(500, 500) }, { data: page(200, 1000) }, { data: [] });
      const out = await db.listExternalActivities({});
      expect(out).toHaveLength(1200);
      expect(out.map((a) => a.id)).toEqual(page(1200).map((r) => r.id));
      expect(ranges(stub)).toEqual([[[0, 999]], [[500, 1499]], [[1000, 1999]], [[1200, 2199]]]);
    });

    describe("limit contract", () => {
      // Queues the pages a server holding `available` rows returns for a read capped at `limit`.
      const serve = (stub: SupabaseStub, available: number, limit: number) => {
        let from = 0;
        while (from < limit) {
          const n = Math.max(0, Math.min(1000, limit - from, available - from));
          stub.reply({ data: page(n, from) });
          if (n === 0) break;
          from += n;
        }
      };
      test.each([
        [0, 0, []],
        [1, 1, [[0, 0]]],
        [50, 50, [[0, 49]]],
        [1000, 1000, [[0, 999]]],
        [1001, 1001, [[0, 999], [1000, 1000]]],
        [2500, 2500, [[0, 999], [1000, 1999], [2000, 2499]]],
      ])("limit %i returns %i rows with ranges %j", async (limit, expected, expectedRanges) => {
        const { db, stub } = setup();
        serve(stub, 3000, limit);
        const out = await db.listExternalActivities({ limit });
        expect(out).toHaveLength(expected);
        expect(out.map((a) => a.id)).toEqual(page(expected).map((r) => r.id));
        expect(ranges(stub)).toEqual(expectedRanges.map((r) => [r]));
      });

      test("a limit above the rows available stops at the empty page", async () => {
        const { db, stub } = setup();
        serve(stub, 1001, 2500);
        expect(await db.listExternalActivities({ limit: 2500 })).toHaveLength(1001);
        expect(ranges(stub)).toEqual([[[0, 999]], [[1000, 1999]], [[1001, 2000]]]);
      });

      test("an over-long page is trimmed to the limit", async () => {
        const { db, stub } = setup();
        stub.reply({ data: page(80) });
        expect(await db.listExternalActivities({ limit: 50 })).toHaveLength(50);
        expect(stub.queries).toHaveLength(1);
      });

      test.each([-1, 1.5, NaN, Infinity])("limit %s throws a RangeError without a query", async (limit) => {
        const { db, stub } = setup();
        await expect(db.listExternalActivities({ limit })).rejects.toThrow(new RangeError("limit must be a non-negative integer"));
        expect(stub.queries).toHaveLength(0);
      });
    });

    test("listExternalActivities with a limit asks for exactly that many rows and stops", async () => {
      const { db, stub } = setup();
      stub.reply({ data: page(50) });
      expect(await db.listExternalActivities({ limit: 50 })).toHaveLength(50);
      expect(ranges(stub)).toEqual([[[0, 49]]]);
      expect(stub.queries[0].steps.some((s) => s.method === "limit")).toBe(false);
    });

    test("listExternalActivities with a limit above the cap pages up to it and no further", async () => {
      const { db, stub } = setup();
      stub.reply({ data: page(1000) }, { data: page(200, 1000) }, { data: page(5, 1200) });
      expect(await db.listExternalActivities({ limit: 1200 })).toHaveLength(1200);
      expect(ranges(stub)).toEqual([[[0, 999]], [[1000, 1199]]]);
    });

    test("listExternalActivities with limit 0 issues no query", async () => {
      const { db, stub } = setup();
      expect(await db.listExternalActivities({ limit: 0 })).toEqual([]);
      expect(stub.queries).toHaveLength(0);
    });

    test("listExternalActivities throws an error from a later page", async () => {
      const { db, stub } = setup();
      stub.reply({ data: page(1000) }, { error: FAIL });
      await expect(db.listExternalActivities({})).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(2);
    });

    test("listExternalActivities maps numeric strings and throws the Supabase error", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [activityRow("a-1", { tss: "74", has_power: null })] }, { data: [] }, { error: FAIL });
      const [a] = await db.listExternalActivities({});
      expect(a.tss).toBe(74);
      expect(a.hasPower).toBe(false);
      await expect(db.listExternalActivities({})).rejects.toBe(FAIL);
    });

    test("getExternalActivity selects one row by id, null when missing", async () => {
      const { db, stub } = setup();
      stub.reply({ data: activityRow("a-1") }, {}, { error: FAIL });
      expect(await db.getExternalActivity("a-1")).toEqual(activity("a-1"));
      expect(await db.getExternalActivity("nope")).toBeNull();
      await expect(db.getExternalActivity("a-1")).rejects.toBe(FAIL);
      expect(stub.queries[0]).toEqual({
        table: "external_activities",
        op: "select",
        steps: [
          { method: "select", args: [EXTERNAL_ACTIVITY_COLUMNS] },
          { method: "eq", args: ["id", "a-1"] },
          { method: "maybeSingle", args: [] },
        ],
      });
    });

    test("upsertExternalActivities sends every column on (user_id,source,source_id) and returns the rows", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [activityRow("a-1")] });
      const out = await db.upsertExternalActivities([
        {
          source: "garmin",
          sourceId: "g-a-1",
          startedAt: "2026-11-01T14:00:00Z",
          sport: "cycling",
          environment: "outdoor",
          tss: 74,
          hasPower: true,
          providerPayload: { trainingStressScore: 80 },
        },
      ]);
      expect(out).toEqual([activity("a-1")]);
      const [q] = stub.queries;
      expect(q.table).toBe("external_activities");
      expect(q.op).toBe("upsert");
      expect(q.steps).toEqual([
        {
          method: "upsert",
          args: [
            [
              {
                ...NULL_METRICS,
                source: "garmin",
                source_id: "g-a-1",
                started_at: "2026-11-01T14:00:00Z",
                sport: "cycling",
                environment: "outdoor",
                tss: 74,
                has_power: true,
                has_hr: false,
                provider_payload: { trainingStressScore: 80 },
                synced_at: NOW,
                updated_at: NOW,
              },
            ],
            { onConflict: "user_id,source,source_id" },
          ],
        },
        { method: "select", args: [EXTERNAL_ACTIVITY_COLUMNS] },
      ]);
      // The DataLayer leaves user_id to the column default (auth.uid()).
      expect((q.payload as Record<string, unknown>[])[0]).not.toHaveProperty("user_id");
    });

    test("upsertExternalActivities with a userId stamps it on every row; [] issues no query; errors throw", async () => {
      const stub = createSupabaseStub();
      const input = { source: "peloton" as const, sport: "cycling", environment: "indoor" as const, providerPayload: {} };
      await upsertExternalActivities(
        stub.client,
        [
          { ...input, sourceId: "p-1", startedAt: "2026-11-01T00:00:00Z" },
          { ...input, sourceId: "p-2", startedAt: "2026-11-02T00:00:00Z" },
        ],
        USER,
      );
      expect((stub.queries[0].payload as Record<string, unknown>[]).map((r) => r.user_id)).toEqual([USER, USER]);
      expect(await upsertExternalActivities(stub.client, [], USER)).toEqual([]);
      expect(stub.queries).toHaveLength(1);
      stub.reply({ error: FAIL });
      await expect(upsertExternalActivities(stub.client, [{ ...input, sourceId: "p-3", startedAt: NOW }])).rejects.toBe(FAIL);
    });

    test("upsertExternalActivities refuses a row without providerPayload before any query", async () => {
      const stub = createSupabaseStub();
      const ok = { source: "garmin" as const, sport: "cycling", environment: "outdoor" as const, startedAt: NOW, providerPayload: {} };
      for (const bad of [undefined, null]) {
        await expect(
          upsertExternalActivities(stub.client, [
            { ...ok, sourceId: "g-1" },
            { ...ok, sourceId: "g-2", providerPayload: bad },
          ]),
        ).rejects.toThrow("external activity garmin/g-2 has no providerPayload");
      }
      expect(stub.queries).toHaveLength(0);
    });
  });

  test("bulk upserts collapse rows sharing a conflict key to the last one; ftp_used_w is rounded", async () => {
    const stub = createSupabaseStub();
    const ride = { source: "garmin" as const, sport: "cycling", environment: "outdoor" as const, providerPayload: {}, startedAt: NOW };
    await upsertExternalActivities(stub.client, [
      { ...ride, sourceId: "1", title: "old", ftpUsedW: 251.6 },
      { ...ride, sourceId: "2" },
      { ...ride, source: "peloton", sourceId: "1" },
      { ...ride, sourceId: "1", title: "new", ftpUsedW: 251.6 },
    ]);
    const acts = stub.queries[0].payload as Record<string, unknown>[];
    expect(acts.map((r) => [r.source, r.source_id, r.title, r.ftp_used_w])).toEqual([
      ["garmin", "1", "new", 252],
      ["garmin", "2", null, null],
      ["peloton", "1", null, null],
    ]);

    await replaceActivityStreams(stub.client, "a-1", [{ channel: "power", values: [1] }, { channel: "power", values: [2] }]);
    // queries[1] is the delete of dropped channels; [2] the upsert.
    expect((stub.queries[2].payload as Record<string, unknown>[]).map((r) => r.values)).toEqual([[2]]);

    const w = { source: "garmin" as const, sourceId: "9", measuredAt: NOW, providerPayload: {} };
    await upsertBodyWeights(stub.client, [{ ...w, weightKg: 80 }, { ...w, weightKg: 81 }]);
    expect((stub.queries[3].payload as Record<string, unknown>[]).map((r) => r.weight_kg)).toEqual([81]);

    const d = { date: "2026-11-01", tssBySource: {}, ctl: 1, atl: 1, tsb: 0 };
    await upsertDailyTrainingLoad(stub.client, [{ ...d, tssTotal: 1 }, { ...d, date: "2026-11-02", tssTotal: 5 }, { ...d, tssTotal: 2 }]);
    expect((stub.queries[4].payload as Record<string, unknown>[]).map((r) => [r.date, r.tss_total])).toEqual([["2026-11-01", 2], ["2026-11-02", 5]]);
  });

  describe("activity_streams", () => {
    test("getActivityStreams reads one activity's channels ordered by channel", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [{ activity_id: "a-1", channel: "power", start_offset_s: 0, values: [100, null, 120] }] }, { error: FAIL });
      expect(await db.getActivityStreams("a-1")).toEqual([
        { activityId: "a-1", channel: "power", startOffsetS: 0, values: [100, null, 120] },
      ]);
      expect(stub.queries[0]).toEqual({
        table: "activity_streams",
        op: "select",
        steps: [
          { method: "select", args: ["activity_id, channel, start_offset_s, values"] },
          { method: "eq", args: ["activity_id", "a-1"] },
          { method: "order", args: ["channel"] },
        ],
      });
      await expect(db.getActivityStreams("a-1")).rejects.toBe(FAIL);
    });

    test("replaceActivityStreams upserts on (activity_id,channel), defaulting start_offset_s to 0", async () => {
      const { db, stub } = setup();
      await db.replaceActivityStreams("a-1", [
        { channel: "power", values: [1, 2] },
        { channel: "heart_rate", startOffsetS: 3, values: [null, 140] },
      ]);
      expect(stub.queries).toEqual([
        {
          table: "activity_streams",
          op: "delete",
          steps: [
            { method: "delete", args: [] },
            { method: "eq", args: ["activity_id", "a-1"] },
            { method: "not", args: ["channel", "in", "(power,heart_rate)"] },
          ],
        },
        {
          table: "activity_streams",
          op: "upsert",
          payload: [
            { activity_id: "a-1", channel: "power", start_offset_s: 0, values: [1, 2], updated_at: NOW },
            { activity_id: "a-1", channel: "heart_rate", start_offset_s: 3, values: [null, 140], updated_at: NOW },
          ],
          steps: [expect.objectContaining({ method: "upsert", args: [expect.any(Array), { onConflict: "activity_id,channel" }] })],
        },
      ]);
    });

    test("replaceActivityStreams stamps a userId, deletes every channel for an empty list and throws errors", async () => {
      const stub = createSupabaseStub();
      await replaceActivityStreams(stub.client, "a-1", [{ channel: "cadence", values: [90] }], USER);
      expect(stub.filters(stub.queries[0])).toEqual([["eq", "activity_id", "a-1"], ["not", "channel", "in", "(cadence)"]]);
      expect((stub.queries[1].payload as Record<string, unknown>[])[0].user_id).toBe(USER);
      // Empty set: one unfiltered-by-channel delete, no upsert.
      await replaceActivityStreams(stub.client, "a-1", []);
      expect(stub.queries).toHaveLength(3);
      expect(stub.queries[2].op).toBe("delete");
      expect(stub.filters(stub.queries[2])).toEqual([["eq", "activity_id", "a-1"]]);
      // A failed delete stops before the upsert; a failed upsert throws too.
      stub.reply({ error: FAIL });
      await expect(replaceActivityStreams(stub.client, "a-1", [{ channel: "speed", values: [] }])).rejects.toBe(FAIL);
      expect(stub.queries).toHaveLength(4);
      stub.reply({}, { error: FAIL });
      await expect(replaceActivityStreams(stub.client, "a-1", [{ channel: "speed", values: [] }])).rejects.toBe(FAIL);
      expect(stub.queries.slice(4).map((q) => q.op)).toEqual(["delete", "upsert"]);
    });
  });

  describe("body_weights", () => {
    const weightRow = {
      id: "bw-1", source: "garmin", source_id: "123", measured_at: "2026-11-01T12:00:00+00:00", weight_kg: 80.5,
      bmi: 24.1, body_fat_pct: null, body_water_pct: null, muscle_mass_kg: 35.2, bone_mass_kg: null,
    };

    test("listBodyWeights filters measured_at inclusively, oldest first", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [weightRow] }, { data: [] }, { error: FAIL });
      expect(await db.listBodyWeights("2026-11-01T00:00:00Z", "2026-11-30T23:59:59Z")).toEqual([
        {
          id: "bw-1", source: "garmin", sourceId: "123", measuredAt: "2026-11-01T12:00:00+00:00", weightKg: 80.5,
          bmi: 24.1, bodyFatPct: null, bodyWaterPct: null, muscleMassKg: 35.2, boneMassKg: null,
        },
      ]);
      const [q] = stub.queries;
      expect(q.table).toBe("body_weights");
      expect(q.steps[0]).toEqual({
        method: "select",
        args: ["id, source, source_id, measured_at, weight_kg, bmi, body_fat_pct, body_water_pct, muscle_mass_kg, bone_mass_kg"],
      });
      expect(stub.filters(q)).toEqual([
        ["gte", "measured_at", "2026-11-01T00:00:00Z"],
        ["lte", "measured_at", "2026-11-30T23:59:59Z"],
      ]);
      expect(q.steps.slice(-3)).toEqual([
        { method: "order", args: ["measured_at"] },
        { method: "order", args: ["id"] },
        { method: "range", args: [0, 999] },
      ]);
      await expect(db.listBodyWeights("a", "b")).rejects.toBe(FAIL);
    });

    test("listBodyWeights pages past the 1000-row cap", async () => {
      const { db, stub } = setup();
      stub.reply({ data: Array.from({ length: 1000 }, (_, i) => ({ ...weightRow, id: `bw-${i}` })) }, { data: [weightRow] }, { data: [] });
      expect(await db.listBodyWeights("a", "b")).toHaveLength(1001);
      expect(stub.queries.map((q) => q.steps[q.steps.length - 1])).toEqual([
        { method: "range", args: [0, 999] },
        { method: "range", args: [1000, 1999] },
        { method: "range", args: [1001, 2000] },
      ]);
      expect(stub.filters(stub.queries[1])).toEqual([
        ["gte", "measured_at", "a"],
        ["lte", "measured_at", "b"],
      ]);
    });

    test("upsertBodyWeights upserts on (user_id,source,source_id) with the payload; userId stamped when given", async () => {
      const { db, stub } = setup();
      const input = { source: "garmin" as const, sourceId: "123", measuredAt: "2026-11-01T12:00:00Z", weightKg: 80.5, providerPayload: { weight: 80500 } };
      await db.upsertBodyWeights([input]);
      expect(stub.queries[0]).toMatchObject({
        table: "body_weights",
        op: "upsert",
        steps: [
          {
            method: "upsert",
            args: [
              [
                {
                  source: "garmin", source_id: "123", measured_at: "2026-11-01T12:00:00Z", weight_kg: 80.5, bmi: null,
                  body_fat_pct: null, body_water_pct: null, muscle_mass_kg: null, bone_mass_kg: null,
                  provider_payload: { weight: 80500 }, updated_at: NOW,
                },
              ],
              { onConflict: "user_id,source,source_id" },
            ],
          },
        ],
      });
      expect((stub.queries[0].payload as Record<string, unknown>[])[0]).not.toHaveProperty("user_id");

      const direct = createSupabaseStub();
      await upsertBodyWeights(direct.client, [input, { ...input, sourceId: "124" }], USER);
      expect((direct.queries[0].payload as Record<string, unknown>[]).map((r) => r.user_id)).toEqual([USER, USER]);
      await upsertBodyWeights(direct.client, [], USER);
      expect(direct.queries).toHaveLength(1);
      direct.reply({ error: FAIL });
      await expect(upsertBodyWeights(direct.client, [input])).rejects.toBe(FAIL);
    });
  });

  describe("athlete_settings", () => {
    const COLUMNS = "manual_ftp_w, lthr_bpm, max_hr_bpm, resting_hr_bpm, strength_session_tss, no_power_tss_per_hour, units, week_start";
    const settingsRow = {
      manual_ftp_w: 250, lthr_bpm: null, max_hr_bpm: 185, resting_hr_bpm: null,
      strength_session_tss: "40", no_power_tss_per_hour: 55, units: "metric", week_start: "sunday",
    };
    const settings = {
      manualFtpW: 250, lthrBpm: null, maxHrBpm: 185, restingHrBpm: null,
      strengthSessionTss: 40, noPowerTssPerHour: 55, units: "metric", weekStart: "sunday",
    };

    test("getAthleteSettings maps the row, or the column defaults when there is none", async () => {
      const { db, stub } = setup();
      stub.reply({ data: settingsRow }, {}, { error: FAIL });
      expect(await db.getAthleteSettings()).toEqual(settings);
      expect(await db.getAthleteSettings()).toEqual({
        manualFtpW: null, lthrBpm: null, maxHrBpm: null, restingHrBpm: null,
        strengthSessionTss: 50, noPowerTssPerHour: 55, units: "imperial", weekStart: "monday",
      });
      await expect(db.getAthleteSettings()).rejects.toBe(FAIL);
      expect(stub.queries[0]).toEqual({
        table: "athlete_settings",
        op: "select",
        steps: [{ method: "select", args: [COLUMNS] }, { method: "maybeSingle", args: [] }],
      });
    });

    test("saveAthleteSettings upserts only the defined fields on user_id and returns the row", async () => {
      const { db, stub } = setup();
      stub.reply({ data: settingsRow });
      expect(await db.saveAthleteSettings({ manualFtpW: 250, units: "metric", lthrBpm: undefined, restingHrBpm: null })).toEqual(settings);
      expect(stub.queries).toEqual([
        {
          table: "athlete_settings",
          op: "upsert",
          payload: { manual_ftp_w: 250, resting_hr_bpm: null, units: "metric", updated_at: NOW },
          steps: [
            {
              method: "upsert",
              args: [{ manual_ftp_w: 250, resting_hr_bpm: null, units: "metric", updated_at: NOW }, { onConflict: "user_id" }],
            },
            { method: "select", args: [COLUMNS] },
            { method: "single", args: [] },
          ],
        },
      ]);
    });

    test("saveAthleteSettings with an empty patch only reads; errors throw", async () => {
      const { db, stub } = setup();
      await db.saveAthleteSettings({ units: undefined });
      expect(stub.queries.map((q) => q.op)).toEqual(["select"]);
      stub.reply({ error: FAIL });
      await expect(db.saveAthleteSettings({ units: "metric" })).rejects.toBe(FAIL);
    });
  });

  describe("ftp_history", () => {
    const COLUMNS = "id, effective_from, ftp_w, source, source_ref";
    const row = { id: "f-1", effective_from: "2026-10-01T00:00:00+00:00", ftp_w: 250, source: "peloton_test", source_ref: "w-9" };
    const entry = { id: "f-1", effectiveFrom: "2026-10-01T00:00:00+00:00", ftpW: 250, source: "peloton_test", sourceRef: "w-9" };

    test("listFtpHistory reads oldest first", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [row] }, { data: [] }, { error: FAIL });
      expect(await db.listFtpHistory()).toEqual([entry]);
      expect(stub.queries[0]).toEqual({
        table: "ftp_history",
        op: "select",
        steps: [
          { method: "select", args: [COLUMNS] },
          { method: "order", args: ["effective_from"] },
          { method: "order", args: ["created_at"] },
          { method: "order", args: ["id"] },
          { method: "range", args: [0, 999] },
        ],
      });
      await expect(db.listFtpHistory()).rejects.toBe(FAIL);
    });

    test("listFtpHistory pages past the 1000-row cap", async () => {
      const { db, stub } = setup();
      stub.reply({ data: Array.from({ length: 1000 }, (_, i) => ({ ...row, id: `f-${i}` })) }, { data: [] });
      expect(await db.listFtpHistory()).toHaveLength(1000);
      expect(stub.queries.map((q) => q.steps[q.steps.length - 1])).toEqual([
        { method: "range", args: [0, 999] },
        { method: "range", args: [1000, 1999] },
      ]);
    });

    test("addFtpHistoryEntry inserts one row and returns it; a userId is stamped; a unique violation throws", async () => {
      const { db, stub } = setup();
      stub.reply({ data: row });
      expect(await db.addFtpHistoryEntry({ effectiveFrom: "2026-10-01T00:00:00Z", ftpW: 250, source: "peloton_test", sourceRef: "w-9" })).toEqual(entry);
      expect(stub.queries[0]).toEqual({
        table: "ftp_history",
        op: "insert",
        payload: { effective_from: "2026-10-01T00:00:00Z", ftp_w: 250, source: "peloton_test", source_ref: "w-9" },
        steps: [
          { method: "insert", args: [{ effective_from: "2026-10-01T00:00:00Z", ftp_w: 250, source: "peloton_test", source_ref: "w-9" }] },
          { method: "select", args: [COLUMNS] },
          { method: "single", args: [] },
        ],
      });

      const direct = createSupabaseStub();
      direct.reply({ data: row }, { error: { code: "23505", message: "duplicate key" } });
      await addFtpHistoryEntry(direct.client, { effectiveFrom: "x", ftpW: 1, source: "manual", sourceRef: null }, USER);
      expect(direct.queries[0].payload).toMatchObject({ user_id: USER, source_ref: null });
      await expect(addFtpHistoryEntry(direct.client, { effectiveFrom: "x", ftpW: 1, source: "manual", sourceRef: null })).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("daily_training_load", () => {
    const day = { date: "2026-11-01", tssTotal: 120, tssBySource: { garmin: 70, strength: 50 }, ctl: 60, atl: 80, tsb: -20 };

    test("listDailyTrainingLoad filters date inclusively, oldest first", async () => {
      const { db, stub } = setup();
      stub.reply(
        { data: [{ date: "2026-11-01", tss_total: 120, tss_by_source: { garmin: 70, strength: 50 }, ctl: 60, atl: 80, tsb: -20 }] },
        { data: [] },
        { error: FAIL },
      );
      expect(await db.listDailyTrainingLoad("2026-11-01", "2026-11-07")).toEqual([day]);
      const [q] = stub.queries;
      expect(q.table).toBe("daily_training_load");
      expect(q.steps[0]).toEqual({ method: "select", args: ["date, tss_total, tss_by_source, ctl, atl, tsb"] });
      expect(stub.filters(q)).toEqual([
        ["gte", "date", "2026-11-01"],
        ["lte", "date", "2026-11-07"],
      ]);
      expect(q.steps.slice(-2)).toEqual([
        { method: "order", args: ["date"] },
        { method: "range", args: [0, 999] },
      ]);
      await expect(db.listDailyTrainingLoad("a", "b")).rejects.toBe(FAIL);
    });

    test("listDailyTrainingLoad pages past the 1000-row cap", async () => {
      const { db, stub } = setup();
      const dbRow = { date: "2026-11-01", tss_total: 0, tss_by_source: {}, ctl: 0, atl: 0, tsb: 0 };
      stub.reply({ data: Array.from({ length: 1000 }, () => dbRow) }, { data: [dbRow] }, { data: [] });
      expect(await db.listDailyTrainingLoad("a", "b")).toHaveLength(1001);
      expect(stub.queries.map((q) => q.steps[q.steps.length - 1])).toEqual([
        { method: "range", args: [0, 999] },
        { method: "range", args: [1000, 1999] },
        { method: "range", args: [1001, 2000] },
      ]);
    });

    test("upsertDailyTrainingLoad upserts on (user_id,date); a userId is stamped; [] is a no-op", async () => {
      const { db, stub } = setup();
      await db.upsertDailyTrainingLoad([day]);
      const snake = { date: "2026-11-01", tss_total: 120, tss_by_source: { garmin: 70, strength: 50 }, ctl: 60, atl: 80, tsb: -20, updated_at: NOW };
      expect(stub.queries).toEqual([
        { table: "daily_training_load", op: "upsert", payload: [snake], steps: [{ method: "upsert", args: [[snake], { onConflict: "user_id,date" }] }] },
      ]);

      const direct = createSupabaseStub();
      await upsertDailyTrainingLoad(direct.client, [day, { ...day, date: "2026-11-02" }], USER);
      expect((direct.queries[0].payload as Record<string, unknown>[]).map((r) => r.user_id)).toEqual([USER, USER]);
      await upsertDailyTrainingLoad(direct.client, []);
      expect(direct.queries).toHaveLength(1);
      direct.reply({ error: FAIL });
      await expect(upsertDailyTrainingLoad(direct.client, [day])).rejects.toBe(FAIL);
    });
  });

  describe("sync_state", () => {
    const COLUMNS =
      "source, cursor, last_run_at, last_success_at, items_fetched, items_upserted, last_error, backfill_complete, auth_status";
    const row = {
      source: "peloton", cursor: { page: 3 }, last_run_at: NOW, last_success_at: null, items_fetched: 10,
      items_upserted: 8, last_error: "boom", backfill_complete: false, auth_status: "reconnect_required",
    };
    const state = {
      source: "peloton", cursor: { page: 3 }, lastRunAt: NOW, lastSuccessAt: null, itemsFetched: 10,
      itemsUpserted: 8, lastError: "boom", backfillComplete: false, authStatus: "reconnect_required",
    };

    test("listSyncState reads every feed ordered by source", async () => {
      const { db, stub } = setup();
      stub.reply({ data: [row] }, { error: FAIL });
      expect(await db.listSyncState()).toEqual([state]);
      expect(stub.queries[0]).toEqual({
        table: "sync_state",
        op: "select",
        steps: [{ method: "select", args: [COLUMNS] }, { method: "order", args: ["source"] }],
      });
      await expect(db.listSyncState()).rejects.toBe(FAIL);
    });

    test("upsertSyncState stamps user_id, sends only defined fields, upserts on (user_id,source)", async () => {
      const stub = createSupabaseStub();
      stub.reply({ data: row }, { error: FAIL });
      expect(await upsertSyncState(stub.client, { source: "peloton", lastRunAt: NOW, lastError: null, itemsFetched: undefined }, USER)).toEqual(state);
      const payload = { user_id: USER, source: "peloton", last_run_at: NOW, last_error: null, updated_at: NOW };
      expect(stub.queries[0]).toEqual({
        table: "sync_state",
        op: "upsert",
        payload,
        steps: [
          { method: "upsert", args: [payload, { onConflict: "user_id,source" }] },
          { method: "select", args: [COLUMNS] },
          { method: "single", args: [] },
        ],
      });
      await expect(upsertSyncState(stub.client, { source: "garmin_weight" }, USER)).rejects.toBe(FAIL);
    });
  });
});
