/** Calendar-date helpers shared by the load and weight maths. Dates are `YYYY-MM-DD`. */

export const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Day number (days since 1970-01-01) of a `YYYY-MM-DD` string; `null` if malformed. */
export function dayNumber(date: string): number | null {
  const m = DATE_ONLY.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCDate() !== Number(m[3]) || d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return ms / DAY_MS;
}

/** `YYYY-MM-DD` of a day number. */
export function dateFromDayNumber(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Calendar date of an instant (UTC ISO with `Z` or an offset; an offset-less instant is read in
 * the host zone by `Date.parse`, so callers must not pass one) in an IANA time zone. A date-only string is returned as is.
 * An unknown time zone falls back to UTC rather than throwing; an unparseable instant gives `null`.
 */
export function localDate(instant: string, timeZone: string | undefined): string | null {
  if (DATE_ONLY.test(instant)) return dayNumber(instant) === null ? null : instant;
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;
  let f: Intl.DateTimeFormat;
  try {
    f = formatterFor(timeZone ?? "UTC");
  } catch {
    f = formatterFor("UTC");
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
