/**
 * Display maths for the ride screens (AI-649, wave 3): the one definition of every number the
 * feed, stats, training, power, weight and Home strip screens show. Pure functions, no I/O.
 */
import type { ExternalActivity, TssSource } from "../types.js";
import { bestEffortDistances, type PersonalRecords, type RecordValue } from "./bestEfforts.js";
import { dateFromDayNumber, dayNumber, localDate } from "./dates.js";
import type { Stream } from "./power.js";
import type { WeighIn, WeightTrend } from "./weight.js";

const EMPTY = "—";

// ---------------------------------------------------------------------------
// Durations

export type DurationStyle = "short" | "clock";

/**
 * Seconds → `"3h 28m"` / `"45m"` (`"short"`, rounded to the minute) or `"7:25:23"` / `"12:06"`
 * (`"clock"`, rounded to the second). Missing or negative input gives the empty mark.
 */
export function formatDuration(s: number | null | undefined, style: DurationStyle = "short"): string {
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0) return EMPTY;
  if (style === "short") {
    const minutes = Math.round(s / 60);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ---------------------------------------------------------------------------
// Which activities a screen shows

/** Garmin recordings shorter than this are fragments (accidental start/stop) and are hidden. */
export const FRAGMENT_MAX_ELAPSED_S = 60;

type ActivityRow = Pick<ExternalActivity, "id" | "source" | "elapsedS" | "pairedActivityId">;

/** A shown activity; a Peloton row that absorbed its Garmin recording carries it in `pairedWith`. */
export type VisibleActivity<T extends ActivityRow = ExternalActivity> = T & { pairedWith: T | null };

function isFragment(row: ActivityRow): boolean {
  return row.source === "garmin" && typeof row.elapsedS === "number" && row.elapsedS < FRAGMENT_MAX_ELAPSED_S;
}

/**
 * Drops Garmin fragments (`elapsedS < 60`) and collapses each Garmin+Peloton pair
 * (`pairedActivityId`, either direction) to the Peloton row, with `pairedWith` set to the Garmin
 * row. A Garmin row whose Peloton partner is not in `rows` stays visible. Order is kept.
 */
export function visibleActivities<T extends ActivityRow>(rows: readonly T[]): VisibleActivity<T>[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const garminPartnerOf = new Map<string, T>(); // peloton id → garmin row
  for (const r of rows) {
    const partner = r.pairedActivityId ? byId.get(r.pairedActivityId) : undefined;
    if (!partner) continue;
    if (r.source === "garmin" && partner.source === "peloton") garminPartnerOf.set(partner.id, r);
    else if (r.source === "peloton" && partner.source === "garmin") garminPartnerOf.set(r.id, partner);
  }
  const absorbed = new Set([...garminPartnerOf.values()].map((g) => g.id));
  const out: VisibleActivity<T>[] = [];
  for (const r of rows) {
    if (absorbed.has(r.id) || isFragment(r)) continue;
    out.push({ ...r, pairedWith: r.source === "peloton" ? (garminPartnerOf.get(r.id) ?? null) : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weeks and period totals

export type WeekStart = "monday" | "sunday";

/** First day (`YYYY-MM-DD`) of the week holding local date `date` (`YYYY-MM-DD`). Throws on a malformed date. */
export function weekStartOf(date: string, weekStart: WeekStart): string {
  const day = dayNumber(date);
  if (day === null) throw new RangeError(`weekStartOf: not a YYYY-MM-DD date: ${date}`);
  const dow = (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  const back = weekStart === "monday" ? (dow + 6) % 7 : dow;
  return dateFromDayNumber(day - back);
}

export interface WeekGroup<T> {
  /** First local day of the week, `YYYY-MM-DD`. */
  weekStart: string;
  items: T[];
}

/**
 * Groups items by the week of their local start date (`startedAt` read in `timezone`, UTC when
 * absent; a `YYYY-MM-DD` startedAt is taken as is). Newest week first; items keep input order.
 * Items with an unparseable start are skipped.
 */
export function groupByWeek<T extends { startedAt: string; timezone?: string | null }>(
  items: readonly T[],
  weekStart: WeekStart,
): WeekGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const date = localDate(item.startedAt, item.timezone ?? undefined);
    if (date === null) continue;
    const key = weekStartOf(date, weekStart);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, list]) => ({ weekStart: key, items: list }));
}

export interface PeriodTotals {
  count: number;
  /** Moving time, falling back to elapsed time when a row has no moving time. */
  movingS: number;
  /** All distance, indoor included. */
  distanceM: number;
  /** The indoor part of `distanceM` (decision 13: shown separately, labelled indoor). */
  indoorDistanceM: number;
  elevationM: number;
  tss: number;
  workKj: number;
}

type TotalsRow = Pick<
  ExternalActivity,
  "environment" | "movingS" | "elapsedS" | "distanceM" | "elevationGainM" | "tss" | "workKj"
>;

const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Sums over `rows` (pass them through `visibleActivities` first so a pair counts once). */
export function periodTotals(rows: readonly TotalsRow[]): PeriodTotals {
  const t: PeriodTotals = { count: 0, movingS: 0, distanceM: 0, indoorDistanceM: 0, elevationM: 0, tss: 0, workKj: 0 };
  for (const r of rows) {
    t.count++;
    t.movingS += num(r.movingS ?? r.elapsedS);
    t.distanceM += num(r.distanceM);
    if (r.environment === "indoor") t.indoorDistanceM += num(r.distanceM);
    t.elevationM += num(r.elevationGainM);
    t.tss += num(r.tss);
    t.workKj += num(r.workKj);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Personal records from stored columns

export interface StoredBestEffort {
  label: string;
  distanceM: number;
  seconds: number;
}

type RecordsRow = Pick<ExternalActivity, "id" | "environment" | "distanceM" | "elevationGainM" | "biggestClimbM" | "bestEfforts">;

/** The stored `bestEfforts` jsonb as a typed list; malformed entries are dropped. */
export function storedBestEfforts(value: unknown): StoredBestEffort[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is StoredBestEffort =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as StoredBestEffort).label === "string" &&
      typeof (e as StoredBestEffort).seconds === "number" &&
      Number.isFinite((e as StoredBestEffort).seconds),
  );
}

function maxRecord(current: RecordValue | null, value: number | null, id: string): RecordValue | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return current;
  return current === null || value > current.value ? { value, activityId: id } : current;
}

/**
 * The 15 rows of decision 8 (Longest ride, Biggest climb, Most elevation, then the 12 distances)
 * from stored columns, outdoor rows only (decision 13). Same shape as `personalRecords`; distance
 * values are elapsed seconds. Ties keep the first row seen.
 */
export function recordsFromStored(rows: readonly RecordsRow[]): PersonalRecords {
  let longest: RecordValue | null = null;
  let climb: RecordValue | null = null;
  let elevation: RecordValue | null = null;
  const best: (RecordValue | null)[] = bestEffortDistances.map(() => null);
  for (const r of rows) {
    if (r.environment !== "outdoor") continue;
    longest = maxRecord(longest, r.distanceM, r.id);
    climb = maxRecord(climb, r.biggestClimbM, r.id);
    elevation = maxRecord(elevation, r.elevationGainM, r.id);
    for (const effort of storedBestEfforts(r.bestEfforts)) {
      const k = bestEffortDistances.findIndex((d) => d.label === effort.label);
      if (k === -1) continue;
      const cur = best[k];
      if (cur === null || effort.seconds < cur.value) best[k] = { value: effort.seconds, activityId: r.id };
    }
  }
  return {
    longestRideM: longest,
    biggestClimbM: climb,
    mostElevationM: elevation,
    distances: bestEffortDistances.map((d, k) => ({ ...d, record: best[k] })),
  };
}

// ---------------------------------------------------------------------------
// Form (TSB) and ramp rate

export type TsbBand = "overreaching" | "productive" | "grey" | "fresh" | "transition";

/**
 * The five form bands (plan section 4), lowest first. `min` is inclusive, `max` exclusive, except
 * that +25 itself is still fresh ("above +25" is transition). Open ends are ±Infinity.
 */
export const TSB_BANDS: readonly { band: TsbBand; label: string; min: number; max: number }[] = [
  { band: "overreaching", label: "Overreaching", min: -Infinity, max: -30 },
  { band: "productive", label: "Productive", min: -30, max: -10 },
  { band: "grey", label: "Grey zone", min: -10, max: 5 },
  { band: "fresh", label: "Fresh", min: 5, max: 25 },
  { band: "transition", label: "Transition", min: 25, max: Infinity },
];

/** Band of a TSB value: < −30 overreaching, [−30, −10) productive, [−10, +5) grey, [+5, +25] fresh, > +25 transition. */
export function tsbBand(tsb: number): TsbBand {
  if (tsb < -30) return "overreaching";
  if (tsb < -10) return "productive";
  if (tsb < 5) return "grey";
  if (tsb <= 25) return "fresh";
  return "transition";
}

/** CTL(date) − CTL(date − 7 days); `null` when either day has no row. `date` is `YYYY-MM-DD`. */
export function rampRate(rows: readonly { date: string; ctl: number }[], date: string): number | null {
  const day = dayNumber(date);
  if (day === null) return null;
  const weekAgo = dateFromDayNumber(day - 7);
  const now = rows.find((r) => r.date === date);
  const before = rows.find((r) => r.date === weekAgo);
  return now && before ? now.ctl - before.ctl : null;
}

// ---------------------------------------------------------------------------
// Zones

export interface Zone {
  label: string;
  /** Inclusive lower bound, % of the threshold. The zone runs to the next zone's `minPct`. */
  minPct: number;
}

export interface ZoneTable {
  name: string;
  /** Lowest first; the last zone is open-ended. Samples below the first `minPct` are not counted. */
  zones: readonly Zone[];
  /** Whether a 0 sample counts (power: coasting is zone 1; HR: 0 is a dropout). */
  countZero: boolean;
}

/** Coggan power zones, % FTP (plan section 4). */
export const COGGAN_POWER_ZONES: ZoneTable = {
  name: "Coggan power",
  countZero: true,
  zones: [
    { label: "Z1 Active recovery", minPct: 0 },
    { label: "Z2 Endurance", minPct: 56 },
    { label: "Z3 Tempo", minPct: 76 },
    { label: "Z4 Threshold", minPct: 91 },
    { label: "Z5 VO2max", minPct: 106 },
    { label: "Z6 Anaerobic", minPct: 121 },
    { label: "Z7 Neuromuscular", minPct: 151 },
  ],
};

/** Friel bike HR zones, % LTHR, with 5a/5b/5c merged into zone 5 (plan section 4). */
export const FRIEL_HR_ZONES: ZoneTable = {
  name: "Friel heart rate",
  countZero: false,
  zones: [
    { label: "Z1 Recovery", minPct: 0 },
    { label: "Z2 Aerobic", minPct: 81 },
    { label: "Z3 Tempo", minPct: 90 },
    { label: "Z4 Threshold", minPct: 94 },
    { label: "Z5 Anaerobic", minPct: 100 },
  ],
};

/** Garmin's default HR zones, % max HR (plan section 4); under 50% is in no zone. */
export const GARMIN_HR_MAX_ZONES: ZoneTable = {
  name: "Garmin heart rate",
  countZero: false,
  zones: [
    { label: "Z1 Warm up", minPct: 50 },
    { label: "Z2 Easy", minPct: 60 },
    { label: "Z3 Aerobic", minPct: 70 },
    { label: "Z4 Threshold", minPct: 80 },
    { label: "Z5 Maximum", minPct: 90 },
  ],
};

/**
 * Seconds in each zone of `table` for a 1 Hz stream (one sample = one second) against
 * `threshold` (FTP, LTHR or max HR). Null, non-finite and negative samples are skipped; `null`
 * when the threshold is missing or not positive.
 */
export function zoneSeconds(stream: Stream, threshold: number | null | undefined, table: ZoneTable): number[] | null {
  if (typeof threshold !== "number" || !(threshold > 0)) return null;
  const out = table.zones.map(() => 0);
  for (const v of stream) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    if (v === 0 && !table.countZero) continue;
    const pct = (v / threshold) * 100;
    let k = -1;
    for (let i = 0; i < table.zones.length; i++) if (pct >= table.zones[i].minPct) k = i;
    if (k >= 0) out[k]++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Power curve

export interface PowerCurvePoint {
  durationS: number;
  watts: number;
  activityId: string;
  startedAt: string;
}

/**
 * Best stored power per duration key of `powerCurve` (`{"5": 610, "60": 380, …}`) over `rows`,
 * optionally only rows started at or after `fromIso`. Sorted by duration; ties keep the earlier ride.
 */
export function bestPowerCurve(
  rows: readonly Pick<ExternalActivity, "id" | "startedAt" | "powerCurve">[],
  fromIso?: string,
): PowerCurvePoint[] {
  const from = fromIso === undefined ? -Infinity : Date.parse(fromIso);
  const best = new Map<number, PowerCurvePoint>();
  for (const r of rows) {
    const t = Date.parse(r.startedAt);
    if (Number.isNaN(t) || t < from) continue;
    const curve = r.powerCurve;
    if (typeof curve !== "object" || curve === null || Array.isArray(curve)) continue;
    for (const [key, w] of Object.entries(curve as Record<string, unknown>)) {
      const d = Number(key);
      if (!Number.isFinite(d) || d <= 0 || typeof w !== "number" || !Number.isFinite(w)) continue;
      const cur = best.get(d);
      if (!cur || w > cur.watts || (w === cur.watts && t < Date.parse(cur.startedAt))) {
        best.set(d, { durationS: d, watts: w, activityId: r.id, startedAt: r.startedAt });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.durationS - b.durationS);
}

// ---------------------------------------------------------------------------
// Weight

export interface WeightDay {
  /** Local day, `YYYY-MM-DD`. */
  date: string;
  /** That day's weigh-ins in kg, in input order. */
  weighInsKg: number[];
  /** Mean of every weigh-in on the 7 local days ending at `date` (as `weightTrend`). */
  avg7Kg: number;
}

/** One entry per local day that has a weigh-in, oldest first. */
export function weightSeries(weighIns: readonly WeighIn[]): WeightDay[] {
  const byDay = new Map<number, number[]>();
  for (const w of weighIns) {
    if (typeof w.weightKg !== "number" || !Number.isFinite(w.weightKg)) continue;
    const date = localDate(w.measuredAt, w.timezone);
    const day = date === null ? null : dayNumber(date);
    if (day === null) continue;
    const list = byDay.get(day) ?? [];
    list.push(w.weightKg);
    byDay.set(day, list);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  return days.map((day) => {
    let sum = 0;
    let count = 0;
    for (let d = day - 6; d <= day; d++) {
      for (const kg of byDay.get(d) ?? []) {
        sum += kg;
        count++;
      }
    }
    return { date: dateFromDayNumber(day), weighInsKg: byDay.get(day)!.slice(), avg7Kg: sum / count };
  });
}

/** kg per week over the last four weeks: `change4wKg / 4`; `null` when the change is unknown. */
export function weightRatePerWeek(trend: Pick<WeightTrend, "change4wKg">): number | null {
  return trend.change4wKg === null ? null : trend.change4wKg / 4;
}

export type WPerKgBand = "untrained" | "fair" | "good" | "excellent" | "superior";

/**
 * FTP W/kg rating bands (Coggan via Garmin's FTP rating table, men's column; the lead's pinned
 * default for AI-649). `min` inclusive, lowest first.
 */
export const W_PER_KG_BANDS: readonly { band: WPerKgBand; label: string; min: number }[] = [
  { band: "untrained", label: "Untrained", min: -Infinity },
  { band: "fair", label: "Fair", min: 2.23 },
  { band: "good", label: "Good", min: 2.79 },
  { band: "excellent", label: "Excellent", min: 3.93 },
  { band: "superior", label: "Superior", min: 5.05 },
];

/** Rating band of an FTP W/kg value; `null` when it is missing. */
export function wPerKgBand(wkg: number | null | undefined): WPerKgBand | null {
  if (typeof wkg !== "number" || !Number.isFinite(wkg)) return null;
  let band: WPerKgBand = "untrained";
  for (const b of W_PER_KG_BANDS) if (wkg >= b.min) band = b.band;
  return band;
}

// ---------------------------------------------------------------------------
// TSS provenance

/** Decision 16: a ride with neither power nor HR gets a flat-rate TSS, flagged as estimated. */
export function isEstimatedTss(row: { tssSource: TssSource | string | null }): boolean {
  return row.tssSource === "estimated_flat";
}
