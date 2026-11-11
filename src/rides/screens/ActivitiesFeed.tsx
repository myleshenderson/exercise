import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { DEFAULT_ATHLETE_SETTINGS, type DataLayer } from "../../data/DataLayer";
import { localDate } from "../../metrics/dates";
import { groupByWeek, isEstimatedTss, visibleActivities } from "../../metrics/display";
import type { AthleteSettings, ExternalActivity, Session, WorkoutDay } from "../../types";
import { EmptyState, RangeTabs, SourceBadge, TssChip } from "../components";
import { useUnits, type UnitFormatters } from "../hooks";
import { useRideDb } from "../RideDb";
import { lastWeekStarts, localToday, shortDate, windowStartIso } from "../stats/time";
import { EMPTY_MARK, dayText, localDateText, localTimeText } from "../feed/format";
import { FEED_CHIPS, buildFeedRows, filterFeedRows, weekTotalsText, type FeedChip, type FeedRow, type RideRow, type StrengthRow } from "../feed/feedRows";

/** Weeks loaded first, and added by each "Load earlier". */
export const FEED_WEEKS = 12;

interface FeedData {
  settings: AthleteSettings;
  firstDay: string;
  activities: ExternalActivity[];
  sessions: Session[];
  days: WorkoutDay[];
  /** Whether anything (ride or strength) is older than `firstDay`. */
  hasEarlier: boolean;
}

interface FeedBase {
  settings: AthleteSettings;
  sessions: Session[];
  days: WorkoutDay[];
}

async function loadBase(db: DataLayer): Promise<FeedBase> {
  const [settings, sessions, days] = await Promise.all([db.getAthleteSettings(), db.listSessions(), db.getWorkoutDays()]);
  return { settings, sessions, days };
}

/** Rows read before the window to tell whether "Load earlier" has anything visible to add. */
const EARLIER_PROBE = 20;

type FeedState =
  | { status: "loading"; data: FeedData | null }
  | { status: "error"; message: string; data: FeedData | null }
  | { status: "ready"; data: FeedData };

