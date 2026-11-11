import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { dayNumber, DAY_MS, localDate } from "../../metrics/dates";
import { kgToLb } from "../../metrics/units";
import { W_PER_KG_BANDS, weightRatePerWeek, weightSeries, wPerKgBand, type WeightDay } from "../../metrics/display";
import { weightTrend, wPerKg, type WeighIn } from "../../metrics/weight";
import type { AthleteSettings, BodyWeight } from "../../types";
import { LineChart, seriesColor } from "../charts";
import { RangeTabs, StatTile } from "../components";
import { useUnits, type UnitFormatters } from "../hooks";
import { useRideDb } from "../RideDb";
import { eftpOf, ftpInUse } from "../settings/ftp";
import { Card } from "../stats/Card";
import { addDays, hostTimeZone, localToday, shortDate, windowStartIso } from "../stats/time";
import { useLoad } from "../stats/useLoad";

const EMPTY = "—";

type Range = "30d" | "90d" | "1y" | "all";

const RANGES: readonly { value: Range; label: string; days: number | null }[] = [
  { value: "30d", label: "30 d", days: 30 },
  { value: "90d", label: "90 d", days: 90 },
  { value: "1y", label: "1 y", days: 365 },
  { value: "all", label: "All", days: null },
];

interface WeightData {
  settings: AthleteSettings;
  today: string;
  weighIns: WeighIn[];
  latest: BodyWeight | null;
  eftpW: number | null;
}

/** "+1.2 lb" / "−0.8 kg" / "0.0 lb". */
function signedWeight(kg: number | null, fmt: UnitFormatters, suffix = ""): string {
  if (kg === null) return EMPTY;
  const text = fmt.weight(Math.abs(kg));
  if (/^0(\.0+)? /.test(text)) return `${text}${suffix}`;
  return `${kg > 0 ? "+" : "−"}${text}${suffix}`;
}

/** Weight (AI-652): weigh-ins, 7-day mean, trend readouts and W/kg at the FTP in use. */
export default function Weight({ now }: { now?: Date }) {
  const db = useRideDb();
  const [fallbackNow] = useState(() => Date.now());
  const nowMs = now?.getTime() ?? fallbackNow;
  const [range, setRange] = useState<Range>("90d");

  const load = useCallback(async (): Promise<WeightData> => {
    const today = localToday(new Date(nowMs));
    const nowIso = new Date(nowMs).toISOString();
    const [settings, rows, rides] = await Promise.all([
      db.getAthleteSettings(),
      db.listBodyWeights("1970-01-01T00:00:00.000Z", nowIso),
      // eFTP looks back 90 days (decision 10); a day of slack for time zones.
      db.listExternalActivities({ from: windowStartIso(addDays(today, -91)), to: nowIso }),
    ]);
    const tz = hostTimeZone();
    return {
      settings,
      today,
      weighIns: rows.map((w) => ({ measuredAt: w.measuredAt, timezone: tz, weightKg: w.weightKg })),
      latest: rows.length ? rows.reduce((a, b) => (Date.parse(b.measuredAt) >= Date.parse(a.measuredAt) ? b : a)) : null,
      eftpW: eftpOf(rides, new Date(nowMs)),
    };
  }, [db, nowMs]);
  const state = useLoad(load);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Weight</h1>
        <Link to="/settings" aria-label="Settings" className="p-2 text-xl text-gray-600">
          ⚙
        </Link>
      </div>
      {state.status === "loading" && <p className="text-sm text-gray-500">Loading…</p>}
      {state.status === "error" && <p className="text-sm text-red-700">Couldn't load your weight: {state.message}</p>}
      {state.status === "ready" && <WeightView data={state.data} range={range} setRange={setRange} />}
    </div>
  );
}

function WeightView({ data, range, setRange }: { data: WeightData; range: Range; setRange(r: Range): void }) {
  const fmt = useUnits(data.settings);
  const trend = weightTrend(data.weighIns, data.today);
  const rate = weightRatePerWeek(trend);
  const ftp = ftpInUse(data.settings, data.eftpW);
  const wkg = wPerKg(ftp.ftpW, trend.avg7Kg);
  const band = wPerKgBand(wkg);
  const bandLabel = band === null ? null : W_PER_KG_BANDS.find((b) => b.band === band)?.label;

  const latestDate = data.latest ? localDate(data.latest.measuredAt, hostTimeZone()) : null;
  const series = weightSeries(data.weighIns);
  const days = RANGES.find((r) => r.value === range)?.days ?? null;
  const todayN = dayNumber(data.today) ?? 0;
  const shown: WeightDay[] = days === null ? series : series.filter((d) => (dayNumber(d.date) ?? 0) > todayN - days);
  // Display values in the user's units, so the axis reads lb or kg.
  const toUnit = (kg: number) => (fmt.units === "imperial" ? kgToLb(kg) : kg);
  const unit = fmt.units === "imperial" ? "lb" : "kg";

  return (
    <div className="space-y-4" data-ready="weight">
      <Card title="Readouts">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile
            label="Latest weigh-in"
            value={fmt.weight(data.latest?.weightKg ?? null)}
            sub={latestDate ? shortDate(latestDate) : undefined}
          />
          <StatTile label="7-day average" value={fmt.weight(trend.avg7Kg)} />
          <StatTile label="4-week change" value={signedWeight(trend.change4wKg, fmt)} />
          <StatTile label="Rate" value={signedWeight(rate, fmt, " / wk")} />
          <StatTile
            label="W/kg"
            value={wkg === null ? EMPTY : wkg.toFixed(2)}
            sub={
              wkg === null
                ? ftp.ftpW === null
                  ? "No FTP or eFTP"
                  : "No weigh-ins in the last 7 days"
                : `${bandLabel} · FTP ${Math.round(ftp.ftpW!)} W${ftp.manual ? " (manual)" : " (eFTP)"}`
            }
          />
        </div>
      </Card>
      <Card title="Trend">
        <div className="mb-2">
          <RangeTabs ariaLabel="Range" options={RANGES} value={range} onChange={setRange} />
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-gray-500">No weigh-ins in this range.</p>
        ) : (
          <LineChart
            ariaLabel={`Body weight, ${unit}`}
            series={[
              {
                name: "Weigh-ins",
                dots: true,
                color: seriesColor(0),
                points: shown.flatMap((d) => d.weighInsKg.map((kg) => ({ x: dayNumber(d.date)! * DAY_MS, y: toUnit(kg) }))),
              },
              {
                name: "7-day mean",
                color: seriesColor(1),
                points: shown.map((d) => ({ x: dayNumber(d.date)! * DAY_MS, y: toUnit(d.avg7Kg) })),
              },
            ]}
            xFormat={(x) => shortDate(new Date(x).toISOString().slice(0, 10))}
            yFormat={(v) => v.toFixed(1)}
          />
        )}
      </Card>
    </div>
  );
}
