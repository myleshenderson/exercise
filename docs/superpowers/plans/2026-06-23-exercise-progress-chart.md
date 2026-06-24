# Per-Exercise Progress Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-exercise progress view: a Progress screen lists exercises, and tapping one shows a hand-rolled bar chart with one bar per logged set (height = weight × reps), grouped by session over time.

**Architecture:** A pure helper (`src/lib/progress.ts`) turns an exercise's session history into ordered per-set volume groups. The existing (currently unused) `/history/:exerciseId` route + `History.tsx` is repurposed to render the chart from that helper. A new `Progress.tsx` screen (route `/progress`, added to the bottom nav) lists exercises and links to each chart. No data-layer changes.

**Tech Stack:** React + Vite + TypeScript, Vitest + React Testing Library. Hand-rolled SVG/CSS bars (no chart library).

## Global Constraints

- TypeScript strict mode; mobile-first.
- No charting dependency — bars are plain CSS/SVG.
- Volume = `weight * reps`.
- No `DataLayer` changes — reuse `listExercises()`, `getExercise(id)`, `getExerciseHistory(exerciseId)`.
- Routes: `/progress` (exercise list), `/history/:exerciseId` (chart, repurposed).
- Tests run on the mock backend; the existing suite stays green.

---

## Task 1: Progress logic (`src/lib/progress.ts`)

**Files:**
- Create: `src/lib/progress.ts`, `src/lib/progress.test.ts`

**Interfaces:**
- Consumes: `Session`, `SetEntry` from `src/types.ts`.
- Produces:
  - `setVolume(set: SetEntry): number`
  - `interface SetSeriesPoint { performedOn: string; setVolumes: number[] }`
  - `exerciseSetSeries(sessions: Session[], exerciseId: string): SetSeriesPoint[]` — sessions containing the exercise, oldest→newest, each with that exercise's per-set volumes in set order.

- [ ] **Step 1: Write the failing test** — `src/lib/progress.test.ts`:

```ts
import { setVolume, exerciseSetSeries } from "./progress";
import type { Session } from "../types";

test("setVolume multiplies weight by reps", () => {
  expect(setVolume({ setNumber: 1, weight: 150, reps: 12 })).toBe(1800);
});

const sessions: Session[] = [
  { id: "s2", workoutDayId: "d", performedOn: "2026-06-10", exercises: [
    { exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 150, reps: 12 }, { setNumber: 2, weight: 150, reps: 10 }] },
    { exerciseId: "leg-curl", sets: [{ setNumber: 1, weight: 100, reps: 10 }] },
  ] },
  { id: "s1", workoutDayId: "d", performedOn: "2026-06-01", exercises: [
    { exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 140, reps: 12 }] },
  ] },
  { id: "s3", workoutDayId: "d", performedOn: "2026-06-15", exercises: [
    { exerciseId: "leg-curl", sets: [{ setNumber: 1, weight: 105, reps: 10 }] },
  ] },
];

test("exerciseSetSeries returns oldest->newest per-set volume groups for the exercise", () => {
  expect(exerciseSetSeries(sessions, "leg-press")).toEqual([
    { performedOn: "2026-06-01", setVolumes: [1680] },
    { performedOn: "2026-06-10", setVolumes: [1800, 1500] },
  ]);
});

test("exerciseSetSeries skips sessions that don't include the exercise", () => {
  expect(exerciseSetSeries(sessions, "leg-curl").map((p) => p.performedOn)).toEqual([
    "2026-06-10",
    "2026-06-15",
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/lib/progress.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/progress.ts`:

```ts
import type { Session, SetEntry } from "../types";

export function setVolume(set: SetEntry): number {
  return set.weight * set.reps;
}

export interface SetSeriesPoint {
  performedOn: string;
  setVolumes: number[];
}

export function exerciseSetSeries(sessions: Session[], exerciseId: string): SetSeriesPoint[] {
  return sessions
    .filter((s) => s.exercises.some((e) => e.exerciseId === exerciseId))
    .slice()
    .sort((a, b) => (a.performedOn < b.performedOn ? -1 : a.performedOn > b.performedOn ? 1 : 0))
    .map((s) => ({
      performedOn: s.performedOn,
      setVolumes: s.exercises.find((e) => e.exerciseId === exerciseId)!.sets.map(setVolume),
    }));
}
```

- [ ] **Step 4: Run it to verify it passes** — `npx vitest run src/lib/progress.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress.ts src/lib/progress.test.ts
git commit -m "feat: per-exercise set-volume series helper"
```

---

## Task 2: Chart screen (repurpose `History.tsx`)

**Files:**
- Modify: `src/screens/History.tsx`
- Create: `src/screens/History.test.tsx`

**Interfaces:**
- Consumes: `db.getExercise`, `db.getExerciseHistory`; `exerciseSetSeries` (Task 1); `formatSessionDate` from `src/lib/date.ts`.
- Produces: the chart at route `/history/:exerciseId` (already wired in `App.tsx`). Each set renders a bar with `aria-label="set N volume V"`.

- [ ] **Step 1: Write the failing test** — `src/screens/History.test.tsx` (the mock seed logs Leg Press with 3 sets in the Leg Day session; Lateral Raise has no logged history):

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import History from "./History";

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/history/:exerciseId" element={<History />} />
      </Routes>
    </MemoryRouter>,
  );
}

test("renders one bar per logged set for the exercise", async () => {
  renderAt("/history/leg-press");
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getAllByLabelText(/^set \d+ volume /).length).toBe(3);
});

