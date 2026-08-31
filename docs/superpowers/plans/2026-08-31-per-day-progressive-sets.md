# Per-Day Progressive Set Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Manage Days day card define an optional per-(day, exercise) progressive set scheme (an ordered `{weight, reps}` list) that seeds the session's per-set editor, without changing today's uniform-defaults behavior when no scheme is defined.

**Architecture:** Add a nullable `target_sets` jsonb column to `workout_day_exercises`, expose it through two new `DataLayer` methods (`getDayExerciseTargets`, `setDayExerciseTarget`) implemented in both `mock.ts` and `supabase.ts`, surface an editor for it in `ManageDays`, and thread the resolved scheme into `Session` → `ExerciseCard` → `SetEditor` so a defined scheme opens the card directly in per-set mode pre-filled with the scheme's values (logged values still always win once something's been logged).

**Tech Stack:** React 19 + TypeScript, Vitest + Testing Library, Supabase (Postgres/PostgREST), Vite.

**Spec:** bd issue `exercise-d5r` ("Define per-day progressive set targets for an exercise") — see `bd show exercise-d5r`.

## Global Constraints

- Scheme is scoped to the `(day, exercise)` pairing — never global to the exercise, never shared across days.
- No scheme defined → today's uniform `defaultSets`/`defaultRepLow`/`defaultRepHigh` behavior is byte-for-byte unchanged.
- Persisted via nullable `target_sets` (jsonb) column on `workout_day_exercises`, added via a Supabase migration.
- Implemented in both `src/data/mock.ts` and `src/data/supabase.ts`.
- Scheme is editable/removable from Manage Days at any time, not just at add-time.
- Starting a session seeds `ExerciseCard`/`SetEditor` directly into per-set mode from the scheme (if defined) instead of the uniform line/defaults.
- The scheme is only a starting point — free per-set add/remove/edit during the actual session (already supported by `SetEditor`) is untouched.
- Once something is logged for that exercise in the session, logged values always take priority over the scheme (mirrors existing logged-vs-defaults priority).

---

## File Structure

- `supabase/migrations/0007_target_sets.sql` — new migration adding the `target_sets` jsonb column.
- `src/data/DataLayer.ts` — add `getDayExerciseTargets` / `setDayExerciseTarget` to the interface.
- `src/data/mock.ts` — in-memory implementation, scoped per day.
- `src/data/supabase.ts` — Postgres-backed implementation; also fixes `updateDayExercises` so its delete+reinsert no longer wipes `target_sets` for exercises that stay on the day.
- `src/data/mock.test.ts` — data-layer scoping/removal tests.
- `src/components/ExerciseCard.tsx` — new optional `targetSets` prop; seeds per-set mode/values when no logged sets exist yet.
- `src/components/ExerciseCard.test.tsx` — seeding/priority tests.
- `src/screens/Session.tsx` — loads the day's targets and passes them through.
- `src/screens/Session.test.tsx` — end-to-end "session opens pre-filled per-set" test.
- `src/screens/ManageDays.tsx` — new `SchemeEditor` component + wiring to add/edit/remove a scheme per (day, exercise).
- `src/screens/ManageDays.test.tsx` — UI tests for defining, editing, removing, and day-scoping.

---

## Task 1: Data layer — `target_sets` column + `DataLayer` methods (mock)

**Files:**
- Create: `supabase/migrations/0007_target_sets.sql`
- Modify: `src/data/DataLayer.ts`
- Modify: `src/data/mock.ts`
- Test: `src/data/mock.test.ts`

**Interfaces:**
- Produces: `DataLayer.getDayExerciseTargets(dayId: string): Promise<Record<string, SetEntry[]>>` — keys are only present when a scheme is defined for that exercise on that day; absent key means no scheme.
- Produces: `DataLayer.setDayExerciseTarget(dayId: string, exerciseId: string, sets: SetEntry[] | null): Promise<void>` — `null` (or an empty array) removes the scheme.

- [ ] **Step 1: Write the failing tests**

