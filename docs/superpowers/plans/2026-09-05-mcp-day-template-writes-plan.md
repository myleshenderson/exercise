# MCP day-template write tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add eight MCP tools to `api/mcp.ts` that let a connected MCP client fully manage a user's day templates (create/rename/delete days, create exercises, attach/detach/reorder a day's exercises, set/clear a day's per-exercise scheme), scoped to the caller's own data via the same RLS-respecting pattern the six existing read tools use.

**Architecture:** Pull the day/exercise write logic in `src/data/supabase.ts` out of `createSupabaseDataLayer()`'s closures into module-scope functions that take a `SupabaseClient` as an explicit first parameter, so `api/mcp.ts` can call them with a per-request `createUserScopedClient(accessToken)` instead of the browser-session client. Register eight new tools in `api/mcp.ts` following the exact `withIdentity`/`createUserScopedClient` pattern the six read tools already use, with id-only targeting and existence checks so writes never silently guess, duplicate, or drop data.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, `zod`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-09-05-mcp-day-template-writes-design.md`

## Global Constraints

- **Id-only targeting.** No tool accepts or fuzzy-matches a name for an existing row; every write targets an existing day/exercise by id.
- **`user_id` is never an accepted tool parameter.** It is always left to the column default (`auth.uid()`) via RLS on the user-scoped client.
- **Existence checks before writing.** Any tool taking a `day_id`/`exercise_id` confirms the row exists first (via the user-scoped client, so RLS naturally 404s another user's id) and returns `"Day template <id> not found."` / `"Exercise <id> not found."` on failure — never a raw Postgres error or a silent no-op.
- **Every tool error goes through `toolError(\`${toolName} failed: ${message}\`)`**, matching the six existing read tools' convention.
- **Every successful write returns the affected row(s)** via `toolResult(...)`.
- **Numeric bounds**: weight must be `0–500`; reps (and `default_rep_low`/`default_rep_high`) must be an integer `1–40` — mirrors `SchemeEditor`'s validation in `src/screens/ManageDays.tsx:379-389`, but without its extra "weight is a multiple of 5" UI-only constraint, which the design spec does not carry over to the tool layer.
- **No new Postgres migration** — every write goes through `.from(table).insert/update/delete()` on tables whose RLS policies (`supabase/migrations/0001_init.sql`, `0003_harden_child_rls.sql`) already cover every write path this plan adds.
- **Resolving a design-doc ambiguity** (see "Where the write logic lives" in the spec): one sentence says `DataLayer`'s interface gains only `deleteDay`, but the very next sentence and the spec's own testing plan require `addExerciseToDay`/`removeExerciseFromDay` to be callable as `db.addExerciseToDay(...)` in `mock.test.ts`, which only type-checks if they're declared on `DataLayer`. This plan adds all three (`deleteDay`, `addExerciseToDay`, `removeExerciseFromDay`) to `DataLayer`, implemented by both backends — the reading that makes every part of the spec consistent and testable.

---

### Task 1: `DataLayer` gains `deleteDay`/`addExerciseToDay`/`removeExerciseFromDay`, implemented in `mock.ts`

**Files:**
- Modify: `src/data/DataLayer.ts`
- Modify: `src/data/mock.ts`
- Test: `src/data/mock.test.ts`

**Interfaces:**
- Produces: `DataLayer.deleteDay(id: string): Promise<void>`, `DataLayer.addExerciseToDay(dayId: string, exerciseId: string): Promise<void>`, `DataLayer.removeExerciseFromDay(dayId: string, exerciseId: string): Promise<void>` — used by Task 2's `createSupabaseDataLayer()` binder.

- [ ] **Step 1: Write the failing tests**

Append to `src/data/mock.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/data/mock.test.ts`
Expected: FAIL — `db.deleteDay is not a function` (and similarly for `addExerciseToDay`/`removeExerciseFromDay`).

- [ ] **Step 3: Add the three methods to the `DataLayer` interface**

In `src/data/DataLayer.ts`, change:

```ts
  createDay(name: string): Promise<WorkoutDay>;
  updateDayExercises(dayId: string, exerciseIds: string[]): Promise<void>;
```

to:

```ts
  createDay(name: string): Promise<WorkoutDay>;
  deleteDay(id: string): Promise<void>;
  addExerciseToDay(dayId: string, exerciseId: string): Promise<void>;
  removeExerciseFromDay(dayId: string, exerciseId: string): Promise<void>;
  updateDayExercises(dayId: string, exerciseIds: string[]): Promise<void>;
```

- [ ] **Step 4: Implement the three methods in `mock.ts`**

In `src/data/mock.ts`, in the object returned by `createMockDataLayer`, change:

```ts
    async createDay(name) {
      const day: WorkoutDay = { id: nextId("day"), name, position: days.length, exerciseIds: [] };
      days.push(day);
      return day;
    },
    async updateDayExercises(dayId, exerciseIds) {
```

to:

```ts
    async createDay(name) {
      const day: WorkoutDay = { id: nextId("day"), name, position: days.length, exerciseIds: [] };
      days.push(day);
      return day;
    },
    async deleteDay(dayId) {
      const idx = days.findIndex((d) => d.id === dayId);
      if (idx !== -1) days.splice(idx, 1);
      delete targets[dayId];
    },
    async addExerciseToDay(dayId, exerciseId) {
      const day = days.find((d) => d.id === dayId);
      if (day && !day.exerciseIds.includes(exerciseId)) day.exerciseIds.push(exerciseId);
    },
    async removeExerciseFromDay(dayId, exerciseId) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.exerciseIds = day.exerciseIds.filter((id) => id !== exerciseId);
      const dayTargets = targets[dayId];
      if (dayTargets) delete dayTargets[exerciseId];
    },
    async updateDayExercises(dayId, exerciseIds) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/data/mock.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 6: Typecheck (expected error, not a regression)**

Run: `npm run typecheck`

This task only touches `DataLayer.ts` and `mock.ts`; `src/data/supabase.ts` is untouched and does not implement the three new `DataLayer` methods yet (that starts in Task 2, finishes in Task 3). Expected output is exactly one error, naming `deleteDay`, `addExerciseToDay`, and `removeExerciseFromDay` as missing from the object `createSupabaseDataLayer` (in `src/data/supabase.ts`) returns. Do not attempt to fix this error in this task — do not modify `supabase.ts`. Confirm the error names only those three properties, record that in your report, and proceed to commit.

- [ ] **Step 7: Commit**

```bash
git add src/data/DataLayer.ts src/data/mock.ts src/data/mock.test.ts
git commit -m "Add deleteDay/addExerciseToDay/removeExerciseFromDay to DataLayer + mock backend"
```

---

### Task 2: Extract `src/data/supabase.ts`'s write functions to module scope

**Files:**
- Modify: `src/data/supabase.ts`
- Test: `src/data/supabase.test.ts` (new)

**Interfaces:**
- Consumes: `Exercise`, `WorkoutDay`, `SetEntry` from `../types` (existing); `SupabaseClient` from `@supabase/supabase-js`.
- Produces (all exported at module scope, for Task 3 and `api/mcp.ts` to import):
  - `createDay(client: SupabaseClient, name: string): Promise<WorkoutDay>`
  - `updateDayName(client: SupabaseClient, dayId: string, name: string): Promise<void>`
  - `updateDayExercises(client: SupabaseClient, dayId: string, exerciseIds: string[]): Promise<void>`
  - `setDayExerciseTarget(client: SupabaseClient, dayId: string, exerciseId: string, sets: SetEntry[] | null): Promise<void>`
  - `createExercise(client: SupabaseClient, input: Omit<Exercise, "id">): Promise<Exercise>`

- [ ] **Step 1: Write the failing tests**

Create `src/data/supabase.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/data/supabase.test.ts`
Expected: FAIL — `createDay`/etc. are not exported from `./supabase` (module has no such named exports yet).

- [ ] **Step 3: Extract the functions in `src/data/supabase.ts`**

Add the `SupabaseClient` type import and replace the five closures with module-scope exported functions, then rewire `createSupabaseDataLayer()` to bind them. Full new file contents:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DataLayer } from "./DataLayer";
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";
import { getSupabase } from "./supabaseClient";

interface ExerciseRow {
  id: string;
  name: string;
  cue: string;
  default_sets: number;
  default_rep_low: number;
  default_rep_high: number;
}

const toExercise = (r: ExerciseRow): Exercise => ({
  id: r.id,
  name: r.name,
  cue: r.cue,
  defaultSets: r.default_sets,
  defaultRepLow: r.default_rep_low,
  defaultRepHigh: r.default_rep_high,
});

export async function createDay(client: SupabaseClient, name: string): Promise<WorkoutDay> {
  const { data, error } = await client.from("workout_days").insert({ name }).select("*").single();
  if (error) throw error;
  return { id: data.id, name: data.name, position: data.position, exerciseIds: [] };
}

export async function updateDayName(client: SupabaseClient, dayId: string, name: string): Promise<void> {
  const { error } = await client.from("workout_days").update({ name }).eq("id", dayId);
  if (error) throw error;
}

export async function updateDayExercises(client: SupabaseClient, dayId: string, exerciseIds: string[]): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_day_exercises")
    .select("exercise_id, target_sets")
    .eq("workout_day_id", dayId);
  if (selectError) throw selectError;
  const targetsByExercise: Record<string, unknown> = {};
  for (const row of existing ?? []) {
    if (row.target_sets) targetsByExercise[row.exercise_id] = row.target_sets;
  }
  await client.from("workout_day_exercises").delete().eq("workout_day_id", dayId);
  if (exerciseIds.length) {
    await client.from("workout_day_exercises").insert(
      exerciseIds.map((exercise_id, position) => ({
        workout_day_id: dayId,
        exercise_id,
        position,
        target_sets: targetsByExercise[exercise_id] ?? null,
      })),
    );
  }
}

export async function setDayExerciseTarget(
  client: SupabaseClient,
  dayId: string,
  exerciseId: string,
  sets: SetEntry[] | null,
): Promise<void> {
  const target_sets = sets && sets.length > 0 ? sets.map((s) => ({ weight: s.weight, reps: s.reps })) : null;
  const { error } = await client
    .from("workout_day_exercises")
    .update({ target_sets })
    .eq("workout_day_id", dayId)
    .eq("exercise_id", exerciseId);
  if (error) throw error;
}

export async function createExercise(client: SupabaseClient, input: Omit<Exercise, "id">): Promise<Exercise> {
  const { data, error } = await client
    .from("exercises")
    .insert({
      name: input.name,
      cue: input.cue,
      default_sets: input.defaultSets,
      default_rep_low: input.defaultRepLow,
      default_rep_high: input.defaultRepHigh,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toExercise(data);
}

export function createSupabaseDataLayer(): DataLayer {
  const supabase = getSupabase();

  async function fetchExercise(id: string): Promise<Exercise | null> {
    const { data } = await supabase.from("exercises").select("*").eq("id", id).maybeSingle();
    return data ? toExercise(data) : null;
  }

  async function loadSession(id: string): Promise<Session | null> {
    const { data: s } = await supabase.from("sessions").select("*").eq("id", id).maybeSingle();
    if (!s) return null;
    const { data: sets } = await supabase
      .from("session_sets")
      .select("*")
      .eq("session_id", id)
      .order("set_number");
    const byExercise: Record<string, SetEntry[]> = {};
    for (const row of sets ?? []) {
      (byExercise[row.exercise_id] ??= []).push({
        setNumber: row.set_number,
        weight: Number(row.weight),
        reps: row.reps,
      });
    }
    return {
      id: s.id,
      workoutDayId: s.workout_day_id,
      performedOn: s.performed_on,
      exercises: Object.entries(byExercise).map(([exerciseId, exSets]) => ({ exerciseId, sets: exSets })),
    };
  }

  return {
    async listExercises() {
      const { data } = await supabase.from("exercises").select("*").order("name");
      return (data ?? []).map(toExercise);
    },
    getExercise: (id) => fetchExercise(id),
    createExercise: (input) => createExercise(supabase, input),
    async getWorkoutDays() {
      const { data } = await supabase.from("workout_days").select("*").order("position");
      const days: WorkoutDay[] = [];
      for (const d of data ?? []) {
        const { data: links } = await supabase
          .from("workout_day_exercises")
          .select("exercise_id, position")
          .eq("workout_day_id", d.id)
          .order("position");
        days.push({
          id: d.id,
          name: d.name,
          position: d.position,
          exerciseIds: (links ?? []).map((l) => l.exercise_id),
        });
      }
      return days;
    },
    async getDayExercises(dayId) {
      const { data: links } = await supabase
        .from("workout_day_exercises")
        .select("exercise_id, position")
        .eq("workout_day_id", dayId)
        .order("position");
      const out: Exercise[] = [];
      for (const l of links ?? []) {
        const ex = await fetchExercise(l.exercise_id);
        if (ex) out.push(ex);
      }
      return out;
    },
    createDay: (name) => createDay(supabase, name),
    updateDayExercises: (dayId, exerciseIds) => updateDayExercises(supabase, dayId, exerciseIds),
    updateDayName: (dayId, name) => updateDayName(supabase, dayId, name),
    async getDayExerciseTargets(dayId) {
      const { data } = await supabase
        .from("workout_day_exercises")
        .select("exercise_id, target_sets")
        .eq("workout_day_id", dayId);
      const out: Record<string, SetEntry[]> = {};
      for (const row of data ?? []) {
        const raw = row.target_sets as { weight: number; reps: number }[] | null;
        if (raw && raw.length > 0) {
          out[row.exercise_id] = raw.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps }));
        }
      }
      return out;
    },
    setDayExerciseTarget: (dayId, exerciseId, sets) => setDayExerciseTarget(supabase, dayId, exerciseId, sets),
    async getLastSetsForExercise(exerciseId, beforeDate) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id, performed_on")
        .lt("performed_on", beforeDate)
        .order("performed_on", { ascending: false })
        .order("created_at", { ascending: false });
      for (const sess of s ?? []) {
        const { data: sets } = await supabase
          .from("session_sets")
          .select("*")
          .eq("session_id", sess.id)
          .eq("exercise_id", exerciseId)
          .order("set_number");
        if (sets && sets.length) {
          return sets.map((row) => ({ setNumber: row.set_number, weight: Number(row.weight), reps: row.reps }));
        }
      }
      return [];
    },
    async startSession(workoutDayId, date) {
      const { data, error } = await supabase
        .from("sessions")
        .insert({ workout_day_id: workoutDayId, performed_on: date })
        .select("*")
        .single();
      if (error) throw error;
      return { id: data.id, workoutDayId: data.workout_day_id, performedOn: data.performed_on, exercises: [] };
    },
    getSession: (id) => loadSession(id),
    async getLastSessionForDay(workoutDayId) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .eq("workout_day_id", workoutDayId)
        .order("performed_on", { ascending: false })
        .order("created_at", { ascending: false });
      for (const sess of s ?? []) {
        const full = await loadSession(sess.id);
        if (full && full.exercises.length > 0) return full;
      }
      return null;
    },
    async getSessionForDayAndDate(workoutDayId, date) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .eq("workout_day_id", workoutDayId)
        .eq("performed_on", date)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!s) return null;
      return loadSession(s.id);
    },
    async logExercise(sessionId, exerciseId, sets) {
      await supabase.from("session_sets").delete().eq("session_id", sessionId).eq("exercise_id", exerciseId);
      if (sets.length) {
        await supabase.from("session_sets").insert(
          sets.map((s) => ({
            session_id: sessionId,
            exercise_id: exerciseId,
            set_number: s.setNumber,
            weight: s.weight,
            reps: s.reps,
          })),
        );
      }
    },
    async getExerciseHistory(exerciseId) {
      const { data: setRows } = await supabase
        .from("session_sets")
        .select("session_id")
        .eq("exercise_id", exerciseId);
      const ids = [...new Set((setRows ?? []).map((r) => r.session_id))];
      const sessions: Session[] = [];
      for (const id of ids) {
        const sess = await loadSession(id);
        if (sess) sessions.push(sess);
      }
      return sessions.sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
    async listSessions() {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .order("performed_on", { ascending: false })
        .order("created_at", { ascending: false });
      const sessions: Session[] = [];
      for (const row of s ?? []) {
        const sess = await loadSession(row.id);
        if (sess) sessions.push(sess);
      }
      return sessions;
    },
    async deleteSession(id) {
      const { error } = await supabase.from("sessions").delete().eq("id", id);
      if (error) throw error;
    },
  };
}
```

Note: `deleteDay`, `addExerciseToDay`, `removeExerciseFromDay` are added to this file and bound into the returned object in Task 3, not here — this task only extracts what already existed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/data/supabase.test.ts src/data/mock.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (expected error, not a regression)**

Run: `npm run typecheck`

`createSupabaseDataLayer()`'s return type will fail to satisfy `DataLayer` at this point, because Task 1 already added `deleteDay`/`addExerciseToDay`/`removeExerciseFromDay` to the `DataLayer` interface, and this task's binder object does not implement them yet (that's Task 3's job). Expected output is exactly one error, naming those three missing properties on the object returned from `createSupabaseDataLayer`. Do not attempt to fix this error in this task — do not add stub implementations, do not modify `DataLayer`. Confirm the error is only about those three named properties (nothing else — e.g. no error about `createDay`, `updateDayName`, `updateDayExercises`, `setDayExerciseTarget`, or `createExercise`), record that in your report, and proceed to commit.

- [ ] **Step 6: Commit**

```bash
git add src/data/supabase.ts src/data/supabase.test.ts
git commit -m "Extract supabase.ts day/exercise write functions to module scope"
```

---

### Task 3: Add `deleteDay`/`addExerciseToDay`/`removeExerciseFromDay` to `supabase.ts`

**Files:**
- Modify: `src/data/supabase.ts`
- Test: `src/data/supabase.test.ts`

**Interfaces:**
- Consumes: the `FakeRow`/`makeFakeClient` test harness from Task 2 (same file).
- Produces: `deleteDay(client: SupabaseClient, dayId: string): Promise<void>`, `addExerciseToDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void>`, `removeExerciseFromDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void>` — consumed by `api/mcp.ts` in Tasks 4 and 6, and bound into `createSupabaseDataLayer()`'s returned `DataLayer` here.

- [ ] **Step 1: Write the failing tests**

Append to `src/data/supabase.test.ts`:

```ts
describe("deleteDay", () => {
  test("removes the targeted workout_days row", async () => {
    const tables: Record<string, Row[]> = { workout_days: [{ id: "day-1", name: "Push" }] };
    const client = makeFakeClient(tables);
    await deleteDay(client, "day-1");
    expect(tables.workout_days).toEqual([]);
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
```

And update the top import line:

```ts
import { createDay, updateDayName, updateDayExercises, setDayExerciseTarget, createExercise } from "./supabase";
```

to:

```ts
import {
  createDay,
  updateDayName,
  updateDayExercises,
  setDayExerciseTarget,
  createExercise,
  deleteDay,
  addExerciseToDay,
  removeExerciseFromDay,
} from "./supabase";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/data/supabase.test.ts`
Expected: FAIL — `deleteDay`/`addExerciseToDay`/`removeExerciseFromDay` are not exported from `./supabase`.

- [ ] **Step 3: Implement the three functions**

In `src/data/supabase.ts`, add after `createExercise`:

```ts
export async function deleteDay(client: SupabaseClient, dayId: string): Promise<void> {
  const { error } = await client.from("workout_days").delete().eq("id", dayId);
  if (error) throw error;
}

export async function addExerciseToDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_day_exercises")
    .select("position")
    .eq("workout_day_id", dayId)
    .order("position", { ascending: false })
    .limit(1);
  if (selectError) throw selectError;
  const nextPosition = existing && existing.length > 0 ? (existing[0].position as number) + 1 : 0;
  const { error } = await client
    .from("workout_day_exercises")
    .insert({ workout_day_id: dayId, exercise_id: exerciseId, position: nextPosition });
  if (error) throw error;
}

export async function removeExerciseFromDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void> {
  const { error } = await client
    .from("workout_day_exercises")
    .delete()
    .eq("workout_day_id", dayId)
    .eq("exercise_id", exerciseId);
  if (error) throw error;
}
```

Then bind all three into `createSupabaseDataLayer()`'s returned object, next to the other day bindings:

```ts
    createDay: (name) => createDay(supabase, name),
    deleteDay: (id) => deleteDay(supabase, id),
    addExerciseToDay: (dayId, exerciseId) => addExerciseToDay(supabase, dayId, exerciseId),
    removeExerciseFromDay: (dayId, exerciseId) => removeExerciseFromDay(supabase, dayId, exerciseId),
    updateDayExercises: (dayId, exerciseIds) => updateDayExercises(supabase, dayId, exerciseIds),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/data/supabase.test.ts src/data/mock.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors — `createSupabaseDataLayer()`'s return now satisfies `DataLayer` in full.

- [ ] **Step 6: Commit**

```bash
git add src/data/supabase.ts src/data/supabase.test.ts
git commit -m "Add deleteDay/addExerciseToDay/removeExerciseFromDay to supabase.ts"
```

---

### Task 4: MCP test fixture infra + `create_day_template`/`rename_day_template`/`delete_day_template`

**Files:**
- Modify: `api/mcp.ts`
- Modify: `api/mcp.test.ts`
- Modify: `src/data/supabase.ts` (add `.js` extensions to its own relative imports — one-time cross-boundary typecheck fix, see Step 3)
- Modify: `src/data/DataLayer.ts` (same fix, one import)
- Modify: `tsconfig.api.json` (same fix, one `include` entry)

**Interfaces:**
- Consumes: `createDay`, `updateDayName`, `deleteDay` from `../src/data/supabase.js` (Tasks 2–3).
- Produces: `findDay(client, dayId)` helper (used by every subsequent task's tool); the `TABLES`/`FakeQuery`/`fakeFrom` test fixtures in `api/mcp.test.ts` (used by every subsequent task's tests); the `create_day_template`, `rename_day_template`, `delete_day_template` tools; the cross-boundary typecheck fix in Step 3 (a one-time fix — Tasks 5-8 extend the same `api/mcp.ts` import line but do not need to repeat this).

- [ ] **Step 1: Write the failing tests**

In `api/mcp.test.ts`, add the fake-table infrastructure near the top, after the existing `accessTokenOwner`/`seq` declarations and before `FIXTURES`:

```ts
interface FakeRow {
  id: string;
  user_id: string;
  [key: string]: unknown;
}

type FakeTableName = "workout_days" | "exercises" | "workout_day_exercises";

const TABLES: Record<FakeTableName, FakeRow[]> = {
  workout_days: [],
  exercises: [],
  workout_day_exercises: [],
};
let fakeRowSeq = 0;
function nextFakeId(prefix: string): string {
  return `${prefix}-${++fakeRowSeq}`;
}

type FakeResult = { data: unknown; error: { message: string } | null };
type FakeMode = "list" | "single" | "maybeSingle";

// Emulates just enough of Postgres RLS for the write tools under test: every row is
// owned by whichever user's access token built the client, select/update/delete only
// ever see rows owned by that caller (own_select/own_update/own_delete), and inserting
// into workout_day_exercises additionally requires the referenced day and exercise to
// both already belong to that same caller (0003_harden_child_rls.sql).
class FakeQuery implements PromiseLike<FakeResult> {
  private filters: Array<[string, unknown]> = [];
  private orderCol?: string;
  private orderAsc = true;
  private limitN?: number;
  private mode: FakeMode = "list";

  constructor(
    private tableName: FakeTableName,
    private table: FakeRow[],
    private callerId: string,
    private op: "select" | "insert" | "update" | "delete",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private payload?: any,
  ) {}

  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  single(): this {
    this.mode = "single";
    return this;
  }
  maybeSingle(): this {
    this.mode = "maybeSingle";
    return this;
  }

  private owned(): FakeRow[] {
    return this.table.filter((r) => r.user_id === this.callerId);
  }

  private matched(rows: FakeRow[]): FakeRow[] {
    let out = rows.filter((r) => this.filters.every(([col, val]) => r[col] === val));
    if (this.orderCol) {
      const col = this.orderCol;
      const dir = this.orderAsc ? 1 : -1;
      out = out.slice().sort((a, b) => ((a[col] as number) - (b[col] as number)) * dir);
    }
    if (this.limitN !== undefined) out = out.slice(0, this.limitN);
    return out;
  }

  private finish(rows: FakeRow[]): FakeResult {
    if (this.mode === "single") {
      return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: "no rows found" } };
    }
    if (this.mode === "maybeSingle") {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  private run(): FakeResult {
    if (this.op === "select") return this.finish(this.matched(this.owned()));

    if (this.op === "delete") {
      for (const row of this.matched(this.owned())) {
        const idx = this.table.indexOf(row);
        if (idx !== -1) this.table.splice(idx, 1);
      }
      return { data: null, error: null };
    }

    if (this.op === "update") {
      const targets = this.matched(this.owned());
      for (const row of targets) Object.assign(row, this.payload);
      return this.finish(targets);
    }

    const inputs: Array<Record<string, unknown>> = Array.isArray(this.payload) ? this.payload : [this.payload];
    const inserted: FakeRow[] = [];
    for (const input of inputs) {
      if (this.tableName === "workout_day_exercises") {
        const dayOwned = TABLES.workout_days.some((d) => d.id === input.workout_day_id && d.user_id === this.callerId);
        const exOwned = TABLES.exercises.some((e) => e.id === input.exercise_id && e.user_id === this.callerId);
        if (!dayOwned || !exOwned) {
          return { data: null, error: { message: "new row violates row-level security policy" } };
        }
      }
      // position defaults to 0, mirroring workout_days.position/workout_day_exercises.position's
      // `not null default 0` column default — overridable when the caller supplies it explicitly
      // (e.g. addExerciseToDay, updateDayExercises).
      const row: FakeRow = { id: nextFakeId(this.tableName), user_id: this.callerId, position: 0, ...input };
      this.table.push(row);
      inserted.push(row);
    }
    return this.finish(inserted);
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

function fakeFrom(tableName: FakeTableName, callerId: string | undefined) {
  const table = TABLES[tableName];
  if (!callerId) {
    const errResult: FakeResult = { data: null, error: { message: "invalid access token" } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub: any = {
      select: () => stub,
      insert: () => stub,
      update: () => stub,
      delete: () => stub,
      eq: () => stub,
      order: () => stub,
      limit: () => stub,
      single: () => stub,
      maybeSingle: () => stub,
      then: (res: (v: FakeResult) => unknown) => Promise.resolve(errResult).then(res),
    };
    return stub;
  }
  return {
    select: () => new FakeQuery(tableName, table, callerId, "select"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (payload: any) => new FakeQuery(tableName, table, callerId, "insert", payload),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: (payload: any) => new FakeQuery(tableName, table, callerId, "update", payload),
    delete: () => new FakeQuery(tableName, table, callerId, "delete"),
  };
}

function seedDay(userId: string, id: string, name: string, position = 0): FakeRow {
  const row: FakeRow = { id, user_id: userId, name, position };
  TABLES.workout_days.push(row);
  return row;
}

function seedExercise(userId: string, id: string, name: string): FakeRow {
  const row: FakeRow = { id, user_id: userId, name, cue: "", default_sets: 3, default_rep_low: 10, default_rep_high: 12 };
  TABLES.exercises.push(row);
  return row;
}

function seedDayExercise(userId: string, dayId: string, exerciseId: string, position: number, targetSets: unknown = null): FakeRow {
  const row: FakeRow = {
    id: nextFakeId("wde"),
    user_id: userId,
    workout_day_id: dayId,
    exercise_id: exerciseId,
    position,
    target_sets: targetSets,
  };
  TABLES.workout_day_exercises.push(row);
  return row;
}
```

Wire it into `makeSupabaseClient`'s `authHeader` branch — change:

```ts
  if (authHeader) {
    const accessToken = authHeader.replace(/^Bearer /, "");
    return {
      rpc: async (name: string, _args?: Record<string, unknown>) => {
        const userId = accessTokenOwner.get(accessToken);
        if (!userId) return { data: null, error: { message: "invalid access token" } };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { data: (FIXTURES[userId] as any)[name], error: null };
      },
    };
  }
```

to:

```ts
  if (authHeader) {
    const accessToken = authHeader.replace(/^Bearer /, "");
    return {
      rpc: async (name: string, _args?: Record<string, unknown>) => {
        const userId = accessTokenOwner.get(accessToken);
        if (!userId) return { data: null, error: { message: "invalid access token" } };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { data: (FIXTURES[userId] as any)[name], error: null };
      },
      from: (tableName: FakeTableName) => fakeFrom(tableName, accessTokenOwner.get(accessToken)),
    };
  }
```

Reset the fake tables in `beforeEach` — change:

```ts
  beforeEach(async () => {
    sessionsById.clear();
    tokenHashToId.clear();
    validRefreshTokens.clear();
    accessTokenOwner.clear();
    seq = 0;
    seedSession("user-a", "token-a");
    seedSession("user-b", "token-b");
```

to:

```ts
  beforeEach(async () => {
    sessionsById.clear();
    tokenHashToId.clear();
    validRefreshTokens.clear();
    accessTokenOwner.clear();
    seq = 0;
    TABLES.workout_days.length = 0;
    TABLES.exercises.length = 0;
    TABLES.workout_day_exercises.length = 0;
    fakeRowSeq = 0;
    seedSession("user-a", "token-a");
    seedSession("user-b", "token-b");
```

Update the tool-listing assertions to include the three new tools — change both occurrences of:

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);
```

to:

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_day_template",
      "delete_day_template",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "rename_day_template",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);
```

Finally, add a new `describe` block at the end of the file, before the closing of `describe("api/mcp handler", ...)`:

```ts
  describe("day template write tools", () => {
    it("create_day_template creates a day owned by the caller and returns it", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "create_day_template", arguments: { name: "Pull Day" } });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      const day = JSON.parse(content.text);
      expect(day).toEqual({ id: expect.any(String), name: "Pull Day", position: 0, exerciseIds: [] });
      expect(TABLES.workout_days.find((d) => d.id === day.id)?.user_id).toBe("user-a");

      await client.close();
    });

    it("rename_day_template renames an existing day and returns it", async () => {
      seedDay("user-a", "day-a", "Push");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_day_template", arguments: { day_id: "day-a", name: "Push (v2)" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_days.find((d) => d.id === "day-a")?.name).toBe("Push (v2)");

      await client.close();
    });

    it("rename_day_template errors clearly on a nonexistent day id", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_day_template", arguments: { day_id: "no-such-day", name: "X" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "rename_day_template failed: Day template no-such-day not found." },
      ]);

      await client.close();
    });

    it("rename_day_template cannot rename another user's day", async () => {
      seedDay("user-b", "day-b", "Pull");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_day_template", arguments: { day_id: "day-b", name: "Hijacked" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "rename_day_template failed: Day template day-b not found." },
      ]);
      expect(TABLES.workout_days.find((d) => d.id === "day-b")?.name).toBe("Pull");

      await client.close();
    });

    it("delete_day_template deletes an existing day and returns confirmation", async () => {
      seedDay("user-a", "day-a", "Push");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "delete_day_template", arguments: { day_id: "day-a" } });

      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ id: "day-a", name: "Push", deleted: true }, null, 2) },
      ]);
      expect(TABLES.workout_days.find((d) => d.id === "day-a")).toBeUndefined();

      await client.close();
    });

    it("delete_day_template cannot delete another user's day", async () => {
      seedDay("user-b", "day-b", "Pull");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "delete_day_template", arguments: { day_id: "day-b" } });

      expect(result.isError).toBe(true);
      expect(TABLES.workout_days.find((d) => d.id === "day-b")).toBeDefined();

      await client.close();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/mcp.test.ts`
Expected: FAIL — the updated tool-list assertions fail (the three new tools don't exist yet), and the new `describe("day template write tools", ...)` tests fail with "Tool create_day_template not found" (or similar MCP SDK error).

- [ ] **Step 3: Fix cross-boundary typecheck gap (one-time, needed only in this task)**

`api/mcp.ts` importing from `../src/data/supabase.js` pulls `src/data/supabase.ts` — and transitively `src/data/DataLayer.ts` and `src/data/supabaseClient.ts` — into `tsconfig.api.json`'s program (`moduleResolution: nodenext`, stricter than `src/`'s own `tsconfig.json`, which uses `moduleResolution: bundler`) for the first time. Two gaps surface, both one-time fixes (later tasks that extend the same import line will not hit this again):

1. `nodenext` requires explicit file extensions on relative imports. `src/data/supabase.ts` and `src/data/DataLayer.ts` both import their sibling modules without extensions (fine under `bundler`, an error under `nodenext`).
2. `src/data/supabaseClient.ts` reads `import.meta.env.VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`, typed only via `src/vite-env.d.ts`'s `/// <reference types="vite/client" />` — which `tsconfig.api.json`'s `"include": ["api"]` never pulls in.

