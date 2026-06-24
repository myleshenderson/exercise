# Past-Date Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user log a workout on a chosen past date (to backfill history) via a date field on the Home screen.

**Architecture:** Add a controlled `<input type="date">` to the Home screen, defaulting to today; the existing `start(dayId)` handler passes that date to `db.startSession(dayId, date)` instead of the hardcoded `today()`. No data-layer or backend change — `startSession` already accepts a date.

**Tech Stack:** React + Vite + TypeScript, Vitest + React Testing Library.

## Global Constraints

- TypeScript strict mode.
- Mobile-first; large tap targets.
- Dates are ISO `YYYY-MM-DD` strings.
- No `DataLayer` / mock / Supabase changes — `startSession(workoutDayId: string, date: string)` is unchanged.
- The date resets to today on each Home mount (no persistence).
- Tests run on the default mock backend; existing Home tests must keep passing.

---

## Task 1: Date field on Home for past-date sessions

**Files:**
- Modify: `src/screens/Home.tsx`
- Test: `src/screens/Home.test.tsx`

**Interfaces:**
- Consumes: `db.startSession(workoutDayId: string, date: string)` (existing), `db.getWorkoutDays()`, `db.getLastSessionForDay(dayId)`.
- Produces: no new exported API; behavior change only (Home creates sessions on the selected date).

- [ ] **Step 1: Add the two failing tests** to `src/screens/Home.test.tsx` (keep the existing tests). Ensure the top-of-file import from `@testing-library/react` includes `render`, `screen`, `waitFor`, and `fireEvent`, and that `MemoryRouter` and `db` are imported (they are used by existing tests; `db` is imported from `../data`). Add:

```tsx
test("workout date defaults to today", () => {
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  const todayStr = new Date().toISOString().slice(0, 10);
  expect(screen.getByLabelText(/workout date/i)).toHaveValue(todayStr);
});

test("starts a session on the chosen date", async () => {
  const spy = vi.spyOn(db, "startSession");
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/workout date/i), { target: { value: "2026-05-01" } });
  fireEvent.click(screen.getByText("Leg Day"));
  await waitFor(() => expect(spy).toHaveBeenCalledWith("leg-day", "2026-05-01"));
  spy.mockRestore();
});
```

(If `db` is not yet imported in this test file, add `import { db } from "../data";` at the top.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/screens/Home.test.tsx`
Expected: the two new tests FAIL — there is no "Workout date" field yet, and `start` uses `today()` not the chosen date.

- [ ] **Step 3: Implement the change** — replace `src/screens/Home.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { WorkoutDay } from "../types";
import { formatSessionDate } from "../lib/date";

const today = () => new Date().toISOString().slice(0, 10);

export default function Home() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [lastByDay, setLastByDay] = useState<Record<string, string | null>>({});
  const [date, setDate] = useState(today());
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

  async function start(dayId: string) {
    const session = await db.startSession(dayId, date);
    navigate(`/session/${session.id}`);
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
          className="mt-1 block w-full rounded-lg border p-2 text-base text-black"
        />
      </label>
      {days.map((d) => (
        <button
          key={d.id}
          onClick={() => start(d.id)}
          className="w-full rounded-xl border p-4 text-left active:bg-gray-100"
        >
          <span className="block text-lg font-semibold">{d.name}</span>
          <span className="block text-sm text-gray-500">
            {lastByDay[d.id] ? `Last done ${formatSessionDate(lastByDay[d.id]!)}` : "Not done yet"}
          </span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/screens/Home.test.tsx`
Expected: PASS — all Home tests (existing + 2 new).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run test` (all pass) and `npm run typecheck` (clean).

- [ ] **Step 6: Commit**

```bash
git add src/screens/Home.tsx src/screens/Home.test.tsx
git commit -m "feat: choose a past date on Home to backfill workout history"
```

---

## Self-Review

**Spec coverage:**
- Date input on Home defaulting to today → Task 1 (input + `useState(today())`). ✓
- `start` uses the selected date via `db.startSession(dayId, date)` → Task 1 Step 3. ✓
- No data-layer/backend change → confirmed (only `Home.tsx` touched). ✓
- Date resets to today on mount (no persistence) → `useState(today())` re-inits each mount. ✓
- Tests: default-today + past-date-creates-session, existing tests still pass → Task 1 Steps 1–5. ✓
- Out-of-scope items (day editor, new exercises, off-template logging, edit/delete session, validation) → not implemented. ✓

**Placeholder scan:** none — full file and full tests provided.

**Type consistency:** `start(dayId: string)` and `db.startSession(workoutDayId: string, date: string)` match the existing `DataLayer` signature; `date` is a `string` (`YYYY-MM-DD`). Consistent.
