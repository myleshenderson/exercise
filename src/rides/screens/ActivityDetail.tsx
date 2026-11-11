import { useCallback, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { DEFAULT_ATHLETE_SETTINGS } from "../../data/DataLayer";
import {
  COGGAN_POWER_ZONES,
  FRIEL_HR_ZONES,
  GARMIN_HR_MAX_ZONES,
  formatDuration,
  isEstimatedTss,
  recordsFromStored,
  storedBestEfforts,
  zoneSeconds,
  type ZoneTable,
  visibleActivities,
} from "../../metrics/display";
import { mToFt } from "../../metrics/units";
import type { ActivityStream, AthleteSettings, ExternalActivity, StreamChannel } from "../../types";
import { LineChart, ZoneBars, seriesColor } from "../charts";
import { SourceBadge, StatTile, TssChip } from "../components";
import { useUnits, type UnitFormatters } from "../hooks";
import { useRideDb } from "../RideDb";
import { Card } from "../stats/Card";
import { useLoad } from "../stats/useLoad";
import { EMPTY_MARK, chartPoints, localDateText, localTimeText, streamMean, streamOf, streamsEndS } from "../feed/format";

interface DetailData {
  activity: ExternalActivity | null;
  streams: ActivityStream[];
  settings: AthleteSettings;
  /** Every outdoor activity, for the all-time records (outdoor rides only). */
  outdoor: ExternalActivity[];
  partner: ExternalActivity | null;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const withUnit = (v: number | null | undefined, unit: string, digits = 0) =>
  finite(v) ? `${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}` : EMPTY_MARK;
const fixed = (v: number | null | undefined, digits: number) => (finite(v) ? v.toFixed(digits) : EMPTY_MARK);

const CHANNEL_LABEL: Partial<Record<StreamChannel, string>> = {
  altitude: "altitude",
  power: "power",
  heart_rate: "heart rate",
  cadence: "cadence",
};

const SOURCE_LINK: Partial<Record<ExternalActivity["source"], { href: (sourceId: string) => string; label: string }>> = {
  garmin: { href: (id) => `https://connect.garmin.com/modern/activity/${encodeURIComponent(id)}`, label: "View on Garmin Connect" },
  peloton: { href: (id) => `https://members.onepeloton.com/profile/workouts/${encodeURIComponent(id)}`, label: "View on Peloton" },
};

/** Activity detail (AI-650): one ride's stats, stream charts, zones, best efforts and links. */
export default function ActivityDetail() {
  const { id = "" } = useParams();
  const db = useRideDb();
  const load = useCallback(async (): Promise<DetailData> => {
    const [activity, settings] = await Promise.all([db.getExternalActivity(id), db.getAthleteSettings()]);
    if (!activity) return { activity: null, streams: [], settings, outdoor: [], partner: null };
    const [streams, outdoor, partner] = await Promise.all([
      db.getActivityStreams(id),
      activity.environment === "outdoor" ? db.listExternalActivities({ environment: "outdoor" }) : Promise.resolve([]),
      activity.pairedActivityId ? db.getExternalActivity(activity.pairedActivityId) : Promise.resolve(null),
    ]);
    return { activity, streams, settings, outdoor, partner };
  }, [db, id]);
  const state = useLoad(load);
  const units = useUnits(state.status === "ready" ? state.data.settings : DEFAULT_ATHLETE_SETTINGS);

  const back = (
    <Link to="/activities" className="text-sm text-blue-700">
      ‹ Activities
    </Link>
  );

  if (state.status === "loading")
    return (
      <div className="space-y-4 p-4">
        {back}
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  if (state.status === "error")
    return (
      <div className="space-y-4 p-4" data-ready="activity">
        {back}
        <p className="text-sm text-red-700">Couldn't load this activity: {state.message}</p>
      </div>
    );

  const { activity: a, streams, settings, outdoor, partner } = state.data;
  if (!a) {
    return (
      <div className="space-y-3 p-4" data-ready="activity">
        <h1 className="text-2xl font-bold">Activity not found</h1>
        <Link to="/activities" className="text-sm text-blue-700 underline">
          Back to Activities
        </Link>
      </div>
    );
  }

  const isOutdoor = a.environment === "outdoor";
  const title = a.title || (isOutdoor ? "Outdoor ride" : "Indoor ride");
  const link = SOURCE_LINK[a.source];

  return (
    <div className="space-y-4 p-4" data-ready={`activity-${a.environment}`}>
      {back}
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <SourceBadge source={a.source} />
          <TssChip tss={a.tss} estimated={isEstimatedTss(a)} />
        </div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <div className="text-sm text-gray-600">
          {localDateText(a.startedAt, a.timezone)} · {localTimeText(a.startedAt, a.timezone)}
        </div>
        {isEstimatedTss(a) && <p className="text-sm text-gray-600">Estimated TSS (no power or HR)</p>}
        {a.pairedActivityId && partner && (
          <p className="text-sm text-gray-600" data-testid="paired-note">
            Paired with the {partner.source === "garmin" ? "Garmin recording" : partner.source === "peloton" ? "Peloton class" : "recording"} that
            started at {localTimeText(partner.startedAt, partner.timezone ?? a.timezone)}
          </p>
        )}
        {link && (
          <a href={link.href(a.sourceId)} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-700 underline">
            {link.label}
          </a>
        )}
      </header>

      <StatsGrid a={a} units={units} />

      {!isOutdoor && <IndoorSummary a={a} streams={streams} units={units} />}

      <StreamCharts streams={streams} channels={isOutdoor ? ["altitude", "power", "heart_rate"] : ["power", "cadence", "heart_rate"]} units={units} />

      <Zones a={a} streams={streams} settings={settings} />

      {isOutdoor && <BestEfforts a={a} outdoor={outdoor} units={units} />}
    </div>
  );
}

function StatsGrid({ a, units }: { a: ExternalActivity; units: UnitFormatters }) {
  const tiles: [string, ReactNode, ReactNode?][] = [
    ["Distance", units.distance(a.distanceM), a.environment === "indoor" && finite(a.distanceM) ? "indoor" : undefined],
    ["Moving time", units.duration(a.movingS ?? a.elapsedS, "clock")],
    ["Elevation", units.elevation(a.elevationGainM)],
    ["Avg HR", withUnit(a.avgHrBpm, "bpm")],
    ["Max HR", withUnit(a.maxHrBpm, "bpm")],
    ["Avg speed", units.speed(a.avgSpeedMps)],
    ["Avg power", withUnit(a.avgPowerW, "W")],
    ["NP", withUnit(a.normalizedPowerW, "W")],
    ["IF", fixed(a.intensityFactor, 2)],
    ["TSS", finite(a.tss) ? Math.round(a.tss).toLocaleString("en-US") : EMPTY_MARK],
    ["Work", withUnit(a.workKj, "kJ")],
    ["Calories", withUnit(a.calories, "kcal")],
  ];
  return (
    <section aria-label="Stats" className="grid grid-cols-3 gap-3 rounded-xl border p-3">
      {tiles.map(([label, value, sub]) => (
        <StatTile key={label} label={label} value={value} sub={sub} />
      ))}
    </section>
  );
}

function IndoorSummary({ a, streams, units }: { a: ExternalActivity; streams: ActivityStream[]; units: UnitFormatters }) {
  const resistance = streamOf(streams, "resistance");
  const avgResistance = resistance ? streamMean(resistance.values) : null;
  const rows: [string, string][] = [
    ["Class", a.title || EMPTY_MARK],
    ["Total output", withUnit(a.workKj, "kJ")],
    ["Avg output", withUnit(a.avgPowerW, "W")],
    ["Max output", withUnit(a.maxPowerW, "W")],
    ["Avg cadence", withUnit(a.avgCadenceRpm, "rpm")],
    ["Avg resistance", finite(avgResistance) ? `${Math.round(avgResistance)}%` : EMPTY_MARK],
    ["Distance", finite(a.distanceM) ? `${units.distance(a.distanceM)} indoor` : EMPTY_MARK],
  ];
  return (
    <Card title="Class">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2" data-testid={`indoor-${label.toLowerCase().replace(/ /g, "-")}`}>
            <dt className="text-gray-500">{label}</dt>
            <dd className="m-0 text-right font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function StreamCharts({ streams, channels, units }: { streams: ActivityStream[]; channels: StreamChannel[]; units: UnitFormatters }) {
  const endMin = Math.max(streamsEndS(streams) / 60, 1);
  const xDomain: [number, number] = [0, endMin];
  const xFormat = (m: number) => `${Math.round(m)}`;
  const imperial = units.units === "imperial";
  const spec: Record<string, { name: string; unit: string; convert?: (v: number) => number }> = {
    altitude: { name: "Altitude", unit: imperial ? "ft" : "m", convert: imperial ? mToFt : undefined },
    power: { name: "Power", unit: "W" },
    heart_rate: { name: "Heart rate", unit: "bpm" },
    cadence: { name: "Cadence", unit: "rpm" },
  };
  return (
    <Card title="Streams">
      <div className="space-y-3">
        {channels.map((ch, i) => {
          const s = streamOf(streams, ch);
          const c = spec[ch];
          if (!s) {
            return (
              <p key={ch} className="text-sm text-gray-500" data-missing-channel={ch}>
                No {CHANNEL_LABEL[ch]} recorded
              </p>
            );
          }
          return (
            <div key={ch} data-channel={ch}>
              <LineChart
                ariaLabel={`${c.name} (${c.unit}) by minute from start`}
                series={[{ name: `${c.name} (${c.unit})`, points: chartPoints(s, 600, c.convert), color: seriesColor(i) }]}
                xDomain={xDomain}
                xFormat={xFormat}
                height={120}
              />
            </div>
          );
        })}
        <p className="text-xs text-gray-500">Minutes from start</p>
      </div>
    </Card>
  );
}

function ZoneBlock({ title, stream, threshold, table }: { title: string; stream: ActivityStream; threshold: number; table: ZoneTable }) {
  const secs = zoneSeconds(stream.values, threshold, table);
  if (!secs) return null;
  return (
    <div data-zone-table={table.name}>
      <h3 className="mb-1 text-xs font-medium text-gray-600">{title}</h3>
      <ZoneBars ariaLabel={`${title}: time in zone`} zones={table.zones.map((z, k) => ({ label: z.label, seconds: secs[k] }))} />
    </div>
  );
}

function Zones({ a, streams, settings }: { a: ExternalActivity; streams: ActivityStream[]; settings: AthleteSettings }) {
  const power = streamOf(streams, "power");
  const hr = streamOf(streams, "heart_rate");
  const hrZone =
    finite(settings.lthrBpm) && settings.lthrBpm > 0
      ? { table: FRIEL_HR_ZONES, threshold: settings.lthrBpm, title: `Heart rate zones (LTHR ${Math.round(settings.lthrBpm)} bpm)` }
      : finite(settings.maxHrBpm) && settings.maxHrBpm > 0
        ? { table: GARMIN_HR_MAX_ZONES, threshold: settings.maxHrBpm, title: `Heart rate zones (max HR ${Math.round(settings.maxHrBpm)} bpm)` }
        : null;
  return (
    <Card title="Zones">
      <div className="space-y-3">
        {!power ? (
          <p className="text-sm text-gray-500">No power recorded</p>
        ) : finite(a.ftpUsedW) && a.ftpUsedW > 0 ? (
          <ZoneBlock title={`Power zones (FTP ${Math.round(a.ftpUsedW)} W)`} stream={power} threshold={a.ftpUsedW} table={COGGAN_POWER_ZONES} />
        ) : (
          <p className="text-sm text-gray-500">No FTP on this ride for power zones</p>
        )}
        {!hr ? (
          <p className="text-sm text-gray-500">No heart rate recorded</p>
        ) : hrZone ? (
          <ZoneBlock title={hrZone.title} stream={hr} threshold={hrZone.threshold} table={hrZone.table} />
        ) : (
          <p className="text-sm text-gray-500">Set threshold or max HR in Settings for HR zones</p>
        )}
      </div>
    </Card>
  );
}

function PrMark() {
  return <span className="ml-1 rounded bg-amber-100 px-1 text-xs font-semibold text-amber-900">PR</span>;
}

function BestEfforts({ a, outdoor, units }: { a: ExternalActivity; outdoor: ExternalActivity[]; units: UnitFormatters }) {
  // The ride itself is part of the records even if the list came back without it.
  // Fragments never hold a record (as on My Stats).
  const rows = visibleActivities(outdoor.some((r) => r.id === a.id) ? outdoor : [...outdoor, a]);
  const records = recordsFromStored(rows);
  const efforts = storedBestEfforts(a.bestEfforts);
  const climbPr = records.biggestClimbM?.activityId === a.id;
  return (
    <Card title="Best efforts">
      <div className="mb-2 text-sm" data-testid="biggest-climb">
        Biggest climb: <span className="font-medium tabular-nums">{units.elevation(a.biggestClimbM)}</span>
        {climbPr && finite(a.biggestClimbM) && <PrMark />}
      </div>
      {efforts.length === 0 ? (
        <p className="text-sm text-gray-500">No best efforts on this ride.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th className="font-normal">Distance</th>
              <th className="font-normal">This ride</th>
              <th className="font-normal">All-time</th>
            </tr>
          </thead>
          <tbody>
            {efforts.map((e) => {
              const record = records.distances.find((d) => d.label === e.label)?.record ?? null;
              const pr = record?.activityId === a.id;
              return (
                <tr key={e.label} data-effort={e.label} data-pr={pr ? "true" : "false"}>
                  <td>{e.label}</td>
                  <td className="tabular-nums">
                    {formatDuration(e.seconds, "clock")}
                    {pr && <PrMark />}
                  </td>
                  <td className="tabular-nums text-gray-600">
                    {record ? (
                      pr ? (
                        formatDuration(record.value, "clock")
                      ) : (
                        <Link to={`/activities/${encodeURIComponent(record.activityId)}`} className="text-blue-700">
                          {formatDuration(record.value, "clock")}
                        </Link>
                      )
                    ) : (
                      EMPTY_MARK
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
