import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { dateFromDayNumber, dayNumber } from "../../metrics/dates";
import { COGGAN_POWER_ZONES, rampRate, visibleActivities } from "../../metrics/display";
import type { AthleteSettings, DailyTrainingLoad, ExternalActivity } from "../../types";
import { BandedArea, INK, LineChart, StackedBars, TSB_CHART_BANDS, seriesColor, zoneColors } from "../charts";
import { EmptyState } from "../components";
import { useRideDb } from "../RideDb";
import { TSS_SOURCES, formReadout, loadZoneWeeks, weeklyTssBySource, type ZoneWeek } from "../stats/training";
import { activityDate, addDays, lastWeekStarts, localToday, shortDate, windowStartIso } from "../stats/time";
import { Card } from "../stats/Card";
import { useLoad } from "../stats/useLoad";

const WEEKS = 12;
const ZONE_WEEKS = 6;
const RAMP_CAPTION = "+4 to +8 a week is a steady build";

/** "+5.2" / "−3.1" / "0.0". */
function signed(v: number, digits = 1): string {
  const text = Math.abs(v).toFixed(digits);
  if (Number(text) === 0) return text;
  return `${v > 0 ? "+" : "−"}${text}`;
}

interface TrainingData {
  settings: AthleteSettings;
  today: string;
  rows: DailyTrainingLoad[];
  /** Visible rides of the last `ZONE_WEEKS` weeks, for the time-in-zone bars. */
  zoneRides: ExternalActivity[];
  zoneWeeks: string[];
}

