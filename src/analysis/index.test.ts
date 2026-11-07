import * as analysis from "./index.js";

describe("src/analysis index", () => {
  it("exports exactly the eight analysis functions", () => {
    expect(Object.keys(analysis).sort()).toEqual(
      [
        "adherenceForDay",
        "getDayTemplates",
        "getWorkoutHistory",
        "progressionForExercise",
        "schemeHistoryForDayExercise",
        "setsForExercise",
        "trainingGaps",
        "weeklyVolume",
      ].sort(),
    );
    for (const fn of Object.values(analysis)) expect(typeof fn).toBe("function");
  });
});
