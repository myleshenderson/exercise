import { adherenceForDay } from "./adherenceForDay";
import { day, dayExercise, exercise, history, session, set } from "./testFixtures";

// Expected values worked by hand from 20260906152003_adherence_for_day_rpc.sql:
// group sets per (session, exercise); target = latest history row with
// recorded_at::date (UTC) <= performed_on, else current wde.target_sets, else
// exercise defaults; statuses via SQL CASE; round(avg(reps), 1);
// order by performed_on, session_id, exercise_name (nulls last).
const exercises = [
  exercise("e1", "Bench", { default_sets: 3, default_rep_low: 8, default_rep_high: 10 }),
  exercise("e2", "curl", { default_sets: 3, default_rep_low: 10, default_rep_high: 12 }),
  exercise("e3", "Squat", { default_sets: 3, default_rep_low: 5, default_rep_high: 8 }),
];
// d2 is soft-deleted; adherence_for_day still joins its name.
const workoutDays = [day("d1", "Push", 0), day("d2", "Legs", 1, { deleted_at: "2026-09-01T00:00:00+00:00" })];
const workoutDayExercises = [
  dayExercise("d1", "e1", 0, [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }, { weight: 105, reps: 3 }]),
  dayExercise("d1", "e2", 1, null),
  dayExercise("d2", "e3", 0, [{ weight: 200, reps: 5 }]),
];
const schemeHistory = [
  history("d1", "e1", "2026-08-01T12:00:00Z", [{ weight: 90, reps: 8 }, { weight: 95, reps: 6 }]),
  // 2026-08-11T04:30Z: its ::date in UTC is 08-11, so it is not in effect on 08-10
  history("d1", "e1", "2026-08-10T23:30:00-05:00", [{ weight: 110, reps: 5 }]),
  // scheme cleared on 08-05: from then on defaults apply, not the current wde scheme
  history("d2", "e3", "2026-08-05T00:00:00Z", null),
];
const sessions = [
  session("s1", "2026-07-30", "d1"),
  session("s2", "2026-08-10", "d1"),
  session("s3", "2026-08-11", "d1"),
  session("s4", "2026-08-06", "d2"),
  session("s5", "2026-08-04", "d2"),
  session("s6", "2026-08-12", null),
  session("s7", "2026-08-13", "d1"), // no sets: inner join yields nothing
];
const sessionSets = [
  set("s1", "e2", 1, 20, 12),
  set("s1", "e1", 1, 100, 5),
  set("s1", "e1", 2, 100, 5),
  set("s1", "e1", 3, 105, 3),
  set("s1", "e2", 2, 20, 10),
  set("s2", "e1", 1, 95, 8),
  set("s2", "e1", 2, 95, 8),
  set("s2", "e1", 3, 95, 8),
  set("s2", "e1", 4, 95, 7),
  set("s3", "e1", 1, 105, 5),
  set("s3", "e1", 2, 105, 4),
  set("s4", "e3", 1, 180, 6),
  set("s4", "e3", 2, 180, 6),
  set("s4", "e3", 3, 180, 6),
  set("s5", "e3", 1, 210, 5),
  set("s6", "gone", 1, 50, 5),
  set("s6", "e1", 1, 60, 11),
  set("s6", "e1", 2, 60, 11),
  set("s6", "e1", 3, 60, 12),
  set("no-session", "e1", 1, 1, 1),
];
const tables = { sessions, sessionSets, workoutDays, exercises, workoutDayExercises, schemeHistory };

const push = { workout_day_id: "d1", workout_day_name: "Push" };
const legs = { workout_day_id: "d2", workout_day_name: "Legs" };

