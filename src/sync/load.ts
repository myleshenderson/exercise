/** Daily training load (CTL/ATL/TSB) rebuilt from stored activities and strength sessions. */
import { DAY_MS, dailyLoad, dateFromDayNumber, dayNumber, localDate, type LoadItem } from "../metrics/index.js";
import type { AthleteSettings, DailyTrainingLoad, ExternalActivity } from "../types.js";
import type { SyncStore } from "./store.js";

export function loadItems(
  activities: readonly ExternalActivity[],
  sessions: readonly { id: string; performedOn: string }[],
  settings: Pick<AthleteSettings, "strengthSessionTss">,
  defaultTimeZone: string,
): LoadItem[] {
  const items: LoadItem[] = [];
  for (const a of activities) {
    if (a.tss === null || a.tssSource === null) continue;
    items.push({
      id: a.id,
      startedAt: a.startedAt,
      timezone: a.timezone ?? defaultTimeZone,
      source: a.source,
      tss: a.tss,
      tssSource: a.tssSource,
      pairedActivityId: a.pairedActivityId,
    });
  }
  for (const s of sessions) {
    items.push({
      id: s.id,
      startedAt: `${s.performedOn}T12:00:00.000Z`,
      timezone: "UTC",
      source: "strength",
      tss: settings.strengthSessionTss,
      tssSource: "strength_fixed",
    });
  }
  return items;
}

function addDays(date: string, days: number): string | null {
  const n = dayNumber(date);
  return n === null ? null : dateFromDayNumber(n + days);
}

/**
 * Rewrites daily_training_load for `from`..`to` (YYYY-MM-DD, inclusive) and returns the number
 * of rows written. Seeds from the stored row of the day before `from`; when there is none (or
 * `fromZero` is set, for a full rebuild), the range starts at the earliest item's date instead
 * (if earlier) and the seed is zero.
 */
export async function recomputeDailyLoad(
  store: SyncStore,
  from: string,
  to: string,
  opts: { defaultTimeZone: string; fromZero?: boolean },
): Promise<number> {
  const dayBefore = addDays(from, -1);
  if (dayBefore === null || dayNumber(to) === null) return 0;
  const [settings, sessions, seedRow] = await Promise.all([
    store.getAthleteSettings(),
    store.listStrengthSessions(),
    opts.fromZero ? Promise.resolve(null) : store.getDailyLoad(dayBefore),
  ]);

  let start = from;
  let activities: ExternalActivity[];
  if (seedRow) {
    // A day in any time zone lies within a day either side of the UTC day.
    const fromIso = new Date((dayNumber(from) as number) * DAY_MS - DAY_MS).toISOString();
    const toIso = new Date((dayNumber(to) as number) * DAY_MS + 2 * DAY_MS - 1).toISOString();
    activities = await store.listActivitiesBetween(fromIso, toIso);
  } else {
    activities = await store.listAllActivities();
  }
  const items = loadItems(activities, sessions, settings, opts.defaultTimeZone);
  if (!seedRow) {
    for (const item of items) {
      const date = localDate(item.startedAt, item.timezone);
      if (date !== null && date < start) start = date;
    }
  }

  const seed = seedRow ? { ctl: seedRow.ctl, atl: seedRow.atl } : { ctl: 0, atl: 0 };
  const rows: DailyTrainingLoad[] = dailyLoad(items, start, to, seed).map((r) => ({
    date: r.date,
    tssTotal: r.tssTotal,
    tssBySource: r.tssBySource as DailyTrainingLoad["tssBySource"],
    ctl: r.ctl,
    atl: r.atl,
    tsb: r.tsb,
  }));
  await store.upsertDailyTrainingLoad(rows);
  return rows.length;
}
