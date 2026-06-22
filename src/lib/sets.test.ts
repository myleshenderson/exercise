import { expandLine, formatSets } from "./sets";

test("expandLine creates N identical numbered sets", () => {
  expect(expandLine(150, 3, 12)).toEqual([
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 150, reps: 12 },
    { setNumber: 3, weight: 150, reps: 12 },
  ]);
});

test("formatSets collapses uniform sets", () => {
  expect(formatSets(expandLine(150, 3, 12))).toBe("150 × 3 × 12");
});

test("formatSets shows per-set reps when weight uniform but reps differ", () => {
  const sets = [
    { setNumber: 1, weight: 35, reps: 8 },
    { setNumber: 2, weight: 35, reps: 6 },
    { setNumber: 3, weight: 35, reps: 4 },
  ];
  expect(formatSets(sets)).toBe("35 × (8, 6, 4)");
});

test("formatSets shows weight×reps per set when weights differ", () => {
  const sets = [
    { setNumber: 1, weight: 35, reps: 8 },
    { setNumber: 2, weight: 30, reps: 6 },
  ];
  expect(formatSets(sets)).toBe("35×8, 30×6");
});

test("formatSets handles empty", () => {
  expect(formatSets([])).toBe("");
});
