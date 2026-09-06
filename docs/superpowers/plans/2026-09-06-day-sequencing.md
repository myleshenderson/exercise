# Day Sequencing ("Programs") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workout days be organized into named, one-time "programs" (ordered sequences) so the Home screen and MCP clients can surface "what's the next available day" per program, without blocking access to any other day.

**Architecture:** A new `programs` table plus `program_id`/`program_position` columns on `workout_days`. Availability (which day is "next") is computed on the fly from session history — never stored — in three places that must agree: a SQL CTE in the `get_day_templates` RPC (MCP), and a shared TypeScript helper used by both `src/data/mock.ts` and `src/data/supabase.ts` (the app's own Home-screen fetch path, which queries tables directly rather than via the RPC). Six new MCP write tools manage programs and day membership, mirroring the existing `add_exercise_to_day`/`remove_exercise_from_day`/`reorder_day_exercises` narrow-tool pattern.

**Tech Stack:** TypeScript, React, Vitest + Testing Library, Supabase/Postgres, `@modelcontextprotocol/sdk`, Zod.

**Spec:** `docs/superpowers/specs/2026-09-06-day-sequencing-design.md`

## Global Constraints

- A program is a **one-time linear progression, not a repeating rotation** — once every day in a program has a completed session, the program has nothing further to suggest (no wraparound).
- "Completed" means the same predicate `getLastSessionForDay` already uses: a session exists for that day with ≥1 exercise logged (checked via `session_sets`, not just `sessions` existing).
- Availability is **derived on every read, never stored** as a pointer — no write path may set an "available" or "current" flag directly.
- A day not assigned to any program (`program_id is null`) is **always available** — untracked-day behavior must be byte-for-byte unchanged from today.
- Program deletion is a **soft delete** (`deleted_at`), matching the `workout_days` precedent from `exercise-3y9`. Member days keep their `program_id`/`program_position` — deleting a program never touches its days.
- MCP write tools never accept `user_id` as a parameter — always `default auth.uid()` or implied by an RLS-checked row.
- New module-scope write functions in `src/data/supabase.ts` take `client: SupabaseClient` as their first parameter, matching every existing function in that file (`createDay`, `deleteDay`, etc.) — this is what lets `api/mcp.ts` call them with a per-request user-scoped client.

---

## Task 1: Migration — `programs` table, `workout_days` columns, `get_day_templates` RPC

**Files:**
- Create: `supabase/migrations/20260906180000_day_sequencing.sql`

**Interfaces:**
- Produces: table `programs(id, user_id, name, deleted_at, created_at)`; new columns `workout_days.program_id`, `workout_days.program_position`; updated RPC `public.get_day_templates()` returning the same columns as before plus `program_id`, `program_name`, `program_position`, `is_available`.

There's no automated test harness for real Postgres in this repo (RPC calls are mocked in `api/mcp.test.ts`; see Task 7/8). This migration is verified by inspection against the RLS/grant conventions already in the codebase, and — per the precedent in `docs/superpowers/specs/2026-09-05-mcp-day-template-writes-design.md`'s "RLS coverage" section — should be spot-checked against a real Supabase instance before merging.

- [ ] **Step 1: Write the migration file**

```sql
-- Day sequencing (exercise-w8s): programs group workout_days into an ordered,
-- one-time progression, not a repeating rotation (see the design doc's "Track
-- lifecycle" decision). program_id/program_position stay null for untracked
-- days, which behave exactly as before. Availability is derived, not stored:
-- get_day_templates computes each day's is_available on every call from actual
-- session history, so there is no separate pointer that can drift.

create table programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table programs enable row level security;

-- This table postdates 0002's blanket grant (which only covered tables that
-- existed at the time it ran — see 20260906151951_scheme_history.sql's comment
-- for the same gotcha), so it needs its own explicit grant.
grant select, insert, update, delete on programs to authenticated;

create policy "own_select" on programs for select using (user_id = auth.uid());
create policy "own_insert" on programs for insert with check (user_id = auth.uid());
create policy "own_update" on programs for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own_delete" on programs for delete using (user_id = auth.uid());

alter table workout_days
  add column program_id uuid references programs(id) on delete set null,
  add column program_position int;

-- Positions only need to be unique within a program; untracked days (program_id
-- null) must be free to all share program_position null, so this is a partial
-- index rather than a plain unique constraint over both columns.
create unique index workout_days_program_position_uq
  on workout_days (program_id, program_position) where program_id is not null;

create or replace function public.get_day_templates()
returns table (
  workout_day_id uuid,
  workout_day_name text,
  workout_day_position int,
  program_id uuid,
  program_name text,
  program_position int,
  is_available boolean,
  exercise_id uuid,
  exercise_name text,
  exercise_cue text,
  exercise_position int,
  target_sets jsonb,
  uses_default_scheme boolean,
  default_sets int,
  default_rep_low int,
  default_rep_high int
)
language sql
stable
security invoker
set search_path = public
as $$
  with day_done as (
    select distinct s.workout_day_id
    from sessions s
    join session_sets ss on ss.session_id = s.id
    where s.workout_day_id is not null
  ),
  program_next as (
    select wd.program_id, min(wd.program_position) as next_position
    from workout_days wd
    left join day_done dd on dd.workout_day_id = wd.id
    where wd.program_id is not null and wd.deleted_at is null and dd.workout_day_id is null
    group by wd.program_id
  )
  select wd.id                                                 as workout_day_id,
         wd.name                                                as workout_day_name,
         wd.position                                            as workout_day_position,
         p.id                                                   as program_id,
         p.name                                                 as program_name,
         wd.program_position                                    as program_position,
         (p.id is null or wd.program_position = pn.next_position) as is_available,
         e.id                                                   as exercise_id,
         e.name                                                 as exercise_name,
         e.cue                                                  as exercise_cue,
         wde.position                                           as exercise_position,
         wde.target_sets                                        as target_sets,
         wde.target_sets is null                                as uses_default_scheme,
         e.default_sets                                         as default_sets,
         e.default_rep_low                                      as default_rep_low,
         e.default_rep_high                                     as default_rep_high
  from workout_days wd
  left join programs p on p.id = wd.program_id and p.deleted_at is null
  left join program_next pn on pn.program_id = p.id
  left join workout_day_exercises wde on wde.workout_day_id = wd.id
  left join exercises e on e.id = wde.exercise_id
  where wd.deleted_at is null
  order by wd.position, wde.position;
$$;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Sanity-check the file parses as valid SQL syntax**

Run: `node -e "require('fs').readFileSync('supabase/migrations/20260906180000_day_sequencing.sql','utf8')"` (just confirms the file is readable/saved; there is no local Postgres to actually apply it against in this environment — CI's `migrate` job applies it on merge, per `exercise-4ly`).
Expected: no error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260906180000_day_sequencing.sql
git commit -m "exercise-w8s: Add programs table and day-sequencing columns"
```

---

## Task 2: Types — `Program`, extended `WorkoutDay`, seed data

**Files:**
- Modify: `src/types.ts`
- Modify: `src/data/seed.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Program { id: string; name: string; }
  export interface WorkoutDay {
    id: string;
    name: string;
    position: number;
    exerciseIds: string[];
    programId: string | null;
    programPosition: number | null;
    programName: string | null;
    isAvailable: boolean;
  }
  ```
- `WorkoutDay` here is the **read/view shape** returned by `DataLayer.getWorkoutDays()` and `DataLayer.createDay()`. `programName`/`isAvailable` are always computed at read time (see Task 4/5) — never stored as mutable fields on an in-memory or DB record, since storing them would reintroduce the "stored pointer that can drift" problem the design explicitly rejected. `src/data/mock.ts` and `src/data/supabase.ts` internally track only `id/name/position/exerciseIds/programId/programPosition` for a day; they build the full `WorkoutDay` (with `programName`/`isAvailable` filled in) only when returning it.

This task has no independent runtime behavior to test — it's a type/data change consumed by Tasks 4–5. Verify via typecheck.

- [ ] **Step 1: Add `Program` and extend `WorkoutDay` in `src/types.ts`**

Replace lines 10-15 of `src/types.ts`:

```ts
export interface Program {
  id: string;
  name: string;
}

export interface WorkoutDay {
  id: string;
  name: string;
  position: number;
  exerciseIds: string[]; // ordered
  programId: string | null;
  programPosition: number | null;
  programName: string | null; // null when programId is null, or when the program is soft-deleted
  isAvailable: boolean; // always true when programId is null; for a programmed day, true only for that program's current suggested day
}
```

- [ ] **Step 2: Update the two seed days in `src/data/seed.ts` to satisfy the new shape**

In `src/data/seed.ts`, change the `seedDays` array (currently lines 20-29) to:

```ts
export const seedDays: WorkoutDay[] = [
  {
    id: "leg-day", name: "Leg Day", position: 0,
    exerciseIds: ["leg-press", "leg-curl", "leg-extension", "seated-calf-raise", "hip-thrust", "core-crunch"],
    programId: null, programPosition: null, programName: null, isAvailable: true,
  },
  {
    id: "upper-day", name: "Upper Day", position: 1,
    exerciseIds: ["chest-press", "seated-row", "shoulder-press", "lat-pulldown", "lateral-raise", "triceps-pushdown"],
    programId: null, programPosition: null, programName: null, isAvailable: true,
  },
];
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails with errors in `src/data/mock.ts` and `src/data/supabase.ts` (their `createDay`/`getWorkoutDays` return objects no longer satisfy `WorkoutDay`) — this is expected; Tasks 4 and 5 fix them. Confirm the *only* errors are in those two files (nothing unexpected broke).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/data/seed.ts
git commit -m "exercise-w8s: Add Program type and extend WorkoutDay with program fields"
```

---

## Task 3: Shared derivation helper — `src/lib/programAvailability.ts`

**Files:**
- Create: `src/lib/programAvailability.ts`
- Test: `src/lib/programAvailability.test.ts`

**Interfaces:**
- Consumes: nothing outside this file.
- Produces:
  ```ts
  export interface DayForAvailability {
    id: string;
    programId: string | null;
    programPosition: number | null;
  }
  export function nextAvailablePositionByProgram(
    days: DayForAvailability[],
    completedDayIds: ReadonlySet<string>,
  ): Map<string, number>;
  export function isDayAvailable(day: DayForAvailability, nextByProgram: ReadonlyMap<string, number>): boolean;
  ```
  Both `src/data/mock.ts` (Task 4) and `src/data/supabase.ts` (Task 5) import these two functions so the two `DataLayer` backends compute availability identically.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/programAvailability.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { nextAvailablePositionByProgram, isDayAvailable, type DayForAvailability } from "./programAvailability";

describe("nextAvailablePositionByProgram / isDayAvailable", () => {
  test("an untracked day (programId null) is always available", () => {
    const day: DayForAvailability = { id: "d1", programId: null, programPosition: null };
    const next = nextAvailablePositionByProgram([day], new Set());
    expect(isDayAvailable(day, next)).toBe(true);
  });

  test("an empty (no completions) program makes its first position available, others not", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
      { id: "d3", programId: "p1", programPosition: 2 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set());
    expect(isDayAvailable(days[0], next)).toBe(true);
    expect(isDayAvailable(days[1], next)).toBe(false);
    expect(isDayAvailable(days[2], next)).toBe(false);
  });

  test("a partially completed program surfaces the first incomplete day", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
      { id: "d3", programId: "p1", programPosition: 2 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set(["d1"]));
    expect(isDayAvailable(days[0], next)).toBe(false);
    expect(isDayAvailable(days[1], next)).toBe(true);
    expect(isDayAvailable(days[2], next)).toBe(false);
  });

  test("a fully completed program has no available day — no wraparound", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set(["d1", "d2"]));
    expect(isDayAvailable(days[0], next)).toBe(false);
    expect(isDayAvailable(days[1], next)).toBe(false);
  });

  test("two independent programs don't affect each other", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
      { id: "d3", programId: "p2", programPosition: 0 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set(["d1"]));
    expect(isDayAvailable(days[1], next)).toBe(true); // p1 advanced
    expect(isDayAvailable(days[2], next)).toBe(true); // p2 untouched, still at its own start
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/programAvailability.test.ts`
Expected: FAIL — `Cannot find module './programAvailability'`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/programAvailability.ts`:

```ts
export interface DayForAvailability {
  id: string;
  programId: string | null;
  programPosition: number | null;
}

// For each program, the "available" day is the lowest programPosition whose
// day has never been completed. A program is a one-time progression, not a
// repeating rotation (see the design doc's "Track lifecycle" decision) — once
// every day is completed, the program has no entry here and nothing is
// suggested (no wraparound).
export function nextAvailablePositionByProgram(
  days: DayForAvailability[],
  completedDayIds: ReadonlySet<string>,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const day of days) {
    if (day.programId === null || day.programPosition === null) continue;
    if (completedDayIds.has(day.id)) continue;
    const current = next.get(day.programId);
    if (current === undefined || day.programPosition < current) {
      next.set(day.programId, day.programPosition);
    }
  }
  return next;
}

export function isDayAvailable(day: DayForAvailability, nextByProgram: ReadonlyMap<string, number>): boolean {
  if (day.programId === null) return true;
  return nextByProgram.get(day.programId) === day.programPosition;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/programAvailability.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/programAvailability.ts src/lib/programAvailability.test.ts
git commit -m "exercise-w8s: Add shared program-availability derivation helper"
```

---

## Task 4: `DataLayer` interface + `mock.ts` implementation

**Files:**
- Modify: `src/data/DataLayer.ts`
- Modify: `src/data/mock.ts`
- Test: `src/data/mock.test.ts`

**Interfaces:**
- Consumes: `nextAvailablePositionByProgram`, `isDayAvailable` from `src/lib/programAvailability.ts` (Task 3); `Program`, extended `WorkoutDay` from `src/types.ts` (Task 2).
- Produces (added to `DataLayer`):
  ```ts
  createProgram(name: string): Promise<Program>;
  renameProgram(programId: string, name: string): Promise<void>;
  deleteProgram(programId: string): Promise<void>;
  addDayToProgram(dayId: string, programId: string): Promise<void>;
  removeDayFromProgram(dayId: string): Promise<void>;
  reorderProgramDays(programId: string, dayIds: string[]): Promise<void>;
  ```
  `getWorkoutDays()`'s return type is now the extended `WorkoutDay` (unchanged signature, richer shape).

- [ ] **Step 1: Add the six methods to the `DataLayer` interface**

In `src/data/DataLayer.ts`, add `import type { Program, ... }` to the existing type import line, and add after `updateDayName(dayId: string, name: string): Promise<void>;` (line 21):

```ts
  createProgram(name: string): Promise<Program>;
  renameProgram(programId: string, name: string): Promise<void>;
  deleteProgram(programId: string): Promise<void>;
  addDayToProgram(dayId: string, programId: string): Promise<void>;
  removeDayFromProgram(dayId: string): Promise<void>;
  reorderProgramDays(programId: string, dayIds: string[]): Promise<void>;
```

(Full updated import line: `import type { Exercise, WorkoutDay, Session, SetEntry, Program } from "../types.js";`)

- [ ] **Step 2: Write the failing tests**

Add to `src/data/mock.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/data/mock.test.ts`
Expected: FAIL — `db.createProgram is not a function` (and the existing seed-based tests may also start failing on shape mismatches; that's expected until Step 4).

- [ ] **Step 4: Implement in `src/data/mock.ts`**

Add the import at the top:

```ts
import { nextAvailablePositionByProgram, isDayAvailable } from "../lib/programAvailability";
import type { Exercise, WorkoutDay, Session, SetEntry, Program } from "../types";
```

Change the internal day storage type (currently `const days: WorkoutDay[] = ...`) to a narrower stored shape, since `programName`/`isAvailable` must never be stored — only computed at read time:

```ts
type StoredDay = Omit<WorkoutDay, "programName" | "isAvailable">;
```

Then, inside `createMockDataLayer`, change:

```ts
  const days: WorkoutDay[] = useSeed ? structuredClone(seedDays) : [];
```

to:

```ts
  const days: StoredDay[] = useSeed ? structuredClone(seedDays) : [];
  const programs: Program[] = [];
```

Update `createDay` (currently `days.push({ id: nextId("day"), name, position: days.length, exerciseIds: [] })`) to include the new stored fields:

```ts
    async createDay(name) {
      const day: StoredDay = { id: nextId("day"), name, position: days.length, exerciseIds: [], programId: null, programPosition: null };
      days.push(day);
      return { ...day, programName: null, isAvailable: true };
    },
```

Replace `getWorkoutDays` (currently returns `days.slice().sort(...)`) to compute availability fresh on every call:

```ts
    async getWorkoutDays() {
      const completed = new Set(
        sessions.filter((s) => s.workoutDayId !== null && s.exercises.length > 0).map((s) => s.workoutDayId as string),
      );
      const nextByProgram = nextAvailablePositionByProgram(days, completed);
      return days
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((d) => {
          const program = d.programId ? programs.find((p) => p.id === d.programId) ?? null : null;
          return {
            ...d,
            programName: program ? program.name : null,
            isAvailable: isDayAvailable(d, nextByProgram),
          };
        });
    },
```

Add the six new methods (anywhere in the returned object, e.g. after `updateDayName`):

```ts
    async createProgram(name) {
      const program: Program = { id: nextId("program"), name };
      programs.push(program);
      return program;
    },
    async renameProgram(programId, name) {
      const program = programs.find((p) => p.id === programId);
      if (program) program.name = name;
    },
    async deleteProgram(programId) {
      const idx = programs.findIndex((p) => p.id === programId);
      if (idx !== -1) programs.splice(idx, 1);
    },
    async addDayToProgram(dayId, programId) {
      const day = days.find((d) => d.id === dayId);
      if (!day) return;
      const maxPosition = days
        .filter((d) => d.programId === programId)
        .reduce((max, d) => Math.max(max, d.programPosition ?? -1), -1);
      day.programId = programId;
      day.programPosition = maxPosition + 1;
    },
    async removeDayFromProgram(dayId) {
      const day = days.find((d) => d.id === dayId);
      if (day) {
        day.programId = null;
        day.programPosition = null;
      }
    },
    async reorderProgramDays(programId, dayIds) {
      dayIds.forEach((dayId, index) => {
        const day = days.find((d) => d.id === dayId && d.programId === programId);
        if (day) day.programPosition = index;
      });
    },
```

Note: `deleteProgram` here removes the program from the in-memory `programs` array entirely rather than soft-deleting with a `deletedAt` field, since `mock.ts` has no other soft-delete precedent to mirror (unlike `supabase.ts`, which mirrors the real `deleted_at` column). Once a program is gone from `programs`, `getWorkoutDays()` must treat its former member days as untracked for availability purposes too — a day whose `programId` no longer resolves to a live program is not "in a program" any more. Use this final version of `getWorkoutDays` (replacing the earlier draft above), which computes an "effective" program id per day (keyed by day id, not array position, so it stays correct regardless of sort order) before deriving availability:

```ts
    async getWorkoutDays() {
      const completed = new Set(
        sessions.filter((s) => s.workoutDayId !== null && s.exercises.length > 0).map((s) => s.workoutDayId as string),
      );
      const livingProgramIds = new Set(programs.map((p) => p.id));
      const effectiveProgramIdByDay = new Map(
        days.map((d) => [d.id, d.programId && livingProgramIds.has(d.programId) ? d.programId : null]),
      );
      const availabilityInput = days.map((d) => ({ id: d.id, programId: effectiveProgramIdByDay.get(d.id)!, programPosition: d.programPosition }));
      const nextByProgram = nextAvailablePositionByProgram(availabilityInput, completed);
      return days
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((d) => {
          const effectiveProgramId = effectiveProgramIdByDay.get(d.id)!;
          const program = effectiveProgramId ? programs.find((p) => p.id === effectiveProgramId) ?? null : null;
          return {
            ...d,
            // Override, don't just spread ...d: once a program is deleted, its former
            // days must report programId/programPosition null too (matching
            // src/data/supabase.ts's getWorkoutDays, which nulls these the same way for
            // a day whose program_id points at a soft-deleted row) — not just programName.
            programId: effectiveProgramId,
            programPosition: effectiveProgramId ? d.programPosition : null,
            programName: program ? program.name : null,
            isAvailable: isDayAvailable({ id: d.id, programId: effectiveProgramId, programPosition: d.programPosition }, nextByProgram),
          };
        });
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/data/mock.test.ts`
Expected: PASS, including all pre-existing `mock.test.ts` tests (seeded days are untracked, so their `isAvailable`/`programName`/`programId`/`programPosition` fields are just additive — no existing assertion should break).

- [ ] **Step 6: Commit**

```bash
git add src/data/DataLayer.ts src/data/mock.ts src/data/mock.test.ts
git commit -m "exercise-w8s: Add program CRUD + derived availability to DataLayer/mock backend"
```

---

## Task 5: `supabase.ts` implementation

**Files:**
- Modify: `src/data/supabase.ts`
- Test: `src/data/supabase.test.ts`

**Interfaces:**
- Consumes: `nextAvailablePositionByProgram`, `isDayAvailable` from Task 3; `Program` from Task 2.
- Produces (module-scope, client-first-arg, matching `createDay`/`deleteDay` etc.):
  ```ts
  export async function createProgram(client: SupabaseClient, name: string): Promise<Program>
  export async function renameProgram(client: SupabaseClient, programId: string, name: string): Promise<void>
  export async function deleteProgram(client: SupabaseClient, programId: string): Promise<void>
  export async function addDayToProgram(client: SupabaseClient, dayId: string, programId: string): Promise<void>
  export async function removeDayFromProgram(client: SupabaseClient, dayId: string): Promise<void>
  export async function reorderProgramDays(client: SupabaseClient, programId: string, dayIds: string[]): Promise<void>
  ```
  These are imported directly by `api/mcp.ts` in Task 8, exactly like `createDay`/`deleteDay` are today.

- [ ] **Step 1: Write the failing tests**

Add to `src/data/supabase.test.ts`, alongside the existing `import` block (add `createProgram, renameProgram, deleteProgram, addDayToProgram, removeDayFromProgram, reorderProgramDays` to the import from `"./supabase"`):

```ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/data/supabase.test.ts`
Expected: FAIL — `createProgram is not exported`.

- [ ] **Step 3: Implement the module-scope functions in `src/data/supabase.ts`**

Add `Program` to the type import at the top (`import type { Exercise, WorkoutDay, Session, SetEntry, Program } from "../types.js";`), then add these functions (e.g. after `removeExerciseFromDay`, before `createSupabaseDataLayer`):

```ts
export async function createProgram(client: SupabaseClient, name: string): Promise<Program> {
  const { data, error } = await client.from("programs").insert({ name }).select("id, name").single();
  if (error) throw error;
  return { id: data.id, name: data.name };
}

export async function renameProgram(client: SupabaseClient, programId: string, name: string): Promise<void> {
  const { error } = await client.from("programs").update({ name }).eq("id", programId);
  if (error) throw error;
}

export async function deleteProgram(client: SupabaseClient, programId: string): Promise<void> {
  const { error } = await client.from("programs").update({ deleted_at: new Date().toISOString() }).eq("id", programId);
  if (error) throw error;
}

export async function addDayToProgram(client: SupabaseClient, dayId: string, programId: string): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_days")
    .select("program_position")
    .eq("program_id", programId)
    .order("program_position", { ascending: false })
    .limit(1);
  if (selectError) throw selectError;
  const nextPosition = existing && existing.length > 0 ? (existing[0].program_position as number) + 1 : 0;
  const { error } = await client
    .from("workout_days")
    .update({ program_id: programId, program_position: nextPosition })
    .eq("id", dayId);
  if (error) throw error;
}

export async function removeDayFromProgram(client: SupabaseClient, dayId: string): Promise<void> {
  const { error } = await client
    .from("workout_days")
    .update({ program_id: null, program_position: null })
    .eq("id", dayId);
  if (error) throw error;
}

// One update per day, not a delete-and-reinsert (contrast updateDayExercises):
// workout_days rows are the actual day identity that sessions reference by id,
// so they can never be recreated the way workout_day_exercises join rows can.
export async function reorderProgramDays(client: SupabaseClient, programId: string, dayIds: string[]): Promise<void> {
  for (const [index, dayId] of dayIds.entries()) {
    const { error } = await client
      .from("workout_days")
      .update({ program_position: index })
      .eq("id", dayId)
      .eq("program_id", programId);
    if (error) throw error;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/data/supabase.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `createDay` and `getWorkoutDays`' extended shape**

Add to the `describe("createDay", ...)` block in `src/data/supabase.test.ts`, replacing its existing single test:

```ts
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
```

`getWorkoutDays()` lives inside `createSupabaseDataLayer()`'s closure (it isn't a module-scope exported function like the others), so it's covered by the MCP-level fixtures instead — there is no existing unit-test seam for it in `supabase.test.ts` (same as today, where it's untested there). Its logic is exercised indirectly through Task 6's `Home.test.tsx` once `mock.ts`'s equivalent (already tested in Task 4) backs the app in tests. This is consistent with the existing gap: `supabase.test.ts`'s own file comment says it covers "exactly the `.from(table)...` chains `src/data/supabase.ts`'s write functions issue" — `getWorkoutDays` was never one of those.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/data/supabase.test.ts`
Expected: FAIL — returned object missing `programId`/`programPosition`/`programName`/`isAvailable`.

- [ ] **Step 7: Update `createDay` and `getWorkoutDays` in `src/data/supabase.ts`**

Change `createDay` (currently returns `{ id: data.id, name: data.name, position: data.position, exerciseIds: [] }`):

```ts
export async function createDay(client: SupabaseClient, name: string): Promise<WorkoutDay> {
  const { data, error } = await client.from("workout_days").insert({ name }).select("*").single();
  if (error) throw error;
  return {
    id: data.id, name: data.name, position: data.position, exerciseIds: [],
    programId: null, programPosition: null, programName: null, isAvailable: true,
  };
}
```

Add the import at the top of the file: `import { nextAvailablePositionByProgram, isDayAvailable } from "../lib/programAvailability.js";`

Replace `getWorkoutDays` inside `createSupabaseDataLayer()` (currently the `.from("workout_days").select("*").is("deleted_at", null).order("position")` block):

```ts
    async getWorkoutDays() {
      const { data } = await supabase.from("workout_days").select("*").is("deleted_at", null).order("position");
      const rows = data ?? [];

      const { data: programRows } = await supabase.from("programs").select("id, name").is("deleted_at", null);
      const programsById = new Map((programRows ?? []).map((p) => [p.id as string, p.name as string]));

      const { data: doneRows } = await supabase
        .from("sessions")
        .select("id, workout_day_id, session_sets!inner(id)")
        .not("workout_day_id", "is", null);
      const completed = new Set((doneRows ?? []).map((r) => r.workout_day_id as string));

      const availabilityInput = rows.map((d) => ({
        id: d.id as string,
        programId: d.program_id && programsById.has(d.program_id) ? (d.program_id as string) : null,
        programPosition: d.program_position as number | null,
      }));
      const nextByProgram = nextAvailablePositionByProgram(availabilityInput, completed);

      const days: WorkoutDay[] = [];
      for (const [i, d] of rows.entries()) {
        const { data: links } = await supabase
          .from("workout_day_exercises")
          .select("exercise_id, position")
          .eq("workout_day_id", d.id)
          .order("position");
        const effective = availabilityInput[i];
        days.push({
          id: d.id,
          name: d.name,
          position: d.position,
          exerciseIds: (links ?? []).map((l) => l.exercise_id),
          programId: effective.programId,
          programPosition: effective.programId ? (d.program_position as number) : null,
          programName: effective.programId ? programsById.get(effective.programId)! : null,
          isAvailable: isDayAvailable(effective, nextByProgram),
        });
      }
      return days;
    },
```

(The `session_sets!inner(id)` embedded-resource filter is Supabase/PostgREST's way of expressing "sessions that have at least one session_sets row" — the same "session with ≥1 exercise logged" predicate `getLastSessionForDay` uses elsewhere in this file, just phrased as a join filter instead of a per-row loop since we only need the *set* of days with any qualifying session, not the sessions themselves.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/data/supabase.test.ts`
Expected: PASS.

- [ ] **Step 9: Fix the ripple effect on `api/mcp.test.ts`'s existing `create_day_template` test**

`api/mcp.ts`'s `create_day_template` tool handler is untouched until Task 8, and today it does `const day = await createDay(...); return toolResult(day);` — forwarding the *entire* `day` object returned by `createDay`. Since Step 7 just changed what that object contains, the pre-existing test `"create_day_template creates a day owned by the caller and returns it"` in `api/mcp.test.ts` now receives extra fields it doesn't expect. Update its assertion (in the `describe("day template write tools", ...)` block) from:

```ts
      expect(day).toEqual({ id: expect.any(String), name: "Pull Day", position: 0, exerciseIds: [] });
```

to:

```ts
      expect(day).toEqual({
        id: expect.any(String), name: "Pull Day", position: 0, exerciseIds: [],
        programId: null, programPosition: null, programName: null, isAvailable: true,
      });
```

(Task 8 will change the handler itself to return a smaller, explicit subset instead of the raw `day` object — at which point this same assertion gets updated again.)

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. (This is the point where Task 2's Step 3 typecheck failures should now be fully resolved.)

- [ ] **Step 11: Commit**

```bash
git add src/data/supabase.ts src/data/supabase.test.ts api/mcp.test.ts
git commit -m "exercise-w8s: Implement program CRUD and derived availability in the Supabase backend"
```

---

## Task 6: Home screen — suggested day per program, collapsible group

**Files:**
- Modify: `src/screens/Home.tsx`
- Test: `src/screens/Home.test.tsx`

**Interfaces:**
- Consumes: `WorkoutDay.programId`, `.programName`, `.programPosition`, `.isAvailable` (Task 2/4/5).

- [ ] **Step 1: Write the failing tests**

Add to `src/screens/Home.test.tsx` (needs `db.createProgram`/`db.addDayToProgram` to seed program state — these hit the same `db` singleton the other tests already use):

```ts
test("a day with no program renders exactly as before, with no grouping affordance", async () => {
  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.queryByText(/show all/i)).not.toBeInTheDocument();
});

test("a program shows its available day prominently and collapses the rest behind a toggle", async () => {
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Prep Week 1");
  const d2 = await db.createDay("Prep Week 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);

  render(<MemoryRouter><Home /></MemoryRouter>);

  await waitFor(() => expect(screen.getByText("Prep Week 1")).toBeInTheDocument());
  expect(screen.queryByText("Prep Week 2")).not.toBeInTheDocument();
  expect(screen.getByText(/show all 2 days in prep phase/i)).toBeInTheDocument();

  fireEvent.click(screen.getByText(/show all 2 days in prep phase/i));
  expect(screen.getByText("Prep Week 2")).toBeInTheDocument();
});

test("the non-suggested day in an expanded program group is still tappable to start a session", async () => {
  // Distinct program/day names from the previous test: this file's mock `db` is a
  // shared singleton that accumulates state across tests (same convention the
  // pre-existing tests in this file already rely on), so reusing "Prep Phase"/
  // "Prep Week 1" here would make screen.getByText match two elements ambiguously.
  const program = await db.createProgram("Push Progression");
  const d1 = await db.createDay("Push Block 1");
  const d2 = await db.createDay("Push Block 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);
  const spy = vi.spyOn(db, "startSession");

  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Push Block 1")).toBeInTheDocument());
  fireEvent.click(screen.getByText(/show all 2 days in push progression/i));
  fireEvent.click(screen.getByText("Push Block 2"));

  await waitFor(() => expect(spy).toHaveBeenCalledWith(d2.id, expect.any(String)));
  spy.mockRestore();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/screens/Home.test.tsx`
Expected: FAIL — `db.createProgram is not a function` shouldn't happen (Task 4 already added it to the mock backend); instead expect failures on the "show all" text not being found, and `Prep Week 2` rendering unconditionally today (no collapsing exists yet).

- [ ] **Step 3: Implement grouping in `src/screens/Home.tsx`**

Replace the component body (from the `useState` declarations through the final `return`) — the date-handling `useEffect`s and `start()` function are unchanged; only the rendering below `days.map(...)` changes. Add one new piece of state and a grouping computation, then replace the render:

```tsx
export default function Home() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [lastByDay, setLastByDay] = useState<Record<string, string | null>>({});
  const [sessionForDate, setSessionForDate] = useState<Record<string, Session | null>>({});
  const [date, setDate] = useState(today());
  const [expandedPrograms, setExpandedPrograms] = useState<Record<string, boolean>>({});
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const ds = await db.getWorkoutDays();
      setDays(ds);
      const map: Record<string, string | null> = {};
      for (const d of ds) {
        const last = await db.getLastSessionForDay(d.id);
        map[d.id] = last ? last.performedOn : null;
      }
      setLastByDay(map);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSessionForDate({});
    (async () => {
      const entries = await Promise.all(
        days.map(async (d) => [d.id, await db.getSessionForDayAndDate(d.id, date)] as const),
      );
      if (cancelled) return;
      setSessionForDate(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [days, date]);

  async function start(dayId: string) {
    const existing = await db.getSessionForDayAndDate(dayId, date);
    const session = existing ?? (await db.startSession(dayId, date));
    navigate(`/session/${session.id}`);
  }

  function dayCard(d: WorkoutDay) {
    const existing = sessionForDate[d.id];
    const loggedCount = existing?.exercises.length ?? 0;

    let cardClass = "w-full rounded-xl border p-4 text-left active:bg-gray-100";
    let subtitleClass = "text-sm text-gray-500";
    let subtitle = lastByDay[d.id] ? `Last done ${formatSessionDate(lastByDay[d.id]!)}` : "Not done yet";
    let indicator: ReactNode = null;

    if (existing && loggedCount > 0) {
      cardClass = "w-full rounded-xl border border-green-200 bg-green-50 p-4 text-left active:bg-green-100";
      subtitleClass = "text-sm text-green-800";
      subtitle = `Resume · ${loggedCount} exercise${loggedCount === 1 ? "" : "s"} logged`;
      indicator = (
        <span aria-label="logged" className="shrink-0 text-green-600">
          ✓
        </span>
      );
    } else if (existing) {
      cardClass = "w-full rounded-xl border border-blue-200 bg-blue-50 p-4 text-left active:bg-blue-100";
      subtitleClass = "text-sm text-blue-800";
      subtitle = "In progress — resume";
      indicator = (
        <span aria-label="in progress" className="shrink-0 text-blue-600">
          ●
        </span>
      );
    }

    return (
      <button key={d.id} onClick={() => start(d.id)} className={cardClass}>
        <span className="flex items-center gap-2">
          <span className="block flex-1 text-lg font-semibold">{d.name}</span>
          {indicator}
        </span>
        <span className={`block ${subtitleClass}`}>{subtitle}</span>
      </button>
    );
  }

  const untracked = days.filter((d) => d.programId === null);
  const programGroups = new Map<string, { name: string; days: WorkoutDay[] }>();
  for (const d of days) {
    if (d.programId === null) continue;
    const group = programGroups.get(d.programId) ?? { name: d.programName ?? "", days: [] };
    group.days.push(d);
    programGroups.set(d.programId, group);
  }

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-2xl font-bold">Today's Workout</h1>
      <label className="block text-sm text-gray-500">
        Workout date
        <input
          aria-label="Workout date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onClick={(e) => {
            try {
              e.currentTarget.showPicker?.();
            } catch {
              /* showPicker unsupported / not allowed — fall back to default behavior */
            }
          }}
          className="mt-1 block w-full rounded-lg border p-2 text-base text-black"
        />
      </label>

      {[...programGroups.entries()].map(([programId, group]) => {
        const suggested = group.days.find((d) => d.isAvailable);
        const rest = group.days.filter((d) => d !== suggested).sort((a, b) => (a.programPosition ?? 0) - (b.programPosition ?? 0));
        const expanded = expandedPrograms[programId] ?? false;
        return (
          <div key={programId} className="space-y-2">
            {suggested && dayCard(suggested)}
            {rest.length > 0 && (
              <>
                <button
                  className="text-sm text-gray-500 underline"
                  onClick={() => setExpandedPrograms((prev) => ({ ...prev, [programId]: !expanded }))}
                >
                  {expanded ? "hide" : `show all ${group.days.length} days in ${group.name}`}
                </button>
                {expanded && <div className="space-y-2 opacity-70">{rest.map(dayCard)}</div>}
              </>
            )}
          </div>
        );
      })}

      {untracked.map(dayCard)}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/screens/Home.test.tsx`
Expected: PASS, including every pre-existing test in this file (untracked days render unchanged, since `programGroups` is empty for them and they render via the same `untracked.map(dayCard)` path using the identical `dayCard` logic as before).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/screens/Home.tsx src/screens/Home.test.tsx
git commit -m "exercise-w8s: Surface suggested day per program on the Home screen"
```

---

## Task 7: MCP tools — `create_program`, `rename_program`, `delete_program`

**Files:**
- Modify: `api/mcp.ts`
- Test: `api/mcp.test.ts`

**Interfaces:**
- Consumes: `createProgram`, `renameProgram`, `deleteProgram` from `src/data/supabase.ts` (Task 5).
- Produces: a `findProgram` helper (mirroring `findDay`/`findExercise`) for Task 8 to reuse; three new registered tools.

- [ ] **Step 1: Write the failing tests**

Add to `api/mcp.test.ts`. First, extend the fake-table plumbing: change the `FakeTableName` union (line 29) to include `"programs"`:

```ts
type FakeTableName = "workout_days" | "exercises" | "workout_day_exercises" | "workout_day_exercise_scheme_history" | "programs";
```

and add `programs: []` to the `TABLES` object (line 31-36), and `TABLES.programs.length = 0;` to the `beforeEach` reset block (alongside the other three `.length = 0` lines around line 374-377). Add a seed helper near `seedDay`/`seedExercise`:

```ts
function seedProgram(userId: string, id: string, name: string, deletedAt: string | null = null): FakeRow {
  const row: FakeRow = { id, user_id: userId, name, deleted_at: deletedAt };
  TABLES.programs.push(row);
  return row;
}
```

Then add a new `describe` block, inside the existing `describe("api/mcp handler", ...)`, alongside `describe("day template write tools", ...)`:

```ts
  describe("program write tools", () => {
    it("create_program creates a program owned by the caller and returns it", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "create_program", arguments: { name: "Prep Phase" } });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      const program = JSON.parse(content.text);
      expect(program).toEqual({ id: expect.any(String), name: "Prep Phase" });
      expect(TABLES.programs.find((p) => p.id === program.id)?.user_id).toBe("user-a");

      await client.close();
    });

    it("rename_program renames an existing program", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_program", arguments: { program_id: "prog-a", name: "Prep Phase (v2)" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.programs.find((p) => p.id === "prog-a")?.name).toBe("Prep Phase (v2)");

      await client.close();
    });

    it("rename_program errors clearly on a nonexistent program id", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_program", arguments: { program_id: "no-such-program", name: "X" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "rename_program failed: Program no-such-program not found." }]);

      await client.close();
    });

    it("rename_program cannot rename another user's program", async () => {
      seedProgram("user-b", "prog-b", "Pull Progression");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "rename_program", arguments: { program_id: "prog-b", name: "Hijacked" } });

      expect(result.isError).toBe(true);
      expect(TABLES.programs.find((p) => p.id === "prog-b")?.name).toBe("Pull Progression");

      await client.close();
    });

    it("delete_program soft-deletes and leaves member days' program assignment untouched", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      TABLES.workout_days[0].program_id = "prog-a";
      TABLES.workout_days[0].program_position = 0;
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "delete_program", arguments: { program_id: "prog-a" } });

      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ id: "prog-a", name: "Prep Phase", deleted: true }, null, 2) }]);
      expect(TABLES.programs.find((p) => p.id === "prog-a")?.deleted_at).toEqual(expect.any(String));
      expect(TABLES.workout_days[0].program_id).toBe("prog-a");
      expect(TABLES.workout_days[0].program_position).toBe(0);

      await client.close();
    });

    it("delete_program treats an already-deleted program id as not found", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase", "2026-09-01T00:00:00.000Z");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "delete_program", arguments: { program_id: "prog-a" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "delete_program failed: Program prog-a not found." }]);

      await client.close();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run api/mcp.test.ts -t "program write tools"`
Expected: FAIL — `create_program` is not a registered tool.

- [ ] **Step 3: Implement in `api/mcp.ts`**

Add the three new functions to the existing import from `../src/data/supabase.js` (line 9-18):

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
  createProgram,
  renameProgram,
  deleteProgram,
} from "../src/data/supabase.js";
```

Add a `findProgram` helper right after `findExercise` (around line 82-85):

```ts
async function findProgram(client: SupabaseClient, programId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await client
    .from("programs")
    .select("id, name")
    .eq("id", programId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { id: string; name: string } | null) ?? null;
}
```

Register the three tools (e.g. right after the `set_day_exercise_scheme` tool, before `return server;`):

```ts
  server.registerTool(
    "create_program",
    {
      title: "Create program",
      description: "Creates a new, empty program for the authenticated user. Returns it, including its id.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) =>
      withWriteTool("create_program", async (accessToken) => {
        const program = await createProgram(createUserScopedClient(accessToken), name);
        return toolResult(program);
      }),
  );

  server.registerTool(
    "rename_program",
    {
      title: "Rename program",
      description: "Renames an existing program belonging to the authenticated user, targeted by id.",
      inputSchema: { program_id: z.string(), name: z.string() },
    },
    async ({ program_id, name }) =>
      withWriteTool("rename_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`rename_program failed: Program ${program_id} not found.`);
        await renameProgram(client, program_id, name);
        return toolResult({ id: program.id, name });
      }),
  );

  server.registerTool(
    "delete_program",
    {
      title: "Delete program",
      description:
        "Soft-deletes a program belonging to the authenticated user, targeted by id: it's no longer a valid target for other program tools, but member days keep their program_id/program_position (not unassigned), so the program's structure and completion history survive and get_day_templates treats its former days as untracked (always available) in the meantime.",
      inputSchema: { program_id: z.string() },
    },
    async ({ program_id }) =>
      withWriteTool("delete_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`delete_program failed: Program ${program_id} not found.`);
        await deleteProgram(client, program_id);
        return toolResult({ id: program.id, name: program.name, deleted: true });
      }),
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run api/mcp.test.ts -t "program write tools"`
Expected: PASS.

- [ ] **Step 5: Update the tool-listing tests**

The two tests asserting the full sorted tool-name list (`"lists the progression..."` and `"lists tools with no Authorization header..."`) need `"create_program"`, `"rename_program"`, and `"delete_program"` inserted (alphabetically) into both expected arrays — e.g. `create_program` goes right after `create_exercise` and before `delete_day_template`; `delete_program` goes right after `delete_day_template`; `rename_program` goes right after `remove_exercise_from_day` and before `reorder_day_exercises`. Update both occurrences.

- [ ] **Step 6: Run the full MCP test file and typecheck**

Run: `npx vitest run api/mcp.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/mcp.ts api/mcp.test.ts
git commit -m "exercise-w8s: Add create_program/rename_program/delete_program MCP tools"
```

---

## Task 8: MCP tools — day/program membership + `create_day_template` extension

**Files:**
- Modify: `api/mcp.ts`
- Test: `api/mcp.test.ts`

**Interfaces:**
- Consumes: `findProgram` (Task 7); `addDayToProgram`, `removeDayFromProgram`, `reorderProgramDays` from `src/data/supabase.ts` (Task 5).

- [ ] **Step 1: Extend `findDay` to expose `program_id`**

In `api/mcp.ts`, change `findDay` (needed so `add_day_to_program` can check whether a day is already assigned):

```ts
async function findDay(
  client: SupabaseClient,
  dayId: string,
): Promise<{ id: string; name: string; position: number; program_id: string | null } | null> {
  const { data } = await client
    .from("workout_days")
    .select("id, name, position, program_id")
    .eq("id", dayId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { id: string; name: string; position: number; program_id: string | null } | null) ?? null;
}
```

- [ ] **Step 2: Write the failing tests**

Add to the `describe("program write tools", ...)` block from Task 7:

```ts
    it("add_day_to_program assigns an untracked day to a program at position 0", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_day_to_program", arguments: { day_id: "day-a", program_id: "prog-a" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_days[0]).toMatchObject({ program_id: "prog-a", program_position: 0 });

      await client.close();
    });

    it("add_day_to_program appends after the current highest program_position", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      seedDay("user-a", "day-b", "Week 2");
      TABLES.workout_days[0].program_id = "prog-a";
      TABLES.workout_days[0].program_position = 0;
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_day_to_program", arguments: { day_id: "day-b", program_id: "prog-a" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_days.find((d) => d.id === "day-b")).toMatchObject({ program_id: "prog-a", program_position: 1 });

      await client.close();
    });

    it("add_day_to_program rejects a day that's already in a program", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      TABLES.workout_days[0].program_id = "prog-a";
      TABLES.workout_days[0].program_position = 0;
      seedProgram("user-a", "prog-b", "Other Phase");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_day_to_program", arguments: { day_id: "day-a", program_id: "prog-b" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "add_day_to_program failed: Day day-a is already in program prog-a; remove it first." },
      ]);

      await client.close();
    });

    it("add_day_to_program errors on a nonexistent program id", async () => {
      seedDay("user-a", "day-a", "Week 1");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_day_to_program", arguments: { day_id: "day-a", program_id: "no-such-program" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "add_day_to_program failed: Program no-such-program not found." },
      ]);

      await client.close();
    });

    it("add_day_to_program cannot attach another user's day", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-b", "day-b", "Week 1");
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "add_day_to_program", arguments: { day_id: "day-b", program_id: "prog-a" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "add_day_to_program failed: Day template day-b not found." }]);

      await client.close();
    });

    it("remove_day_from_program clears assignment", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      TABLES.workout_days[0].program_id = "prog-a";
      TABLES.workout_days[0].program_position = 0;
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "remove_day_from_program", arguments: { day_id: "day-a" } });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_days[0]).toMatchObject({ program_id: null, program_position: null });

      await client.close();
    });

    it("reorder_program_days rewrites order for the program's current membership", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      seedDay("user-a", "day-b", "Week 2");
      TABLES.workout_days[0].program_id = "prog-a";
      TABLES.workout_days[0].program_position = 0;
      TABLES.workout_days[1].program_id = "prog-a";
      TABLES.workout_days[1].program_position = 1;
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_program_days",
        arguments: { program_id: "prog-a", day_ids: ["day-b", "day-a"] },
      });

      expect(result.isError).not.toBe(true);
      expect(TABLES.workout_days.find((d) => d.id === "day-b")?.program_position).toBe(0);
      expect(TABLES.workout_days.find((d) => d.id === "day-a")?.program_position).toBe(1);

      await client.close();
    });

    it("reorder_program_days rejects a list missing a current member", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      seedDay("user-a", "day-b", "Week 2");
      TABLES.workout_days[0].program_id = "prog-a";
      TABLES.workout_days[0].program_position = 0;
      TABLES.workout_days[1].program_id = "prog-a";
      TABLES.workout_days[1].program_position = 1;
      const client = await connectAs("token-a");

      const result = await client.callTool({
        name: "reorder_program_days",
        arguments: { program_id: "prog-a", day_ids: ["day-a"] },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text:
            "reorder_program_days failed: day_ids missing [day-b]. Use add_day_to_program/remove_day_from_program to change membership instead.",
        },
      ]);

      await client.close();
    });

    it("create_day_template with program_id appends the new day into that program", async () => {
      seedProgram("user-a", "prog-a", "Prep Phase");
      seedDay("user-a", "day-a", "Week 1");
      TABLES.workout_days[0].program_id = "prog-a";
      TABLES.workout_days[0].program_position = 0;
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "create_day_template", arguments: { name: "Week 2", program_id: "prog-a" } });

      expect(result.isError).not.toBe(true);
      const [content] = result.content as [{ type: "text"; text: string }];
      const day = JSON.parse(content.text);
      expect(TABLES.workout_days.find((d) => d.id === day.id)).toMatchObject({ program_id: "prog-a", program_position: 1 });

      await client.close();
    });

    it("create_day_template errors on a nonexistent program_id without creating the day", async () => {
      const client = await connectAs("token-a");

      const result = await client.callTool({ name: "create_day_template", arguments: { name: "Week 1", program_id: "no-such-program" } });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "create_day_template failed: Program no-such-program not found." },
      ]);
      expect(TABLES.workout_days).toHaveLength(0);

      await client.close();
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run api/mcp.test.ts -t "program write tools"`
Expected: FAIL — the new tools don't exist yet, and `create_day_template`'s schema doesn't accept `program_id`.

- [ ] **Step 4: Add the three membership tools and extend `create_day_template`**

Add `addDayToProgram, removeDayFromProgram, reorderProgramDays` to the existing import from `../src/data/supabase.js`.

Replace the existing `create_day_template` registration with:

```ts
  server.registerTool(
    "create_day_template",
    {
      title: "Create day template",
      description:
        "Creates a new, empty day template for the authenticated user. Returns the new day, including its id. If program_id is given, appends the day to the end of that program.",
      inputSchema: { name: z.string(), program_id: z.string().optional() },
    },
    async ({ name, program_id }) =>
      withWriteTool("create_day_template", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        if (program_id) {
          const program = await findProgram(client, program_id);
          if (!program) return toolError(`create_day_template failed: Program ${program_id} not found.`);
        }
        const day = await createDay(client, name);
        if (program_id) await addDayToProgram(client, day.id, program_id);
        // Explicit subset, not the raw `day` object: `day.programPosition`/`programName`/
        // `isAvailable` reflect its state from BEFORE the addDayToProgram call above (createDay
        // always returns an untracked day), so they'd be stale/wrong here. programId is the one
        // piece of program state worth echoing back, and is known directly from the input.
        return toolResult({ id: day.id, name: day.name, position: day.position, exerciseIds: day.exerciseIds, programId: program_id ?? null });
      }),
  );
```

Add the three new tools after `delete_program` (from Task 7):

```ts
  server.registerTool(
    "add_day_to_program",
    {
      title: "Add day to program",
      description:
        "Assigns an existing day template to a program, appended at the end. Errors if the day already belongs to a program; use remove_day_from_program first to reassign it.",
      inputSchema: { day_id: z.string(), program_id: z.string() },
    },
    async ({ day_id, program_id }) =>
      withWriteTool("add_day_to_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`add_day_to_program failed: Day template ${day_id} not found.`);
        if (day.program_id) {
          return toolError(`add_day_to_program failed: Day ${day_id} is already in program ${day.program_id}; remove it first.`);
        }
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`add_day_to_program failed: Program ${program_id} not found.`);
        await addDayToProgram(client, day_id, program_id);
        return toolResult({ day_id, program_id });
      }),
  );

  server.registerTool(
    "remove_day_from_program",
    {
      title: "Remove day from program",
      description: "Clears a day template's program assignment, reverting it to untracked (always available).",
      inputSchema: { day_id: z.string() },
    },
    async ({ day_id }) =>
      withWriteTool("remove_day_from_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`remove_day_from_program failed: Day template ${day_id} not found.`);
        await removeDayFromProgram(client, day_id);
        return toolResult({ day_id, removed: true });
      }),
  );

  server.registerTool(
    "reorder_program_days",
    {
      title: "Reorder program days",
      description:
        "Rewrites a program's day order for the authenticated user. day_ids must be exactly the program's current membership (same members, any order); membership changes must go through add_day_to_program/remove_day_from_program instead.",
      inputSchema: { program_id: z.string(), day_ids: z.array(z.string()) },
    },
    async ({ program_id, day_ids }) =>
      withWriteTool("reorder_program_days", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`reorder_program_days failed: Program ${program_id} not found.`);

        if (new Set(day_ids).size !== day_ids.length) {
          return toolError(`reorder_program_days failed: day_ids contains duplicate ids.`);
        }

        const { data: current, error: selectError } = await client
          .from("workout_days")
          .select("id")
          .eq("program_id", program_id)
          .is("deleted_at", null);
        if (selectError) return toolError(`reorder_program_days failed: ${selectError.message}`);

        const currentIds = new Set((current ?? []).map((r: { id: string }) => r.id));
        const requestedIds = new Set(day_ids);
        const missing = [...currentIds].filter((id) => !requestedIds.has(id));
        const extra = [...requestedIds].filter((id) => !currentIds.has(id));
        if (missing.length || extra.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`missing [${missing.join(", ")}]`);
          if (extra.length) parts.push(`unexpected [${extra.join(", ")}]`);
          return toolError(
            `reorder_program_days failed: day_ids ${parts.join(" and ")}. Use add_day_to_program/remove_day_from_program to change membership instead.`,
          );
        }

        await reorderProgramDays(client, program_id, day_ids);
        return toolResult({ program_id, day_ids });
      }),
  );
```

- [ ] **Step 5: Update the pre-existing `create_day_template` response-shape test again**

Step 4 changed the handler to return an explicit subset (`{id, name, position, exerciseIds, programId}`) instead of the raw `day` object from Task 5's Step 9 fix. Update the same assertion in `api/mcp.test.ts` once more, from:

```ts
      expect(day).toEqual({
        id: expect.any(String), name: "Pull Day", position: 0, exerciseIds: [],
        programId: null, programPosition: null, programName: null, isAvailable: true,
      });
```

to:

```ts
      expect(day).toEqual({ id: expect.any(String), name: "Pull Day", position: 0, exerciseIds: [], programId: null });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run api/mcp.test.ts -t "program write tools|create_day_template"`
Expected: PASS.

- [ ] **Step 7: Update the tool-listing tests again**

Insert `"add_day_to_program"` and `"reorder_program_days"` and `"remove_day_from_program"` (alphabetically) into both full tool-list assertions from Task 7 Step 5 (`add_day_to_program` goes right before `add_exercise_to_day`; `remove_day_from_program` goes right after `remove_exercise_from_day` and before `rename_day_template`; `reorder_program_days` goes right after `reorder_day_exercises`).

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — every test file in the repo, including the untouched RPC-fixture tests (`get_day_templates`'s fixture-based assertions are unaffected since fixtures are static JSON, not derived).

- [ ] **Step 9: Commit**

```bash
git add api/mcp.ts api/mcp.test.ts
git commit -m "exercise-w8s: Add day/program membership MCP tools and extend create_day_template"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: every success criterion in the design doc maps to a task — schema (Task 1), untracked-day parity (Tasks 4/5's "always available" tests, Task 6's "renders exactly as before" test), completion advancing suggestion (Task 4's availability tests), Home screen surfacing (Task 6), MCP read exposure (Task 1's RPC — `get_day_templates`'s tool wrapper needed no code change since it already forwards RPC output verbatim), MCP write tools including program CRUD and membership (Tasks 7-8).
- **Type consistency check**: `Program { id, name }` is used identically in `DataLayer.createProgram`'s return type (Task 4), `src/data/supabase.ts`'s `createProgram` (Task 5), and the MCP tool result (Task 7) — no renamed fields across tasks. `WorkoutDay.programId`/`programPosition`/`programName`/`isAvailable` names are consistent from Task 2 through Task 6.
- **No placeholders**: every step above has literal code, not a description of code.
