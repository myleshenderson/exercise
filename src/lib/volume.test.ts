import { totalVolume } from "./volume";
import type { Session } from "../types";

test("totalVolume sums weight*reps across all sets", () => {
  const session: Session = {
    id: "s", workoutDayId: "d", performedOn: "2026-06-22",
    exercises: [
      { exerciseId: "a", sets: [{ setNumber: 1, weight: 100, reps: 10 }, { setNumber: 2, weight: 100, reps: 8 }] },
      { exerciseId: "b", sets: [{ setNumber: 1, weight: 50, reps: 12 }] },
    ],
  };
  expect(totalVolume(session)).toBe(100 * 10 + 100 * 8 + 50 * 12); // 2400
});

test("totalVolume of an empty session is 0", () => {
  expect(totalVolume({ id: "s", workoutDayId: null, performedOn: "2026-06-22", exercises: [] })).toBe(0);
});
