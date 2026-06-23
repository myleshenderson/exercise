import { findLastSetsForExercise } from "./lastSession";
import type { Session } from "../types";

const sessions: Session[] = [
  {
    id: "s1", workoutDayId: "d1", performedOn: "2026-06-01",
    exercises: [{ exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 130, reps: 12 }] }],
  },
  {
    id: "s2", workoutDayId: "d1", performedOn: "2026-06-10",
    exercises: [{ exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 150, reps: 12 }] }],
  },
];

test("returns sets from most recent prior session", () => {
  expect(findLastSetsForExercise(sessions, "leg-press", "2026-06-22"))
    .toEqual([{ setNumber: 1, weight: 150, reps: 12 }]);
});

test("ignores sessions on/after beforeDate", () => {
  expect(findLastSetsForExercise(sessions, "leg-press", "2026-06-10"))
    .toEqual([{ setNumber: 1, weight: 130, reps: 12 }]);
});

test("returns empty when exercise never done", () => {
  expect(findLastSetsForExercise(sessions, "unknown", "2026-06-22")).toEqual([]);
});

test("on same-day sessions, the later-recorded one wins", () => {
  const sameDay: Session[] = [
    { id: "a", workoutDayId: "d1", performedOn: "2026-06-10", exercises: [{ exerciseId: "x", sets: [{ setNumber: 1, weight: 100, reps: 10 }] }] },
    { id: "b", workoutDayId: "d1", performedOn: "2026-06-10", exercises: [{ exerciseId: "x", sets: [{ setNumber: 1, weight: 120, reps: 10 }] }] },
  ];
  expect(findLastSetsForExercise(sameDay, "x", "2026-06-22")[0].weight).toBe(120);
});
