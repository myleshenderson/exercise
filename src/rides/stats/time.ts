/** Date helpers shared by the My Stats and Training screens (AI-651). Dates are `YYYY-MM-DD`. */
import { dateFromDayNumber, dayNumber, localDate } from "../../metrics/dates";
import { weekStartOf, type WeekStart } from "../../metrics/display";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Today's local date (host zone) at instant `now`. */
export function localToday(now: Date): string {
  const iso = now.toISOString();
  return localDate(iso, hostTimeZone()) ?? iso.slice(0, 10);
}

/** `date` moved by `days` calendar days. Throws on a malformed date. */
export function addDays(date: string, days: number): string {
  const day = dayNumber(date);
  if (day === null) throw new RangeError(`addDays: not a YYYY-MM-DD date: ${date}`);
  return dateFromDayNumber(day + days);
}

/** The first days of the `n` weeks ending with the week holding `today`, oldest first. */
export function lastWeekStarts(today: string, weekStart: WeekStart, n: number): string[] {
  const current = weekStartOf(today, weekStart);
  return Array.from({ length: n }, (_, i) => addDays(current, -7 * (n - 1 - i)));
}

/**
 * An instant safely before the start of local day `date` in any time zone (UTC midnight minus
 * 14 h); the exact cut is made per row on its own local date.
 */
export function windowStartIso(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 14 * 3_600_000).toISOString();
}

/** `2026-11-09` → `Nov 9`. */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** The local date an activity happened on, in its own time zone (as `daily_training_load` files it). */
export function activityDate(a: { startedAt: string; timezone?: string | null }): string | null {
  return localDate(a.startedAt, a.timezone ?? undefined);
}
