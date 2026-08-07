# ManageDays Inline Delete Confirmation + Add Exercises Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Manage Days screen, make exercise removal require an inline Confirm/Cancel step, and add a per-day flow to add an existing catalog exercise or create a new one.

**Architecture:** All changes live in `src/screens/ManageDays.tsx` (plus its test file). The screen talks to the existing `DataLayer` via the `db` singleton — `listExercises()`, `createExercise()`, `updateDayExercises()` already exist; no data-layer changes. A small `AddExerciseSection` child component in the same file holds the add-form state; the parent owns db calls and reload.

**Tech Stack:** React 19 + TypeScript, Vitest + React Testing Library (jsdom, globals on, RTL auto-cleanup active), Tailwind utility classes.

**Spec:** `docs/superpowers/specs/2026-08-07-manage-days-confirm-and-add-design.md`

## Global Constraints

- Only one row may be in the Remove-confirming state at a time; only one day's add section may be open at a time; opening one clears the other.
- Create form defaults: sets 3, rep low 8, rep high 12. Create & add is disabled unless name is non-empty (trimmed), sets ≥ 1, and 1 ≤ rep low ≤ rep high.
- The picker lists only catalog exercises whose ids are NOT in `day.exerciseIds`.
- **Test-state caveat:** `db` (from `src/data/index.ts`) is a module singleton — mutations persist across tests within `ManageDays.test.tsx`. Tests must run in the order written; do not reorder them. Non-destructive tests use Leg Curl; the destructive confirm-delete test uses Leg Press and runs after them.
- Error handling: plain `await` like the rest of the screen — no try/catch, no toasts.
- Run tests with: `npx vitest run src/screens/ManageDays.test.tsx`
- Before opening a PR: `npm run typecheck` and `npm test` must pass (user requirement).

---

### Task 1: Inline delete confirmation

**Files:**
- Modify: `src/screens/ManageDays.tsx`
- Test: `src/screens/ManageDays.test.tsx`

**Interfaces:**
- Consumes: existing `db.updateDayExercises(dayId, exerciseIds)`, existing `remove(day, exerciseId)` helper.
- Produces: component state `confirming: { dayId: string; exerciseId: string } | null` with setter `setConfirming` — Task 2 clears it when opening an add section. Button aria-labels: `remove <name>`, `confirm remove <name>`, `cancel remove <name>`.

- [ ] **Step 1: Write the failing tests**

In `src/screens/ManageDays.test.tsx`, replace the existing `"removing an exercise updates the list"` test with the three tests below (keep the first `"shows days and their exercises"` test as-is). Note the anchored regexes — `/^remove leg curl$/i` must not match `confirm remove leg curl`.

```tsx
test("first tap of Remove shows Confirm/Cancel and does not delete", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Curl")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^remove leg curl$/i }));
  expect(screen.getByText("Leg Curl")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^confirm remove leg curl$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^cancel remove leg curl$/i })).toBeInTheDocument();
});

test("cancel keeps the exercise and restores the Remove button", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Curl")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^remove leg curl$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^cancel remove leg curl$/i }));
  expect(screen.getByText("Leg Curl")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^confirm remove leg curl$/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^remove leg curl$/i })).toBeInTheDocument();
});

test("confirming removes the exercise", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^remove leg press$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm remove leg press$/i }));
  await waitFor(() => expect(screen.queryByText("Leg Press")).not.toBeInTheDocument());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/screens/ManageDays.test.tsx`
Expected: the two new confirm/cancel tests FAIL (no `confirm remove …` button found); `confirming removes the exercise` FAILS because the first click already deletes and the confirm button is never found.

- [ ] **Step 3: Implement the confirmation state**

In `src/screens/ManageDays.tsx`, add state and clear it inside `remove`:

