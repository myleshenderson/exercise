# Per-Exercise Progress Chart — Design Spec

**Date:** 2026-06-23
**Status:** Approved design, pre-implementation

## Purpose

Show progress for an individual exercise over time as a hand-rolled bar chart:
**one bar per set**, height = that set's volume (weight × reps), bars grouped by
session in chronological order. Lets the user see a lift climb across workouts.

## Scope

**In scope:**
- A new **Progress** screen (in the bottom nav) listing the user's exercises.
- Tapping an exercise opens its **per-set volume chart** (reusing the existing,
  currently-unused `/history/:exerciseId` route + `History.tsx` screen).
- Hand-rolled chart (SVG/CSS bars) — no charting dependency.

**Out of scope (deferred):**
- The day-template volume overview (volume-by-day, grouped by Leg/Upper).
- Recharts or any chart library.
- Tooltips, zoom, axis ticks beyond simple date labels, multi-exercise overlays.
- Filtering the exercise list to only those with history (list all; the chart
  shows an empty state when an exercise has no logged sets).

## Data

No new data-layer method. Uses existing:
- `db.listExercises()` → the Progress screen's list.
- `db.getExercise(id)` → exercise name on the chart screen.
- `db.getExerciseHistory(exerciseId)` → `Session[]` containing that exercise.

## Logic (pure, `src/lib/progress.ts`)

- `setVolume(set: SetEntry): number` → `set.weight * set.reps`.
- `exerciseSetSeries(sessions: Session[], exerciseId: string): { performedOn: string; setVolumes: number[] }[]`
  - For each session that contains `exerciseId`, in **oldest→newest** order, emit
    `{ performedOn, setVolumes }` where `setVolumes` is each set's volume in set order.
  - Sessions without the exercise are skipped. (`getExerciseHistory` already only
    returns sessions containing it, but the helper filters defensively.)

## UI

- **`src/screens/Progress.tsx`** (route `/progress`): loads `listExercises()`,
  renders each as a button that navigates to `/history/${exercise.id}`. Heading
  "Progress". Empty state if no exercises.
- **`src/screens/History.tsx`** (route `/history/:exerciseId`, repurposed):
  loads `getExercise` + `getExerciseHistory`, computes `exerciseSetSeries`, and
  renders the exercise name + a hand-rolled bar chart:
  - One bar per set, height proportional to `setVolume` (scaled to the max set
    volume across the series). Bars grouped per session with a date label under
    each group (via `formatSessionDate`).
  - Empty state ("No sets logged yet") when the series is empty.
- **`src/App.tsx`**: add the `/progress` route and a "Progress" link in the
  bottom nav (alongside Home / Days).

## Testing

- `progress.test.ts`: `setVolume` math; `exerciseSetSeries` returns groups
  oldest→newest with correct per-set volumes, and skips sessions lacking the exercise.
- `Progress.test.tsx`: lists exercises; an exercise button links to its chart route.
- `History.test.tsx` (updated): renders the exercise name and the right number of
  bars for a seeded/mock exercise with history; shows the empty state when none.
- Existing suite stays green; `npm run typecheck` clean.