In `src/data/supabase.ts`, change:

```ts
import type { DataLayer } from "./DataLayer";
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";
import { getSupabase } from "./supabaseClient";
```

to:

```ts
import type { DataLayer } from "./DataLayer.js";
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types.js";
import { getSupabase } from "./supabaseClient.js";
```

In `src/data/DataLayer.ts`, change:

```ts
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";
```

to:

```ts
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types.js";
```

In `tsconfig.api.json`, change:

```json
  "include": ["api"],
```

to:

```json
  "include": ["api", "src/vite-env.d.ts"],
```

This adds no new "types" entry (so `api/`'s own files still see only Node globals) — it just makes the ambient `ImportMeta.env` augmentation visible to the program that now transitively needs it, since `supabaseClient.ts`'s body (specifically `getSupabase()`, which `api/mcp.ts` never calls but which still must typecheck) references it.

Run `npm run typecheck` and confirm zero errors from both `tsc --noEmit` and `tsc -p tsconfig.api.json`. Run `npm test` and confirm all tests still pass (this is a type-level/config fix; no runtime behavior changes — `.js`-suffixed relative imports resolving to sibling `.ts` files is standard practice already used throughout `api/*.ts`, e.g. `./_env.js`, `./mcp-auth.js`).

- [ ] **Step 4: Add `findDay` and the three tools to `api/mcp.ts`**

Add the import and helper near the top of `api/mcp.ts`, after the existing imports:

```ts
import { createDay, updateDayName, deleteDay } from "../src/data/supabase.js";
```

After `createUserScopedClient`, add:

```ts
async function findDay(
  client: SupabaseClient,
  dayId: string,
): Promise<{ id: string; name: string; position: number } | null> {
  const { data } = await client.from("workout_days").select("id, name, position").eq("id", dayId).maybeSingle();
  return (data as { id: string; name: string; position: number } | null) ?? null;
}
```

Inside `createMcpServer`, after the `get_workout_history` tool registration and before `return server;`, add:

```ts
  server.registerTool(
    "create_day_template",
    {
      title: "Create day template",
      description: "Creates a new, empty day template for the authenticated user. Returns the new day, including its id.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) =>
      withIdentity(async (accessToken) => {
        const day = await createDay(createUserScopedClient(accessToken), name);
        return toolResult(day);
      }),
  );

  server.registerTool(
    "rename_day_template",
    {
      title: "Rename day template",
      description: "Renames an existing day template belonging to the authenticated user, targeted by id.",
      inputSchema: { day_id: z.string(), name: z.string() },
    },
    async ({ day_id, name }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`rename_day_template failed: Day template ${day_id} not found.`);
        await updateDayName(client, day_id, name);
        return toolResult({ id: day.id, name, position: day.position });
      }),
  );

  server.registerTool(
    "delete_day_template",
    {
      title: "Delete day template",
      description:
        "Hard-deletes a day template belonging to the authenticated user, targeted by id. Its exercise attachments cascade-delete; any session that referenced this day keeps its history with workout_day_id set to null.",
      inputSchema: { day_id: z.string() },
    },
    async ({ day_id }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`delete_day_template failed: Day template ${day_id} not found.`);
        await deleteDay(client, day_id);
        return toolResult({ id: day.id, name: day.name, deleted: true });
      }),
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run api/mcp.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors (this also confirms Step 3's cross-boundary fix).

- [ ] **Step 7: Commit**

```bash
git add api/mcp.ts api/mcp.test.ts src/data/supabase.ts src/data/DataLayer.ts tsconfig.api.json
git commit -m "Add create/rename/delete day-template MCP tools"
```

---

### Task 5: `create_exercise` tool

**Files:**
- Modify: `api/mcp.ts`
- Modify: `api/mcp.test.ts`

**Interfaces:**
- Consumes: `createExercise` from `../src/data/supabase.js`; `seedExercise` fixture helper from Task 4.
- Produces: `validateReps(value: number): string | undefined` helper, reused by Task 8.

- [ ] **Step 1: Write the failing tests**

In `api/mcp.test.ts`, update the tool-list assertions (both occurrences) to insert `"create_exercise"` in sorted position:

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_day_template",
      "create_exercise",
      "delete_day_template",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "rename_day_template",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);
```

Add to the `"day template write tools"` describe block:

```ts
    it("create_exercise creates a catalog exercise with defaults applied", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "create_exercise", arguments: { name: "Overhead Press" } });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      const exercise = JSON.parse(content.text);
      expect(exercise).toEqual({
        id: expect.any(String),
        name: "Overhead Press",
        cue: "",
        defaultSets: 3,
        defaultRepLow: 10,
        defaultRepHigh: 12,
      });

      await client.close();
    });

    it("create_exercise honors explicit optional fields", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "create_exercise",
        arguments: { name: "Deadlift", cue: "neutral spine", default_sets: 5, default_rep_low: 3, default_rep_high: 5 },
      });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      expect(JSON.parse(content.text)).toEqual({
        id: expect.any(String),
        name: "Deadlift",
        cue: "neutral spine",
        defaultSets: 5,
        defaultRepLow: 3,
        defaultRepHigh: 5,
      });

      await client.close();
    });

    it("create_exercise rejects an out-of-range default_rep_high", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "create_exercise",
        arguments: { name: "Curl", default_rep_high: 41 },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "create_exercise failed: default_rep_high must be an integer between 1 and 40." },
      ]);

      await client.close();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/mcp.test.ts`
Expected: FAIL — `create_exercise` tool not found; tool-list assertions mismatch.

- [ ] **Step 3: Add `create_exercise` to `api/mcp.ts`**

Update the import:

```ts
import { createDay, updateDayName, deleteDay, createExercise } from "../src/data/supabase.js";
```

Add near `findDay`:

```ts
function validateReps(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 40) return "must be an integer between 1 and 40.";
  return undefined;
}
```

Add the tool registration after `delete_day_template`:

```ts
  server.registerTool(
    "create_exercise",
    {
      title: "Create exercise",
      description:
        "Creates a catalog exercise not yet attached to any day, for the authenticated user. Omitted optionals fall back to the same defaults as the exercises table's own column defaults.",
      inputSchema: {
        name: z.string(),
        cue: z.string().optional(),
        default_sets: z.number().optional(),
        default_rep_low: z.number().optional(),
        default_rep_high: z.number().optional(),
      },
    },
    async ({ name, cue, default_sets, default_rep_low, default_rep_high }) =>
      withIdentity(async (accessToken) => {
        const repLow = default_rep_low ?? 10;
        const repHigh = default_rep_high ?? 12;
        const repLowError = validateReps(repLow);
        if (repLowError) return toolError(`create_exercise failed: default_rep_low ${repLowError}`);
        const repHighError = validateReps(repHigh);
        if (repHighError) return toolError(`create_exercise failed: default_rep_high ${repHighError}`);

        const exercise = await createExercise(createUserScopedClient(accessToken), {
          name,
          cue: cue ?? "",
          defaultSets: default_sets ?? 3,
          defaultRepLow: repLow,
          defaultRepHigh: repHigh,
        });
        return toolResult(exercise);
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add api/mcp.ts api/mcp.test.ts
git commit -m "Add create_exercise MCP tool"
```

---

### Task 6: `add_exercise_to_day` / `remove_exercise_from_day` tools

**Files:**
- Modify: `api/mcp.ts`
- Modify: `api/mcp.test.ts`

**Interfaces:**
- Consumes: `addExerciseToDay`, `removeExerciseFromDay` from `../src/data/supabase.js` (Task 3); `findDay` (Task 4); `seedDay`/`seedExercise`/`seedDayExercise` fixtures (Task 4).
- Produces: `findExercise(client, exerciseId)` helper, reused by Task 8.

- [ ] **Step 1: Write the failing tests**

Update the tool-list assertions (both occurrences):

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_exercise_to_day",
      "create_day_template",
      "create_exercise",
      "delete_day_template",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "remove_exercise_from_day",
      "rename_day_template",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);
