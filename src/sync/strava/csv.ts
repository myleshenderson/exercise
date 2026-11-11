/**
 * Strava archive `activities.csv` (AI-640): the typed columns the importer reads, over the shared
 * RFC 4180 parser in ../csv.ts. Pure: no I/O.
 */
import { parseCsvRecords } from "../csv.js";

export { parseCsvRecords };

/** One CSV row: the typed fields the importer uses, and every column as a string in `raw`. */
export interface StravaRow {
  id: string | null;
  /** ISO instant (UTC); null when `Activity Date` is empty or not in the export's form. */
  startedAt: string | null;
  name: string | null;
  type: string | null;
  elapsedS: number | null;
  movingS: number | null;
  distanceM: number | null;
  elevationGainM: number | null;
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  avgPowerW: number | null;
  maxPowerW: number | null;
  avgHrBpm: number | null;
  maxHrBpm: number | null;
  avgCadenceRpm: number | null;
  calories: number | null;
  filename: string | null;
  /** Every column by (deduplicated) header name; a cell missing from a short row is "". */
  raw: Record<string, string>;
}

export const REQUIRED_COLUMNS = ["Activity ID", "Activity Date", "Activity Type", "Filename"] as const;

/** Header names with repeats renamed `"<name> (2)"`, `"<name> (3)"`, ... */
export function dedupeHeader(header: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((raw) => {
    const name = raw.trim();
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

/** The required columns absent from `header` (raw or deduplicated), in REQUIRED_COLUMNS order. */
export function requiredColumnsMissing(header: readonly string[]): string[] {
  const names = new Set(header.map((h) => h.trim()));
  return REQUIRED_COLUMNS.filter((c) => !names.has(c));
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const DATE_RE = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/;

/** `Mon D, YYYY, h:mm:ss AM` (UTC) to ISO; null for anything else. */
export function parseStravaDate(value: string | null | undefined): string | null {
  const m = DATE_RE.exec((value ?? "").trim().replace(/ | /g, " "));
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month === undefined || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59 || second > 59) return null;
  const pm = m[7].toLowerCase() === "p";
  if (hour === 12) hour = 0;
  if (pm) hour += 12;
  const ms = Date.UTC(year, month, day, hour, minute, second);
  // Rejects day overflow such as Feb 30.
  if (new Date(ms).getUTCDate() !== day) return null;
  return new Date(ms).toISOString();
}

const text = (v: string | undefined): string | null => (v === undefined || v.trim() === "" ? null : v);

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
};

/** The first column of `names` with a non-empty cell. */
const first = (raw: Record<string, string>, ...names: string[]): string | undefined => {
  for (const n of names) if (text(raw[n]) !== null) return raw[n];
  return undefined;
};

export function stravaRowFromRaw(raw: Record<string, string>): StravaRow {
  return {
    id: text(raw["Activity ID"])?.trim() ?? null,
    startedAt: parseStravaDate(raw["Activity Date"]),
    name: text(raw["Activity Name"]),
    type: text(raw["Activity Type"])?.trim() ?? null,
    elapsedS: num(first(raw, "Elapsed Time (2)", "Elapsed Time")),
    movingS: num(raw["Moving Time"]),
    distanceM: num(raw["Distance (2)"]),
    elevationGainM: num(raw["Elevation Gain"]),
    avgSpeedMps: num(raw["Average Speed"]),
    maxSpeedMps: num(raw["Max Speed"]),
    avgPowerW: num(raw["Average Watts"]),
    maxPowerW: num(raw["Max Watts"]),
    avgHrBpm: num(raw["Average Heart Rate"]),
    maxHrBpm: num(first(raw, "Max Heart Rate (2)", "Max Heart Rate")),
    avgCadenceRpm: num(raw["Average Cadence"]),
    calories: num(raw["Calories"]),
    filename: text(raw["Filename"])?.trim() ?? null,
    raw,
  };
}

/** The header (deduplicated) and the rows of an `activities.csv`. */
export function parseActivitiesCsvWithHeader(csvText: string): { header: string[]; rows: StravaRow[] } {
  const [head, ...body] = parseCsvRecords(csvText);
  const header = dedupeHeader(head ?? []);
  const rows = body.map((cells) => {
    const raw: Record<string, string> = {};
    header.forEach((h, i) => (raw[h] = cells[i] ?? ""));
    return stravaRowFromRaw(raw);
  });
  return { header, rows };
}

export function parseActivitiesCsv(csvText: string): StravaRow[] {
  return parseActivitiesCsvWithHeader(csvText).rows;
}

/** Activity types imported, and their environment. */
export const RIDE_TYPES: Readonly<Record<string, "indoor" | "outdoor">> = {
  Ride: "outdoor",
  "Virtual Ride": "indoor",
  "E-Bike Ride": "outdoor",
  "Gravel Ride": "outdoor",
  "Mountain Bike Ride": "outdoor",
};

/** The ride's environment, or null when the row is not an imported ride type. */
export function rideEnvironment(type: string | null): "indoor" | "outdoor" | null {
  return type !== null && Object.prototype.hasOwnProperty.call(RIDE_TYPES, type) ? RIDE_TYPES[type] : null;
}
