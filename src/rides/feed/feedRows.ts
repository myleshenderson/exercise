/**
 * The Activities feed's rows (AI-650): visible rides and strength sessions merged into one
 * newest-first list, the sport-chip filter and each week's header totals.
 */
import { localDate } from "../../metrics/dates";
import { formatDuration, periodTotals, visibleActivities, type VisibleActivity } from "../../metrics/display";
import type { AthleteSettings, ExternalActivity, Session, WorkoutDay } from "../../types";
import { localTimeText, sessionCounts } from "./format";

export type FeedChip = "all" | "rides" | "outdoor" | "indoor" | "strength";

export const FEED_CHIPS: readonly { value: FeedChip; label: string }[] = [
  { value: "all", label: "All" },
  { value: "rides", label: "Rides" },
  { value: "outdoor", label: "Outdoor" },
  { value: "indoor", label: "Indoor" },
  { value: "strength", label: "Strength" },
];

interface RowBase {
  key: string;
  /** For `groupByWeek`: an instant for rides, the `YYYY-MM-DD` day for strength. */
  startedAt: string;
  timezone: string | null;
  /** Local `YYYY-MM-DD` the row happened on. */
  date: string;
  /** Newest-first order: local date then local time; a strength session (no time) counts as the latest of its day. */
  sortKey: string;
}

export interface RideRow extends RowBase {
  kind: "ride";
  activity: VisibleActivity<ExternalActivity>;
}

export interface StrengthRow extends RowBase {
  kind: "strength";
  session: Session;
  title: string;
  tss: number;
  exercises: number;
  sets: number;
}

export type FeedRow = RideRow | StrengthRow;

/**
 * Feed rows on or after local day `firstDay`, newest first: `activities` through
 * `visibleActivities`, plus one row per strength session (TSS = `strengthSessionTss`, title = the
 * workout day's name, else "Strength").
 */
export function buildFeedRows(
  activities: readonly ExternalActivity[],
  sessions: readonly Session[],
  days: readonly Pick<WorkoutDay, "id" | "name">[],
  settings: Pick<AthleteSettings, "strengthSessionTss">,
  firstDay: string,
): FeedRow[] {
  const dayName = new Map(days.map((d) => [d.id, d.name]));
  const rows: FeedRow[] = [];
  for (const a of visibleActivities(activities)) {
    const date = localDate(a.startedAt, a.timezone ?? undefined);
    if (date === null || date < firstDay) continue;
    rows.push({
      kind: "ride",
      key: `ride:${a.id}`,
      startedAt: a.startedAt,
      timezone: a.timezone,
      date,
      sortKey: `${date} ${localTimeText(a.startedAt, a.timezone)}`,
      activity: a,
    });
  }
  for (const s of sessions) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.performedOn) || s.performedOn < firstDay) continue;
    const counts = sessionCounts(s);
    rows.push({
      kind: "strength",
      key: `strength:${s.id}`,
      startedAt: s.performedOn,
      timezone: null,
      date: s.performedOn,
      sortKey: `${s.performedOn} ~`,
      session: s,
      title: (s.workoutDayId && dayName.get(s.workoutDayId)) || "Strength",
      tss: settings.strengthSessionTss,
      ...counts,
    });
  }
  return rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
}

/** The rows a sport chip shows. */
export function filterFeedRows(rows: readonly FeedRow[], chip: FeedChip): FeedRow[] {
  switch (chip) {
    case "all":
      return rows.slice();
    case "rides":
      return rows.filter((r) => r.kind === "ride");
    case "outdoor":
    case "indoor":
      return rows.filter((r) => r.kind === "ride" && r.activity.environment === chip);
    case "strength":
      return rows.filter((r) => r.kind === "strength");
  }
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * A week header's totals line: "3 rides · 4h 12m · 210 TSS · 2,140 kJ" from `periodTotals` over
 * the week's rides; strength sessions add their TSS and a "· 1 strength" count.
 */
export function weekTotalsText(rows: readonly FeedRow[]): string {
  const rides = rows.flatMap((r) => (r.kind === "ride" ? [r.activity] : []));
  const strength = rows.filter((r): r is StrengthRow => r.kind === "strength");
  const t = periodTotals(rides);
  const tss = t.tss + strength.reduce((s, r) => s + r.tss, 0);
  const parts: string[] = [];
  if (t.count > 0) parts.push(plural(t.count, "ride", "rides"), formatDuration(t.movingS));
  parts.push(`${Math.round(tss).toLocaleString("en-US")} TSS`);
  // No ride in the week has power: omit the segment rather than print "0 kJ".
  const kj = Math.round(t.workKj);
  if (t.count > 0 && Number.isFinite(kj) && kj > 0) parts.push(`${kj.toLocaleString("en-US")} kJ`);
  if (strength.length > 0) parts.push(`${strength.length.toLocaleString("en-US")} strength`);
  return parts.join(" · ");
}
