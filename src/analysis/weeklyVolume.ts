import type { SessionRow, SessionSetRow } from "./rows";
import {
  addDecimal,
  compareDates,
  groupByUuid,
  isoWeekStart,
  mulDecimalInt,
  roundDecimal,
  toDecimal,
  uuidKey,
  type Decimal,
} from "./sqlSemantics";

export interface WeeklyVolumeTables {
  sessions: readonly Pick<SessionRow, "id" | "performed_on">[];
  sessionSets: readonly Pick<SessionSetRow, "session_id" | "weight" | "reps">[];
}

export interface WeeklyVolumeResult {
  /** Monday of the week, "YYYY-MM-DD". */
  week: string;
  sessions: number;
  /** Null when no session in the week has any set. */
  total_volume: number | null;
}

/**
 * Session count and total volume per week. Mirrors `public.weekly_volume` in
 * `supabase/migrations/0005_analysis_rpc.sql`.
 *
 * Postgres semantics reproduced:
 * - `date_trunc('week', performed_on)::date` buckets by ISO week starting
 *   Monday; for a `date` input the result is the same calendar Monday in any
 *   session TimeZone.
 * - `sessions left join session_sets`: a session with no sets still counts
 *   toward `sessions`; `count(distinct s.id)` counts each session once.
 *   Sets whose session is not in the input are dropped.
 * - `round(sum(weight * reps))` in exact decimal arithmetic, half away from
 *   zero; `sum` over only null products (a week of set-less sessions) is null.
 * - Ordered by week, which is unique per output row.
 */
export function weeklyVolume(tables: WeeklyVolumeTables): WeeklyVolumeResult[] {
  const setsBySession = groupByUuid(tables.sessionSets, (ss) => ss.session_id);

  const byWeek = new Map<string, { sessionIds: Set<string>; volume: Decimal | null }>();
  for (const s of tables.sessions) {
    const week = isoWeekStart(s.performed_on);
    let group = byWeek.get(week);
    if (group === undefined) {
      group = { sessionIds: new Set(), volume: null };
      byWeek.set(week, group);
    }
    const key = uuidKey(s.id);
    group.sessionIds.add(key);
    for (const ss of setsBySession.get(key) ?? []) {
      const product = mulDecimalInt(toDecimal(ss.weight), ss.reps);
      group.volume = group.volume === null ? product : addDecimal(group.volume, product);
    }
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => compareDates(a, b))
    .map(([week, g]) => ({
      week,
      sessions: g.sessionIds.size,
      total_volume: g.volume === null ? null : roundDecimal(g.volume),
    }));
}
