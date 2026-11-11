import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { DAY_MS } from "../../metrics/dates";
import { bestPowerCurve, visibleActivities, type PowerCurvePoint } from "../../metrics/display";
import { weightTrend } from "../../metrics/weight";
import type { AthleteSettings, ExternalActivity } from "../../types";
import { INK, LogAxisLine, seriesColor, type ReferenceLine } from "../charts";
import { EmptyState, RangeTabs } from "../components";
import { useUnits } from "../hooks";
import { useRideDb } from "../RideDb";
import { Card } from "../stats/Card";
import { eftpOf } from "../settings/ftp";
import { activityDate, hostTimeZone, localToday, shortDate } from "../stats/time";
import { useLoad } from "../stats/useLoad";

const EMPTY = "—";
const RECENT_DAYS = 90;
const WEIGHT_DAYS = 60;

/** The key-duration table's rows (seconds). */
const KEY_DURATIONS: readonly { durationS: number; label: string }[] = [
  { durationS: 5, label: "5 s" },
  { durationS: 60, label: "1 min" },
  { durationS: 300, label: "5 min" },
  { durationS: 1200, label: "20 min" },
  { durationS: 3600, label: "1 h" },
];

type Mode = "w" | "wkg";

interface PowerData {
  settings: AthleteSettings;
  rides: ExternalActivity[];
  allTime: PowerCurvePoint[];
  recent: PowerCurvePoint[];
  eftpW: number | null;
  avg7Kg: number | null;
}

/** Power curve (AI-652): all-time and 90-day best power per stored duration, eFTP and FTP lines. */
export default function PowerCurve({ now }: { now?: Date }) {
  const db = useRideDb();
  const [fallbackNow] = useState(() => Date.now());
  const nowMs = now?.getTime() ?? fallbackNow;
  const [mode, setMode] = useState<Mode>("w");

  const load = useCallback(async (): Promise<PowerData> => {
    const today = localToday(new Date(nowMs));
    const [settings, rows, weighIns] = await Promise.all([
      db.getAthleteSettings(),
      db.listExternalActivities({}), // all rides, indoor included (decision 13)
      db.listBodyWeights(new Date(nowMs - WEIGHT_DAYS * DAY_MS).toISOString(), new Date(nowMs).toISOString()),
    ]);
    // Hidden rows (Garmin fragments, the Garmin half of a Peloton pair) never hold a best, as on My Stats.
    const rides = visibleActivities(rows);
    const tz = hostTimeZone();
    return {
      settings,
      rides,
      allTime: bestPowerCurve(rides),
      recent: bestPowerCurve(rides, new Date(nowMs - RECENT_DAYS * DAY_MS).toISOString()),
      eftpW: eftpOf(rows, new Date(nowMs)), // every stored ride, as the sync runner computes it
      avg7Kg: weightTrend(
        weighIns.map((w) => ({ measuredAt: w.measuredAt, timezone: tz, weightKg: w.weightKg })),
        today,
      ).avg7Kg,
    };
  }, [db, nowMs]);
  const state = useLoad(load);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Power curve</h1>
        <Link to="/settings" aria-label="Settings" className="p-2 text-xl text-gray-600">
          ⚙
        </Link>
      </div>
      {state.status === "loading" && <p className="text-sm text-gray-500">Loading…</p>}
      {state.status === "error" && <p className="text-sm text-red-700">Couldn't load your power curve: {state.message}</p>}
      {state.status === "ready" && <PowerView data={state.data} mode={mode} setMode={setMode} />}
    </div>
  );
}

function PowerView({ data, mode: requested, setMode }: { data: PowerData; mode: Mode; setMode(m: Mode): void }) {
  const fmt = useUnits(data.settings);
  const kg = data.avg7Kg;
  const mode: Mode = kg === null ? "w" : requested;
  const scale = (w: number) => (mode === "wkg" && kg !== null ? w / kg : w);
  const valueText = (w: number) => (mode === "wkg" ? `${scale(w).toFixed(2)} W/kg` : `${Math.round(w)} W`);

  if (data.allTime.length === 0) {
    return (
      <div data-ready="power">
        <EmptyState />
      </div>
    );
  }

  const referenceLines: ReferenceLine[] = [];
  if (data.eftpW !== null) {
    referenceLines.push({ y: scale(data.eftpW), label: `eFTP ${valueText(data.eftpW)}`, dashed: true, color: INK.secondary, labelPosition: "below" });
  }
  const manual = data.settings.manualFtpW;
  if (typeof manual === "number" && manual > 0) {
    referenceLines.push({ y: scale(manual), label: `FTP ${valueText(manual)} (manual)`, color: INK.primary, labelPosition: "above" });
  }

  const byId = new Map(data.rides.map((r) => [r.id, r]));
  const dateOf = (p: PowerCurvePoint) => {
    const ride = byId.get(p.activityId);
    const d = activityDate({ startedAt: p.startedAt, timezone: ride?.timezone ?? null });
    return d === null ? "" : shortDate(d);
  };
  const find = (points: PowerCurvePoint[], d: number) => points.find((p) => p.durationS === d) ?? null;

  return (
    <div className="space-y-4" data-ready="power">
      <Card title="Best power">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <RangeTabs
            ariaLabel="Power units"
            value={mode}
            onChange={setMode}
            options={[
              { value: "w", label: "W" },
              { value: "wkg", label: "W/kg", disabled: kg === null },
            ]}
          />
          {kg === null ? (
            <span className="text-xs text-gray-500">No weigh-ins in the last 7 days</span>
          ) : (
            mode === "wkg" && <span className="text-xs text-gray-500">at {fmt.weight(kg)} (7-day average)</span>
          )}
        </div>
        <LogAxisLine
          ariaLabel={`Best power per duration, ${mode === "wkg" ? "W/kg" : "W"}`}
          series={[
            { name: "All-time", points: data.allTime.map((p) => ({ x: p.durationS, y: scale(p.watts) })), color: seriesColor(0) },
            { name: "Last 90 days", points: data.recent.map((p) => ({ x: p.durationS, y: scale(p.watts) })), color: seriesColor(1) },
          ]}
          referenceLines={referenceLines}
          yFormat={mode === "wkg" ? (v) => v.toFixed(1) : (v) => String(Math.round(v))}
        />
      </Card>
      <Card title="Key durations">
        <table className="w-full text-sm" aria-label="Key durations">
          <thead>
            <tr className="text-xs text-gray-500">
              <th className="text-left font-normal">Duration</th>
              <th className="text-right font-normal">All-time</th>
              <th className="text-right font-normal">90 days</th>
            </tr>
          </thead>
          <tbody>
            {KEY_DURATIONS.map((k) => (
              <tr key={k.durationS} data-duration={k.label} className="border-t tabular-nums">
                <th scope="row" className="py-1 text-left font-normal text-gray-600">
                  {k.label}
                </th>
                {[find(data.allTime, k.durationS), find(data.recent, k.durationS)].map((p, i) => (
                  <td key={i} className="py-1 text-right">
                    {p ? (
                      <Link to={`/activities/${p.activityId}`} className="text-blue-700">
                        <span className="font-medium">{valueText(p.watts)}</span>{" "}
                        <span className="text-xs text-gray-500">{dateOf(p)}</span>
                      </Link>
                    ) : (
                      EMPTY
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