```tsx
const [confirming, setConfirming] = useState<{ dayId: string; exerciseId: string } | null>(null);

async function remove(day: WorkoutDay, exerciseId: string) {
  const remaining = day.exerciseIds.filter((id) => id !== exerciseId);
  await db.updateDayExercises(day.id, remaining);
  setConfirming(null);
  await load();
}
```

Replace the row's Remove button JSX with:

```tsx
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
    onClick={() => setConfirming({ dayId: day.id, exerciseId: e.id })}
    className="text-red-600 text-sm px-2">
    Remove
  </button>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/screens/ManageDays.test.tsx`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/ManageDays.tsx src/screens/ManageDays.test.tsx
git commit -m "feat: inline confirm/cancel before removing an exercise from a day"
```

---

### Task 2: Add an existing catalog exercise to a day

**Files:**
- Modify: `src/screens/ManageDays.tsx`
- Test: `src/screens/ManageDays.test.tsx`

**Interfaces:**
- Consumes: `db.listExercises(): Promise<Exercise[]>`, `db.updateDayExercises(dayId, exerciseIds)`, Task 1's `setConfirming`.
- Produces: parent state `allExercises: Exercise[]` and `addingDayId: string | null`; helper `addExisting(day: WorkoutDay, exerciseId: string): Promise<void>`; child component `AddExerciseSection({ day, available, onAdd, onClose })` in the same file — Task 3 extends it with a create mode and an `onCreate` prop. Aria-labels: `add exercise to <day name>`, `exercise picker for <day name>`, `add selected exercise to <day name>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/screens/ManageDays.test.tsx`. These run after the Leg Press removal test — Leg Press is no longer in Leg Day, which is fine: the tests only assert on Leg Curl (still in the day) and Bicep Curl (seeded in the catalog, in no day).

```tsx
test("picker excludes exercises already in the day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to leg day$/i }));
  const picker = screen.getByRole("combobox", { name: /exercise picker for leg day/i });
  const options = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
  expect(options).toContain("Bicep Curl");
  expect(options).not.toContain("Leg Curl");
});

