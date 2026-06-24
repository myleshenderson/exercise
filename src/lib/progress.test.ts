import { setVolume, exerciseSetSeries } from "./progress";
import type { Session } from "../types";

test("setVolume multiplies weight by reps", () => {
  expect(setVolume({ setNumber: 1, weight: 150, reps: 12 })).toBe(1800);
});

const sessions: Session[] = [
  { id: "s2", workoutDayId: "d", performedOn: "2026-06-10", exercises: [
    { exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 150, reps: 12 }, { setNumber: 2, weight: 150, reps: 10 }] },
    { exerciseId: "leg-curl", sets: [{ setNumber: 1, weight: 100, reps: 10 }] },
  ] },
  { id: "s1", workoutDayId: "d", performedOn: "2026-06-01", exercises: [
    { exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 140, reps: 12 }] },
  ] },
  { id: "s3", workoutDayId: "d", performedOn: "2026-06-15", exercises: [
    { exerciseId: "leg-curl", sets: [{ setNumber: 1, weight: 105, reps: 10 }] },
  ] },
];

test("exerciseSetSeries returns oldest->newest per-set volume groups for the exercise", () => {
  expect(exerciseSetSeries(sessions, "leg-press")).toEqual([
    { performedOn: "2026-06-01", setVolumes: [1680] },
    { performedOn: "2026-06-10", setVolumes: [1800, 1500] },
  ]);
});

test("exerciseSetSeries skips sessions that don't include the exercise", () => {
  expect(exerciseSetSeries(sessions, "leg-curl").map((p) => p.performedOn)).toEqual([
    "2026-06-10",
    "2026-06-15",
  ]);
});