```

Add to the `"day template write tools"` describe block:

```ts
    it("add_exercise_to_day attaches an exercise the caller owns", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_exercise_to_day", arguments: { day_id: "day-a", exercise_id: "ex-a" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_day_exercises).toContainEqual(
        expect.objectContaining({ workout_day_id: "day-a", exercise_id: "ex-a", position: 0 }),
      );

      await client.close();
    });

    it("add_exercise_to_day rejects a duplicate attach without creating a second row", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_exercise_to_day", arguments: { day_id: "day-a", exercise_id: "ex-a" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "add_exercise_to_day failed: Exercise ex-a is already on day day-a." },
      ]);
      expect(TABLES.workout_day_exercises.filter((r) => r.workout_day_id === "day-a")).toHaveLength(1);

      await client.close();
    });

    it("add_exercise_to_day cannot attach another user's exercise to the caller's day", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-b", "ex-b", "Row");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_exercise_to_day", arguments: { day_id: "day-a", exercise_id: "ex-b" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "add_exercise_to_day failed: Exercise ex-b not found." },
      ]);

      await client.close();
    });

    it("remove_exercise_from_day detaches only the targeted exercise", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedExercise("user-a", "ex-c", "Incline Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      seedDayExercise("user-a", "day-a", "ex-c", 1);
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "remove_exercise_from_day", arguments: { day_id: "day-a", exercise_id: "ex-a" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_day_exercises.map((r) => r.exercise_id)).toEqual(["ex-c"]);

      await client.close();
    });

    it("remove_exercise_from_day cannot touch another user's day", async () => {
      seedDay("user-b", "day-b", "Pull");
      seedExercise("user-b", "ex-b", "Row");
      seedDayExercise("user-b", "day-b", "ex-b", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "remove_exercise_from_day", arguments: { day_id: "day-b", exercise_id: "ex-b" } });

      expect(result.isError).toBe(true);
      expect(TABLES.workout_day_exercises).toHaveLength(1);

      await client.close();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/mcp.test.ts`
Expected: FAIL — tools not found; tool-list mismatch.

- [ ] **Step 3: Add `findExercise` and the two tools to `api/mcp.ts`**

Update the import:

```ts
import { createDay, updateDayName, deleteDay, createExercise, addExerciseToDay, removeExerciseFromDay } from "../src/data/supabase.js";
```

Add near `findDay`:

```ts
async function findExercise(client: SupabaseClient, exerciseId: string): Promise<{ id: string } | null> {
  const { data } = await client.from("exercises").select("id").eq("id", exerciseId).maybeSingle();
  return (data as { id: string } | null) ?? null;
}
```

Add the tool registrations after `create_exercise`:

```ts
  server.registerTool(
    "add_exercise_to_day",
    {
      title: "Add exercise to day",
      description: "Appends an existing catalog exercise to the end of a day template's exercise list, for the authenticated user.",
      inputSchema: { day_id: z.string(), exercise_id: z.string() },
    },
    async ({ day_id, exercise_id }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`add_exercise_to_day failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(client, exercise_id);
        if (!exercise) return toolError(`add_exercise_to_day failed: Exercise ${exercise_id} not found.`);

        const { data: existing, error: existingError } = await client
          .from("workout_day_exercises")
          .select("id")
          .eq("workout_day_id", day_id)
          .eq("exercise_id", exercise_id)
          .maybeSingle();
        if (existingError) return toolError(`add_exercise_to_day failed: ${existingError.message}`);
        if (existing) return toolError(`add_exercise_to_day failed: Exercise ${exercise_id} is already on day ${day_id}.`);

        await addExerciseToDay(client, day_id, exercise_id);
        return toolResult({ day_id, exercise_id });
      }),
  );

  server.registerTool(
    "remove_exercise_from_day",
    {
      title: "Remove exercise from day",
      description: "Removes one exercise from a day template, for the authenticated user. Touches only that one attachment.",
      inputSchema: { day_id: z.string(), exercise_id: z.string() },
    },
    async ({ day_id, exercise_id }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`remove_exercise_from_day failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(client, exercise_id);
        if (!exercise) return toolError(`remove_exercise_from_day failed: Exercise ${exercise_id} not found.`);

        await removeExerciseFromDay(client, day_id, exercise_id);
        return toolResult({ day_id, exercise_id, removed: true });
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add api/mcp.ts api/mcp.test.ts
git commit -m "Add add_exercise_to_day/remove_exercise_from_day MCP tools"
```

---

### Task 7: `reorder_day_exercises` tool

**Files:**
- Modify: `api/mcp.ts`
- Modify: `api/mcp.test.ts`

**Interfaces:**
- Consumes: `updateDayExercises` from `../src/data/supabase.js` (existing export, Task 2); `findDay` (Task 4); fixtures from Task 4.

- [ ] **Step 1: Write the failing tests**

Update the tool-list assertions (both occurrences):

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_exercise_to_day",
      "create_day_template",
      "create_exercise",
      "delete_day_template",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "remove_exercise_from_day",
      "rename_day_template",
      "reorder_day_exercises",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);
```

Add to the `"day template write tools"` describe block:

```ts
    it("reorder_day_exercises rewrites order and preserves target_sets across the round-trip", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedExercise("user-a", "ex-c", "Incline Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0, [{ weight: 185, reps: 5 }]);
      seedDayExercise("user-a", "day-a", "ex-c", 1);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_day_exercises",
        arguments: { day_id: "day-a", exercise_ids: ["ex-c", "ex-a"] },
      });

      expect(result.isError).not.toBe(true);
      const rows = TABLES.workout_day_exercises
        .filter((r) => r.workout_day_id === "day-a")
        .sort((a, b) => (a.position as number) - (b.position as number));
      expect(rows.map((r) => r.exercise_id)).toEqual(["ex-c", "ex-a"]);
      expect(rows.find((r) => r.exercise_id === "ex-a")?.target_sets).toEqual([{ weight: 185, reps: 5 }]);

      await client.close();
    });

    it("reorder_day_exercises rejects a list missing a current member", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedExercise("user-a", "ex-c", "Incline Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      seedDayExercise("user-a", "day-a", "ex-c", 1);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_day_exercises",
        arguments: { day_id: "day-a", exercise_ids: ["ex-a"] },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text:
            "reorder_day_exercises failed: exercise_ids missing [ex-c]. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.",
        },
      ]);
      expect(TABLES.workout_day_exercises.filter((r) => r.workout_day_id === "day-a")).toHaveLength(2);

      await client.close();
    });

    it("reorder_day_exercises rejects a list with an id not on the day", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_day_exercises",
        arguments: { day_id: "day-a", exercise_ids: ["ex-a", "ex-z"] },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text:
            "reorder_day_exercises failed: exercise_ids unexpected [ex-z]. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.",
        },
      ]);

      await client.close();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/mcp.test.ts`
Expected: FAIL — tool not found; tool-list mismatch.

- [ ] **Step 3: Add `reorder_day_exercises` to `api/mcp.ts`**

Update the import:

```ts
import {
  createDay,
  updateDayName,
  deleteDay,
  createExercise,
  addExerciseToDay,
  removeExerciseFromDay,
  updateDayExercises,
} from "../src/data/supabase.js";
```

Add the tool registration after `remove_exercise_from_day`:

```ts
  server.registerTool(
    "reorder_day_exercises",
    {
      title: "Reorder day exercises",
      description:
        "Rewrites a day template's exercise order for the authenticated user. exercise_ids must be exactly the day's current exercise-id set (same members, any order); membership changes must go through add_exercise_to_day/remove_exercise_from_day instead.",
      inputSchema: { day_id: z.string(), exercise_ids: z.array(z.string()) },
    },
    async ({ day_id, exercise_ids }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`reorder_day_exercises failed: Day template ${day_id} not found.`);

        const { data: current, error: selectError } = await client
          .from("workout_day_exercises")
          .select("exercise_id")
          .eq("workout_day_id", day_id);
        if (selectError) return toolError(`reorder_day_exercises failed: ${selectError.message}`);

        const currentIds = new Set((current ?? []).map((r: { exercise_id: string }) => r.exercise_id));
        const requestedIds = new Set(exercise_ids);
        const missing = [...currentIds].filter((id) => !requestedIds.has(id));
        const extra = [...requestedIds].filter((id) => !currentIds.has(id));
        if (missing.length || extra.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`missing [${missing.join(", ")}]`);
          if (extra.length) parts.push(`unexpected [${extra.join(", ")}]`);
          return toolError(
            `reorder_day_exercises failed: exercise_ids ${parts.join(" and ")}. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.`,
          );
        }

        await updateDayExercises(client, day_id, exercise_ids);
        return toolResult({ day_id, exercise_ids });
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add api/mcp.ts api/mcp.test.ts
git commit -m "Add reorder_day_exercises MCP tool"
```

---

### Task 8: `set_day_exercise_scheme` tool

**Files:**
- Modify: `api/mcp.ts`
- Modify: `api/mcp.test.ts`

**Interfaces:**
- Consumes: `setDayExerciseTarget` from `../src/data/supabase.js` (existing export, Task 2); `findDay`/`findExercise` (Tasks 4/6); `validateReps` (Task 5).
- Produces: `validateWeight(value: number): string | undefined` helper.

- [ ] **Step 1: Write the failing tests**

Update the tool-list assertions (both occurrences) to the full, final 14-tool list:

```ts
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_exercise_to_day",
      "create_day_template",
      "create_exercise",
      "delete_day_template",
      "get_day_templates",
      "get_workout_history",
      "progression_for_exercise",
      "remove_exercise_from_day",
      "rename_day_template",
      "reorder_day_exercises",
      "set_day_exercise_scheme",
      "sets_for_exercise",
      "training_gaps",
      "weekly_volume",
    ]);
```

Add to the `"day template write tools"` describe block:

```ts
    it("set_day_exercise_scheme sets a scheme for one exercise on one day", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "set_day_exercise_scheme",
        arguments: { day_id: "day-a", exercise_id: "ex-a", sets: [{ weight: 185, reps: 5 }, { weight: 185, reps: 5 }] },
      });

      expect(result.isError).not.toBe(true);
      // The workout_day_exercises.target_sets column stores {weight, reps} pairs only —
      // setNumber is derived from array index on read (see getDayExerciseTargets in
      // supabase.ts), so the stored row must NOT carry setNumber even though the tool's
      // own JSON response (asserted below) does, as a convenience for the caller.
      const row = TABLES.workout_day_exercises.find((r) => r.exercise_id === "ex-a");
      expect(row?.target_sets).toEqual([
        { weight: 185, reps: 5 },
        { weight: 185, reps: 5 },
      ]);
      const [content] = result.content as [{ type: "text"; text: string }];
      expect(JSON.parse(content.text)).toEqual({
        day_id: "day-a",
        exercise_id: "ex-a",
        sets: [
          { setNumber: 1, weight: 185, reps: 5 },
          { setNumber: 2, weight: 185, reps: 5 },
        ],
      });

      await client.close();
    });

    it("set_day_exercise_scheme with null clears an existing scheme", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0, [{ weight: 185, reps: 5 }]);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "set_day_exercise_scheme",
        arguments: { day_id: "day-a", exercise_id: "ex-a", sets: null },
      });

      expect(result.isError).not.toBe(true);
      const row = TABLES.workout_day_exercises.find((r) => r.exercise_id === "ex-a");
      expect(row?.target_sets).toBeNull();

      await client.close();
    });

    it("set_day_exercise_scheme rejects an out-of-range weight", async () => {
      seedDay("user-a", "day-a", "Push");
      seedExercise("user-a", "ex-a", "Bench Press");
      seedDayExercise("user-a", "day-a", "ex-a", 0);
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "set_day_exercise_scheme",
        arguments: { day_id: "day-a", exercise_id: "ex-a", sets: [{ weight: 501, reps: 5 }] },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "set_day_exercise_scheme failed: set 1 weight must be between 0 and 500." },
      ]);

      await client.close();
    });

    it("set_day_exercise_scheme errors on a nonexistent exercise id", async () => {
      seedDay("user-a", "day-a", "Push");
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "set_day_exercise_scheme",
        arguments: { day_id: "day-a", exercise_id: "no-such-exercise", sets: null },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "set_day_exercise_scheme failed: Exercise no-such-exercise not found." },
      ]);

      await client.close();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run api/mcp.test.ts`
Expected: FAIL — tool not found; tool-list mismatch.

- [ ] **Step 3: Add `set_day_exercise_scheme` to `api/mcp.ts`**

Update the import:

```ts
import {
  createDay,
  updateDayName,
  deleteDay,
  createExercise,
  addExerciseToDay,
  removeExerciseFromDay,
  updateDayExercises,
  setDayExerciseTarget,
} from "../src/data/supabase.js";
```

Add near `validateReps`:

```ts
function validateWeight(value: number): string | undefined {
  if (!(value >= 0 && value <= 500)) return "must be between 0 and 500.";
  return undefined;
}
```

Add the tool registration after `reorder_day_exercises`:

```ts
  server.registerTool(
    "set_day_exercise_scheme",
    {
      title: "Set day exercise scheme",
      description:
        "Sets the day-specific rep/weight scheme for one exercise on one day, for the authenticated user. null (or an empty array) clears it, reverting that exercise to its own uniform defaults on that day.",
      inputSchema: {
        day_id: z.string(),
        exercise_id: z.string(),
        sets: z.array(z.object({ weight: z.number(), reps: z.number() })).nullable(),
      },
    },
    async ({ day_id, exercise_id, sets }) =>
      withIdentity(async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`set_day_exercise_scheme failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(client, exercise_id);
        if (!exercise) return toolError(`set_day_exercise_scheme failed: Exercise ${exercise_id} not found.`);

        if (sets) {
          for (const [i, s] of sets.entries()) {
            const weightError = validateWeight(s.weight);
            if (weightError) return toolError(`set_day_exercise_scheme failed: set ${i + 1} weight ${weightError}`);
            const repsError = validateReps(s.reps);
            if (repsError) return toolError(`set_day_exercise_scheme failed: set ${i + 1} reps ${repsError}`);
          }
        }

        const setEntries =
          sets && sets.length > 0 ? sets.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps })) : null;
        await setDayExerciseTarget(client, day_id, exercise_id, setEntries);
        return toolResult({ day_id, exercise_id, sets: setEntries });
      }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run api/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add api/mcp.ts api/mcp.test.ts
git commit -m "Add set_day_exercise_scheme MCP tool"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including every pre-existing test untouched by this plan.

- [ ] **Step 2: Run the full typecheck**

Run: `npm run typecheck`
Expected: no errors (`tsc --noEmit` for `src/`, `tsc -p tsconfig.api.json` for `api/`).

- [ ] **Step 3: Confirm RLS coverage against a real Supabase instance**

The design spec's "RLS coverage (no new migration expected)" conclusion is derived from reading migration files, not from running anything live — spot-check it before merging: apply `supabase/migrations/*.sql` to a scratch/staging Supabase project (or use the existing dev project if one is configured) and manually exercise each of the 8 tools once each as one user, plus one cross-user attempt (e.g. `rename_day_template` on another user's `day_id`), confirming the same not-found/error behavior the fake-table tests assert. Record the result in the handoff notes; if any policy gap surfaces, stop and report it rather than patching around it in `api/mcp.ts`.

- [ ] **Step 4: Report status per CLAUDE.md's conservative git profile**

Do not commit beyond the per-task commits already made, and do not push, without explicit user authorization. Run `git status` and `git log --oneline main..HEAD` and report them alongside a summary of what changed.
