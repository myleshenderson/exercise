import { getWorkoutHistory } from "./getWorkoutHistory";
import { day, exercise, session, set } from "./testFixtures";

// Expected values worked by hand from 0011_workout_history_filters.sql:
// sessions LEFT JOIN workout_days LEFT JOIN session_sets LEFT JOIN exercises,
// inclusive date filters, escaped ilike name filter,
// order by performed_on, s.id, ss.set_number (nulls last).
const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "BBBBBBBB-0000-4000-8000-000000000002"; // upper-case: uuids compare by value, so still after SA
const SC = "cccccccc-0000-4000-8000-000000000003";
const SD = "dddddddd-0000-4000-8000-000000000004";

const workoutDays = [day("d1", "Push", 0, { deleted_at: "2026-08-20T00:00:00+00:00" }), day("d2", "Pull", 1)];
const exercises = [exercise("e1", "Bench Press"), exercise("e2", "Row"), exercise("e3", "50%_Curl")];
const sessions = [
  session(SB, "2026-08-01", "d1"),
  session(SA, "2026-08-01", "d2"),
  session(SC, "2026-08-02", null),
  session(SD, "2026-08-03", "day-not-in-input"),
];
const sessionSets = [
  set(SB, "e1", 2, 100, 5),
  set(SB, "e1", 1, 95, 5),
  set(SA, "e2", 1, 60, 10),
  set(SA, "e3", 1, 20, 12),
  set(SD, "e1", 1, 105, 5),
  set(SD, "exercise-not-in-input", 2, 80, 8),
];
const tables = { sessions, workoutDays, sessionSets, exercises };

const rowA2 = { session_id: SA, performed_on: "2026-08-01", workout_day_id: "d2", workout_day_name: "Pull", exercise_id: "e2", exercise_name: "Row", set_number: 1, weight: 60, reps: 10 };
const rowA3 = { ...rowA2, exercise_id: "e3", exercise_name: "50%_Curl", weight: 20, reps: 12 };
// d1 is soft-deleted but get_workout_history does not filter deleted_at.
const rowB1 = { session_id: SB, performed_on: "2026-08-01", workout_day_id: "d1", workout_day_name: "Push", exercise_id: "e1", exercise_name: "Bench Press", set_number: 1, weight: 95, reps: 5 };
const rowB2 = { ...rowB1, set_number: 2, weight: 100 };
const rowC = { session_id: SC, performed_on: "2026-08-02", workout_day_id: null, workout_day_name: null, exercise_id: null, exercise_name: null, set_number: null, weight: null, reps: null };
// The day row is not in the input, so wd.id/wd.name are null even though s.workout_day_id is set.
const rowD1 = { session_id: SD, performed_on: "2026-08-03", workout_day_id: null, workout_day_name: null, exercise_id: "e1", exercise_name: "Bench Press", set_number: 1, weight: 105, reps: 5 };
const rowD2 = { ...rowD1, exercise_id: null, exercise_name: null, set_number: 2, weight: 80, reps: 8 };

describe("getWorkoutHistory (0011_workout_history_filters.sql)", () => {
  it("returns every set and set-less session ordered by date, session id, set number", () => {
    // SA's two set-1 rows tie on all sort keys: SQL leaves them unordered; input order kept.
    expect(getWorkoutHistory(tables)).toEqual([rowA2, rowA3, rowB1, rowB2, rowC, rowD1, rowD2]);
    expect(getWorkoutHistory(tables, { start_date: null, end_date: null, exercise_name: null })).toEqual(
      getWorkoutHistory(tables),
    );
  });

  it("applies inclusive start/end date bounds", () => {
    expect(getWorkoutHistory(tables, { start_date: "2026-08-02", end_date: "2026-08-02" })).toEqual([rowC]);
    expect(getWorkoutHistory(tables, { start_date: "2026-08-02" })).toEqual([rowC, rowD1, rowD2]);
    expect(getWorkoutHistory(tables, { end_date: "2026-08-01" })).toEqual([rowA2, rowA3, rowB1, rowB2]);
    expect(getWorkoutHistory(tables, { start_date: "2026-08-04" })).toEqual([]);
  });

  it("filters by a case-insensitive literal substring, dropping rows without an exercise", () => {
    expect(getWorkoutHistory(tables, { exercise_name: "BENCH" })).toEqual([rowB1, rowB2, rowD1]);
    // % and _ are escaped, so they only match themselves.
    expect(getWorkoutHistory(tables, { exercise_name: "_" })).toEqual([rowA3]);
    expect(getWorkoutHistory(tables, { exercise_name: "0%_c" })).toEqual([rowA3]);
    expect(getWorkoutHistory(tables, { exercise_name: "b_nch" })).toEqual([]);
    expect(getWorkoutHistory(tables, { exercise_name: "bench", start_date: "2026-08-02" })).toEqual([rowD1]);
  });

  it("returns no rows for empty input", () => {
    expect(getWorkoutHistory({ sessions: [], workoutDays: [], sessionSets: [], exercises: [] })).toEqual([]);
  });
});
