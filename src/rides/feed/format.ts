/**
 * Screen-local helpers of the Activities feed and Activity detail (AI-650): local date/time text,
 * the empty mark, stream sampling for the charts and the stream mean the detail page shows as
 * average resistance. Pure functions, no I/O.
 */
import { formatDistance } from "../../metrics/units";
import type { ActivityStream, Session, StreamChannel } from "../../types";

/** The units helpers' empty mark ("—"), for values with no formatter of their own. */
export const EMPTY_MARK = formatDistance(null);

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, kind: "date" | "time"): Intl.DateTimeFormat {
  const key = `${kind}\u0000${timeZone}`;
  let f = dateFormatters.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions =
      kind === "date"
        ? { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" }
        : { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    try {
      f = new Intl.DateTimeFormat("en-US", options);
    } catch {
      f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }); // unknown zone
    }
    dateFormatters.set(key, f);
  }
  return f;
}

/** "Wed, Nov 11, 2026" for an instant in `timeZone` (UTC when absent or unknown); empty mark when unparseable. */
export function localDateText(instant: string, timeZone: string | null | undefined): string {
  const ms = Date.parse(instant);
  return Number.isNaN(ms) ? EMPTY_MARK : formatter(timeZone ?? "UTC", "date").format(new Date(ms));
}

/** "07:05" (24-hour HH:MM) for an instant in `timeZone` (UTC when absent or unknown); empty mark when unparseable. */
export function localTimeText(instant: string, timeZone: string | null | undefined): string {
  const ms = Date.parse(instant);
  return Number.isNaN(ms) ? EMPTY_MARK : formatter(timeZone ?? "UTC", "time").format(new Date(ms));
}

/** "Wed, Nov 11, 2026" for a `YYYY-MM-DD` day (a strength session's `performedOn`). */
export function dayText(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? localDateText(`${date}T12:00:00Z`, "UTC") : EMPTY_MARK;
}

/** The stream of `channel`, or null when it is missing or holds no finite sample. */
export function streamOf(streams: readonly ActivityStream[], channel: StreamChannel): ActivityStream | null {
  const s = streams.find((x) => x.channel === channel);
  return s && s.values.some((v) => typeof v === "number" && Number.isFinite(v)) ? s : null;
}

/** Mean of the finite samples of a stream; null when there are none. */
export function streamMean(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : null;
}

/** Last second (from the activity start) covered by any stream. */
export function streamsEndS(streams: readonly ActivityStream[]): number {
  return streams.reduce((m, s) => Math.max(m, s.startOffsetS + s.values.length), 0);
}

/**
 * Chart points of a 1 Hz stream: x in minutes from the activity start, every `step`-th sample
 * (about `maxPoints` in all), each y passed through `convert`. Samples are taken, never averaged.
 */
export function chartPoints(
  stream: ActivityStream,
  maxPoints = 600,
  convert: (v: number) => number = (v) => v,
): { x: number; y: number | null }[] {
  const step = Math.max(1, Math.ceil(stream.values.length / maxPoints));
  const out: { x: number; y: number | null }[] = [];
  for (let i = 0; i < stream.values.length; i += step) {
    const v = stream.values[i];
    out.push({ x: (stream.startOffsetS + i) / 60, y: typeof v === "number" && Number.isFinite(v) ? convert(v) : null });
  }
  return out;
}

/** Exercises with at least one logged set, and the number of sets, of a strength session. */
export function sessionCounts(session: Session): { exercises: number; sets: number } {
  const done = session.exercises.filter((e) => e.sets.length > 0);
  return { exercises: done.length, sets: done.reduce((n, e) => n + e.sets.length, 0) };
}
