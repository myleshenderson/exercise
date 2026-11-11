import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DAY_MS } from "../../metrics/dates";
import { formatDuration, type PeriodTotals } from "../../metrics/display";
import type { AthleteSettings, Session } from "../../types";
import { StackedBars } from "../charts";
import { EmptyState, RangeTabs, StatTile } from "../components";
import { useUnits, type UnitFormatters } from "../hooks";
import { useRideDb } from "../RideDb";
import { cyclingStats, type CyclingStats } from "../stats/cycling";
import { strengthStats, type StrengthTotals, type StrengthWeek } from "../stats/strength";
import { hostTimeZone, localToday, shortDate } from "../stats/time";
import { Card } from "../stats/Card";
import { useLoad, type Load } from "../stats/useLoad";

type Tab = "cycling" | "strength";

const TABS = [
  { value: "cycling", label: "Cycling" },
  { value: "strength", label: "Strength" },
] as const;

const EMPTY = "—";

/** My Stats (AI-651): Strava's profile blocks with stored numbers; `?tab=strength` opens Strength. */
export default function MyStats({ now }: { now?: Date }) {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "strength" ? "strength" : "cycling";
  const [fallbackNow] = useState(() => Date.now());
  const nowMs = now?.getTime() ?? fallbackNow;

  const select = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === "strength") next.set("tab", "strength");
    else next.delete("tab");
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">My Stats</h1>
        <Link to="/settings" aria-label="Settings" className="p-2 text-xl text-gray-600">
          ⚙
        </Link>
      </div>
      <nav className="flex gap-4 text-sm" aria-label="More stats">
        <Link to="/training" className="text-blue-700 underline">
          Training
        </Link>
        <Link to="/power" className="text-blue-700 underline">
          Power
        </Link>
        <Link to="/weight" className="text-blue-700 underline">
          Weight
        </Link>
      </nav>
      <RangeTabs ariaLabel="Sport" options={TABS} value={tab} onChange={select} />
      {tab === "cycling" ? <CyclingTab nowMs={nowMs} /> : <StrengthTab nowMs={nowMs} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading

function Status({ state }: { state: Load<unknown> }) {
  if (state.status === "loading") return <p className="text-sm text-gray-500">Loading…</p>;
  if (state.status === "error") return <p className="text-sm text-red-700">Couldn't load your stats: {state.message}</p>;
  return null;
}


// ---------------------------------------------------------------------------
// Cycling

function CyclingTab({ nowMs }: { nowMs: number }) {
  const db = useRideDb();
  const load = useCallback(async () => {
    const nowIso = new Date(nowMs).toISOString();
    const [settings, rows, weighIns] = await Promise.all([
      db.getAthleteSettings(),
      db.listExternalActivities({}),
      db.listBodyWeights(new Date(nowMs - 60 * DAY_MS).toISOString(), nowIso),
    ]);
    return { settings, stats: cyclingStats(rows, weighIns, localToday(new Date(nowMs)), hostTimeZone()) };
  }, [db, nowMs]);
  const state = useLoad(load);

  if (state.status !== "ready") return <Status state={state} />;
  return <CyclingView settings={state.data.settings} stats={state.data.stats} />;
}

function CyclingView({ settings, stats }: { settings: AthleteSettings; stats: CyclingStats }) {
  const fmt = useUnits(settings);
  return (
    <div className="space-y-4" data-ready="stats-cycling">
      {stats.count === 0 ? (
        <EmptyState />
      ) : (
        <>
          <Card title="Last 4 weeks">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Activities / week" value={stats.last4Weeks.activities.toFixed(1)} />
              <StatTile label="Distance / week" value={fmt.distance(stats.last4Weeks.distanceM)} />
              <StatTile label="Elevation / week" value={fmt.elevation(stats.last4Weeks.elevationM)} />
              <StatTile label="Time / week" value={fmt.duration(stats.last4Weeks.movingS)} />
            </div>
          </Card>
          <BestEfforts stats={stats} fmt={fmt} />
          <Card title="Year to date">
            <Totals totals={stats.yearToDate} fmt={fmt} />
          </Card>
          <Card title="All-time">
            <Totals totals={stats.allTime} fmt={fmt} />
          </Card>
          <Card
            title="Power bests"
            action={
              <Link to="/power" className="text-xs text-blue-700">
                Power curve ›
              </Link>
            }
          >
            <ul className="grid grid-cols-5 gap-2 text-center">
              {stats.powerBests.map((p) => (
                <li key={p.durationS} data-power={p.label}>
                  <div className="text-xs text-gray-500">{p.label}</div>
                  <div className="font-semibold tabular-nums">
                    {p.point ? (
                      <Link to={`/activities/${p.point.activityId}`} className="text-blue-700">
                        {Math.round(p.point.watts)} W
                      </Link>
                    ) : (
                      EMPTY
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
      {stats.weight && (
        <Link to="/weight" aria-label="Weight: open Weight" data-testid="weight-card" className="block rounded-xl border p-3 active:bg-gray-100">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-sm font-semibold">Weight</span>
            <span className="text-xs text-gray-500">Weight ›</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Latest" value={fmt.weight(stats.weight.latestKg)} />
            <StatTile label="7-day average" value={fmt.weight(stats.weight.avg7Kg)} />
            <StatTile label="4-week change" value={signedWeight(stats.weight.change4wKg, fmt)} />
          </div>
        </Link>
      )}
    </div>
  );
}

function signedWeight(kg: number | null, fmt: UnitFormatters): string {
  if (kg === null) return EMPTY;
  const text = fmt.weight(Math.abs(kg));
  if (/^0(\.0+)? /.test(text)) return text;
  return `${kg > 0 ? "+" : "−"}${text}`;
}

function Totals({ totals, fmt }: { totals: PeriodTotals; fmt: UnitFormatters }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Activities" value={totals.count.toLocaleString("en-US")} />
      <StatTile
        label="Distance"
        value={fmt.distance(totals.distanceM)}
        sub={totals.indoorDistanceM > 0 ? `incl. ${fmt.distance(totals.indoorDistanceM)} indoor` : undefined}
      />
      <StatTile label="Elevation" value={fmt.elevation(totals.elevationM)} />
      <StatTile label="Time" value={fmt.duration(totals.movingS)} />
    </div>
  );
}

function BestEfforts({ stats, fmt }: { stats: CyclingStats; fmt: UnitFormatters }) {
  const r = stats.records;
  const rows = [
    { label: "Longest ride", record: r.longestRideM, text: fmt.distance },
    { label: "Biggest climb", record: r.biggestClimbM, text: fmt.elevation },
    { label: "Most elevation", record: r.mostElevationM, text: fmt.elevation },
    ...r.distances.map((d) => ({ label: d.label, record: d.record, text: (s: number) => formatDuration(s, "clock") })),
  ];
  return (
    <Card title="Best efforts">
      <p className="mb-1 text-xs text-gray-500">Outdoor rides only.</p>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} data-record={row.label} className="border-t first:border-t-0">
              <th scope="row" className="py-1 text-left font-normal text-gray-600">
                {row.label}
              </th>
              <td className="py-1 text-right font-medium tabular-nums">
                {row.record ? (
                  <Link to={`/activities/${row.record.activityId}`} className="text-blue-700">
                    {row.text(row.record.value)}
                  </Link>
                ) : (
                  EMPTY
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Strength

const lb = (v: number) => `${Math.round(v).toLocaleString("en-US")} lb`;

function StrengthTab({ nowMs }: { nowMs: number }) {
  const db = useRideDb();
  const load = useCallback(async () => {
    const [settings, sessions] = await Promise.all([db.getAthleteSettings(), db.listSessions()]);
    return { sessions, ...strengthStats(sessions, localToday(new Date(nowMs)), settings.weekStart) };
  }, [db, nowMs]);
  const state = useLoad(load);

  if (state.status !== "ready") return <Status state={state} />;
  return <StrengthView sessions={state.data.sessions} weeks={state.data.weeks} total={state.data.total} />;
}

function StrengthView({ sessions, weeks, total }: { sessions: Session[]; weeks: StrengthWeek[]; total: StrengthTotals }) {
  if (sessions.length === 0) {
    return (
      <div data-ready="stats-strength" className="rounded-xl border border-dashed p-6 text-center text-sm text-gray-600">
        No strength sessions yet.
      </div>
    );
  }
  return (
    <div className="space-y-4" data-ready="stats-strength">
      <Card title="Volume per week (last 12 weeks)">
        <StackedBars
          ariaLabel="Strength volume per week, lb"
          categories={weeks.map((w) => shortDate(w.weekStart))}
          series={[{ name: "Volume (lb)", values: weeks.map((w) => w.volume) }]}
          yFormat={(v) => Math.round(v).toLocaleString("en-US")}
        />
        <table className="mt-2 w-full text-sm" aria-label="Strength per week">
          <thead>
            <tr className="text-xs text-gray-500">
              <th className="text-left font-normal">Week of</th>
              <th className="text-right font-normal">Sessions</th>
              <th className="text-right font-normal">Sets</th>
              <th className="text-right font-normal">Volume</th>
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w) => (
              <tr key={w.weekStart} data-week={w.weekStart} className="border-t tabular-nums">
                <td className="py-1">{shortDate(w.weekStart)}</td>
                <td className="py-1 text-right">{w.sessions}</td>
                <td className="py-1 text-right">{w.sets}</td>
                <td className="py-1 text-right">{lb(w.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="All-time">
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Sessions" value={total.sessions.toLocaleString("en-US")} />
          <StatTile label="Sets" value={total.sets.toLocaleString("en-US")} />
          <StatTile label="Volume" value={lb(total.volume)} />
        </div>
      </Card>
    </div>
  );
}
