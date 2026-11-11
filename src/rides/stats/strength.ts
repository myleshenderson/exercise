/** The Strength tab's numbers (AI-651): sessions, sets and volume (lb) per week and all time. */
import { totalVolume } from "../../lib/volume";
import { weekStartOf, type WeekStart } from "../../metrics/display";
import type { Session } from "../../types";
import { lastWeekStarts } from "./time";

export interface StrengthTotals {
  sessions: number;
  sets: number;
  /** Σ weight × reps, in lb as logged. */
  volume: number;
}

export interface StrengthWeek extends StrengthTotals {
  weekStart: string;
}

export function sessionSets(session: Session): number {
  return session.exercises.reduce((n, ex) => n + ex.sets.length, 0);
}

/** The last `weeks` weeks (oldest first) ending with the week of `today`, and all-time totals. */
export function strengthStats(
  sessions: readonly Session[],
  today: string,
  weekStart: WeekStart,
  weeks = 12,
): { weeks: StrengthWeek[]; total: StrengthTotals } {
  const byWeek = new Map<string, StrengthWeek>(
    lastWeekStarts(today, weekStart, weeks).map((w) => [w, { weekStart: w, sessions: 0, sets: 0, volume: 0 }]),
  );
  const total: StrengthTotals = { sessions: 0, sets: 0, volume: 0 };
  for (const s of sessions) {
    const sets = sessionSets(s);
    const volume = totalVolume(s);
    total.sessions++;
    total.sets += sets;
    total.volume += volume;
    let key: string;
    try {
      key = weekStartOf(s.performedOn, weekStart);
    } catch {
      continue; // a malformed date counts all time but in no week
    }
    const week = byWeek.get(key);
    if (!week) continue;
    week.sessions++;
    week.sets += sets;
    week.volume += volume;
  }
  return { weeks: [...byWeek.values()], total };
}
