import { getDayTemplates } from "./getDayTemplates.js";
import { day, dayExercise, exercise, program, session, set } from "./testFixtures.js";

// Expected values worked by hand from 20260906180100_day_sequencing.sql:
// non-deleted days LEFT JOIN non-deleted programs, LEFT JOIN program_next
// (min program_position of the program's non-deleted days with no session that
// has a set), LEFT JOIN workout_day_exercises, LEFT JOIN exercises,
// order by wd.position, wde.position (nulls last).
const DELETED = "2026-08-20T00:00:00+00:00";
const exercises = [
  exercise("e1", "Bench", { cue: "tuck elbows", default_sets: 3, default_rep_low: 8, default_rep_high: 10 }),
  exercise("e2", "Row", { cue: "", default_sets: 4, default_rep_low: 10, default_rep_high: 12 }),
];
const programs = [program("p1", "Block"), program("p2", "Old", DELETED)];
const workoutDays = [
  day("dH", "P1 unpositioned", 7, { program_id: "p1", program_position: null }),
  day("dA", "Upper", 0),
  day("dB", "P1 Day1", 1, { program_id: "p1", program_position: 1 }),
  day("dC", "P1 Day2", 2, { program_id: "p1", program_position: 2 }),
  day("dD", "P1 Day3", 3, { program_id: "p1", program_position: 3 }),
  day("dE", "Deleted", 4, { program_id: "p1", program_position: 0, deleted_at: DELETED }),
  day("dF", "In deleted program", 5, { program_id: "p2", program_position: 1 }),
  day("dG", "Empty", 6),
];
const scheme = [{ weight: 100, reps: 5 }];
const workoutDayExercises = [
  dayExercise("dA", "e1", 1, scheme),
  dayExercise("dA", "e2", 0, null),
  dayExercise("dB", "e1", 0),
  dayExercise("dC", "e2", 0),
  dayExercise("dD", "e1", 0),
  dayExercise("dE", "e1", 0),
  dayExercise("dF", "e1", 0),
];
const sessions = [session("s1", "2026-08-01", "dB"), session("s2", "2026-08-02", "dC"), session("s3", "2026-08-03", null)];
// dB is done (its session has a set); dC's session has no sets, so dC is not done.
const sessionSets = [set("s1", "e1", 1, 100, 5), set("s3", "e1", 1, 100, 5)];
const tables = { workoutDays, programs, workoutDayExercises, exercises, sessions, sessionSets };

const e1Cols = { exercise_id: "e1", exercise_name: "Bench", exercise_cue: "tuck elbows", default_sets: 3, default_rep_low: 8, default_rep_high: 10 };
const e2Cols = { exercise_id: "e2", exercise_name: "Row", exercise_cue: "", default_sets: 4, default_rep_low: 10, default_rep_high: 12 };
const noExercise = { exercise_id: null, exercise_name: null, exercise_cue: null, exercise_position: null, target_sets: null, uses_default_scheme: true, default_sets: null, default_rep_low: null, default_rep_high: null };
const untracked = { program_id: null, program_name: null, program_position: null, is_available: true };

describe("getDayTemplates (20260906180100_day_sequencing.sql)", () => {
  it("lists non-deleted days with ordered exercises, program info and availability", () => {
    expect(getDayTemplates(tables)).toEqual([
      { workout_day_id: "dA", workout_day_name: "Upper", workout_day_position: 0, ...untracked, ...e2Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true },
      { workout_day_id: "dA", workout_day_name: "Upper", workout_day_position: 0, ...untracked, ...e1Cols, exercise_position: 1, target_sets: scheme, uses_default_scheme: false },
      { workout_day_id: "dB", workout_day_name: "P1 Day1", workout_day_position: 1, program_id: "p1", program_name: "Block", program_position: 1, is_available: false, ...e1Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true },
      // next position is 2: dB is done, and the soft-deleted dE (position 0) is ignored
      { workout_day_id: "dC", workout_day_name: "P1 Day2", workout_day_position: 2, program_id: "p1", program_name: "Block", program_position: 2, is_available: true, ...e2Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true },
      { workout_day_id: "dD", workout_day_name: "P1 Day3", workout_day_position: 3, program_id: "p1", program_name: "Block", program_position: 3, is_available: false, ...e1Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true },
      // dE is soft-deleted: excluded. dF's program is soft-deleted: treated as untracked.
      { workout_day_id: "dF", workout_day_name: "In deleted program", workout_day_position: 5, ...untracked, ...e1Cols, exercise_position: 0, target_sets: null, uses_default_scheme: true },
      { workout_day_id: "dG", workout_day_name: "Empty", workout_day_position: 6, ...untracked, ...noExercise },
      // null program_position = next_position is null -> coalesce(..., false)
      { workout_day_id: "dH", workout_day_name: "P1 unpositioned", workout_day_position: 7, program_id: "p1", program_name: "Block", program_position: null, is_available: false, ...noExercise },
    ]);
  });

  it("marks no day available once every day of a program is done", () => {
    const rows = getDayTemplates({
      ...tables,
      workoutDays: [day("dB", "P1 Day1", 1, { program_id: "p1", program_position: 1 })],
      sessions: [session("s1", "2026-08-01", "dB")],
      sessionSets: [set("s1", "e1", 1, 100, 5)],
    });
    expect(rows.map((r) => [r.workout_day_id, r.is_available])).toEqual([["dB", false]]);
  });

  it("keeps input order for days and exercises tied on position (unordered in SQL)", () => {
    const rows = getDayTemplates({
      ...tables,
      workoutDays: [day("x2", "Second", 0), day("x1", "First", 0)],
      workoutDayExercises: [dayExercise("x2", "e2", 0), dayExercise("x2", "e1", 0)],
    });
    expect(rows.map((r) => [r.workout_day_id, r.exercise_id])).toEqual([
      ["x2", "e2"],
      ["x2", "e1"],
      ["x1", null],
    ]);
  });

  it("returns no rows for empty input or when every day is soft-deleted", () => {
    expect(
      getDayTemplates({ workoutDays: [], programs: [], workoutDayExercises: [], exercises: [], sessions: [], sessionSets: [] }),
    ).toEqual([]);
    expect(getDayTemplates({ ...tables, workoutDays: [day("dZ", "Gone", 0, { deleted_at: DELETED })] })).toEqual([]);
  });
});
