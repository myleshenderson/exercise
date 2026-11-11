/** The Cycling tab's numbers (AI-651), all from stored columns through `src/metrics`. */
import type { BodyWeight, ExternalActivity } from "../../types";
import {
  bestPowerCurve,
  periodTotals,
  recordsFromStored,
  visibleActivities,
  type PeriodTotals,
  type PowerCurvePoint,
} from "../../metrics/display";
import type { PersonalRecords } from "../../metrics/bestEfforts";
import { weightTrend } from "../../metrics/weight";
import { activityDate, addDays } from "./time";

/** The power-bests strip: 5 s, 1 min, 5 min, 20 min, 1 h. */
export const POWER_STRIP: readonly { label: string; durationS: number }[] = [
  { label: "5 s", durationS: 5 },
  { label: "1 min", durationS: 60 },
  { label: "5 min", durationS: 300 },
  { label: "20 min", durationS: 1200 },
  { label: "1 h", durationS: 3600 },
];

export interface WeeklyAverages {
  activities: number;
  distanceM: number;
  elevationM: number;
  movingS: number;
}

export interface WeightCard {
  latestKg: number;
  avg7Kg: number | null;
  change4wKg: number | null;
}

export interface CyclingStats {
  /** Visible activities (pairs collapsed, fragments dropped). */
  count: number;
  /** The 28 days ending `today`, as weekly averages (`periodTotals` / 4). */
  last4Weeks: WeeklyAverages;
  /** Decision 8's 15 rows, outdoor only (decision 13). */
  records: PersonalRecords;
  yearToDate: PeriodTotals;
  allTime: PeriodTotals;
  powerBests: { label: string; durationS: number; point: PowerCurvePoint | null }[];
  /** `null` when there are no weigh-ins (the card is hidden). */
  weight: WeightCard | null;
}

/**
 * Everything the Cycling tab shows. `rows` are every stored activity; `weighIns` the last 60
 * days, oldest first; `today` is the local date and `timeZone` the zone weigh-ins are read in.
 */
export function cyclingStats(
  rows: readonly ExternalActivity[],
  weighIns: readonly BodyWeight[],
  today: string,
  timeZone: string,
): CyclingStats {
  const visible = visibleActivities(rows);
  const dated = visible.map((a) => ({ a, date: activityDate(a) }));
  const fourWeeksFrom = addDays(today, -27);
  const year = today.slice(0, 4);
  const recent = periodTotals(dated.filter(({ date }) => date !== null && date >= fourWeeksFrom && date <= today).map(({ a }) => a));
  const ytd = periodTotals(dated.filter(({ date }) => date !== null && date.slice(0, 4) === year && date <= today).map(({ a }) => a));

  const curve = bestPowerCurve(visible);
  const powerBests = POWER_STRIP.map((p) => ({ ...p, point: curve.find((c) => c.durationS === p.durationS) ?? null }));

  let weight: WeightCard | null = null;
  const valid = weighIns.filter((w) => Number.isFinite(w.weightKg));
  if (valid.length > 0) {
    const trend = weightTrend(
      valid.map((w) => ({ measuredAt: w.measuredAt, timezone: timeZone, weightKg: w.weightKg })),
      today,
    );
    weight = { latestKg: valid[valid.length - 1].weightKg, avg7Kg: trend.avg7Kg, change4wKg: trend.change4wKg };
  }

  return {
    count: visible.length,
    last4Weeks: {
      activities: recent.count / 4,
      distanceM: recent.distanceM / 4,
      elevationM: recent.elevationM / 4,
      movingS: recent.movingS / 4,
    },
    records: recordsFromStored(visible),
    yearToDate: ytd,
    allTime: periodTotals(visible),
    powerBests,
    weight,
  };
}
