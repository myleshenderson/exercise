/** Body-weight trend and W/kg. */
import { dateFromDayNumber, dayNumber, localDate } from "./dates.js";

export interface WeighIn {
  /** ISO instant, or a `YYYY-MM-DD` local date. */
  measuredAt: string;
  /** IANA zone for the local day; UTC when absent. */
  timezone?: string;
  weightKg: number | null;
}

export interface WeightTrend {
  /** Mean of weigh-ins on the 7 local days ending at `date`; `null` when none. */
  avg7Kg: number | null;
  /** avg7(date) − avg7(date − 28 days); `null` when either window is empty. */
  change4wKg: number | null;
}

function avg7(byDate: Map<string, number[]>, endDay: number): number | null {
  let sum = 0;
  let count = 0;
  for (let day = endDay - 6; day <= endDay; day++) {
    for (const kg of byDate.get(dateFromDayNumber(day)) ?? []) {
      sum += kg;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

/** 7-day average and 4-week change at local date `date` (`YYYY-MM-DD`). */
export function weightTrend(weighIns: readonly WeighIn[], date: string): WeightTrend {
  const end = dayNumber(date);
  if (end === null) return { avg7Kg: null, change4wKg: null };
  const byDate = new Map<string, number[]>();
  for (const w of weighIns) {
    if (typeof w.weightKg !== "number" || !Number.isFinite(w.weightKg)) continue;
    const d = localDate(w.measuredAt, w.timezone);
    if (d === null) continue;
    const list = byDate.get(d) ?? [];
    list.push(w.weightKg);
    byDate.set(d, list);
  }
  const now = avg7(byDate, end);
  const before = avg7(byDate, end - 28);
  return { avg7Kg: now, change4wKg: now === null || before === null ? null : now - before };
}

/** Watts per kilogram; `null` when either input is missing or weight is not positive. */
export function wPerKg(ftpW: number | null, kg: number | null): number | null {
  if (ftpW === null || kg === null || !Number.isFinite(ftpW) || !(kg > 0)) return null;
  return ftpW / kg;
}
