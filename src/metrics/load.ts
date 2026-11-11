/** Daily training load: TSS per local calendar day and the CTL/ATL/TSB recursion (decision 6). */
import { dateFromDayNumber, dayNumber, localDate } from "./dates.js";
import type { TssSource } from "./tss.js";

export const CTL_DECAY = Math.exp(-1 / 42);
export const ATL_DECAY = Math.exp(-1 / 7);

export interface LoadState {
  ctl: number;
  atl: number;
}

export interface LoadItem {
  id: string;
  /** UTC ISO instant; strength sessions use local noon. */
  startedAt: string;
  /** IANA time zone the day is taken in (e.g. `America/New_York`, `Etc/GMT+5`). */
  timezone: string;
  /** Where the item came from, e.g. `garmin`, `peloton`, `strength`. Keys `tssBySource`. */
  source: string;
  tss: number;
  tssSource: TssSource;
  /** Id of the other recording of the same effort (e.g. Garmin indoor + Peloton). */
  pairedActivityId?: string | null;
}

export interface DailyLoadRow {
  date: string;
  tssTotal: number;
  /** TSS per item `source`. */
  tssBySource: Record<string, number>;
  ctl: number;
  atl: number;
  /** Today's CTL minus today's ATL. */
  tsb: number;
}

/** One day of the recursion: today's CTL and ATL from yesterday's and today's TSS. */
export function loadStep(prev: LoadState, tss: number): LoadState {
  return {
    ctl: prev.ctl * CTL_DECAY + tss * (1 - CTL_DECAY),
    atl: prev.atl * ATL_DECAY + tss * (1 - ATL_DECAY),
  };
}

function startMs(item: LoadItem): number {
  const ms = Date.parse(item.startedAt);
  return Number.isNaN(ms) ? Infinity : ms;
}

/** True when `a` is the one kept over `b` in a pair: power first, then earlier start, then id. */
function preferred(a: LoadItem, b: LoadItem): boolean {
  const ap = a.tssSource === "power";
  const bp = b.tssSource === "power";
  if (ap !== bp) return ap;
  const as = startMs(a);
  const bs = startMs(b);
  if (as !== bs) return as < bs;
  return a.id < b.id;
}

/** Drops the losing side of every pair (A.pairedActivityId = B.id or the reverse). */
export function dedupePairs(items: readonly LoadItem[]): LoadItem[] {
  const byId = new Map<string, LoadItem>();
  const pointedAtBy = new Map<string, LoadItem[]>();
  for (const item of items) {
    byId.set(item.id, item);
    if (item.pairedActivityId) {
      const list = pointedAtBy.get(item.pairedActivityId) ?? [];
      list.push(item);
      pointedAtBy.set(item.pairedActivityId, list);
    }
  }
  return items.filter((item) => {
    const partners: LoadItem[] = [...(pointedAtBy.get(item.id) ?? [])];
    const target = item.pairedActivityId ? byId.get(item.pairedActivityId) : undefined;
    if (target) partners.push(target);
    return partners.every((p) => p === item || preferred(item, p));
  });
}

/**
 * One row per calendar day from `from` to `to` inclusive (`YYYY-MM-DD`), with TSS totals,
 * TSS per source and CTL/ATL/TSB. The recursion is seeded on the day before `from`
 * (zeros unless `seed` is given); items outside the range are ignored.
 * Returns `[]` when the range is empty or malformed.
 */
export function dailyLoad(
  items: readonly LoadItem[],
  from: string,
  to: string,
  seed: LoadState = { ctl: 0, atl: 0 },
): DailyLoadRow[] {
  const first = dayNumber(from);
  const last = dayNumber(to);
  if (first === null || last === null || last < first) return [];

  const perDay = new Map<string, { total: number; bySource: Record<string, number> }>();
  for (const item of dedupePairs(items)) {
    if (!Number.isFinite(item.tss)) continue;
    const date = localDate(item.startedAt, item.timezone);
    if (date === null) continue;
    const bucket = perDay.get(date) ?? { total: 0, bySource: {} };
    bucket.total += item.tss;
    bucket.bySource[item.source] = (bucket.bySource[item.source] ?? 0) + item.tss;
    perDay.set(date, bucket);
  }

  const rows: DailyLoadRow[] = [];
  let state: LoadState = { ctl: seed.ctl, atl: seed.atl };
  for (let day = first; day <= last; day++) {
    const date = dateFromDayNumber(day);
    const bucket = perDay.get(date);
    const tssTotal = bucket?.total ?? 0;
    state = loadStep(state, tssTotal);
    rows.push({
      date,
      tssTotal,
      tssBySource: { ...(bucket?.bySource ?? {}) },
      ctl: state.ctl,
      atl: state.atl,
      tsb: state.ctl - state.atl,
    });
  }
  return rows;
}