test("adding an existing exercise puts it in the day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to leg day$/i }));
  const picker = screen.getByRole("combobox", { name: /exercise picker for leg day/i });
  fireEvent.change(picker, { target: { value: "bicep-curl" } });
  fireEvent.click(screen.getByRole("button", { name: /^add selected exercise to leg day$/i }));
  await waitFor(() => expect(screen.getByText("Bicep Curl")).toBeInTheDocument());
  // section closes after adding
  expect(screen.queryByRole("combobox", { name: /exercise picker for leg day/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/screens/ManageDays.test.tsx`
Expected: both new tests FAIL with "Unable to find an accessible element with the role button and name /^add exercise to leg day$/i".

- [ ] **Step 3: Implement the add-existing flow**

In `src/screens/ManageDays.tsx`:

Add parent state and load the catalog (add `setAllExercises` inside the existing `load` callback):

```tsx
const [allExercises, setAllExercises] = useState<Exercise[]>([]);
const [addingDayId, setAddingDayId] = useState<string | null>(null);

const load = useCallback(async () => {
  const d = await db.getWorkoutDays();
  setDays(d);
  const map: Record<string, Exercise[]> = {};
  for (const day of d) map[day.id] = await db.getDayExercises(day.id);
  setExByDay(map);
  setAllExercises(await db.listExercises());
}, []);

async function addExisting(day: WorkoutDay, exerciseId: string) {
  await db.updateDayExercises(day.id, [...day.exerciseIds, exerciseId]);
  setAddingDayId(null);
  await load();
}
```

Mutual exclusion (spec §2): opening the add section clears any pending confirmation, and starting a confirmation closes the add section. Update the Remove button's onClick from Task 1:

```tsx
onClick={() => { setConfirming({ dayId: day.id, exerciseId: e.id }); setAddingDayId(null); }}
```

Inside each day card, after the `</ul>`, render:

```tsx
{addingDayId === day.id ? (
  <AddExerciseSection
    day={day}
    available={allExercises.filter((e) => !day.exerciseIds.includes(e.id))}
    onAdd={(exerciseId) => addExisting(day, exerciseId)}
    onClose={() => setAddingDayId(null)}
  />
) : (
  <button
    aria-label={`add exercise to ${day.name}`}
    onClick={() => { setAddingDayId(day.id); setConfirming(null); }}
    className="mt-2 text-sm text-blue-600 px-2">
    + Add exercise
  </button>
)}
```

Add the child component at the bottom of the file:

```tsx
function AddExerciseSection({ day, available, onAdd, onClose }: {
  day: WorkoutDay;
  available: Exercise[];
  onAdd: (exerciseId: string) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState(available[0]?.id ?? "");
  return (
    <div className="mt-2 space-y-2">
      {available.length > 0 && (
        <div className="flex gap-2 items-center">
          <select
            aria-label={`exercise picker for ${day.name}`}
            value={selectedId}
            onChange={(ev) => setSelectedId(ev.target.value)}
            className="border rounded px-2 py-1 flex-1">
            {available.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <button
            aria-label={`add selected exercise to ${day.name}`}
            disabled={!selectedId}
            onClick={() => onAdd(selectedId)}
            className="text-sm px-2 py-1 border rounded">
            Add
          </button>
        </div>
      )}
      <button onClick={onClose} className="text-sm px-2 text-gray-500">Cancel</button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/screens/ManageDays.test.tsx`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/ManageDays.tsx src/screens/ManageDays.test.tsx
git commit -m "feat: add existing catalog exercise to a day from Manage Days"
```

---

### Task 3: Create a new exercise and add it to the day

**Files:**
- Modify: `src/screens/ManageDays.tsx`
- Test: `src/screens/ManageDays.test.tsx`

**Interfaces:**
- Consumes: `db.createExercise(input: Omit<Exercise, "id">): Promise<Exercise>`, `db.updateDayExercises`, Task 2's `AddExerciseSection`.
- Produces: parent helper `createAndAdd(day: WorkoutDay, input: Omit<Exercise, "id">): Promise<void>`; `AddExerciseSection` gains prop `onCreate: (input: Omit<Exercise, "id">) => void` and a pick/create mode toggle. Aria-labels: `create new exercise for <day name>` (mode toggle), `new exercise name`, `new exercise cue`, `new exercise sets`, `new exercise rep low`, `new exercise rep high`, `create and add to <day name>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/screens/ManageDays.test.tsx`:

```tsx
test("creating a new exercise adds it to the day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to upper day$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^create new exercise for upper day$/i }));
  fireEvent.change(screen.getByRole("textbox", { name: /new exercise name/i }), { target: { value: "Face Pull" } });
  fireEvent.click(screen.getByRole("button", { name: /^create and add to upper day$/i }));
  await waitFor(() => expect(screen.getByText("Face Pull")).toBeInTheDocument());
});

test("create button is disabled until the name is filled in", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to upper day$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^create new exercise for upper day$/i }));
  expect(screen.getByRole("button", { name: /^create and add to upper day$/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/screens/ManageDays.test.tsx`
Expected: both new tests FAIL with "Unable to find an accessible element with the role button and name /^create new exercise for upper day$/i".

- [ ] **Step 3: Implement the create mode**

In `src/screens/ManageDays.tsx`:

Add the parent helper next to `addExisting`:

```tsx
async function createAndAdd(day: WorkoutDay, input: Omit<Exercise, "id">) {
  const ex = await db.createExercise(input);
  await db.updateDayExercises(day.id, [...day.exerciseIds, ex.id]);
  setAddingDayId(null);
  await load();
}
```

Pass it to the section where it is rendered:

```tsx
<AddExerciseSection
  day={day}
  available={allExercises.filter((e) => !day.exerciseIds.includes(e.id))}
  onAdd={(exerciseId) => addExisting(day, exerciseId)}
  onCreate={(input) => createAndAdd(day, input)}
  onClose={() => setAddingDayId(null)}
/>
```

Replace `AddExerciseSection` with the two-mode version:

```tsx
function AddExerciseSection({ day, available, onAdd, onCreate, onClose }: {
  day: WorkoutDay;
  available: Exercise[];
  onAdd: (exerciseId: string) => void;
  onCreate: (input: Omit<Exercise, "id">) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"pick" | "create">(available.length > 0 ? "pick" : "create");
  const [selectedId, setSelectedId] = useState(available[0]?.id ?? "");
  const [name, setName] = useState("");
  const [cue, setCue] = useState("");
  const [sets, setSets] = useState(3);
  const [repLow, setRepLow] = useState(8);
  const [repHigh, setRepHigh] = useState(12);

  const createValid = name.trim().length > 0 && sets >= 1 && repLow >= 1 && repLow <= repHigh;

  if (mode === "pick") {
    return (
      <div className="mt-2 space-y-2">
        <div className="flex gap-2 items-center">
          <select
            aria-label={`exercise picker for ${day.name}`}
            value={selectedId}
            onChange={(ev) => setSelectedId(ev.target.value)}
            className="border rounded px-2 py-1 flex-1">
            {available.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <button
            aria-label={`add selected exercise to ${day.name}`}
            disabled={!selectedId}
            onClick={() => onAdd(selectedId)}
            className="text-sm px-2 py-1 border rounded">
            Add
          </button>
        </div>
        <div className="flex gap-3">
          <button
            aria-label={`create new exercise for ${day.name}`}
            onClick={() => setMode("create")}
            className="text-sm px-2 text-blue-600">
            Create new exercise
          </button>
          <button onClick={onClose} className="text-sm px-2 text-gray-500">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <input
        aria-label="new exercise name"
        value={name}
        onChange={(ev) => setName(ev.target.value)}
        placeholder="Exercise name"
        className="border rounded px-2 py-1 w-full"
      />
      <input
        aria-label="new exercise cue"
        value={cue}
        onChange={(ev) => setCue(ev.target.value)}
        placeholder="Cue (optional)"
        className="border rounded px-2 py-1 w-full"
      />
      <div className="flex gap-2">
        <input
          aria-label="new exercise sets"
          type="number"
          value={sets}
          onChange={(ev) => setSets(Number(ev.target.value))}
          className="border rounded px-2 py-1 w-16"
        />
        <input
          aria-label="new exercise rep low"
          type="number"
          value={repLow}
          onChange={(ev) => setRepLow(Number(ev.target.value))}
          className="border rounded px-2 py-1 w-16"
        />
        <input
          aria-label="new exercise rep high"
          type="number"
          value={repHigh}
          onChange={(ev) => setRepHigh(Number(ev.target.value))}
          className="border rounded px-2 py-1 w-16"
        />
      </div>
      <div className="flex gap-3">
        <button
          aria-label={`create and add to ${day.name}`}
          disabled={!createValid}
          onClick={() => onCreate({ name: name.trim(), cue, defaultSets: sets, defaultRepLow: repLow, defaultRepHigh: repHigh })}
          className="text-sm px-2 py-1 border rounded disabled:opacity-50">
          Create &amp; add
        </button>
        <button onClick={onClose} className="text-sm px-2 text-gray-500">Cancel</button>
      </div>
    </div>
  );
}
```

Note: when `available` is empty the section starts in create mode, satisfying the spec's "if the day already contains every catalog exercise, only the create option is shown."

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/screens/ManageDays.test.tsx`
Expected: all 8 tests PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files PASS, tsc exits 0. Fix any failures before committing.

- [ ] **Step 6: Commit**

```bash
git add src/screens/ManageDays.tsx src/screens/ManageDays.test.tsx
git commit -m "feat: create a new exercise and add it to a day from Manage Days"
```