Add to `src/data/mock.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- mock.test.ts`
Expected: FAIL — `db.getDayExerciseTargets is not a function` (method doesn't exist yet).

- [ ] **Step 3: Add the migration**

Create `supabase/migrations/0007_target_sets.sql`:

```sql
-- Optional per-(day, exercise) progressive set scheme: an ordered list of
-- {weight, reps} pairs that overrides the exercise's uniform default-sets
-- behavior when starting a session for that day. Null means "no scheme —
-- use the exercise's defaultSets/defaultRepLow/defaultRepHigh as before".
alter table workout_day_exercises add column target_sets jsonb;
```

- [ ] **Step 4: Add the methods to the `DataLayer` interface**

In `src/data/DataLayer.ts`, after `updateDayName`:

```ts
  updateDayName(dayId: string, name: string): Promise<void>;
  getDayExerciseTargets(dayId: string): Promise<Record<string, SetEntry[]>>;
  setDayExerciseTarget(dayId: string, exerciseId: string, sets: SetEntry[] | null): Promise<void>;
```

- [ ] **Step 5: Implement in `mock.ts`**

In `src/data/mock.ts`, add a module-level store alongside `exercises`/`days`/`sessions`:

```ts
  const targets: Record<string, Record<string, SetEntry[]>> = {};
```

Add the two methods to the returned object (after `updateDayName`):

```ts
    async getDayExerciseTargets(dayId) {
      return { ...(targets[dayId] ?? {}) };
    },
    async setDayExerciseTarget(dayId, exerciseId, sets) {
      const dayTargets = (targets[dayId] ??= {});
      if (sets && sets.length > 0) dayTargets[exerciseId] = sets.slice();
      else delete dayTargets[exerciseId];
    },
```

And update `updateDayExercises` to prune schemes for exercises no longer on the day:

```ts
    async updateDayExercises(dayId, exerciseIds) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.exerciseIds = exerciseIds.slice();
      const dayTargets = targets[dayId];
      if (dayTargets) {
        for (const exId of Object.keys(dayTargets)) {
          if (!exerciseIds.includes(exId)) delete dayTargets[exId];
        }
      }
    },
```

Also add `SetEntry` to the type-only import at the top of `mock.ts`:

```ts
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- mock.test.ts`
Expected: PASS (all `mock.test.ts` tests, including the 4 new ones).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0007_target_sets.sql src/data/DataLayer.ts src/data/mock.ts src/data/mock.test.ts
git commit -m "feat: add per-day-exercise target_sets scheme to the data layer"
```

---

## Task 2: Supabase implementation

**Files:**
- Modify: `src/data/supabase.ts`

**Interfaces:**
- Consumes: same `DataLayer` methods defined in Task 1.
- Produces: nothing new for later tasks — later tasks only depend on the `DataLayer` interface, already satisfied by `mock.ts`.

There's no existing test file exercising `supabase.ts` directly (it talks to a real Supabase project), so this task is verified by typecheck instead of a unit test.

- [ ] **Step 1: Implement `getDayExerciseTargets` / `setDayExerciseTarget`**

In `src/data/supabase.ts`, add after `updateDayName`:

```ts
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
    async setDayExerciseTarget(dayId, exerciseId, sets) {
      const target_sets = sets && sets.length > 0 ? sets.map((s) => ({ weight: s.weight, reps: s.reps })) : null;
      const { error } = await supabase
        .from("workout_day_exercises")
        .update({ target_sets })
        .eq("workout_day_id", dayId)
        .eq("exercise_id", exerciseId);
      if (error) throw error;
    },
```

- [ ] **Step 2: Fix `updateDayExercises` to preserve existing `target_sets`**

The current implementation deletes every row for the day and reinserts fresh rows with only `workout_day_id`/`exercise_id`/`position` — this silently wipes any scheme every time an unrelated exercise is added to or removed from the same day. Replace the existing `updateDayExercises` with:

```ts
    async updateDayExercises(dayId, exerciseIds) {
      const { data: existing } = await supabase
        .from("workout_day_exercises")
        .select("exercise_id, target_sets")
        .eq("workout_day_id", dayId);
      const targetsByExercise: Record<string, unknown> = {};
      for (const row of existing ?? []) {
        if (row.target_sets) targetsByExercise[row.exercise_id] = row.target_sets;
      }
      await supabase.from("workout_day_exercises").delete().eq("workout_day_id", dayId);
      if (exerciseIds.length) {
        await supabase.from("workout_day_exercises").insert(
          exerciseIds.map((exercise_id, position) => ({
            workout_day_id: dayId,
            exercise_id,
            position,
            target_sets: targetsByExercise[exercise_id] ?? null,
          })),
        );
      }
    },
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite** (confirms this file's changes didn't break anything picked up indirectly)

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/supabase.ts
git commit -m "feat: implement target_sets scheme in the Supabase data layer"
```

---

## Task 3: `ExerciseCard` seeds per-set mode from a target scheme

**Files:**
- Modify: `src/components/ExerciseCard.tsx`
- Test: `src/components/ExerciseCard.test.tsx`

**Interfaces:**
- Consumes: `SetEntry[]` (from `../types`, already imported).
- Produces: `ExerciseCard` gains an optional prop `targetSets?: SetEntry[] | null`. Priority when nothing is logged yet: `targetSets` seeds per-set mode and values; once `loggedSets` exists, it always wins (unchanged from before).

- [ ] **Step 1: Write the failing tests**

Add to `src/components/ExerciseCard.test.tsx`:

```tsx
test("seeds per-set mode from a day's target scheme when nothing is logged yet", () => {
  const targetSets = [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
    { setNumber: 3, weight: 275, reps: 3 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} targetSets={targetSets} onLog={() => {}} />);
  expect(screen.getByLabelText("set 3 weight")).toHaveValue("275");
  expect(screen.getByLabelText("set 3 reps")).toHaveValue("3");
});

test("logging a targetSets-seeded exercise logs the scheme's values unless edited", () => {
  const onLog = vi.fn();
  const targetSets = [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} targetSets={targetSets} onLog={onLog} />);
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onLog).toHaveBeenCalledWith(targetSets);
});

