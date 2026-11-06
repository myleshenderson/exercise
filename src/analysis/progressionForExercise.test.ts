import { progressionForExercise } from "./progressionForExercise";
import { exercise, session, set } from "./testFixtures";

// Expected values worked by hand from 0005_analysis_rpc.sql:
// count(*), max(weight), round(sum(weight*reps)) grouped by performed_on,
// where e.name ilike '%' || exercise_name || '%', ordered by performed_on.
const exercises = [
  exercise("e1", "Bench Press"),
  exercise("e2", "Incline BENCH"),
  exercise("e3", "Squat"),
  exercise("e4", "50%_Curl"),
];
const sessions = [session("s1", "2026-08-03"), session("s2", "2026-08-01"), session("s3", "2026-08-03")];
const sessionSets = [
  set("s1", "e1", 1, 100, 5),
  set("s1", "e1", 2, 105, 5),
  set("s2", "e2", 1, 60, 10),
  set("s3", "e1", 1, 110, 3),
  set("s1", "e3", 1, 200, 5),
  set("s2", "e4", 1, 20, 12),
  set("missing-session", "e1", 1, 500, 5), // inner join drops it
  set("s1", "missing-exercise", 1, 500, 5), // inner join drops it
];
const tables = { sessions, sessionSets, exercises };

describe("progressionForExercise (0005_analysis_rpc.sql)", () => {
  it("aggregates matching sets per day, case-insensitively, ordered by date", () => {
    expect(progressionForExercise(tables, { exercise_name: "bench" })).toEqual([
      { performed_on: "2026-08-01", sets: 1, top_weight: 60, volume: 600 },
      // s1 and s3 share the day: 100*5 + 105*5 + 110*3 = 1355
      { performed_on: "2026-08-03", sets: 3, top_weight: 110, volume: 1355 },
    ]);
  });

  it("returns no rows for empty input, no match, or a null name", () => {
    expect(progressionForExercise({ sessions: [], sessionSets: [], exercises: [] }, { exercise_name: "bench" })).toEqual([]);
    expect(progressionForExercise(tables, { exercise_name: "deadlift" })).toEqual([]);
    expect(progressionForExercise(tables, { exercise_name: null })).toEqual([]);
  });

  it("treats % and _ in the name as LIKE wildcards (the SQL does not escape them)", () => {
    // '%b_nch%' matches both bench exercises; '%%%' matches every exercise.
    expect(progressionForExercise(tables, { exercise_name: "b_nch" }).map((r) => r.sets)).toEqual([1, 3]);
    expect(progressionForExercise(tables, { exercise_name: "%" })).toEqual([
      { performed_on: "2026-08-01", sets: 2, top_weight: 60, volume: 840 },
      { performed_on: "2026-08-03", sets: 4, top_weight: 200, volume: 2355 },
    ]);
  });

  it("rounds the exact numeric volume half away from zero", () => {
    const rows = progressionForExercise(
      {
        sessions: [session("s1", "2026-08-01")],
        sessionSets: [set("s1", "e1", 1, 16.4, 3), set("s1", "e1", 2, 0.1, 3)],
        exercises: [exercise("e1", "Curl")],
      },
      { exercise_name: "curl" },
    );
    // 49.2 + 0.3 = 49.5 exactly -> 50 (float arithmetic would give 49.49999999999999 -> 49)
    expect(rows).toEqual([{ performed_on: "2026-08-01", sets: 2, top_weight: 16.4, volume: 50 }]);
  });
});