test("shows an empty state for an exercise with no logged sets", async () => {
  renderAt("/history/lateral-raise");
  await waitFor(() => expect(screen.getByText("Lateral Raise")).toBeInTheDocument());
  expect(screen.getByText(/no sets logged yet/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/screens/History.test.tsx` → FAIL (current History renders a session list with no `set N volume` bars / no "No sets logged yet" text).

- [ ] **Step 3: Implement** — replace `src/screens/History.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { db } from "../data";
import type { Session, Exercise } from "../types";
import { exerciseSetSeries } from "../lib/progress";
import { formatSessionDate } from "../lib/date";

export default function History() {
  const { exerciseId } = useParams();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [exercise, setExercise] = useState<Exercise | null>(null);

  useEffect(() => {
    if (!exerciseId) return;
    db.getExercise(exerciseId).then(setExercise);
    db.getExerciseHistory(exerciseId).then(setSessions);
  }, [exerciseId]);

  const series = exerciseId ? exerciseSetSeries(sessions, exerciseId) : [];
  const max = Math.max(1, ...series.flatMap((p) => p.setVolumes));

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-bold">{exercise?.name ?? "Progress"}</h1>
      <p className="text-sm text-gray-500">Volume per set (weight × reps)</p>
      {series.length === 0 ? (
        <p className="text-gray-500">No sets logged yet.</p>
      ) : (
        <div className="flex items-end gap-4 overflow-x-auto pb-2">
          {series.map((point, i) => (
            <div key={i} className="flex shrink-0 flex-col items-center gap-1">
              <div className="flex items-end gap-1" style={{ height: "10rem" }}>
                {point.setVolumes.map((v, j) => (
                  <div
                    key={j}
                    aria-label={`set ${j + 1} volume ${v}`}
                    title={`${v}`}
                    className="w-3 rounded-t bg-black"
                    style={{ height: `${(v / max) * 100}%` }}
                  />
                ))}
              </div>
              <span className="whitespace-nowrap text-xs text-gray-500">
                {formatSessionDate(point.performedOn)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes** — `npx vitest run src/screens/History.test.tsx` → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/screens/History.tsx src/screens/History.test.tsx
git commit -m "feat: per-exercise set-volume bar chart"
```

---

## Task 3: Progress screen + nav

**Files:**
- Create: `src/screens/Progress.tsx`, `src/screens/Progress.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `db.listExercises()`; navigates to `/history/:exerciseId` (Task 2).
- Produces: route `/progress` and a "Progress" bottom-nav link.

- [ ] **Step 1: Write the failing test** — `src/screens/Progress.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Progress from "./Progress";
import History from "./History";

test("lists exercises", async () => {
  render(<MemoryRouter><Progress /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getByText("Chest Press")).toBeInTheDocument();
});

test("tapping an exercise opens its progress chart", async () => {
  render(
    <MemoryRouter initialEntries={["/progress"]}>
      <Routes>
        <Route path="/progress" element={<Progress />} />
        <Route path="/history/:exerciseId" element={<History />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Leg Press"));
  await waitFor(() => expect(screen.getByText(/volume per set/i)).toBeInTheDocument());
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/screens/Progress.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement `src/screens/Progress.tsx`**:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { Exercise } from "../types";

export default function Progress() {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    db.listExercises().then(setExercises);
  }, []);

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-2xl font-bold">Progress</h1>
      {exercises.map((e) => (
        <button
          key={e.id}
          onClick={() => navigate(`/history/${e.id}`)}
          className="w-full rounded-xl border p-4 text-left text-lg font-semibold active:bg-gray-100"
        >
          {e.name}
        </button>
      ))}
      {exercises.length === 0 && <p className="text-gray-500">No exercises yet.</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run it to verify it passes** — `npx vitest run src/screens/Progress.test.tsx` → PASS (2 tests).

- [ ] **Step 5: Add the route + nav link in `src/App.tsx`.** Add the import alongside the other screen imports:

```tsx
import Progress from "./screens/Progress";
```

Add the route inside `<Routes>` in `Shell` (after the `/history/:exerciseId` route):

```tsx
        <Route path="/progress" element={<Progress />} />
```

Add the nav link inside the `<nav>` (after the Days link):

```tsx
        <Link to="/progress" className="p-2">Progress</Link>
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm run test` (all pass, incl. existing App test which still finds the "Home" nav link) and `npm run typecheck` (clean).

- [ ] **Step 7: Commit**

```bash
git add src/screens/Progress.tsx src/screens/Progress.test.tsx src/App.tsx
git commit -m "feat: Progress screen listing exercises + nav link"
```

---

## Self-Review

**Spec coverage:**
- Progress screen lists exercises, in nav → Task 3. ✓
- Tap exercise → per-set chart at `/history/:exerciseId` → Task 3 (nav) + Task 2 (chart). ✓
- One bar per set, height = weight×reps, grouped by session oldest→newest with date labels → Task 1 (series) + Task 2 (render + `formatSessionDate`). ✓
- Hand-rolled, no chart lib → Task 2 (CSS bars). ✓
- Empty state when no sets → Task 2. ✓
- No data-layer change → confirmed (reuses listExercises/getExercise/getExerciseHistory). ✓
- Deferred day overview → not present. ✓

**Placeholder scan:** none — full code and tests provided.

**Type consistency:** `exerciseSetSeries(sessions, exerciseId): SetSeriesPoint[]` and `setVolume(set)` defined in Task 1 are used with matching signatures in Task 2. Bar `aria-label` format `set N volume V` matches the Task 2 test regex `/^set \d+ volume /`. `/history/:exerciseId` route used by Task 3's navigate matches the existing route + Task 2 screen.