test("a logged exercise ignores the day's target scheme and reopens with its logged values", () => {
  const onLog = vi.fn();
  const logged = [
    { setNumber: 1, weight: 200, reps: 5 },
    { setNumber: 2, weight: 200, reps: 5 },
  ];
  const targetSets = [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={logged} targetSets={targetSets} onLog={onLog} />);
  fireEvent.click(screen.getByRole("button", { name: /edit/i }));
  // logged is uniform, so it reopens in line mode (not per-set) — "weight", not "set 1 weight".
  expect(screen.getByLabelText("weight")).toHaveValue("200");
});

test("no target scheme behaves exactly as before (uniform line mode)", () => {
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} targetSets={null} onLog={() => {}} />);
  expect(screen.getByLabelText("weight")).toBeInTheDocument();
  expect(screen.queryByLabelText("set 1 weight")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- ExerciseCard.test.tsx`
Expected: FAIL — TypeScript error / the per-set fields aren't seeded (first two new tests fail; `targetSets` prop doesn't exist yet).

- [ ] **Step 3: Implement in `ExerciseCard.tsx`**

Update the `Props` interface and component body:

```tsx
interface Props {
  exercise: Exercise;
  lastSets: SetEntry[];
  loggedSets: SetEntry[] | null;
  targetSets?: SetEntry[] | null;
  onLog(sets: SetEntry[]): void;
}
```

```tsx
export default function ExerciseCard({ exercise, lastSets, loggedSets, targetSets, onLog }: Props) {
  const [editing, setEditing] = useState(false);
  const [perSet, setPerSet] = useState(() => {
    if (loggedSets) return !isUniform(loggedSets);
    return !!targetSets && targetSets.length > 0;
  });
```

Further down, the seed used for the main editor should prefer logged, then the day's scheme, then fall back to last-time/defaults:

```tsx
  const lastLine = formatSets(lastSets);
  const seedEntries = loggedSets ?? (targetSets && targetSets.length > 0 ? targetSets : null);
  return (
    <div className="rounded-xl border p-4">
      ...
      <SetEditor
        initialWeight={(seedEntries ?? lastSets)[0]?.weight ?? 0}
        initialSets={seedEntries?.length ?? exercise.defaultSets}
        initialReps={(seedEntries ?? lastSets)[0]?.reps ?? exercise.defaultRepLow}
        initialEntries={seedEntries ?? undefined}
        perSet={perSet}
        onPerSetChange={setPerSet}
        onSave={(sets) => {
          onLog(sets);
          setEditing(false);
        }}
      />
    </div>
  );
}
```

(Leave everything else — the collapsed logged view, the "adjust sets" icon, the `Target:`/`Last:` line — untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ExerciseCard.test.tsx`
Expected: PASS (all tests in the file, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/components/ExerciseCard.tsx src/components/ExerciseCard.test.tsx
git commit -m "feat: seed ExerciseCard per-set mode from a day's target scheme"
```

---

## Task 4: `Session` loads and passes the day's target schemes

**Files:**
- Modify: `src/screens/Session.tsx`
- Test: `src/screens/Session.test.tsx`

**Interfaces:**
- Consumes: `db.getDayExerciseTargets(dayId): Promise<Record<string, SetEntry[]>>` (Task 1), `ExerciseCard`'s new `targetSets` prop (Task 3).

- [ ] **Step 1: Write the failing test**

Add to the **end** of `src/screens/Session.test.tsx` (state set here — the target scheme — persists on the shared mock `db` for the rest of the file's test run, so it must come last and clean up after itself):

```tsx
test("a session for a day with a defined progressive scheme starts pre-filled per-set with the scheme's values", async () => {
  await db.setDayExerciseTarget("leg-day", "leg-press", [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
    { setNumber: 3, weight: 275, reps: 3 },
  ]);
  await renderSession();
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getByLabelText("set 3 weight")).toHaveValue("275");
  expect(screen.getByLabelText("set 3 reps")).toHaveValue("3");
  await db.setDayExerciseTarget("leg-day", "leg-press", null); // don't leak into other tests
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- Session.test.tsx`
Expected: FAIL — `getByLabelText("set 3 weight")` not found (Session doesn't fetch/pass targets yet; card renders in line mode).

- [ ] **Step 3: Implement in `Session.tsx`**

```tsx
export default function Session() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionT | null>(null);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [lastByEx, setLastByEx] = useState<Record<string, SetEntry[]>>({});
  const [targetByEx, setTargetByEx] = useState<Record<string, SetEntry[]>>({});

  useEffect(() => {
    if (!id) return;
    (async () => {
      const s = await db.getSession(id);
      if (!s) return;
      const ex = s.workoutDayId ? await db.getDayExercises(s.workoutDayId) : [];
      const last: Record<string, SetEntry[]> = {};
      for (const e of ex) {
        last[e.id] = await db.getLastSetsForExercise(e.id, s.performedOn);
      }
      const targets = s.workoutDayId ? await db.getDayExerciseTargets(s.workoutDayId) : {};
      setSession(s);
      setExercises(ex);
      setLastByEx(last);
      setTargetByEx(targets);
    })();
  }, [id]);
```

And in the render, pass the new prop through:

```tsx
      {exercises.map((e) => (
        <ExerciseCard
          key={e.id}
          exercise={e}
          lastSets={lastByEx[e.id] ?? []}
          loggedSets={loggedFor(e.id)}
          targetSets={targetByEx[e.id] ?? null}
          onLog={(sets) => log(e.id, sets)}
        />
      ))}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- Session.test.tsx`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/screens/Session.tsx src/screens/Session.test.tsx
git commit -m "feat: seed session exercise cards from the day's progressive scheme"
```

---

## Task 5: `ManageDays` — define/edit/remove a scheme per (day, exercise)

**Files:**
- Modify: `src/screens/ManageDays.tsx`
- Test: `src/screens/ManageDays.test.tsx`

**Interfaces:**
- Consumes: `db.getDayExerciseTargets`, `db.setDayExerciseTarget` (Task 1), `formatSets` from `../lib/sets`.

- [ ] **Step 1: Write the failing tests**

Add to the **end** of `src/screens/ManageDays.test.tsx` (this file's tests are order-dependent and share one mock `db` — by this point in the file "Leg Day" has been renamed to "Leg Day 2" and still contains "Leg Curl"; "Upper Day" still contains "Chest Press"):

```tsx
test("adding a scheme to an exercise shows its summary", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Curl")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add scheme for leg curl on leg day 2$/i }));
  fireEvent.change(screen.getByLabelText("scheme set 1 weight for leg curl on leg day 2"), { target: { value: "105" } });
  fireEvent.change(screen.getByLabelText("scheme set 1 reps for leg curl on leg day 2"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /^add scheme set for leg curl on leg day 2$/i }));
  fireEvent.change(screen.getByLabelText("scheme set 2 weight for leg curl on leg day 2"), { target: { value: "115" } });
  fireEvent.change(screen.getByLabelText("scheme set 2 reps for leg curl on leg day 2"), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: /^save scheme for leg curl on leg day 2$/i }));
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
});

test("editing an existing scheme reopens pre-filled with its saved values", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit scheme for leg curl on leg day 2$/i }));
  expect(screen.getByLabelText("scheme set 2 weight for leg curl on leg day 2")).toHaveValue(115);
});

test("canceling a scheme edit discards changes", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit scheme for leg curl on leg day 2$/i }));
  fireEvent.change(screen.getByLabelText("scheme set 1 weight for leg curl on leg day 2"), { target: { value: "999" } });
  fireEvent.click(screen.getByRole("button", { name: /^cancel scheme for leg curl on leg day 2$/i }));
  expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument();
});

test("removing a scheme clears the summary", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit scheme for leg curl on leg day 2$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^remove scheme for leg curl on leg day 2$/i }));
  await waitFor(() => expect(screen.queryByText(/Scheme:/)).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: /^add scheme for leg curl on leg day 2$/i })).toBeInTheDocument();
});

test("defining a scheme on one day doesn't affect the same exercise on another day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add scheme for chest press on upper day$/i }));
  fireEvent.change(screen.getByLabelText("scheme set 1 weight for chest press on upper day"), { target: { value: "185" } });
  fireEvent.change(screen.getByLabelText("scheme set 1 reps for chest press on upper day"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: /^add scheme set for chest press on upper day$/i }));
  fireEvent.change(screen.getByLabelText("scheme set 2 weight for chest press on upper day"), { target: { value: "205" } });
  fireEvent.change(screen.getByLabelText("scheme set 2 reps for chest press on upper day"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: /^save scheme for chest press on upper day$/i }));
  // Two differing rows -> formatSets' "different weight and reps" branch: "185×5, 205×3".
  await waitFor(() => expect(screen.getByText("Scheme: 185×5, 205×3")).toBeInTheDocument());
  // Leg Curl on Leg Day 2 still has no scheme — unaffected by Chest Press's scheme on Upper Day.
  expect(screen.getByRole("button", { name: /^add scheme for leg curl on leg day 2$/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- ManageDays.test.tsx`
Expected: FAIL — none of the "scheme" buttons/labels exist yet.

- [ ] **Step 3: Implement in `ManageDays.tsx`**

Update imports at the top:

```tsx
import { useEffect, useState, useCallback } from "react";
import { db } from "../data";
import type { WorkoutDay, Exercise, SetEntry } from "../types";
import { formatSets } from "../lib/sets";
```

Add state and update `load()`:

```tsx
  const [targetsByDay, setTargetsByDay] = useState<Record<string, Record<string, SetEntry[]>>>({});
  const [schemeEditing, setSchemeEditing] = useState<{ dayId: string; exerciseId: string } | null>(null);

  const load = useCallback(async () => {
    const d = await db.getWorkoutDays();
    setDays(d);
    const map: Record<string, Exercise[]> = {};
    const targets: Record<string, Record<string, SetEntry[]>> = {};
    for (const day of d) {
      map[day.id] = await db.getDayExercises(day.id);
      targets[day.id] = await db.getDayExerciseTargets(day.id);
    }
    setExByDay(map);
    setTargetsByDay(targets);
    setAllExercises(await db.listExercises());
  }, []);
```

Add handlers near `remove`/`addExisting`:

```tsx
  async function saveScheme(day: WorkoutDay, exerciseId: string, sets: SetEntry[]) {
    await db.setDayExerciseTarget(day.id, exerciseId, sets);
    setSchemeEditing(null);
    await load();
  }

  async function removeScheme(day: WorkoutDay, exerciseId: string) {
    await db.setDayExerciseTarget(day.id, exerciseId, null);
    setSchemeEditing(null);
    await load();
  }
```

Reset `schemeEditing` alongside the other "close other open editors" resets — in `remove`, `startEdit`, `startAddDay`, and the "+ Add exercise" button's `onClick`:

```tsx
  async function remove(day: WorkoutDay, exerciseId: string) {
    const remaining = day.exerciseIds.filter((id) => id !== exerciseId);
    await db.updateDayExercises(day.id, remaining);
    setConfirming(null);
    setSchemeEditing(null);
    await load();
  }
```

```tsx
  function startEdit(day: WorkoutDay) {
    setDraftName(day.name);
    setEditingDayId(day.id);
    setConfirming(null);
    setAddingDayId(null);
    setSchemeEditing(null);
  }
```

```tsx
  function startAddDay() {
    setNewDayName("");
    setAddingDay(true);
    setEditingDayId(null);
    setConfirming(null);
    setAddingDayId(null);
    setSchemeEditing(null);
  }
```

And the "+ Add exercise to {day.name}" button, just below the `<ul>`:

```tsx
            <button
              aria-label={`add exercise to ${day.name}`}
              onClick={() => { setAddingDayId(day.id); setConfirming(null); setEditingDayId(null); setSchemeEditing(null); }}
              className="mt-2 text-sm text-blue-600 px-2">
              + Add exercise
            </button>
```

Replace the exercise `<ul>` block with:

```tsx
          <ul className="mt-2 space-y-1">
            {(exByDay[day.id] ?? []).map((e) => {
              const scheme = targetsByDay[day.id]?.[e.id] ?? null;
              return (
                <li key={e.id} className="py-1">
                  <div className="flex justify-between items-center">
                    <span>{e.name}</span>
                    {confirming?.dayId === day.id && confirming.exerciseId === e.id ? (
                      <span className="flex gap-2">
                        <button
                          aria-label={`confirm remove ${e.name}`}
                          onClick={() => remove(day, e.id)}
                          className="text-white bg-red-600 rounded text-sm px-2">
                          Confirm
                        </button>
                        <button
                          aria-label={`cancel remove ${e.name}`}
                          onClick={() => setConfirming(null)}
                          className="text-sm px-2 border rounded">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        aria-label={`remove ${e.name}`}
                        onClick={() => { setConfirming({ dayId: day.id, exerciseId: e.id }); setAddingDayId(null); setEditingDayId(null); setSchemeEditing(null); }}
                        className="text-red-600 text-sm px-2">
                        Remove
                      </button>
                    )}
                  </div>
                  {schemeEditing?.dayId === day.id && schemeEditing.exerciseId === e.id ? (
                    <SchemeEditor
                      day={day}
                      exercise={e}
                      initial={scheme}
                      onSave={(sets) => saveScheme(day, e.id, sets)}
                      onRemove={() => removeScheme(day, e.id)}
                      onCancel={() => setSchemeEditing(null)}
                    />
                  ) : (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-gray-500">{scheme ? `Scheme: ${formatSets(scheme)}` : ""}</span>
                      <button
                        aria-label={`${scheme ? "edit" : "add"} scheme for ${e.name} on ${day.name}`}
                        onClick={() => { setSchemeEditing({ dayId: day.id, exerciseId: e.id }); setConfirming(null); setAddingDayId(null); setEditingDayId(null); }}
                        className="text-sm text-blue-600 px-2">
                        {scheme ? "Edit scheme" : "+ Scheme"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
```

Add the `SchemeEditor` component at the bottom of the file (alongside `AddExerciseSection`):

```tsx
function SchemeEditor({ day, exercise, initial, onSave, onRemove, onCancel }: {
  day: WorkoutDay;
  exercise: Exercise;
  initial: SetEntry[] | null;
  onSave: (sets: SetEntry[]) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<{ weight: number; reps: number }[]>(
    initial && initial.length > 0
      ? initial.map((s) => ({ weight: s.weight, reps: s.reps }))
      : [{ weight: 0, reps: exercise.defaultRepLow }],
  );

  const valid = rows.length > 0 && rows.every((r) => r.weight >= 0 && r.reps >= 1);

  function updateRow(i: number, field: "weight" | "reps", value: number) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, rs[rs.length - 1] ?? { weight: 0, reps: exercise.defaultRepLow }]);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }
  function save() {
    onSave(rows.map((r, i) => ({ setNumber: i + 1, weight: r.weight, reps: r.reps })));
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border p-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-end gap-2">
          <span className="text-xs text-gray-500 w-10 pb-2 shrink-0">Set {i + 1}</span>
          <label className="flex flex-1 flex-col text-xs text-gray-500">
            weight
            <input
              aria-label={`scheme set ${i + 1} weight for ${exercise.name} on ${day.name}`}
              type="number"
              value={r.weight}
              onChange={(ev) => updateRow(i, "weight", Number(ev.target.value))}
              className="border rounded px-2 py-1 w-full"
            />
          </label>
          <label className="flex flex-1 flex-col text-xs text-gray-500">
            reps
            <input
              aria-label={`scheme set ${i + 1} reps for ${exercise.name} on ${day.name}`}
              type="number"
              value={r.reps}
              onChange={(ev) => updateRow(i, "reps", Number(ev.target.value))}
              className="border rounded px-2 py-1 w-full"
            />
          </label>
          {rows.length > 1 && (
            <button
              aria-label={`remove scheme set ${i + 1} for ${exercise.name} on ${day.name}`}
              onClick={() => removeRow(i)}
              className="shrink-0 text-red-600 text-xl px-2 pb-1">
              −
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-3">
        <button
          aria-label={`add scheme set for ${exercise.name} on ${day.name}`}
          onClick={addRow}
          className="text-sm px-2 py-1 border rounded">
          + add set
        </button>
        <button
          aria-label={`save scheme for ${exercise.name} on ${day.name}`}
          disabled={!valid}
          onClick={save}
          className="text-sm px-2 py-1 border rounded disabled:opacity-50">
          Save
        </button>
        {initial && initial.length > 0 && (
          <button
            aria-label={`remove scheme for ${exercise.name} on ${day.name}`}
            onClick={onRemove}
            className="text-sm px-2 text-red-600">
            Remove scheme
          </button>
        )}
        <button
          aria-label={`cancel scheme for ${exercise.name} on ${day.name}`}
          onClick={onCancel}
          className="text-sm px-2 text-gray-500">
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ManageDays.test.tsx`
Expected: PASS (all tests in the file, old and new, in file order).

- [ ] **Step 5: Commit**

```bash
git add src/screens/ManageDays.tsx src/screens/ManageDays.test.tsx
git commit -m "feat: add per-day progressive scheme editor to Manage Days"
```

---

## Task 6: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — every test file, including all changes from Tasks 1–5.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

No commit for this task — it's a verification checkpoint, not a code change.
