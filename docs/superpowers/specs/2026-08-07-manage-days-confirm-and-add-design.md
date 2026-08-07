# ManageDays: inline delete confirmation + add exercises

**Date:** 2026-08-07
**Status:** Approved

## Goal

Two improvements to the Manage Days screen (`src/screens/ManageDays.tsx`):

1. Removing an exercise from a day requires an inline confirmation instead of
   deleting on first tap.
2. Each day card gets an add-exercise flow: pick an existing exercise from the
   catalog, or create a new one and add it in the same step.

## Scope

All changes live in `src/screens/ManageDays.tsx` and `src/screens/ManageDays.test.tsx`.
No data-layer changes: `listExercises()`, `createExercise()`, and
`updateDayExercises()` already exist on the `DataLayer` interface.

## 1. Inline delete confirmation

- New state: `confirming: { dayId: string; exerciseId: string } | null`.
- Tapping **Remove** sets `confirming` for that row. The row's Remove button is
  replaced by a red **Confirm** and a neutral **Cancel** button.
- Only one row may be in the confirming state at a time; tapping Remove on
  another row moves the confirmation there.
- **Confirm** runs the existing `remove()` (filters the id out of
  `day.exerciseIds`, calls `updateDayExercises`, reloads) and clears `confirming`.
- **Cancel** clears `confirming` with no other effect.

## 2. Add exercise (per day card)

- New state:
  - `allExercises: Exercise[]` — full catalog, loaded in `load()` alongside days.
  - `addingDayId: string | null` — which day's add section is open (one at a time).
  - A pick/create mode toggle plus form fields for the create mode.
- Each day card renders an **+ Add exercise** button below its exercise list.
  Tapping it expands an inline section with two modes:
  - **Pick:** a `<select>` of catalog exercises whose ids are not already in
    `day.exerciseIds`. **Add** appends the chosen id to `day.exerciseIds` via
    `updateDayExercises`, reloads, and closes the section. If the day already
    contains every catalog exercise, only the create option is shown.
  - **Create:** inputs for name (required), cue (optional), sets / rep low /
    rep high prefilled with 3 / 8 / 12. **Create & add** calls
    `createExercise` then `updateDayExercises`, reloads, and closes the
    section. The button is disabled until the name is non-empty and
    1 ≤ rep low ≤ rep high and sets ≥ 1.
- Opening an add section clears any pending delete confirmation, and starting a
  delete confirmation closes any open add section — never both at once.

## 3. Error handling

Same posture as the rest of the screen: awaited calls with no special
handling. A failed write leaves the list unchanged after reload. No new
patterns introduced.

## 4. Testing

Extend `src/screens/ManageDays.test.tsx` using the existing mock-db pattern,
written test-first:

- First tap of Remove does not delete; the row shows Confirm/Cancel.
- Confirm deletes the exercise from the day.
- Cancel keeps the exercise and restores the Remove button.
- Adding an existing catalog exercise puts it in the day.
- Creating a new exercise adds it to the catalog and the day.
- The picker excludes exercises already in the day.
