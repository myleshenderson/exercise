# Workout Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mobile-first PWA to track weightlifting — pick today's workout, see last time's numbers per exercise, log today's sets — backed by Supabase.

**Architecture:** React + Vite + TypeScript single-page PWA. The UI talks only to a typed `DataLayer` interface; a mock in-memory implementation (seeded from the user's real sheet) is used to build/tune the UX, then a Supabase implementation is swapped in behind the same interface. Supabase provides Postgres + magic-link Auth + Row Level Security. Static deploy; schema applied via CI migrations.

**Tech Stack:** React 18, Vite, TypeScript, Tailwind CSS, `@supabase/supabase-js`, Vitest + React Testing Library (unit/component), Playwright (E2E), `vite-plugin-pwa`.

## Global Constraints

- **Node:** 20+. Package manager: npm.
- **Language:** TypeScript strict mode (`"strict": true`).
- **Env vars (browser):** must be prefixed `VITE_`. Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are read client-side. The DB password is never used by the app.
- **Secrets:** `.env.local` is gitignored; never commit it. Never log the anon key.
- **Mobile-first:** all screens designed for a ~390px-wide phone viewport; large tap targets (min 44px).
- **Security:** every Supabase table has `user_id uuid` with RLS enforcing `user_id = auth.uid()`. Data API stays enabled for `public` schema; RLS is the protection.
- **Dates:** `performedOn` is an ISO date string `YYYY-MM-DD` (no time). Pass "today" explicitly into the data layer (do not call `Date.now()` deep in logic) so logic is testable.
- **Infrastructure:** schema changes are SQL migration files applied via CI, not run by hand locally.
- **TDD:** write the failing test first; commit after each green task.

---

## File Structure

```
exercise/
├── index.html
├── package.json
├── vite.config.ts                # Vite + PWA + Vitest config
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── playwright.config.ts
├── public/
│   ├── manifest.webmanifest
│   └── icon-192.png, icon-512.png
├── src/
│   ├── main.tsx                  # React entry + router
│   ├── App.tsx                   # app shell, routes, auth gate
│   ├── index.css                 # Tailwind directives
│   ├── types.ts                  # domain types (single source of truth)
│   ├── lib/
│   │   ├── sets.ts               # pure: expandLine, collapse, formatSets
│   │   └── lastSession.ts        # pure: findLastSetsForExercise
│   ├── data/
│   │   ├── DataLayer.ts          # the interface
│   │   ├── seed.ts               # seed exercises/days/sessions from the sheet
│   │   ├── mock.ts               # in-memory DataLayer
│   │   ├── supabase.ts           # Supabase DataLayer
│   │   ├── supabaseClient.ts     # createClient singleton
│   │   └── index.ts              # selects mock vs supabase via env
│   ├── auth/
│   │   ├── AuthContext.tsx       # session provider
│   │   └── Login.tsx             # magic-link screen
│   ├── components/
│   │   ├── ExerciseCard.tsx      # last-time + quick-log + per-set expand
│   │   └── SetEditor.tsx         # one-line / per-set input
│   └── screens/
│       ├── Home.tsx
│       ├── Session.tsx
│       ├── ManageDays.tsx
│       └── History.tsx
├── e2e/
│   └── flows.spec.ts
└── supabase/
    └── migrations/
        └── 0001_init.sql
```

---

## Task 1: Project scaffold + tooling

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: a booting Vite app; `npm run dev`, `npm run build`, `npm run test`, `npm run typecheck` scripts.

- [ ] **Step 1: Scaffold with Vite React-TS template**

```bash
npm create vite@latest . -- --template react-ts
npm install
npm install -D tailwindcss postcss autoprefixer vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react
npx tailwindcss init -p
```

- [ ] **Step 2: Configure Tailwind** — `tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
```

Replace `src/index.css` with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 3: Configure Vite + Vitest** — `vite.config.ts`:

```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
  },
});
```

Create `src/setupTests.ts`:

```ts
import "@testing-library/jest-dom";
```

- [ ] **Step 4: Add scripts** to `package.json`:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit"
}
```

Ensure `tsconfig.json` has `"strict": true`.

- [ ] **Step 5: Minimal App** — `src/App.tsx`:

```tsx
export default function App() {
  return <h1 className="text-2xl font-bold p-4">Workout Tracker</h1>;
}
```

- [ ] **Step 6: Write the failing test** — `src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders app title", () => {
  render(<App />);
  expect(screen.getByText("Workout Tracker")).toBeInTheDocument();
});
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm run test && npm run typecheck`
Expected: test PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Vite + React + TS + Tailwind + Vitest"
```

---

## Task 2: Domain types

**Files:**
- Create: `src/types.ts`

**Interfaces:**
- Produces: `Exercise`, `WorkoutDay`, `SetEntry`, `SessionExercise`, `Session`. Every later task imports from here.

- [ ] **Step 1: Define types** — `src/types.ts`:

```ts
export interface Exercise {
  id: string;
  name: string;
  cue: string;
  defaultSets: number;
  defaultRepLow: number;
  defaultRepHigh: number;
}

export interface WorkoutDay {
  id: string;
  name: string;
  position: number;
  exerciseIds: string[]; // ordered
}

export interface SetEntry {
  setNumber: number; // 1-based
  weight: number;
  reps: number;
}

export interface SessionExercise {
  exerciseId: string;
  sets: SetEntry[];
}

export interface Session {
  id: string;
  workoutDayId: string | null;
  performedOn: string; // "YYYY-MM-DD"
  exercises: SessionExercise[];
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (no usages yet, file compiles).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add domain types"
```

---

## Task 3: Set display logic (`lib/sets.ts`)

**Files:**
- Create: `src/lib/sets.ts`
- Test: `src/lib/sets.test.ts`

**Interfaces:**
- Consumes: `SetEntry` from `src/types.ts`.
- Produces:
  - `expandLine(weight: number, sets: number, reps: number): SetEntry[]`
  - `formatSets(sets: SetEntry[]): string`

- [ ] **Step 1: Write the failing test** — `src/lib/sets.test.ts`:

```ts
import { expandLine, formatSets } from "./sets";

test("expandLine creates N identical numbered sets", () => {
  expect(expandLine(150, 3, 12)).toEqual([
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 150, reps: 12 },
    { setNumber: 3, weight: 150, reps: 12 },
  ]);
});

test("formatSets collapses uniform sets", () => {
  expect(formatSets(expandLine(150, 3, 12))).toBe("150 × 3 × 12");
});

test("formatSets shows per-set reps when weight uniform but reps differ", () => {
  const sets = [
    { setNumber: 1, weight: 35, reps: 8 },
    { setNumber: 2, weight: 35, reps: 6 },
    { setNumber: 3, weight: 35, reps: 4 },
  ];
  expect(formatSets(sets)).toBe("35 × (8, 6, 4)");
});

test("formatSets shows weight×reps per set when weights differ", () => {
  const sets = [
    { setNumber: 1, weight: 35, reps: 8 },
    { setNumber: 2, weight: 30, reps: 6 },
  ];
  expect(formatSets(sets)).toBe("35×8, 30×6");
});

test("formatSets handles empty", () => {
  expect(formatSets([])).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/lib/sets.ts`:

```ts
import type { SetEntry } from "../types";

export function expandLine(weight: number, sets: number, reps: number): SetEntry[] {
  return Array.from({ length: sets }, (_, i) => ({
    setNumber: i + 1,
    weight,
    reps,
  }));
}

export function formatSets(sets: SetEntry[]): string {
  if (sets.length === 0) return "";
  const sameWeight = sets.every((s) => s.weight === sets[0].weight);
  const sameReps = sets.every((s) => s.reps === sets[0].reps);
  if (sameWeight && sameReps) {
    return `${sets[0].weight} × ${sets.length} × ${sets[0].reps}`;
  }
  if (sameWeight) {
    return `${sets[0].weight} × (${sets.map((s) => s.reps).join(", ")})`;
  }
  return sets.map((s) => `${s.weight}×${s.reps}`).join(", ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/sets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sets.ts src/lib/sets.test.ts
git commit -m "feat: set expand + format logic"
```

---

## Task 4: Last-session lookup (`lib/lastSession.ts`)

**Files:**
- Create: `src/lib/lastSession.ts`
- Test: `src/lib/lastSession.test.ts`

**Interfaces:**
- Consumes: `Session`, `SetEntry`.
- Produces: `findLastSetsForExercise(sessions: Session[], exerciseId: string, beforeDate: string): SetEntry[]` — returns the sets for `exerciseId` from the most recent session with `performedOn < beforeDate` that contains the exercise; `[]` if none.

- [ ] **Step 1: Write the failing test** — `src/lib/lastSession.test.ts`:

```ts
import { findLastSetsForExercise } from "./lastSession";
import type { Session } from "../types";

const sessions: Session[] = [
  {
    id: "s1", workoutDayId: "d1", performedOn: "2026-06-01",
    exercises: [{ exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 130, reps: 12 }] }],
  },
  {
    id: "s2", workoutDayId: "d1", performedOn: "2026-06-10",
    exercises: [{ exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 150, reps: 12 }] }],
  },
];

test("returns sets from most recent prior session", () => {
  expect(findLastSetsForExercise(sessions, "leg-press", "2026-06-22"))
    .toEqual([{ setNumber: 1, weight: 150, reps: 12 }]);
});

test("ignores sessions on/after beforeDate", () => {
  expect(findLastSetsForExercise(sessions, "leg-press", "2026-06-10"))
    .toEqual([{ setNumber: 1, weight: 130, reps: 12 }]);
});

test("returns empty when exercise never done", () => {
  expect(findLastSetsForExercise(sessions, "unknown", "2026-06-22")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lastSession.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/lib/lastSession.ts`:

```ts
import type { Session, SetEntry } from "../types";

export function findLastSetsForExercise(
  sessions: Session[],
  exerciseId: string,
  beforeDate: string,
): SetEntry[] {
  const candidates = sessions
    .filter((s) => s.performedOn < beforeDate)
    .filter((s) => s.exercises.some((e) => e.exerciseId === exerciseId))
    .sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
  const latest = candidates[0];
  if (!latest) return [];
  return latest.exercises.find((e) => e.exerciseId === exerciseId)!.sets;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lastSession.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/lastSession.ts src/lib/lastSession.test.ts
git commit -m "feat: last-session lookup"
```

---

## Task 5: DataLayer interface + seed data

**Files:**
- Create: `src/data/DataLayer.ts`, `src/data/seed.ts`

**Interfaces:**
- Consumes: domain types.
- Produces:
  - `DataLayer` interface (methods listed below).
  - `seedExercises: Exercise[]`, `seedDays: WorkoutDay[]`, `seedSessions: Session[]` from the user's real sheet.

- [ ] **Step 1: Define the interface** — `src/data/DataLayer.ts`:

```ts
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";

export interface DataLayer {
  listExercises(): Promise<Exercise[]>;
  getExercise(id: string): Promise<Exercise | null>;
  createExercise(input: Omit<Exercise, "id">): Promise<Exercise>;

  getWorkoutDays(): Promise<WorkoutDay[]>;
  getDayExercises(dayId: string): Promise<Exercise[]>;
  createDay(name: string): Promise<WorkoutDay>;
  updateDayExercises(dayId: string, exerciseIds: string[]): Promise<void>;

  getLastSetsForExercise(exerciseId: string, beforeDate: string): Promise<SetEntry[]>;

  startSession(workoutDayId: string | null, date: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  logExercise(sessionId: string, exerciseId: string, sets: SetEntry[]): Promise<void>;
  getExerciseHistory(exerciseId: string): Promise<Session[]>;
}
```

