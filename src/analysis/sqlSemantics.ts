/**
 * Internal helpers reproducing the Postgres semantics the analysis SQL relies
 * on: exact `numeric` arithmetic and `round()`, `date` arithmetic and
 * `date_trunc('week', ...)`, `timestamptz` ordering and `::date` casts,
 * `LIKE`/`ILIKE` matching, `uuid` comparison and `ORDER BY` null placement.
 * Not re-exported from `index.ts`.
 */

// ---------------------------------------------------------------- numeric

/** An exact decimal: `units / 10^scale`. */
export interface Decimal {
  units: bigint;
  scale: number;
}

/**
 * Converts a JS number to the exact decimal it was parsed from. PostgREST
 * serialises `numeric` as a decimal literal, and `String(n)` returns the
 * shortest literal that round-trips, which is that literal for any value with
 * at most ~15 significant digits.
 */
export function toDecimal(n: number): Decimal {
  if (!Number.isFinite(n)) throw new Error(`not a finite numeric: ${n}`);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!m) throw new Error(`cannot parse numeric: ${n}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  let units = BigInt(int + frac);
  let scale = frac.length - Number(exp);
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units: sign === "-" ? -units : units, scale };
}

function rescale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale);
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: rescale(a, scale) + rescale(b, scale), scale };
}

/** `numeric * int` */
export function mulDecimalInt(a: Decimal, k: number): Decimal {
  return { units: a.units * BigInt(k), scale: a.scale };
}

/** `round(numerator / denominator, digits)`, half away from zero, like Postgres `round(numeric, int)`. */
export function roundRatio(numerator: bigint, denominator: bigint, digits = 0): number {
  if (denominator === 0n) throw new Error("division by zero");
  let num = numerator * 10n ** BigInt(digits);
  let den = denominator;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = (2n * abs + den) / (2n * den);
  const rounded = negative ? -q : q;
  return Number(rounded) / 10 ** digits;
}

/** Postgres `round(numeric)`: to an integer, half away from zero. */
export function roundDecimal(d: Decimal): number {
  return roundRatio(d.units, 10n ** BigInt(d.scale));
}

// ---------------------------------------------------------------- date / timestamptz

const MS_PER_DAY = 86_400_000;
const MICROS_PER_DAY = 86_400_000_000n;

/** Days since 1970-01-01 for a Postgres `date` ("YYYY-MM-DD"). */
export function dayNumber(date: string): number {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`invalid date: ${date}`);
  return Math.round(utcMs(Number(m[1]), Number(m[2]), Number(m[3])) / MS_PER_DAY);
}

/** `Date.UTC` without its mapping of years 0-99 to 1900-1999. */
function utcMs(year: number, month: number, day: number, h = 0, mi = 0, s = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(h, mi, s, 0);
  return d.getTime();
}

/** Inverse of {@link dayNumber}. */
export function dateFromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * `date_trunc('week', d)::date`: the Monday (ISO-8601 week start) on or before
 * `d`. Postgres casts the `date` to `timestamptz` at midnight in the session
 * TimeZone, truncates there and casts back in the same zone, so the result is
 * the same calendar Monday whatever the zone.
 */
export function isoWeekStart(date: string): string {
  const day = dayNumber(date);
  const dow = new Date(day * MS_PER_DAY).getUTCDay(); // 0 = Sunday
  return dateFromDayNumber(day - ((dow + 6) % 7));
}

/**
 * Parses a `timestamptz` text value to exact microseconds since the epoch.
 * Postgres stores microsecond precision, which `Date.parse` would truncate.
 * A value without an offset is taken as UTC (the session TimeZone the
 * functions are assumed to run in; see {@link timestampToUtcDate}).
 */
export function timestampMicros(ts: string): bigint {
  const m =
    /^(\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/i.exec(
      ts.trim(),
    );
  if (!m) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) throw new Error(`invalid timestamptz: ${ts}`);
    return BigInt(ms) * 1000n;
  }
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", zone = "Z"] = m;
  const ms = utcMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
  // Postgres rounds input beyond microseconds to the nearest microsecond (half up).
  const digits = frac.padEnd(7, "0").slice(0, 7);
  const fracMicros = (BigInt(digits) + 5n) / 10n;
  let micros = BigInt(ms) * 1000n + fracMicros;
  if (zone.toUpperCase() !== "Z") {
    const zm = /^([+-])(\d{2}):?(\d{2})?:?(\d{2})?$/.exec(zone)!;
    const offsetSeconds = Number(zm[2]) * 3600 + Number(zm[3] ?? 0) * 60 + Number(zm[4] ?? 0);
    micros -= BigInt((zm[1] === "-" ? -1 : 1) * offsetSeconds) * 1_000_000n;
  }
  return micros;
}

/**
 * `ts::date` for a `timestamptz`, evaluated in session TimeZone UTC (the
 * Supabase default; the SQL functions don't set a zone of their own).
 */
export function timestampToUtcDate(ts: string): string {
  const micros = timestampMicros(ts);
  let day = micros / MICROS_PER_DAY;
  if (micros < 0n && micros % MICROS_PER_DAY !== 0n) day -= 1n; // floor, not truncate
  return dateFromDayNumber(Number(day));
}

// ---------------------------------------------------------------- LIKE / ILIKE

/**
 * Compiles a Postgres `ILIKE` pattern: `%` matches any run of characters
 * (including newlines), `_` exactly one character, and backslash (the default
 * LIKE escape) makes the next character literal. Postgres raises
 * "LIKE pattern must not end with escape character" for a trailing lone
 * backslash; so does this. Case-insensitivity uses Unicode simple case folding
 * (JS `iu` flags), which matches Postgres `ILIKE` for ordinary text.
 */
export function compileIlike(pattern: string): RegExp {
  const chars = Array.from(pattern);
  let source = "^";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\\") {
      i++;
      if (i >= chars.length) throw new Error("LIKE pattern must not end with escape character");
      source += escapeRegExp(chars[i]);
    } else if (c === "%") {
      source += "[^]*";
    } else if (c === "_") {
      source += "[^]";
    } else {
      source += escapeRegExp(c);
    }
  }
  return new RegExp(source + "$", "iu");
}

function escapeRegExp(c: string): string {
  // Only these are valid identity escapes under the `u` flag (`\-` is not).
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
}

// ---------------------------------------------------------------- uuid / ORDER BY / grouping

/** Canonical form of a uuid for equality and ordering (Postgres compares the 16 bytes). */
export function uuidKey(id: string): string {
  return id.toLowerCase().replace(/[{}-]/g, "");
}

export function uuidEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && uuidKey(a) === uuidKey(b);
}

/** Buckets rows by a uuid column, preserving input order within each bucket. */
export function groupByUuid<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = uuidKey(key(row));
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/** Ascending comparison with Postgres's default `NULLS LAST` for `ASC`. */
export function ascNullsLast<T>(a: T | null | undefined, b: T | null | undefined, cmp: (x: T, y: T) => number): number {
  const aNull = a == null;
  const bNull = b == null;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  return cmp(a, b);
}

export function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Postgres `date` text ("YYYY-MM-DD") sorts chronologically as a string. */
export function compareDates(a: string, b: string): number {
  return dayNumber(a) - dayNumber(b);
}

export function compareUuids(a: string, b: string): number {
  const x = uuidKey(a);
  const y = uuidKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const textCollator = new Intl.Collator("en-US");

/**
 * `text` ordering under the database's default collation, assumed to be
 * `en_US.UTF-8` (Supabase's default). Approximated with ICU's `en-US`
 * collator, which agrees with glibc for letters, digits and case but can
 * differ for punctuation and whitespace. Like Postgres with a deterministic
 * collation, strings the collation ranks equal are tie-broken by code point.
 */
export function compareText(a: string, b: string): number {
  const c = textCollator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}
