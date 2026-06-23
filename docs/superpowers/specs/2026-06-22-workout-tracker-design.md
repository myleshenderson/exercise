# Workout Tracker — Design Spec

**Date:** 2026-06-22
**Status:** Approved design, pre-implementation
**Repo:** https://github.com/myleshenderson/exercise (private)

## Purpose

Replace a messy free-form notes sheet for tracking weightlifting. The core gym
loop: **pick today's workout → see each exercise with what I did last time →
decide today's sets/weight → log it.** Optimized for fast use on a phone at the
gym.

## Users

Single user today (the owner). Designed so additional users can be added later
with zero rework, via Supabase Auth + Row Level Security keyed on `user_id`.

## Architecture & Stack

- **Frontend:** React + Vite + TypeScript, mobile-first, styled with Tailwind.
  Installable PWA ("Add to Home Screen").
- **Backend:** Supabase — Postgres for data, Auth (magic-link email) for login,
  Row Level Security so each user sees only their own rows.
- **Hosting:** static deploy (Vercel or Cloudflare Pages, free tier). The browser
  app talks directly to Supabase via `supabase-js` — no custom server.
- **Data API:** Supabase Data API enabled, exposing the `public` schema. Security
  comes from RLS, not from hiding the API.

### Data layer indirection (mock-first development)

The UI never calls Supabase directly. It calls a typed data-layer interface:

```
getWorkoutDays()             -> WorkoutDay[]
getDayExercises(dayId)       -> Exercise[]
getLastSession(exerciseId)   -> Session | null   (most recent before today)
startSession(dayId)          -> Session
logExercise(sessionId, exerciseId, sets)  -> void
getExerciseHistory(exerciseId) -> Session[]
... (CRUD for exercises and day templates)
```

Two implementations behind this interface:

1. **Mock** (in-memory, seeded with real lifts from the existing sheet) — used to
   build and tune the UX locally with no network and no schema.
2. **Supabase** — the real implementation, swapped in once flows are settled.

Screens are written once against the interface and do not change when swapping.

## Data Model (6 tables)

Every table has `user_id uuid` (FK to `auth.users`) with RLS policies enforcing
`user_id = auth.uid()` for select/insert/update/delete.

- **`exercises`** — movement catalog. `id`, `user_id`, `name`, `cue` (text, e.g.
  "drive elbows down"), `default_sets`, `default_rep_low`, `default_rep_high`.
- **`workout_days`** — day templates. `id`, `user_id`, `name`, `position`.
- **`workout_day_exercises`** — exercises within a day, ordered. `id`,
  `workout_day_id`, `exercise_id`, `position`.
- **`sessions`** — one per workout performed. `id`, `user_id`, `workout_day_id`
  (nullable for blank sessions), `performed_on` (date), `created_at`.
- **`session_sets`** — one row per set. `id`, `session_id`, `exercise_id`,
  `set_number`, `weight` (numeric), `reps` (int).

### Key modeling decisions

- **Every set is stored as its own row** in `session_sets`. Logging "one line"
  (`150 × 3 × 12`) creates N identical rows. Expanding to per-set lets each row
  be edited. Display collapses to `150 × 3 × 12` when all sets match, else shows
  per-set reps (`8, 6, 4`). Uniform storage; simple "last time" query.
- **"Last time"** = for an exercise, the most recent `session` (with
  `performed_on` before today) that contains a `session_set` for it; return those
  sets.
- **Editing a day template** = adding/removing/reordering rows in
  `workout_day_exercises`.

### Schema delivery

Schema is authored as **versioned SQL migration files in the repo, applied to
Supabase via CI** (matches the "infrastructure through CI, not local scripts"
rule). Not hand-pasted into the dashboard.

## Screens & Flow

1. **Home** — day templates as large buttons ("Leg Day", "Upper Day") + "Start
   blank session". Tap to begin today's session.
2. **Session (main screen)** — today's exercises as a checklist. Each card shows:
   name + cue, **last time's numbers** (e.g. "Last: 150 × 3 × 12"), target reps,
   and a quick-log input pre-filled with last time's weight. Default one-line
   entry (weight × sets × reps), expandable to per-set reps. Logging checks the
   card off. "＋ add exercise" to swap/add on the fly.
3. **Manage days** — edit templates: add/remove/reorder exercises, edit cues and
   targets, create new days.
4. **History / exercise detail** — tap an exercise to see its past sessions as a
   list to eyeball the trend. No charts in v1 (YAGNI; easy to add later).

## Auth

Supabase magic-link email login. One login screen: enter email → tap link →
session persists on the device. RLS makes every query user-scoped automatically.

## Offline behavior (v1)

**Best-effort online.** Assume signal is generally available. If a write fails,
show an inline retry. True offline-first queue/sync is deferred until it proves to
be a real problem.

## Testing

**Thorough — logic + E2E.**

- **Unit tests** for the data layer and pure logic: "last time" lookup, set
  collapse/expand display, template editing, session creation. Run against the
  mock implementation.
- **End-to-end tests** (Playwright) of the main flows: log in, start a day, log an
  exercise, see last-time numbers on the next session, edit a day template.

## Out of scope (v1 / YAGNI)

- Progress charts/graphs.
- Offline-first sync.
- Multiple real users / sharing (data model is ready; auth UI stays single-user).
- Rest timers, supersets, RPE/RIR, body-weight/measurement tracking.

## Build order (high level)

1. Scaffold Vite + React + TS + Tailwind, PWA config, Supabase client wiring.
2. Define the data-layer interface + mock implementation seeded from the sheet.
3. Build the four screens against the mock; unit-test logic; tune UX on phone.
4. Author schema migration; wire the Supabase implementation behind the interface.
5. Magic-link auth + RLS verification.
6. E2E tests; deploy to static host via CI; CI applies migrations.
