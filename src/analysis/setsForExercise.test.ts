import { setsForExercise } from "./setsForExercise.js";
import { exercise, session, set } from "./testFixtures.js";

// Expected values worked by hand from 0010_sets_for_exercise_rpc.sql:
// one row per matching set, ordered by performed_on, set_number.
const exercises = [exercise("e1", "Bench Press"), exercise("e2", "Incline Bench"), exercise("e3", "Squat")];
const sessions = [session("s1", "2026-08-03"), session("s2", "2026-08-01"), session("s3", "2026-08-03")];
const sessionSets = [
  set("s1", "e1", 2, 105, 5),
  set("s1", "e1", 1, 100, 5),
  set("s2", "e2", 1, 60, 10),
  set("s3", "e1", 1, 110, 3),
  set("s1", "e3", 1, 200, 5),
  set("missing-session", "e1", 1, 500, 5),
];
const tables = { sessions, sessionSets, exercises };

describe("setsForExercise (0010_sets_for_exercise_rpc.sql)", () => {
  it("returns each matching set ordered by date then set number", () => {
    expect(setsForExercise(tables, { exercise_name: "BENCH" })).toEqual([
      { performed_on: "2026-08-01", set_number: 1, weight: 60, reps: 10 },
      // tie on (2026-08-03, 1) between s1 and s3: SQL leaves it unordered; input order kept
      { performed_on: "2026-08-03", set_number: 1, weight: 100, reps: 5 },
      { performed_on: "2026-08-03", set_number: 1, weight: 110, reps: 3 },
      { performed_on: "2026-08-03", set_number: 2, weight: 105, reps: 5 },
    ]);
  });

  it("returns no rows for empty input, no match, or a null name", () => {
    expect(setsForExercise({ sessions: [], sessionSets: [], exercises: [] }, { exercise_name: "bench" })).toEqual([]);
    expect(setsForExercise(tables, { exercise_name: "row" })).toEqual([]);
    expect(setsForExercise(tables, { exercise_name: null })).toEqual([]);
  });

  it("matches names containing regex metacharacters such as a hyphen", () => {
    const rows = setsForExercise(
      { sessions: [session("s1", "2026-08-01")], sessionSets: [set("s1", "p", 1, 0, 8)], exercises: [exercise("p", "Pull-Up (wide)")] },
      { exercise_name: "pull-up (" },
    );
    expect(rows).toEqual([{ performed_on: "2026-08-01", set_number: 1, weight: 0, reps: 8 }]);
  });

  it("treats _ as a single-character wildcard", () => {
    expect(setsForExercise(tables, { exercise_name: "sq_at" })).toEqual([
      { performed_on: "2026-08-03", set_number: 1, weight: 200, reps: 5 },
    ]);
  });
});
