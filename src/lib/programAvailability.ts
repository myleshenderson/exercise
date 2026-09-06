export interface DayForAvailability {
  id: string;
  programId: string | null;
  programPosition: number | null;
}

// For each program, the "available" day is the lowest programPosition whose
// day has never been completed. A program is a one-time progression, not a
// repeating rotation (see the design doc's "Track lifecycle" decision) — once
// every day is completed, the program has no entry here and nothing is
// suggested (no wraparound).
export function nextAvailablePositionByProgram(
  days: DayForAvailability[],
  completedDayIds: ReadonlySet<string>,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const day of days) {
    if (day.programId === null || day.programPosition === null) continue;
    if (completedDayIds.has(day.id)) continue;
    const current = next.get(day.programId);
    if (current === undefined || day.programPosition < current) {
      next.set(day.programId, day.programPosition);
    }
  }
  return next;
}

export function isDayAvailable(day: DayForAvailability, nextByProgram: ReadonlyMap<string, number>): boolean {
  if (day.programId === null) return true;
  return nextByProgram.get(day.programId) === day.programPosition;
}