/** Activities (AI-650): every visible ride and strength session, newest first, grouped by week. */
export default function ActivitiesFeed({ now }: { now?: Date }) {
  const db = useRideDb();
  const [fallbackNow] = useState(() => Date.now());
  const nowMs = now?.getTime() ?? fallbackNow;
  const [weeks, setWeeks] = useState(FEED_WEEKS);
  const [chip, setChip] = useState<FeedChip>("all");
  const [state, setState] = useState<FeedState>({ status: "loading", data: null });

  // Settings, strength sessions and workout days are read once per db; "Load earlier" only
  // re-reads the activities.
  const base = useRef<{ db: DataLayer; promise: Promise<FeedBase> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ status: "loading", data: s.data }));
    if (base.current?.db !== db) base.current = { db, promise: loadBase(db) };
    const pending = base.current.promise;
    (async (): Promise<FeedData> => {
      const { settings, sessions, days } = await pending;
      const firstDay = lastWeekStarts(localToday(new Date(nowMs)), settings.weekStart, weeks)[0];
      const from = windowStartIso(firstDay);
      const [activities, older] = await Promise.all([
        db.listExternalActivities({ from }),
        db.listExternalActivities({ to: from, limit: EARLIER_PROBE }),
      ]);
      const seen = new Set(activities.map((a) => a.id));
      const candidates = [...activities, ...older.filter((a) => !seen.has(a.id))];
      const hasEarlier =
        sessions.some((x) => x.performedOn < firstDay) ||
        visibleActivities(candidates).some((a) => {
          const d = localDate(a.startedAt, a.timezone ?? undefined);
          return d !== null && d < firstDay;
        });
      return { settings, firstDay, activities, sessions, days, hasEarlier };
    })().then(
      (data) => !cancelled && setState({ status: "ready", data }),
      (e: unknown) => {
        if (base.current?.promise === pending) pending.catch(() => (base.current = null)); // retry the base read next time
        if (!cancelled) setState((s) => ({ status: "error", message: e instanceof Error ? e.message : String(e), data: s.data }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, nowMs, weeks]);

  const data = state.data;
  const units = useUnits(data?.settings ?? DEFAULT_ATHLETE_SETTINGS);
  const rows = useMemo(
    () => (data ? buildFeedRows(data.activities, data.sessions, data.days, data.settings, data.firstDay) : []),
    [data],
  );
  const shown = useMemo(() => filterFeedRows(rows, chip), [rows, chip]);
  const groups = useMemo(() => groupByWeek(shown, data?.settings.weekStart ?? "monday"), [shown, data]);

  const header = <h1 className="text-2xl font-bold">Activities</h1>;

  if (!data) {
    return (
      <div className="space-y-4 p-4">
        {header}
        {state.status === "error" ? (
          <p className="text-sm text-red-700">Couldn't load your activities: {state.message}</p>
        ) : (
          <p className="text-sm text-gray-500">Loading…</p>
        )}
      </div>
    );
  }

  if (rows.length === 0 && !data.hasEarlier) {
    return (
      <div className="space-y-4 p-4" data-ready="activities">
        {header}
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4" data-ready="activities">
      {header}
      <RangeTabs<FeedChip> ariaLabel="Sport" options={FEED_CHIPS} value={chip} onChange={setChip} />
      {groups.length === 0 && <p className="text-sm text-gray-500">Nothing since {shortDate(data.firstDay)}.</p>}
      {groups.map((g) => (
        <section key={g.weekStart} aria-label={`Week of ${shortDate(g.weekStart)}`} data-week={g.weekStart} className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b pb-1">
            <h2 className="text-sm font-semibold">Week of {shortDate(g.weekStart)}</h2>
            <span className="text-xs tabular-nums text-gray-600" data-testid="week-totals">
              {weekTotalsText(g.items)}
            </span>
          </div>
          <ul className="space-y-2">
            {g.items.map((r) => (
              <li key={r.key}>
                <FeedItem row={r} units={units} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {state.status === "error" && <p className="text-sm text-red-700">Couldn't load earlier activities: {state.message}</p>}
      {data.hasEarlier && (
        <button
          type="button"
          className="w-full rounded-lg border py-2 text-sm text-blue-700 disabled:opacity-50"
          disabled={state.status === "loading"}
          onClick={() => setWeeks((w) => w + FEED_WEEKS)}
        >
          {state.status === "loading" ? "Loading…" : "Load earlier"}
        </button>
      )}
    </div>
  );
}

function FeedItem({ row, units }: { row: FeedRow; units: UnitFormatters }) {
  return row.kind === "ride" ? <RideItem row={row} units={units} /> : <StrengthItem row={row} />;
}

const rowClass = "block rounded-xl border p-3 hover:bg-gray-50";

function RideItem({ row, units }: { row: RideRow; units: UnitFormatters }) {
  const a = row.activity;
  const title = a.title || (a.environment === "outdoor" ? "Outdoor ride" : "Indoor ride");
  const watts = (w: number | null) => (typeof w === "number" && Number.isFinite(w) ? `${Math.round(w)} W` : EMPTY_MARK);
  const kj = (v: number | null) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-US")} kJ` : EMPTY_MARK);
  const numbers =
    a.environment === "outdoor"
      ? [units.distance(a.distanceM), units.duration(a.movingS ?? a.elapsedS), units.elevation(a.elevationGainM)]
      : [units.duration(a.movingS ?? a.elapsedS), kj(a.workKj), watts(a.avgPowerW)];
  return (
    <Link to={`/activities/${encodeURIComponent(a.id)}`} className={rowClass} data-activity-id={a.id}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SourceBadge source={a.source} />
            <span className="truncate font-medium">{title}</span>
          </div>
          <div className="text-xs text-gray-500">
            {localDateText(a.startedAt, a.timezone)} · {localTimeText(a.startedAt, a.timezone)}
          </div>
        </div>
        <TssChip tss={a.tss} estimated={isEstimatedTss(a)} />
      </div>
      <div className="mt-1 text-sm tabular-nums text-gray-800">{numbers.join(" · ")}</div>
      {a.pairedWith && <div className="mt-1 text-xs text-gray-500">HR and elevation from Garmin</div>}
    </Link>
  );
}

function StrengthItem({ row }: { row: StrengthRow }) {
  const ex = `${row.exercises} ${row.exercises === 1 ? "exercise" : "exercises"}`;
  const sets = `${row.sets} ${row.sets === 1 ? "set" : "sets"}`;
  return (
    <Link to={`/session/${encodeURIComponent(row.session.id)}/summary`} className={rowClass} data-session-id={row.session.id}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SourceBadge source="strength" />
            <span className="truncate font-medium">{row.title}</span>
          </div>
          <div className="text-xs text-gray-500">{dayText(row.date)}</div>
        </div>
        <TssChip tss={row.tss} />
      </div>
      <div className="mt-1 text-sm tabular-nums text-gray-800">
        {ex} · {sets}
      </div>
    </Link>
  );
}