// s1 (07-30): no history yet -> current wde scheme for e1 (3 sets, reps 3..5, weight 105)
const s1Bench = { session_id: "s1", performed_on: "2026-07-30", ...push, exercise_id: "e1", exercise_name: "Bench", actual_sets: 3, target_sets: 3, sets_status: "match", actual_avg_reps: 4.3, target_rep_low: 3, target_rep_high: 5, reps_status: "match", actual_top_weight: 105, target_weight: 105, weight_status: "match" };
// e2 on d1 has no history and a null current scheme -> exercise defaults, no weight target
const s1Curl = { session_id: "s1", performed_on: "2026-07-30", ...push, exercise_id: "e2", exercise_name: "curl", actual_sets: 2, target_sets: 3, sets_status: "under", actual_avg_reps: 11, target_rep_low: 10, target_rep_high: 12, reps_status: "match", actual_top_weight: 20, target_weight: null, weight_status: null };
// s5 (08-04): d2/e3 history starts 08-05 -> current scheme (1 set, 5 reps, 200)
const s5Squat = { session_id: "s5", performed_on: "2026-08-04", ...legs, exercise_id: "e3", exercise_name: "Squat", actual_sets: 1, target_sets: 1, sets_status: "match", actual_avg_reps: 5, target_rep_low: 5, target_rep_high: 5, reps_status: "match", actual_top_weight: 210, target_weight: 200, weight_status: "over" };
// s4 (08-06): latest history row is the null (cleared) scheme -> e3 defaults 3 x 5..8
const s4Squat = { session_id: "s4", performed_on: "2026-08-06", ...legs, exercise_id: "e3", exercise_name: "Squat", actual_sets: 3, target_sets: 3, sets_status: "match", actual_avg_reps: 6, target_rep_low: 5, target_rep_high: 8, reps_status: "match", actual_top_weight: 180, target_weight: null, weight_status: null };
// s2 (08-10): first history row (2 sets, reps 6..8, weight 95); avg 31/4 = 7.75 -> 7.8
const s2Bench = { session_id: "s2", performed_on: "2026-08-10", ...push, exercise_id: "e1", exercise_name: "Bench", actual_sets: 4, target_sets: 2, sets_status: "over", actual_avg_reps: 7.8, target_rep_low: 6, target_rep_high: 8, reps_status: "match", actual_top_weight: 95, target_weight: 95, weight_status: "match" };
// s3 (08-11): second history row (1 x 5 @ 110); avg 4.5 < 5
const s3Bench = { session_id: "s3", performed_on: "2026-08-11", ...push, exercise_id: "e1", exercise_name: "Bench", actual_sets: 2, target_sets: 1, sets_status: "over", actual_avg_reps: 4.5, target_rep_low: 5, target_rep_high: 5, reps_status: "under", actual_top_weight: 105, target_weight: 110, weight_status: "under" };
// s6 (08-12): no day -> no history/scheme match -> defaults; avg 34/3 = 11.33 > 10
const s6Bench = { session_id: "s6", performed_on: "2026-08-12", workout_day_id: null, workout_day_name: null, exercise_id: "e1", exercise_name: "Bench", actual_sets: 3, target_sets: 3, sets_status: "match", actual_avg_reps: 11.3, target_rep_low: 8, target_rep_high: 10, reps_status: "over", actual_top_weight: 60, target_weight: null, weight_status: null };
// exercise not in input: null name sorts last; null targets make every CASE fall through to 'match'
const s6Gone = { session_id: "s6", performed_on: "2026-08-12", workout_day_id: null, workout_day_name: null, exercise_id: "gone", exercise_name: null, actual_sets: 1, target_sets: null, sets_status: "match", actual_avg_reps: 5, target_rep_low: null, target_rep_high: null, reps_status: "match", actual_top_weight: 50, target_weight: null, weight_status: null };

describe("adherenceForDay (20260906152003_adherence_for_day_rpc.sql)", () => {
  it("compares each session's exercises against the scheme in effect on that date", () => {
    expect(adherenceForDay(tables)).toEqual([s1Bench, s1Curl, s5Squat, s4Squat, s2Bench, s3Bench, s6Bench, s6Gone]);
  });

  it("filters by day and by inclusive date range", () => {
    expect(adherenceForDay(tables, { for_workout_day_id: "d2" })).toEqual([s5Squat, s4Squat]);
    expect(adherenceForDay(tables, { start_date: "2026-08-10", end_date: "2026-08-11" })).toEqual([s2Bench, s3Bench]);
    expect(adherenceForDay(tables, { for_workout_day_id: "d1", start_date: "2026-08-11" })).toEqual([s3Bench]);
    expect(adherenceForDay(tables, { for_workout_day_id: null, start_date: null, end_date: null })).toEqual(adherenceForDay(tables));
  });

  it("orders same-day sessions by session uuid", () => {
    const rows = adherenceForDay({
      ...tables,
      sessions: [session("bbbbbbbb-0000-4000-8000-000000000000", "2026-08-01"), session("AAAAAAAA-0000-4000-8000-000000000000", "2026-08-01")],
      sessionSets: [set("bbbbbbbb-0000-4000-8000-000000000000", "e1", 1, 1, 1), set("AAAAAAAA-0000-4000-8000-000000000000", "e1", 1, 1, 1)],
    });
    expect(rows.map((r) => r.session_id)).toEqual(["AAAAAAAA-0000-4000-8000-000000000000", "bbbbbbbb-0000-4000-8000-000000000000"]);
  });

  it("raises like the SQL casts when a scheme holds a non-integer reps value", () => {
    const bad = { ...tables, workoutDayExercises: [dayExercise("d2", "e3", 0, [{ weight: 200, reps: 5.5 }])] };
    expect(() => adherenceForDay(bad, { for_workout_day_id: "d2", end_date: "2026-08-04" })).toThrow("type integer");
    const text = { ...tables, workoutDayExercises: [dayExercise("d2", "e3", 0, [{ weight: "200", reps: "5" }])] };
    expect(adherenceForDay(text, { for_workout_day_id: "d2", end_date: "2026-08-04" })).toEqual([s5Squat]);
  });

  it("returns no rows for empty input", () => {
    expect(
      adherenceForDay({ sessions: [], sessionSets: [], workoutDays: [], exercises: [], workoutDayExercises: [], schemeHistory: [] }),
    ).toEqual([]);
  });
});
