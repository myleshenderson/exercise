/** Date helpers shared by the My Stats and Training screens (AI-651). Dates are `YYYY-MM-DD`. */
import { addDays, localDate } from "../../metrics/dates";
import { weekStartOf, type WeekStart } from "../../metrics/display";

// One copy of the day helpers, in src/metrics/dates.ts; re-exported for the screens' imports.
export { activityDate, addDays } from "../../metrics/dates";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Today's local date (host zone) at instant `now`. */
export function localToday(now: Date): string {
  const iso = now.toISOString();
  return localDate(iso, hostTimeZone()) ?? iso.slice(0, 10);
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
