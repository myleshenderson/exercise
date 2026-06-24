# Past-Date Logging — Design Spec

**Date:** 2026-06-23
**Status:** Approved design, pre-implementation

## Purpose

Let the user backfill workout history from their old paper/doc by logging a
session on a chosen past date, instead of always "today." Initial use case:
entering existing history so "last time" and the History view reflect real data.

## Scope

**In scope (the whole feature):**
- A date input on the Home screen (defaults to today). Tapping a day starts the
  session on that date.

**Explicitly out of scope (deferred / cut):**
- Day template editing (rename, add/remove/reorder template exercises, create days).
- Creating new exercises (every exercise in the doc already exists in the catalog).
- Logging exercises not in a day's template (no "add exercise to session" picker) —
  off-template entries like Bicep Curl / Pectoral Fly in some sessions are skipped.
- Editing a session's date after creation; deleting sessions; date validation;
  recomputing "last time" when the date changes; persisting the chosen date.

## Design

- **`src/screens/Home.tsx`** gains a controlled `<input type="date">` (label
  "Workout date") whose state defaults to today (`new Date().toISOString().slice(0,10)`).
- The existing `start(dayId)` handler passes the selected date to
  `db.startSession(dayId, date)` instead of the hardcoded `today()`.
- Flow: pick date → tap a day → session created on that date → log via the
  existing Session screen. Data persists and feeds "last time"/history normally.
- The date resets to today on each Home mount (no persistence).

## Data / backend

No changes. `DataLayer.startSession(workoutDayId: string, date: string)` already
accepts the date; the mock and Supabase implementations are unchanged.

## Testing

- `Home.test.tsx`: the date input renders defaulting to today.
- `Home.test.tsx`: setting the date to a past date and tapping a day creates a
  session whose `performedOn` is that date (verified via the mock data layer).
- Existing Home tests (lists days, last-done, no blank-session button) still pass.
