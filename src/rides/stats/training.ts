/** The Training screen's numbers (AI-651), from stored `daily_training_load` rows and ride streams. */
import type { DataLayer } from "../../data/DataLayer";
import { COGGAN_POWER_ZONES, TSB_BANDS, tsbBand, weekStartOf, zoneSeconds, type TsbBand, type WeekStart } from "../../metrics/display";
import type { DailyTrainingLoad, ExternalActivity, TrainingLoadSource } from "../../types";
import { activityDate } from "./time";

/** Stack order of the weekly TSS bars (the sources `daily_training_load.tss_by_source` stores). */
export const TSS_SOURCES: readonly { key: TrainingLoadSource; label: string }[] = [
  { key: "garmin", label: "Garmin" },
  { key: "peloton", label: "Peloton" },
  { key: "strava_export", label: "Strava archive" },
  { key: "strength", label: "Strength" },
];

const finite = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** TSS per source per week, aligned with `weeks` (week starts, oldest first). */
export function weeklyTssBySource(
  rows: readonly DailyTrainingLoad[],
  weeks: readonly string[],
  weekStart: WeekStart,
): Record<TrainingLoadSource, number[]> {
  const index = new Map(weeks.map((w, i) => [w, i]));
  const out = Object.fromEntries(TSS_SOURCES.map((s) => [s.key, weeks.map(() => 0)])) as Record<TrainingLoadSource, number[]>;
  for (const r of rows) {
    let k: number | undefined;
    try {
      k = index.get(weekStartOf(r.date, weekStart));
    } catch {
      continue;
    }
    if (k === undefined) continue;
    for (const s of TSS_SOURCES) out[s.key][k] += finite(r.tssBySource?.[s.key]);
  }
  return out;
}

export interface FormReadout {
  date: string;
  /** False when today has no row and the latest earlier row is shown (labelled with its date). */
  isToday: boolean;
  tsb: number;
  band: TsbBand;
  bandLabel: string;
}

/** Decision 6: today's row (CTL − ATL); else the latest row before today; `null` when none. */
export function formReadout(rows: readonly DailyTrainingLoad[], today: string): FormReadout | null {
  let row: DailyTrainingLoad | undefined;
  for (const r of rows) if (r.date <= today && Number.isFinite(r.tsb) && (!row || r.date > row.date)) row = r;
  if (!row) return null;
  const band = tsbBand(row.tsb);
  return { date: row.date, isToday: row.date === today, tsb: row.tsb, band, bandLabel: TSB_BANDS.find((b) => b.band === band)!.label };
}

export interface ZoneWeek {
  weekStart: string;
  /** Seconds per Coggan zone (Z1 → Z7). */
  zoneS: number[];
  /** Moving time of rides with no usable power stream. */
  noPowerS: number;
}

/**
 * Time in each Coggan power zone per week (`weeks` oldest first). A ride with `hasPower` reads its
 * power stream (`getActivityStreams`) and `zoneSeconds(power, ftpUsedW)`; a ride without power,
 * or whose stream (missing or failing to load) or FTP is missing, adds its moving time as "No power".
 */
export async function loadZoneWeeks(
  db: DataLayer,
  rides: readonly ExternalActivity[],
  weeks: readonly string[],
  weekStart: WeekStart,
): Promise<ZoneWeek[]> {
  const out = weeks.map((w) => ({ weekStart: w, zoneS: COGGAN_POWER_ZONES.zones.map(() => 0), noPowerS: 0 }));
  const index = new Map(weeks.map((w, i) => [w, i]));
  const placed = rides.flatMap((ride) => {
    const date = activityDate(ride);
    const k = date === null ? undefined : index.get(weekStartOf(date, weekStart));
    return k === undefined ? [] : [{ ride, k }];
  });
  const perRide = await Promise.all(
    placed.map(async ({ ride, k }) => {
      if (!ride.hasPower) return { k, zones: null, ride };
      // A failed fetch counts as "No power" rather than blanking the whole chart.
      const streams = await db.getActivityStreams(ride.id).catch(() => []);
      const power = streams.find((s) => s.channel === "power");
      return { k, zones: power ? zoneSeconds(power.values, ride.ftpUsedW, COGGAN_POWER_ZONES) : null, ride };
    }),
  );
  for (const { k, zones, ride } of perRide) {
    if (zones) zones.forEach((s, z) => (out[k].zoneS[z] += s));
    else out[k].noPowerS += finite(ride.movingS ?? ride.elapsedS);
  }
  return out;
}