/** Training (AI-651): weekly TSS, fitness and fatigue, form, ramp rate and time in power zone. */
export default function Training({ now }: { now?: Date }) {
  const db = useRideDb();
  const [fallbackNow] = useState(() => Date.now());
  const nowMs = now?.getTime() ?? fallbackNow;

  const load = useCallback(async (): Promise<TrainingData> => {
    const today = localToday(new Date(nowMs));
    const settings = await db.getAthleteSettings();
    const zoneWeeks = lastWeekStarts(today, settings.weekStart, ZONE_WEEKS);
    const [rows, candidates] = await Promise.all([
      db.listDailyTrainingLoad(addDays(today, -7 * WEEKS), today),
      db.listExternalActivities({ from: windowStartIso(zoneWeeks[0]), to: new Date(nowMs).toISOString() }),
    ]);
    const zoneRides = visibleActivities(candidates).filter((a) => {
      const d = activityDate(a);
      return d !== null && d >= zoneWeeks[0] && d <= today;
    });
    return { settings, today, rows, zoneRides, zoneWeeks };
  }, [db, nowMs]);
  const state = useLoad(load);

  // Streams load after the rest of the page has rendered.
  const [zones, setZones] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; weeks: ZoneWeek[] }>({
    status: "loading",
  });
  const base = state.status === "ready" ? state.data : null;
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    setZones({ status: "loading" });
    loadZoneWeeks(db, base.zoneRides, base.zoneWeeks, base.settings.weekStart).then(
      (weeks) => !cancelled && setZones({ status: "ready", weeks }),
      (e: unknown) => !cancelled && setZones({ status: "error", message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [db, base]);

  const header = (
    <div className="flex items-center justify-between">
      <h1 className="text-2xl font-bold">Training</h1>
      <Link to="/stats" className="text-sm text-blue-700">
        My Stats ›
      </Link>
    </div>
  );

  if (state.status === "loading") return <div className="space-y-4 p-4">{header}<p className="text-sm text-gray-500">Loading…</p></div>;
  if (state.status === "error")
    return (
      <div className="space-y-4 p-4">
        {header}
        <p className="text-sm text-red-700">Couldn't load your training: {state.message}</p>
      </div>
    );

  const { rows, today, settings } = state.data;
  const empty = rows.every((r) => !r.tssTotal && !r.ctl && !r.atl);
  if (empty) {
    return (
      <div className="space-y-4 p-4" data-ready="training">
        {header}
        <EmptyState />
      </div>
    );
  }

  const weeks = lastWeekStarts(today, settings.weekStart, WEEKS);
  const bySource = weeklyTssBySource(rows, weeks, settings.weekStart);
  const sources = TSS_SOURCES.map((s, i) => ({ ...s, color: seriesColor(i) })).filter((s) => bySource[s.key].some((v) => v > 0));
  const form = formReadout(rows, today);
  const ramp = rampRate(rows, today);
  const points = rows.flatMap((r) => {
    const x = dayNumber(r.date);
    return x === null ? [] : [{ x, r }];
  });
  const xTicks = weeks.filter((_, i) => i % 3 === 0).map((w) => dayNumber(w)!);
  const xFormat = (x: number) => shortDate(dateFromDayNumber(x));
  const tsbs = points.map((p) => p.r.tsb).filter(Number.isFinite);
  const tsbDomain: [number, number] = [Math.min(-40, Math.floor(Math.min(...tsbs)) - 5), Math.max(35, Math.ceil(Math.max(...tsbs)) + 5)];
  const zonesReady = zones.status === "ready";

  return (
    <div className="space-y-4 p-4" data-ready={zonesReady || zones.status === "error" ? "training" : undefined}>
      {header}

      <Card title="Weekly TSS">
        <StackedBars
          ariaLabel="Weekly TSS by source, last 12 weeks"
          categories={weeks.map(shortDate)}
          series={sources.map((s) => ({ name: s.label, values: bySource[s.key], color: s.color }))}
        />
      </Card>

      <Card title="Fitness and fatigue">
        <LineChart
          ariaLabel="Fitness (CTL) and fatigue (ATL), last 12 weeks"
          series={[
            { name: "Fitness (CTL)", points: points.map((p) => ({ x: p.x, y: p.r.ctl })) },
            { name: "Fatigue (ATL)", points: points.map((p) => ({ x: p.x, y: p.r.atl })) },
          ]}
          xTicks={xTicks}
          xFormat={xFormat}
        />
      </Card>

      <Card title="Form">
        {form && (
          <p className="mb-2 text-sm" data-testid="form-readout" data-band={form.band}>
            <span className="text-gray-600">{form.isToday ? "Today" : `On ${shortDate(form.date)}`}: </span>
            <span className="text-lg font-semibold tabular-nums">{signed(form.tsb)}</span>{" "}
            <span className="font-medium">{form.bandLabel}</span>
          </p>
        )}
        <BandedArea
          ariaLabel="Form (TSB), last 12 weeks, over the form bands"
          series={[{ name: "Form (TSB)", points: points.map((p) => ({ x: p.x, y: p.r.tsb })), color: INK.primary }]}
          bands={TSB_CHART_BANDS}
          yDomain={tsbDomain}
          yTicks={[-30, -10, 5, 25]}
          xTicks={xTicks}
          xFormat={xFormat}
        />
      </Card>

      <Card title="Ramp rate">
        <p className="text-lg font-semibold tabular-nums" data-testid="ramp-rate">
          {ramp === null ? "—" : `${signed(ramp)} CTL/week`}
        </p>
        <p className="text-xs text-gray-500">{RAMP_CAPTION}</p>
      </Card>

      <Card title="Time in power zone (last 6 weeks)">
        {zones.status === "loading" && <p className="text-sm text-gray-500">Loading ride streams…</p>}
        {zones.status === "error" && <p className="text-sm text-red-700">Couldn't load ride streams: {zones.message}</p>}
        {zones.status === "ready" && <ZoneChart weeks={zones.weeks} />}
      </Card>
    </div>
  );
}

function ZoneChart({ weeks }: { weeks: ZoneWeek[] }) {
  const colors = zoneColors(COGGAN_POWER_ZONES.zones.length);
  return (
    <StackedBars
      ariaLabel="Share of riding time in each power zone per week, last 6 weeks"
      percent
      categories={weeks.map((w) => shortDate(w.weekStart))}
      series={[
        ...COGGAN_POWER_ZONES.zones.map((z, i) => ({ name: z.label, values: weeks.map((w) => w.zoneS[i]), color: colors[i] })),
        { name: "No power", values: weeks.map((w) => w.noPowerS), color: INK.neutral },
      ]}
    />
  );
}