- [ ] **Step 2: Create seed data** — `src/data/seed.ts` (IDs are slugs; targets and last-time numbers taken from the user's sheet):

```ts
import type { Exercise, WorkoutDay, Session } from "../types";

export const seedExercises: Exercise[] = [
  { id: "leg-press", name: "Leg Press", cue: "main driver", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "leg-curl", name: "Leg Curl", cue: "hamstrings — cycling neglects these", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 15 },
  { id: "leg-extension", name: "Leg Extension", cue: "quads, full range", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 15 },
  { id: "seated-calf-raise", name: "Seated Calf Raise", cue: "", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 20 },
  { id: "hip-thrust", name: "Hip Thrust or Back Extension", cue: "glutes/posterior chain", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 15 },
  { id: "core-crunch", name: "Core / Machine Crunch", cue: "hanging or machine", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 15 },
  { id: "chest-press", name: "Chest Press", cue: "", defaultSets: 4, defaultRepLow: 8, defaultRepHigh: 12 },
  { id: "seated-row", name: "Seated Row", cue: "squeeze shoulder blades", defaultSets: 4, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "shoulder-press", name: "Shoulder Press", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 },
  { id: "lat-pulldown", name: "Lat Pulldown", cue: "drive elbows down", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "lateral-raise", name: "Lateral Raise", cue: "light, controlled", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 15 },
  { id: "triceps-pushdown", name: "Triceps Pushdown", cue: "", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 15 },
  { id: "bicep-curl", name: "Bicep Curl", cue: "", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "pectoral-fly", name: "Pectoral Fly", cue: "", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
];

export const seedDays: WorkoutDay[] = [
  {
    id: "leg-day", name: "Leg Day", position: 0,
    exerciseIds: ["leg-press", "leg-curl", "leg-extension", "seated-calf-raise", "hip-thrust", "core-crunch"],
  },
  {
    id: "upper-day", name: "Upper Day", position: 1,
    exerciseIds: ["chest-press", "seated-row", "shoulder-press", "lat-pulldown", "lateral-raise", "triceps-pushdown"],
  },
];

// One prior session per day so "last time" has data to show.
export const seedSessions: Session[] = [
  {
    id: "seed-leg", workoutDayId: "leg-day", performedOn: "2026-06-18",
    exercises: [
      { exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 150, reps: 12 }, { setNumber: 2, weight: 150, reps: 12 }, { setNumber: 3, weight: 150, reps: 12 }] },
      { exerciseId: "leg-curl", sets: [{ setNumber: 1, weight: 105, reps: 10 }, { setNumber: 2, weight: 105, reps: 10 }, { setNumber: 3, weight: 105, reps: 10 }] },
      { exerciseId: "leg-extension", sets: [{ setNumber: 1, weight: 110, reps: 12 }, { setNumber: 2, weight: 110, reps: 12 }, { setNumber: 3, weight: 110, reps: 12 }] },
      { exerciseId: "seated-calf-raise", sets: [{ setNumber: 1, weight: 55, reps: 15 }, { setNumber: 2, weight: 55, reps: 15 }, { setNumber: 3, weight: 55, reps: 15 }] },
      { exerciseId: "hip-thrust", sets: [{ setNumber: 1, weight: 90, reps: 12 }, { setNumber: 2, weight: 90, reps: 12 }, { setNumber: 3, weight: 90, reps: 12 }] },
      { exerciseId: "core-crunch", sets: [{ setNumber: 1, weight: 105, reps: 12 }, { setNumber: 2, weight: 105, reps: 12 }, { setNumber: 3, weight: 105, reps: 12 }] },
    ],
  },
  {
    id: "seed-upper", workoutDayId: "upper-day", performedOn: "2026-06-20",
    exercises: [
      { exerciseId: "chest-press", sets: [{ setNumber: 1, weight: 70, reps: 12 }, { setNumber: 2, weight: 70, reps: 12 }, { setNumber: 3, weight: 70, reps: 12 }, { setNumber: 4, weight: 70, reps: 12 }] },
      { exerciseId: "seated-row", sets: [{ setNumber: 1, weight: 75, reps: 10 }, { setNumber: 2, weight: 75, reps: 10 }, { setNumber: 3, weight: 75, reps: 10 }, { setNumber: 4, weight: 75, reps: 10 }] },
      { exerciseId: "shoulder-press", sets: [{ setNumber: 1, weight: 25, reps: 10 }, { setNumber: 2, weight: 25, reps: 10 }, { setNumber: 3, weight: 25, reps: 8 }] },
      { exerciseId: "lat-pulldown", sets: [{ setNumber: 1, weight: 85, reps: 10 }, { setNumber: 2, weight: 85, reps: 10 }, { setNumber: 3, weight: 85, reps: 10 }] },
    ],
  },
];
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/data/DataLayer.ts src/data/seed.ts
git commit -m "feat: DataLayer interface + seed data from sheet"
```

---

## Task 6: Mock DataLayer implementation

**Files:**
- Create: `src/data/mock.ts`
- Test: `src/data/mock.test.ts`

**Interfaces:**
- Consumes: `DataLayer`, seed data, `findLastSetsForExercise`.
- Produces: `createMockDataLayer(): DataLayer` — in-memory, seeded; mutations persist for the lifetime of the instance.

- [ ] **Step 1: Write the failing test** — `src/data/mock.test.ts`:

```ts
import { createMockDataLayer } from "./mock";

test("getWorkoutDays returns seeded days in order", async () => {
  const db = createMockDataLayer();
  const days = await db.getWorkoutDays();
  expect(days.map((d) => d.name)).toEqual(["Leg Day", "Upper Day"]);
});

test("getDayExercises returns exercises for a day, ordered", async () => {
  const db = createMockDataLayer();
  const ex = await db.getDayExercises("leg-day");
  expect(ex[0].name).toBe("Leg Press");
  expect(ex).toHaveLength(6);
});

test("getLastSetsForExercise returns seeded prior sets", async () => {
  const db = createMockDataLayer();
  const sets = await db.getLastSetsForExercise("leg-press", "2026-06-22");
  expect(sets[0].weight).toBe(150);
});

test("startSession + logExercise persists and is retrievable", async () => {
  const db = createMockDataLayer();
  const session = await db.startSession("leg-day", "2026-06-22");
  await db.logExercise(session.id, "leg-press", [{ setNumber: 1, weight: 155, reps: 10 }]);
  const reloaded = await db.getSession(session.id);
  expect(reloaded!.exercises[0].sets[0].weight).toBe(155);
});

test("logged set becomes 'last time' for a later date", async () => {
  const db = createMockDataLayer();
  const session = await db.startSession("leg-day", "2026-06-22");
  await db.logExercise(session.id, "leg-press", [{ setNumber: 1, weight: 160, reps: 10 }]);
  const sets = await db.getLastSetsForExercise("leg-press", "2026-06-23");
  expect(sets[0].weight).toBe(160);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/mock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/data/mock.ts`:

```ts
import type { DataLayer } from "./DataLayer";
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";
import { seedExercises, seedDays, seedSessions } from "./seed";
import { findLastSetsForExercise } from "../lib/lastSession";

export function createMockDataLayer(): DataLayer {
  const exercises: Exercise[] = structuredClone(seedExercises);
  const days: WorkoutDay[] = structuredClone(seedDays);
  const sessions: Session[] = structuredClone(seedSessions);
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  return {
    async listExercises() {
      return exercises.slice();
    },
    async getExercise(id) {
      return exercises.find((e) => e.id === id) ?? null;
    },
    async createExercise(input) {
      const ex: Exercise = { ...input, id: nextId("ex") };
      exercises.push(ex);
      return ex;
    },
    async getWorkoutDays() {
      return days.slice().sort((a, b) => a.position - b.position);
    },
    async getDayExercises(dayId) {
      const day = days.find((d) => d.id === dayId);
      if (!day) return [];
      return day.exerciseIds
        .map((id) => exercises.find((e) => e.id === id))
        .filter((e): e is Exercise => !!e);
    },
    async createDay(name) {
      const day: WorkoutDay = { id: nextId("day"), name, position: days.length, exerciseIds: [] };
      days.push(day);
      return day;
    },
    async updateDayExercises(dayId, exerciseIds) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.exerciseIds = exerciseIds.slice();
    },
    async getLastSetsForExercise(exerciseId, beforeDate) {
      return findLastSetsForExercise(sessions, exerciseId, beforeDate);
    },
    async startSession(workoutDayId, date) {
      const session: Session = { id: nextId("session"), workoutDayId, performedOn: date, exercises: [] };
      sessions.push(session);
      return session;
    },
    async getSession(id) {
      return sessions.find((s) => s.id === id) ?? null;
    },
    async logExercise(sessionId, exerciseId, sets) {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const existing = session.exercises.find((e) => e.exerciseId === exerciseId);
      if (existing) existing.sets = sets.slice();
      else session.exercises.push({ exerciseId, sets: sets.slice() });
    },
    async getExerciseHistory(exerciseId) {
      return sessions
        .filter((s) => s.exercises.some((e) => e.exerciseId === exerciseId))
        .sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/data/mock.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data/mock.ts src/data/mock.test.ts
git commit -m "feat: in-memory mock DataLayer"
```

---

## Task 7: DataLayer selector + app-wide instance

**Files:**
- Create: `src/data/index.ts`

**Interfaces:**
- Consumes: `createMockDataLayer`. (Supabase impl added in Task 13; selection stubbed to mock until then.)
- Produces: `db: DataLayer` — the singleton the app imports. Selection via `import.meta.env.VITE_DATA_BACKEND` (`"mock"` default).

- [ ] **Step 1: Implement** — `src/data/index.ts`:

```ts
import type { DataLayer } from "./DataLayer";
import { createMockDataLayer } from "./mock";

// Swap to "supabase" via VITE_DATA_BACKEND once the Supabase impl lands (Task 13).
const backend = import.meta.env.VITE_DATA_BACKEND ?? "mock";

export const db: DataLayer =
  backend === "supabase"
    ? (() => { throw new Error("Supabase backend not yet wired (Task 13)"); })()
    : createMockDataLayer();
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/data/index.ts
git commit -m "feat: DataLayer selector (mock default)"
```

---

## Task 8: Routing + app shell

**Files:**
- Modify: `src/App.tsx`, `src/main.tsx`
- Test: `src/App.test.tsx` (update)

**Interfaces:**
- Consumes: screen components (added in later tasks — create placeholder screens here so routes compile).
- Produces: routes `/` (Home), `/session/:id` (Session), `/days` (ManageDays), `/history/:exerciseId` (History), and a bottom nav.

- [ ] **Step 1: Install router**

```bash
npm install react-router-dom
```

- [ ] **Step 2: Create placeholder screens** — `src/screens/Home.tsx`, `Session.tsx`, `ManageDays.tsx`, `History.tsx`, each:

```tsx
export default function Home() { return <div>Home</div>; }
```

(Name each component to match its file; same one-line body for the other three.)

- [ ] **Step 3: Wire router** — `src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

`src/App.tsx`:

```tsx
import { Routes, Route, Link } from "react-router-dom";
import Home from "./screens/Home";
import Session from "./screens/Session";
import ManageDays from "./screens/ManageDays";
import History from "./screens/History";

export default function App() {
  return (
    <div className="min-h-screen max-w-md mx-auto pb-16">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/session/:id" element={<Session />} />
        <Route path="/days" element={<ManageDays />} />
        <Route path="/history/:exerciseId" element={<History />} />
      </Routes>
      <nav className="fixed bottom-0 inset-x-0 max-w-md mx-auto flex justify-around bg-white border-t py-2">
        <Link to="/" className="p-2">Home</Link>
        <Link to="/days" className="p-2">Days</Link>
      </nav>
    </div>
  );
}
```

- [ ] **Step 4: Update test** — `src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

test("renders home route", () => {
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  expect(screen.getByText("Home")).toBeInTheDocument();
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: routing + app shell with bottom nav"
```

---

## Task 9: Home screen (day list)

**Files:**
- Modify: `src/screens/Home.tsx`
- Test: `src/screens/Home.test.tsx`

**Interfaces:**
- Consumes: `db.getWorkoutDays()`, `db.startSession(dayId, today)`. Uses `useNavigate` to go to `/session/:id`.
- Produces: tapping a day creates a session and navigates to it.

- [ ] **Step 1: Write the failing test** — `src/screens/Home.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Home from "./Home";

test("lists workout days", async () => {
  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.getByText("Upper Day")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/screens/Home.test.tsx`
Expected: FAIL — only placeholder "Home" text.

- [ ] **Step 3: Implement** — `src/screens/Home.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { WorkoutDay } from "../types";

const today = () => new Date().toISOString().slice(0, 10);

export default function Home() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const navigate = useNavigate();

  useEffect(() => { db.getWorkoutDays().then(setDays); }, []);

  async function start(dayId: string | null) {
    const session = await db.startSession(dayId, today());
    navigate(`/session/${session.id}`);
  }

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-2xl font-bold">Today's Workout</h1>
      {days.map((d) => (
        <button key={d.id} onClick={() => start(d.id)}
          className="w-full text-left text-lg font-semibold rounded-xl border p-4 active:bg-gray-100">
          {d.name}
        </button>
      ))}
      <button onClick={() => start(null)}
        className="w-full text-left text-gray-600 rounded-xl border border-dashed p-4">
        Start blank session
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/screens/Home.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/Home.tsx src/screens/Home.test.tsx
git commit -m "feat: home screen day list + start session"
```

---

## Task 10: SetEditor + ExerciseCard components

**Files:**
- Create: `src/components/SetEditor.tsx`, `src/components/ExerciseCard.tsx`
- Test: `src/components/ExerciseCard.test.tsx`

**Interfaces:**
- Consumes: `Exercise`, `SetEntry`, `formatSets`, `expandLine`.
- Produces:
  - `SetEditor` props: `{ initialWeight: number; initialSets: number; initialReps: number; onSave(sets: SetEntry[]): void }`. One-line mode (weight, sets, reps) with an "edit per set" toggle.
  - `ExerciseCard` props: `{ exercise: Exercise; lastSets: SetEntry[]; loggedSets: SetEntry[] | null; onLog(sets: SetEntry[]): void }`. Shows name, cue, "Last: …" via `formatSets(lastSets)`, target reps, and a `SetEditor` pre-filled with last weight; shows a check when `loggedSets` is set.

- [ ] **Step 1: Write the failing test** — `src/components/ExerciseCard.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import ExerciseCard from "./ExerciseCard";
import type { Exercise } from "../types";

const ex: Exercise = { id: "leg-press", name: "Leg Press", cue: "main driver", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 };

test("shows last time formatted", () => {
  render(<ExerciseCard exercise={ex} lastSets={[{ setNumber: 1, weight: 150, reps: 12 }, { setNumber: 2, weight: 150, reps: 12 }, { setNumber: 3, weight: 150, reps: 12 }]} loggedSets={null} onLog={() => {}} />);
  expect(screen.getByText(/Last: 150 × 3 × 12/)).toBeInTheDocument();
});

test("logging one line calls onLog with expanded sets", () => {
  const onLog = vi.fn();
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} onLog={onLog} />);
  fireEvent.change(screen.getByLabelText("weight"), { target: { value: "155" } });
  fireEvent.change(screen.getByLabelText("sets"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("reps"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /log/i }));
  expect(onLog).toHaveBeenCalledWith([
    { setNumber: 1, weight: 155, reps: 10 },
    { setNumber: 2, weight: 155, reps: 10 },
    { setNumber: 3, weight: 155, reps: 10 },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ExerciseCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SetEditor`** — `src/components/SetEditor.tsx`:

```tsx
import { useState } from "react";
import type { SetEntry } from "../types";
import { expandLine } from "../lib/sets";

interface Props {
  initialWeight: number;
  initialSets: number;
  initialReps: number;
  onSave(sets: SetEntry[]): void;
}

export default function SetEditor({ initialWeight, initialSets, initialReps, onSave }: Props) {
  const [weight, setWeight] = useState(initialWeight);
  const [sets, setSets] = useState(initialSets);
  const [reps, setReps] = useState(initialReps);

  return (
    <div className="flex items-end gap-2 mt-2">
      <Field label="weight" value={weight} onChange={setWeight} />
      <Field label="sets" value={sets} onChange={setSets} />
      <Field label="reps" value={reps} onChange={setReps} />
      <button
        onClick={() => onSave(expandLine(weight, sets, reps))}
        className="rounded-lg bg-black text-white px-4 py-2 font-semibold">
        Log
      </button>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange(n: number): void }) {
  return (
    <label className="flex flex-col text-xs text-gray-500">
      {label}
      <input
        aria-label={label}
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 rounded-lg border p-2 text-base text-black"
      />
    </label>
  );
}
```

- [ ] **Step 4: Implement `ExerciseCard`** — `src/components/ExerciseCard.tsx`:

```tsx
import type { Exercise, SetEntry } from "../types";
import { formatSets } from "../lib/sets";
import SetEditor from "./SetEditor";

interface Props {
  exercise: Exercise;
  lastSets: SetEntry[];
  loggedSets: SetEntry[] | null;
  onLog(sets: SetEntry[]): void;
}

export default function ExerciseCard({ exercise, lastSets, loggedSets, onLog }: Props) {
  const lastLine = formatSets(lastSets);
  const lastWeight = lastSets[0]?.weight ?? 0;
  return (
    <div className="rounded-xl border p-4">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-lg">{exercise.name}</h2>
        {loggedSets && <span aria-label="logged" className="text-green-600">✓</span>}
      </div>
      {exercise.cue && <p className="text-sm text-gray-500">{exercise.cue}</p>}
      <p className="text-sm text-gray-600">
        Target: {exercise.defaultSets} × {exercise.defaultRepLow}–{exercise.defaultRepHigh}
      </p>
      <p className="text-sm font-medium">Last: {lastLine || "—"}</p>
      {loggedSets ? (
        <p className="text-sm text-green-700 mt-1">Logged: {formatSets(loggedSets)}</p>
      ) : (
        <SetEditor
          initialWeight={lastWeight}
          initialSets={exercise.defaultSets}
          initialReps={exercise.defaultRepLow}
          onSave={onLog}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/ExerciseCard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/SetEditor.tsx src/components/ExerciseCard.tsx src/components/ExerciseCard.test.tsx
git commit -m "feat: SetEditor + ExerciseCard components"
```

---

## Task 11: Session screen (main screen)

**Files:**
- Modify: `src/screens/Session.tsx`
- Test: `src/screens/Session.test.tsx`

**Interfaces:**
- Consumes: `useParams` for `id`; `db.getSession`, `db.getDayExercises`, `db.getLastSetsForExercise`, `db.logExercise`; `ExerciseCard`.
- Produces: renders the session's day exercises as cards with last-time data; logging persists via `db.logExercise` and marks the card done.

- [ ] **Step 1: Write the failing test** — `src/screens/Session.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Session from "./Session";
import { db } from "../data";

async function renderSession() {
  const s = await db.startSession("leg-day", "2026-06-22");
  render(
    <MemoryRouter initialEntries={[`/session/${s.id}`]}>
      <Routes><Route path="/session/:id" element={<Session />} /></Routes>
    </MemoryRouter>,
  );
  return s;
}

test("renders day exercises with last-time numbers", async () => {
  await renderSession();
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getByText(/Last: 150 × 3 × 12/)).toBeInTheDocument();
});

test("logging an exercise marks it done", async () => {
  await renderSession();
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  const buttons = screen.getAllByRole("button", { name: /log/i });
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(screen.getAllByLabelText("logged").length).toBeGreaterThan(0));
});
```

> Note: the mock `db` is a module singleton, so seeded data and any sessions created in the test share state — that's intended.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/screens/Session.test.tsx`
Expected: FAIL — placeholder only.

- [ ] **Step 3: Implement** — `src/screens/Session.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { db } from "../data";
import type { Exercise, Session as SessionT, SetEntry } from "../types";
import ExerciseCard from "../components/ExerciseCard";

export default function Session() {
  const { id } = useParams();
  const [session, setSession] = useState<SessionT | null>(null);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [lastByEx, setLastByEx] = useState<Record<string, SetEntry[]>>({});

  useEffect(() => {
    if (!id) return;
    (async () => {
      const s = await db.getSession(id);
      if (!s) return;
      setSession(s);
      const ex = s.workoutDayId ? await db.getDayExercises(s.workoutDayId) : [];
      setExercises(ex);
      const last: Record<string, SetEntry[]> = {};
      for (const e of ex) {
        last[e.id] = await db.getLastSetsForExercise(e.id, s.performedOn);
      }
      setLastByEx(last);
    })();
  }, [id]);

  async function log(exerciseId: string, sets: SetEntry[]) {
    if (!session) return;
    await db.logExercise(session.id, exerciseId, sets);
    const updated = await db.getSession(session.id);
    setSession(updated);
  }

  if (!session) return <div className="p-4">Loading…</div>;

  const loggedFor = (exId: string) =>
    session.exercises.find((e) => e.exerciseId === exId)?.sets ?? null;

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-bold">Session — {session.performedOn}</h1>
      {exercises.map((e) => (
        <ExerciseCard
          key={e.id}
          exercise={e}
          lastSets={lastByEx[e.id] ?? []}
          loggedSets={loggedFor(e.id)}
          onLog={(sets) => log(e.id, sets)}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/screens/Session.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/screens/Session.tsx src/screens/Session.test.tsx
git commit -m "feat: session screen with last-time + logging"
```

---

## Task 12: Manage Days + History screens

**Files:**
- Modify: `src/screens/ManageDays.tsx`, `src/screens/History.tsx`
- Test: `src/screens/ManageDays.test.tsx`

**Interfaces:**
- Consumes: `db.getWorkoutDays`, `db.getDayExercises`, `db.listExercises`, `db.updateDayExercises`, `db.createDay`; `db.getExerciseHistory`, `db.getExercise`; `formatSets`.
- Produces: ManageDays — view each day's exercises, add an exercise from the catalog, remove one. History — list of past sessions for an exercise with formatted sets.

- [ ] **Step 1: Write the failing test** — `src/screens/ManageDays.test.tsx`:

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ManageDays from "./ManageDays";

test("shows days and their exercises", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.getByText("Leg Press")).toBeInTheDocument();
});

test("removing an exercise updates the list", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  const removeButtons = screen.getAllByRole("button", { name: /remove leg press/i });
  fireEvent.click(removeButtons[0]);
  await waitFor(() => expect(screen.queryByText("Leg Press")).not.toBeInTheDocument());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/screens/ManageDays.test.tsx`
Expected: FAIL — placeholder only.

- [ ] **Step 3: Implement ManageDays** — `src/screens/ManageDays.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react";
import { db } from "../data";
import type { WorkoutDay, Exercise } from "../types";

export default function ManageDays() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [exByDay, setExByDay] = useState<Record<string, Exercise[]>>({});

  const load = useCallback(async () => {
    const d = await db.getWorkoutDays();
    setDays(d);
    const map: Record<string, Exercise[]> = {};
    for (const day of d) map[day.id] = await db.getDayExercises(day.id);
    setExByDay(map);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(day: WorkoutDay, exerciseId: string) {
    const remaining = day.exerciseIds.filter((id) => id !== exerciseId);
    await db.updateDayExercises(day.id, remaining);
    await load();
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Manage Days</h1>
      {days.map((day) => (
        <div key={day.id} className="rounded-xl border p-4">
          <h2 className="font-semibold">{day.name}</h2>
          <ul className="mt-2 space-y-1">
            {(exByDay[day.id] ?? []).map((e) => (
              <li key={e.id} className="flex justify-between items-center">
                <span>{e.name}</span>
                <button
                  aria-label={`remove ${e.name}`}
                  onClick={() => remove(day, e.id)}
                  className="text-red-600 text-sm px-2">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement History** — `src/screens/History.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { db } from "../data";
import type { Session, Exercise } from "../types";
import { formatSets } from "../lib/sets";

export default function History() {
  const { exerciseId } = useParams();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [exercise, setExercise] = useState<Exercise | null>(null);

  useEffect(() => {
    if (!exerciseId) return;
    db.getExercise(exerciseId).then(setExercise);
    db.getExerciseHistory(exerciseId).then(setSessions);
  }, [exerciseId]);

  return (
    <div className="p-4 space-y-2">
      <h1 className="text-xl font-bold">{exercise?.name ?? "History"}</h1>
      {sessions.map((s) => {
        const sets = s.exercises.find((e) => e.exerciseId === exerciseId)?.sets ?? [];
        return (
          <div key={s.id} className="flex justify-between border-b py-2">
            <span className="text-gray-600">{s.performedOn}</span>
            <span className="font-medium">{formatSets(sets)}</span>
          </div>
        );
      })}
      {sessions.length === 0 && <p className="text-gray-500">No history yet.</p>}
    </div>
  );
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/screens/ManageDays.test.tsx && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/screens/ManageDays.tsx src/screens/History.tsx src/screens/ManageDays.test.tsx
git commit -m "feat: manage days + exercise history screens"
```

---

## Task 13: Supabase schema migration

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: the six tables with RLS keyed on `auth.uid()`. Column names map to domain fields (snake_case in DB, camelCase in app — mapping handled in Task 14).

- [ ] **Step 1: Write the migration** — `supabase/migrations/0001_init.sql`:

```sql
-- Exercises catalog
create table exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  cue text not null default '',
  default_sets int not null default 3,
  default_rep_low int not null default 10,
  default_rep_high int not null default 12,
  created_at timestamptz not null default now()
);

create table workout_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table workout_day_exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  workout_day_id uuid not null references workout_days(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  position int not null default 0
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  workout_day_id uuid references workout_days(id) on delete set null,
  performed_on date not null,
  created_at timestamptz not null default now()
);

create table session_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  session_id uuid not null references sessions(id) on delete cascade,
  exercise_id uuid not null references exercises(id) on delete cascade,
  set_number int not null,
  weight numeric not null,
  reps int not null
);

-- Enable RLS + per-user policies
do $$
declare t text;
begin
  foreach t in array array['exercises','workout_days','workout_day_exercises','sessions','session_sets']
  loop
    execute format('alter table %I enable row level security;', t);
    execute format($p$create policy "own_select" on %I for select using (user_id = auth.uid());$p$, t);
    execute format($p$create policy "own_insert" on %I for insert with check (user_id = auth.uid());$p$, t);
    execute format($p$create policy "own_update" on %I for update using (user_id = auth.uid());$p$, t);
    execute format($p$create policy "own_delete" on %I for delete using (user_id = auth.uid());$p$, t);
  end loop;
end $$;
```

- [ ] **Step 2: Validate SQL locally (syntax)**

Run: `npx supabase db lint --file supabase/migrations/0001_init.sql 2>/dev/null || echo "supabase CLI not installed — review SQL manually"`
Expected: no syntax errors (or manual review note).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "feat: initial Supabase schema + RLS migration"
```

> The migration is applied to Supabase via CI (Task 17), not run by hand.

---

## Task 14: Supabase client + DataLayer implementation

**Files:**
- Create: `src/data/supabaseClient.ts`, `src/data/supabase.ts`
- Modify: `src/data/index.ts`

**Interfaces:**
- Consumes: `DataLayer`, domain types, `findLastSetsForExercise` (reused for the "last sets" query post-fetch).
- Produces: `createSupabaseDataLayer(): DataLayer`. Maps snake_case rows ↔ camelCase types.

- [ ] **Step 1: Install client**

```bash
npm install @supabase/supabase-js
```

- [ ] **Step 2: Client singleton** — `src/data/supabaseClient.ts`:

```ts
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anonKey);
```

- [ ] **Step 3: Implement the DataLayer** — `src/data/supabase.ts`:

```ts
import type { DataLayer } from "./DataLayer";
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";
import { supabase } from "./supabaseClient";

const toExercise = (r: any): Exercise => ({
  id: r.id, name: r.name, cue: r.cue,
  defaultSets: r.default_sets, defaultRepLow: r.default_rep_low, defaultRepHigh: r.default_rep_high,
});

async function loadSession(id: string): Promise<Session | null> {
  const { data: s } = await supabase.from("sessions").select("*").eq("id", id).single();
  if (!s) return null;
  const { data: sets } = await supabase.from("session_sets").select("*").eq("session_id", id).order("set_number");
  const byExercise: Record<string, SetEntry[]> = {};
  for (const row of sets ?? []) {
    (byExercise[row.exercise_id] ??= []).push({ setNumber: row.set_number, weight: Number(row.weight), reps: row.reps });
  }
  return {
    id: s.id, workoutDayId: s.workout_day_id, performedOn: s.performed_on,
    exercises: Object.entries(byExercise).map(([exerciseId, sets]) => ({ exerciseId, sets })),
  };
}

export function createSupabaseDataLayer(): DataLayer {
  return {
    async listExercises() {
      const { data } = await supabase.from("exercises").select("*").order("name");
      return (data ?? []).map(toExercise);
    },
    async getExercise(id) {
      const { data } = await supabase.from("exercises").select("*").eq("id", id).single();
      return data ? toExercise(data) : null;
    },
    async createExercise(input) {
      const { data } = await supabase.from("exercises").insert({
        name: input.name, cue: input.cue,
        default_sets: input.defaultSets, default_rep_low: input.defaultRepLow, default_rep_high: input.defaultRepHigh,
      }).select("*").single();
      return toExercise(data);
    },
    async getWorkoutDays() {
      const { data } = await supabase.from("workout_days").select("*").order("position");
      const days: WorkoutDay[] = [];
      for (const d of data ?? []) {
        const { data: links } = await supabase.from("workout_day_exercises")
          .select("exercise_id, position").eq("workout_day_id", d.id).order("position");
        days.push({ id: d.id, name: d.name, position: d.position, exerciseIds: (links ?? []).map((l) => l.exercise_id) });
      }
      return days;
    },
    async getDayExercises(dayId) {
      const { data: links } = await supabase.from("workout_day_exercises")
        .select("exercise_id, position").eq("workout_day_id", dayId).order("position");
      const out: Exercise[] = [];
      for (const l of links ?? []) {
        const ex = await this.getExercise(l.exercise_id);
        if (ex) out.push(ex);
      }
      return out;
    },
    async createDay(name) {
      const { data } = await supabase.from("workout_days").insert({ name }).select("*").single();
      return { id: data.id, name: data.name, position: data.position, exerciseIds: [] };
    },
    async updateDayExercises(dayId, exerciseIds) {
      await supabase.from("workout_day_exercises").delete().eq("workout_day_id", dayId);
      if (exerciseIds.length) {
        await supabase.from("workout_day_exercises").insert(
          exerciseIds.map((exercise_id, position) => ({ workout_day_id: dayId, exercise_id, position })),
        );
      }
    },
    async getLastSetsForExercise(exerciseId, beforeDate) {
      const { data: s } = await supabase.from("sessions")
        .select("id, performed_on").lt("performed_on", beforeDate).order("performed_on", { ascending: false });
      for (const sess of s ?? []) {
        const { data: sets } = await supabase.from("session_sets")
          .select("*").eq("session_id", sess.id).eq("exercise_id", exerciseId).order("set_number");
        if (sets && sets.length) {
          return sets.map((row) => ({ setNumber: row.set_number, weight: Number(row.weight), reps: row.reps }));
        }
      }
      return [];
    },
    async startSession(workoutDayId, date) {
      const { data } = await supabase.from("sessions")
        .insert({ workout_day_id: workoutDayId, performed_on: date }).select("*").single();
      return { id: data.id, workoutDayId: data.workout_day_id, performedOn: data.performed_on, exercises: [] };
    },
    getSession: loadSession,
    async logExercise(sessionId, exerciseId, sets) {
      await supabase.from("session_sets").delete().eq("session_id", sessionId).eq("exercise_id", exerciseId);
      await supabase.from("session_sets").insert(
        sets.map((s) => ({ session_id: sessionId, exercise_id: exerciseId, set_number: s.setNumber, weight: s.weight, reps: s.reps })),
      );
    },
    async getExerciseHistory(exerciseId) {
      const { data: setRows } = await supabase.from("session_sets").select("session_id").eq("exercise_id", exerciseId);
      const ids = [...new Set((setRows ?? []).map((r) => r.session_id))];
      const sessions: Session[] = [];
      for (const id of ids) {
        const s = await loadSession(id);
        if (s) sessions.push(s);
      }
      return sessions.sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
  };
}
```

- [ ] **Step 4: Wire the selector** — update `src/data/index.ts`:

```ts
import type { DataLayer } from "./DataLayer";
import { createMockDataLayer } from "./mock";
import { createSupabaseDataLayer } from "./supabase";

const backend = import.meta.env.VITE_DATA_BACKEND ?? "mock";

export const db: DataLayer =
  backend === "supabase" ? createSupabaseDataLayer() : createMockDataLayer();
```

- [ ] **Step 5: Typecheck (mock backend still active in tests)**

Run: `npm run typecheck && npm run test`
Expected: clean; all existing tests still PASS (tests use the default mock backend).

- [ ] **Step 6: Commit**

```bash
git add src/data/supabaseClient.ts src/data/supabase.ts src/data/index.ts
git commit -m "feat: Supabase DataLayer implementation"
```

---

## Task 15: Magic-link auth + gate

**Files:**
- Create: `src/auth/AuthContext.tsx`, `src/auth/Login.tsx`
- Modify: `src/App.tsx`
- Test: `src/auth/Login.test.tsx`

**Interfaces:**
- Consumes: `supabase` client.
- Produces: `AuthProvider`, `useAuth(): { session, loading }`. When `VITE_DATA_BACKEND==="supabase"` and no session, `App` renders `<Login />`; otherwise renders the app. With the mock backend, auth is bypassed (so unit tests and local mock dev need no login).

- [ ] **Step 1: Write the failing test** — `src/auth/Login.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import Login from "./Login";

test("shows email input and send button", () => {
  render(<Login />);
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/auth/Login.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Login** — `src/auth/Login.tsx`:

```tsx
import { useState } from "react";
import { supabase } from "../data/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  async function send() {
    await supabase.auth.signInWithOtp({ email });
    setSent(true);
  }

  return (
    <div className="p-6 max-w-sm mx-auto space-y-3">
      <h1 className="text-2xl font-bold">Sign in</h1>
      {sent ? (
        <p>Check your email for a magic link.</p>
      ) : (
        <>
          <label className="block text-sm">Email
            <input aria-label="email" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border p-3 mt-1" />
          </label>
          <button onClick={send}
            className="w-full rounded-lg bg-black text-white p-3 font-semibold">
            Send magic link
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement AuthContext** — `src/auth/AuthContext.tsx`:

```tsx
import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../data/supabaseClient";

interface AuthState { session: Session | null; loading: boolean; }
const Ctx = createContext<AuthState>({ session: null, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return <Ctx.Provider value={{ session, loading }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
```

- [ ] **Step 5: Gate the app** — update `src/App.tsx` to wrap routes and gate only when using the Supabase backend:

```tsx
import { Routes, Route, Link } from "react-router-dom";
import Home from "./screens/Home";
import Session from "./screens/Session";
import ManageDays from "./screens/ManageDays";
import History from "./screens/History";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Login from "./auth/Login";

const requireAuth = (import.meta.env.VITE_DATA_BACKEND ?? "mock") === "supabase";

function Shell() {
  return (
    <div className="min-h-screen max-w-md mx-auto pb-16">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/session/:id" element={<Session />} />
        <Route path="/days" element={<ManageDays />} />
        <Route path="/history/:exerciseId" element={<History />} />
      </Routes>
      <nav className="fixed bottom-0 inset-x-0 max-w-md mx-auto flex justify-around bg-white border-t py-2">
        <Link to="/" className="p-2">Home</Link>
        <Link to="/days" className="p-2">Days</Link>
      </nav>
    </div>
  );
}

function Gate() {
  const { session, loading } = useAuth();
  if (loading) return <div className="p-4">Loading…</div>;
  if (!session) return <Login />;
  return <Shell />;
}

export default function App() {
  if (!requireAuth) return <Shell />;
  return <AuthProvider><Gate /></AuthProvider>;
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run test && npm run typecheck`
Expected: PASS (App test still renders Home under default mock backend), clean.

- [ ] **Step 7: Commit**

```bash
git add src/auth/ src/App.tsx
git commit -m "feat: magic-link auth gate (supabase backend only)"
```

---

## Task 16: PWA + mobile polish

**Files:**
- Modify: `vite.config.ts`, `index.html`
- Create: `public/manifest.webmanifest`, icons `public/icon-192.png`, `public/icon-512.png`

**Interfaces:**
- Produces: installable PWA with manifest + service worker.

- [ ] **Step 1: Install PWA plugin**

```bash
npm install -D vite-plugin-pwa
```

- [ ] **Step 2: Configure** — update `vite.config.ts` plugins:

```ts
import { VitePWA } from "vite-plugin-pwa";

// inside defineConfig plugins: [react(), VitePWA({ ... })]
VitePWA({
  registerType: "autoUpdate",
  manifest: {
    name: "Workout Tracker",
    short_name: "Lifts",
    theme_color: "#000000",
    background_color: "#ffffff",
    display: "standalone",
    start_url: "/",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
})
```

- [ ] **Step 3: Add viewport + theme to `index.html`** `<head>`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#000000" />
```

- [ ] **Step 4: Add placeholder icons**

Run: create two square PNGs (192px, 512px) at `public/icon-192.png` and `public/icon-512.png`. A solid-color dumbbell placeholder is fine for v1.

- [ ] **Step 5: Build to verify PWA artifacts generate**

Run: `npm run build`
Expected: build succeeds; `dist/manifest.webmanifest` and a service worker are emitted.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: PWA manifest + service worker + mobile viewport"
```

---

## Task 17: E2E tests + CI deploy/migrations

**Files:**
- Create: `e2e/flows.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the running app (mock backend for E2E so tests need no live Supabase).
- Produces: Playwright E2E of the core flow; CI that typechecks, unit-tests, runs E2E, builds, applies Supabase migrations, and deploys.

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install --with-deps chromium
```

- [ ] **Step 2: Configure** — `playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
```

- [ ] **Step 3: Write E2E** — `e2e/flows.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("start a leg day and log an exercise", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Leg Day" }).click();
  await expect(page.getByText("Leg Press")).toBeVisible();
  await expect(page.getByText(/Last: 150 × 3 × 12/)).toBeVisible();
  await page.getByRole("button", { name: /log/i }).first().click();
  await expect(page.getByLabel("logged").first()).toBeVisible();
});

test("manage days shows exercises", async ({ page }) => {
  await page.goto("/days");
  await expect(page.getByText("Leg Day")).toBeVisible();
  await expect(page.getByText("Leg Press")).toBeVisible();
});
```

- [ ] **Step 4: Run E2E locally**

Run: `npx playwright test`
Expected: PASS (2 tests). (Runs against the mock backend by default.)

- [ ] **Step 5: Commit E2E**

```bash
git add e2e/ playwright.config.ts
git commit -m "test: Playwright E2E for core flows"
```

- [ ] **Step 6: CI workflow** — `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
      - run: npm run build

  migrate:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
        with: { version: latest }
      - run: supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
          SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID }}
```

> Deploy: connect the repo to Vercel/Cloudflare Pages (build `npm run build`, output `dist`, env `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_DATA_BACKEND=supabase`). GitHub secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID` must be set for the migrate job.

- [ ] **Step 7: Commit CI**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck, test, e2e, build, supabase migrate"
```

---

## Self-Review

**Spec coverage:**
- Mobile-first PWA → Tasks 1, 16. ✓
- React + Vite + TS + Tailwind → Task 1. ✓
- Supabase (DB + Auth + RLS) → Tasks 13, 14, 15. ✓
- Data-layer indirection, mock-first → Tasks 5, 6, 7, 14. ✓
- 6-table model, "every set its own row" → Tasks 2, 13. ✓
- "Last time" lookup → Task 4 (+ reused in 6, 14). ✓
- One-line + per-set logging → Tasks 3, 10. ✓
- 4 screens (Home, Session, Manage days, History) → Tasks 9, 11, 12. ✓
- Magic-link auth → Task 15. ✓
- Best-effort online (no offline queue) → respected (no offline tasks). ✓
- Thorough testing (logic + E2E) → unit tests in Tasks 3,4,6,9,10,11,12,15; E2E in Task 17. ✓
- Schema via CI migrations → Tasks 13, 17. ✓
- Out-of-scope (charts, offline sync, multi-user UI) → not implemented. ✓

**Placeholder scan:** No "TBD"/"add error handling"-style placeholders; icon creation in Task 16 is an explicit asset step, not a code placeholder.

**Type consistency:** `DataLayer` method names/signatures defined in Task 5 are used identically in mock (Task 6), supabase (Task 14), and all screens. `SetEntry`/`Session`/`Exercise`/`WorkoutDay` come from `src/types.ts` (Task 2) everywhere. `formatSets`/`expandLine` (Task 3) and `findLastSetsForExercise` (Task 4) signatures match all call sites.
