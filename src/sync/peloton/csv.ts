/**
 * workout_history.csv (AI-627 payload facts section 10): the summary fallback for a cycling
 * workout whose detail or performance graph cannot be fetched. The CSV has no workout id; rows
 * join on (local start minute, title), with Total Output as the tie-break.
 */
import { PELOTON_CSV_COLUMNS, type PelotonCsvRow, type PelotonWorkout } from "./types.js";

/** RFC 4180 records: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Rows keyed by the 18 known columns; a column missing from the header reads as "". */
export function parseWorkoutHistoryCsv(text: string): PelotonCsvRow[] {
  const [header, ...body] = parseRecords(text);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  if (!names.includes("Workout Timestamp")) throw new Error("workout_history.csv has no Workout Timestamp column");
  const index = new Map(PELOTON_CSV_COLUMNS.map((col) => [col, names.indexOf(col)] as const));
  return body.map((cells) => {
    const row = {} as PelotonCsvRow;
    for (const col of PELOTON_CSV_COLUMNS) {
      const i = index.get(col) ?? -1;
      row[col] = i >= 0 ? (cells[i] ?? "").trim() : "";
    }
    return row;
  });
}

/** A CSV number cell ("12.3", "45%") as a number; null when empty or not numeric. */
export function csvNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const s = cell.replace(/%$/, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `epochS` as `YYYY-MM-DD HH:MM` wall clock in `timeZone` (an Etc/GMT±n or IANA zone). */
export function localMinute(epochS: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochS * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** The title the CSV's `Title` column carries for a workout. */
export function workoutTitle(w: PelotonWorkout): string | null {
  return w.ride?.title ?? w.title ?? null;
}

/**
 * The row whose `Workout Timestamp` minute (the first 16 characters; the offset label is
 * unreliable) is `start_time` in `w.timezone` and whose `Title` is the class title. A tie goes to
 * the row whose Total Output (kJ) is nearest to `total_work / 1000`. Null when nothing matches.
 */
export function matchCsvRow(w: PelotonWorkout, rows: readonly PelotonCsvRow[]): PelotonCsvRow | null {
  const title = workoutTitle(w);
  if (title === null || !w.timezone || !Number.isFinite(w.start_time)) return null;
  let minute: string;
  try {
    minute = localMinute(w.start_time, w.timezone);
  } catch {
    return null; // an unknown time zone
  }
  const candidates = rows.filter((r) => r["Workout Timestamp"].slice(0, 16) === minute && r.Title === title);
  if (candidates.length <= 1) return candidates[0] ?? null;
  const targetKj = typeof w.total_work === "number" ? w.total_work / 1000 : null;
  if (targetKj === null) return candidates[0];
  let best = candidates[0];
  let bestGap = Infinity;
  for (const r of candidates) {
    const kj = csvNumber(r["Total Output"]);
    const gap = kj === null ? Infinity : Math.abs(kj - targetKj);
    if (gap < bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}
