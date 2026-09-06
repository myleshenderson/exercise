import { describe, expect, test } from "vitest";
import { nextAvailablePositionByProgram, isDayAvailable, type DayForAvailability } from "./programAvailability";

describe("nextAvailablePositionByProgram / isDayAvailable", () => {
  test("an untracked day (programId null) is always available", () => {
    const day: DayForAvailability = { id: "d1", programId: null, programPosition: null };
    const next = nextAvailablePositionByProgram([day], new Set());
    expect(isDayAvailable(day, next)).toBe(true);
  });

  test("an empty (no completions) program makes its first position available, others not", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
      { id: "d3", programId: "p1", programPosition: 2 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set());
    expect(isDayAvailable(days[0], next)).toBe(true);
    expect(isDayAvailable(days[1], next)).toBe(false);
    expect(isDayAvailable(days[2], next)).toBe(false);
  });

  test("a partially completed program surfaces the first incomplete day", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
      { id: "d3", programId: "p1", programPosition: 2 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set(["d1"]));
    expect(isDayAvailable(days[0], next)).toBe(false);
    expect(isDayAvailable(days[1], next)).toBe(true);
    expect(isDayAvailable(days[2], next)).toBe(false);
  });

  test("a fully completed program has no available day — no wraparound", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set(["d1", "d2"]));
    expect(isDayAvailable(days[0], next)).toBe(false);
    expect(isDayAvailable(days[1], next)).toBe(false);
  });

  test("two independent programs don't affect each other", () => {
    const days: DayForAvailability[] = [
      { id: "d1", programId: "p1", programPosition: 0 },
      { id: "d2", programId: "p1", programPosition: 1 },
      { id: "d3", programId: "p2", programPosition: 0 },
    ];
    const next = nextAvailablePositionByProgram(days, new Set(["d1"]));
    expect(isDayAvailable(days[1], next)).toBe(true); // p1 advanced
    expect(isDayAvailable(days[2], next)).toBe(true); // p2 untouched, still at its own start
  });
});
