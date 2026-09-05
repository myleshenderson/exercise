import { describe, expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDay, updateDayName, updateDayExercises, setDayExerciseTarget, createExercise } from "./supabase";

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

  function builder(table: Row[], op: "select" | "insert" | "update" | "delete", payload?: unknown) {
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
        select: () => builder(table, "select"),
        insert: (payload: unknown) => builder(table, "insert", payload),
        update: (payload: unknown) => builder(table, "update", payload),
        delete: () => builder(table, "delete"),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as SupabaseClient;
}

describe("createDay", () => {
  test("inserts a workout_days row and returns it with an empty exercise list", async () => {
    const tables: Record<string, Row[]> = { workout_days: [] };
    const client = makeFakeClient(tables);
    const day = await createDay(client, "Push Day");
    expect(day).toEqual({ id: expect.any(String), name: "Push Day", position: 0, exerciseIds: [] });
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
