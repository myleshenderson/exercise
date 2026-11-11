import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DataLayer } from "../data/DataLayer";
import { DAY_MS, localDate } from "../metrics/dates";
import { formatDuration, periodTotals, visibleActivities, weekStartOf } from "../metrics/display";
import type { AthleteSettings } from "../types";
import { StatTile } from "./components/StatTile";
import { unitFormatters } from "./hooks";
import { useRideDb } from "./RideDb";

export interface ThisWeek {
  /** First local day of the current week, `YYYY-MM-DD`. */
  weekStart: string;
  rides: number;
  movingS: number;
  tss: number;
  latestWeightKg: number | null;
  units: AthleteSettings["units"];
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * An instant safely before the start of local day `date` in any time zone (UTC midnight minus
 * 14 h); the exact cut is made per activity on its own local date.
 */
function windowStartIso(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 14 * 3_600_000).toISOString();
}

/**
 * The strip's numbers for the week holding `now` (decision 12), or `null` when the account has no
 * external activity and no weigh-in at all (the strip is then not rendered).
 */
export async function loadThisWeek(db: DataLayer, now: Date = new Date()): Promise<ThisWeek | null> {
  const nowIso = now.toISOString();
  const monthAgoIso = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const [anyActivity, recentWeights] = await Promise.all([
    db.listExternalActivities({ limit: 1 }),
    db.listBodyWeights(monthAgoIso, nowIso),
  ]);
  if (anyActivity.length === 0 && recentWeights.length === 0) {
    const everWeighed = await db.listBodyWeights("1970-01-01T00:00:00.000Z", nowIso);
    if (everWeighed.length === 0) return null;
  }

  const settings = await db.getAthleteSettings();
  const today = localDate(nowIso, hostTimeZone()) ?? nowIso.slice(0, 10);
  const weekStart = weekStartOf(today, settings.weekStart);
  const [candidates, load] = await Promise.all([
    db.listExternalActivities({ from: windowStartIso(weekStart), to: nowIso }),
    db.listDailyTrainingLoad(weekStart, today),
  ]);
  // An activity belongs to the week of its own local date (its timezone), the same day the
  // daily_training_load rollup files its TSS under, so Rides, Hours and TSS agree.
  const weekRows = candidates.filter((a) => {
    const day = localDate(a.startedAt, a.timezone ?? undefined);
    return day !== null && day >= weekStart && day <= today;
  });
  const totals = periodTotals(visibleActivities(weekRows));
  return {
    weekStart,
    rides: totals.count,
    movingS: totals.movingS,
    tss: load.reduce((sum, d) => sum + (Number.isFinite(d.tssTotal) ? d.tssTotal : 0), 0),
    latestWeightKg: recentWeights.length ? recentWeights[recentWeights.length - 1].weightKg : null,
    units: settings.units,
  };
}

/**
 * Home's "This week" card (AI-649, decision 12): rides, hours, TSS and latest weight, linking to
 * /activities. Renders nothing until loaded, and nothing for an account without ride data.
 */
export default function ThisWeekStrip({ now }: { now?: Date }) {
  const db = useRideDb();
  const [week, setWeek] = useState<ThisWeek | null>(null);
  const nowMs = now?.getTime();

  useEffect(() => {
    let cancelled = false;
    loadThisWeek(db, nowMs === undefined ? new Date() : new Date(nowMs)).then(
      (w) => !cancelled && setWeek(w),
      () => !cancelled && setWeek(null), // the strip is optional; Home must not break with it
    );
    return () => {
      cancelled = true;
    };
  }, [db, nowMs]);

  if (!week) return null;
  const fmt = unitFormatters(week.units);
  return (
    <Link
      to="/activities"
      data-ready="home-strip"
      aria-label="This week: open Activities"
      className="block rounded-xl border p-3 active:bg-gray-100"
    >
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-semibold">This week</span>
        <span className="text-xs text-gray-500">Activities ›</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <StatTile label="Rides" value={week.rides} />
        <StatTile label="Hours" value={formatDuration(week.movingS, "short")} />
        <StatTile label="TSS" value={Math.round(week.tss)} />
        <StatTile label="Weight" value={fmt.weight(week.latestWeightKg)} />
      </div>
    </Link>
  );
}
