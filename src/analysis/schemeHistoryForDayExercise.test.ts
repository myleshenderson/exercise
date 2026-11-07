import { schemeHistoryForDayExercise } from "./schemeHistoryForDayExercise.js";
import { history } from "./testFixtures.js";

// Expected values worked by hand from 20260906151951_scheme_history.sql:
// rows for the (workout_day_id, exercise_id) pair, order by recorded_at.
const D1 = "11111111-0000-4000-8000-000000000001";
const E1 = "eeeeeeee-0000-4000-8000-000000000001";

const schemeHistory = [
  history(D1, E1, "2026-08-03T10:00:00+00:00", [{ weight: 110, reps: 5 }]),
  history(D1, E1, "2026-08-01T00:00:00.000002+00:00", [{ weight: 100, reps: 5 }]),
  history(D1, E1, "2026-08-01T00:00:00.000001+00:00", [{ weight: 95, reps: 5 }]),
  history(D1, E1, "2026-08-02T01:00:00+02:00", null), // = 2026-08-01T23:00Z, a cleared scheme
  history(D1, "other-exercise", "2026-07-01T00:00:00+00:00", [{ weight: 1, reps: 1 }]),
  history("other-day", E1, "2026-07-01T00:00:00+00:00", [{ weight: 2, reps: 2 }]),
];

describe("schemeHistoryForDayExercise (20260906151951_scheme_history.sql)", () => {
  it("returns the pair's rows ordered by instant, at microsecond precision", () => {
    expect(schemeHistoryForDayExercise({ schemeHistory }, { workout_day_id: D1, exercise_id: E1 })).toEqual([
      { target_sets: [{ weight: 95, reps: 5 }], recorded_at: "2026-08-01T00:00:00.000001+00:00" },
      { target_sets: [{ weight: 100, reps: 5 }], recorded_at: "2026-08-01T00:00:00.000002+00:00" },
      { target_sets: null, recorded_at: "2026-08-02T01:00:00+02:00" },
      { target_sets: [{ weight: 110, reps: 5 }], recorded_at: "2026-08-03T10:00:00+00:00" },
    ]);
  });

  it("matches uuid parameters by value", () => {
    expect(
      schemeHistoryForDayExercise({ schemeHistory }, { workout_day_id: D1.toUpperCase(), exercise_id: E1.toUpperCase() }),
    ).toHaveLength(4);
  });

  it("keeps input order for identical recorded_at (unordered in SQL)", () => {
    const tied = [
      history(D1, E1, "2026-08-01T00:00:00+00:00", [{ weight: 1, reps: 1 }]),
      history(D1, E1, "2026-08-01T00:00:00Z", [{ weight: 2, reps: 2 }]),
    ];
    expect(
      schemeHistoryForDayExercise({ schemeHistory: tied }, { workout_day_id: D1, exercise_id: E1 }).map((r) => r.target_sets),
    ).toEqual([[{ weight: 1, reps: 1 }], [{ weight: 2, reps: 2 }]]);
  });

  it("returns no rows for empty input or an unknown pair", () => {
    expect(schemeHistoryForDayExercise({ schemeHistory: [] }, { workout_day_id: D1, exercise_id: E1 })).toEqual([]);
    expect(schemeHistoryForDayExercise({ schemeHistory }, { workout_day_id: "nope", exercise_id: E1 })).toEqual([]);
  });
});
