/**
 * The seven ride analytics MCP tools (AI-654), shared by both backends: the Supabase server
 * (`api/mcp.ts`) supplies reads over a client scoped to the caller's token, Starkeep
 * (`starkeep/handlers.ts`) its request's DataLayer. Same code, so the same rows give the same
 * text on both. Every number comes from `src/metrics`; nothing here imports `api/`, `src/data/`
 * or Supabase.
 *
 * Output conventions: JSON through `toolResult`; metric fields carry a unit suffix and an
 * imperial twin (`distance_m`/`distance_mi`, `elevation_gain_m`/`elevation_gain_ft`,
 * `weight_kg`/`weight_lb`); values computed here are rounded to one decimal, stored values and
 * ISO timestamps are passed through as stored. An account with nothing stored gets empty arrays
 * and nulls, never an error (only `get_activity` reports "Activity not found").
 *
 * "Today" is the UTC day: the server knows no time zone for the caller. An activity's own day is
 * its local day in its stored time zone, as `daily_training_load` files it.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { catchToolError, invalidIdError, toolError, toolResult } from "../../mcp/format.js";
import type { McpToolHandlers } from "../../mcp/handlers.js";
import type { ToolInput } from "../../mcp/tools.js";
import {
  bestPowerCurve,
  COGGAN_POWER_ZONES,
  dateFromDayNumber,
  dayNumber,
  eftp,
  EFTP_WINDOW_DAYS,
  FRIEL_HR_ZONES,
  GARMIN_HR_MAX_ZONES,
  isEstimatedTss,
  kgToLb,
  localDate,
  mToFt,
  mToMi,
  periodTotals,
  rampRate,
  recordsFromStored,
  storedBestEfforts,
  tsbBand,
  visibleActivities,
  weekStartOf,
  weightRatePerWeek,
  weightTrend,
  wPerKg,
  wPerKgBand,
  zoneSeconds,
  type PeriodTotals,
  type PowerCurvePoint,
  type RecordValue,
  type VisibleActivity,
  type ZoneTable,
} from "../../metrics/index.js";
import { resolveFtp } from "../../sync/ftp.js";
import { mmp20 } from "../../sync/recompute.js";
import type { ActivityStream, AthleteSettings, BodyWeight, ExternalActivity, FtpHistoryEntry } from "../../types.js";
import type { RideReads } from "./reads.js";

export const RIDE_TOOL_NAMES = [
  "list_activities",
  "get_activity",
  "activity_stats",
  "training_load",
  "power_curve",
  "weight_history",
  "sync_status",
] as const;

export type RideToolName = (typeof RIDE_TOOL_NAMES)[number];
export type RideToolHandlers = Pick<McpToolHandlers, RideToolName>;

/**
 * Runs `run` with the caller's reads. A backend that must first resolve who is calling (the
 * Supabase server) returns its own tool error instead of calling `run`.
 */
export type WithRideReads = (run: (reads: RideReads) => Promise<CallToolResult>) => Promise<CallToolResult>;

export interface RideToolOptions {
  /** The clock; tests pin it. */
  now?: () => Date;
}

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_LOAD_DAYS = 90;
const DEFAULT_WEIGHT_DAYS = 90;
const WEEKLY_TSS_WEEKS = 12;
/** The power-bests strip of `activity_stats`: 5 s, 1 min, 5 min, 20 min, 1 h. */
const POWER_BEST_DURATIONS_S = [5, 60, 300, 1200, 3600] as const;
/** Sources `daily_training_load.tss_by_source` stores, in stack order. */
const LOAD_SOURCES = ["garmin", "peloton", "strava_export", "strength"] as const;

// ---------------------------------------------------------------------------
// Small helpers

/** One decimal; `null` for a missing or non-finite value. `-0` prints as `0` in JSON. */
function r1(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

const convert = (v: number | null | undefined, f: (x: number) => number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? r1(f(v)) : null;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function utcToday(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return dateFromDayNumber(dayNumber(date)! + days);
}

const startOfDay = (date: string) => `${date}T00:00:00.000Z`;
const endOfDay = (date: string) => `${date}T23:59:59.999Z`;
const minDate = (a: string, b: string) => (a < b ? a : b);

/** The local day an activity happened on, in its own time zone. */
function activityDate(a: Pick<ExternalActivity, "startedAt" | "timezone">): string | null {
  return localDate(a.startedAt, a.timezone ?? undefined);
}

class InputError extends Error {}

function parseDate(tool: string, param: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!DATE_ONLY.test(value) || dayNumber(value) === null) {
    throw new InputError(`${tool} failed: ${param} must be a date (YYYY-MM-DD), got "${value}".`);
  }
  return value;
}

function intParam(tool: string, param: string, value: number | undefined, min: number, max: number, fallback: number): number;
function intParam(tool: string, param: string, value: number | undefined, min: number, max: number): number | undefined;
function intParam(tool: string, param: string, value: number | undefined, min: number, max: number, fallback?: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${tool} failed: ${param} must be an integer between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

/** The tool's own error wrapping: bad input is the message as is, anything thrown is "<tool> failed: …". */
function guarded(tool: RideToolName, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  return catchToolError(tool, async () => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof InputError) return toolError(e.message);
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Activities

function pairedSummary(a: ExternalActivity | null) {
  return a ? { id: a.id, source: a.source, started_at: a.startedAt, title: a.title } : null;
}

/** The fields `list_activities` prints for a row (and `get_activity` starts from). */
function activityRow(a: ExternalActivity) {
  return {
    id: a.id,
    source: a.source,
    started_at: a.startedAt,
    timezone: a.timezone,
    title: a.title,
    environment: a.environment,
    sub_type: a.subType,
    elapsed_s: a.elapsedS,
    moving_s: a.movingS,
    distance_m: a.distanceM,
    distance_mi: convert(a.distanceM, mToMi),
    elevation_gain_m: a.elevationGainM,
    elevation_gain_ft: convert(a.elevationGainM, mToFt),
    avg_power_w: a.avgPowerW,
    normalized_power_w: a.normalizedPowerW,
    intensity_factor: a.intensityFactor,
    tss: a.tss,
    tss_estimated: isEstimatedTss(a),
    work_kj: a.workKj,
    avg_hr_bpm: a.avgHrBpm,
  };
}

function listRow(a: VisibleActivity) {
  return { ...activityRow(a), paired_with: pairedSummary(a.pairedWith) };
}

function zoneRows(table: ZoneTable, seconds: number[] | null) {
  return seconds === null ? null : table.zones.map((z, k) => ({ zone: z.label, seconds: seconds[k] }));
}

function streamValues(streams: readonly ActivityStream[], channel: ActivityStream["channel"]) {
  return streams.find((s) => s.channel === channel)?.values ?? null;
}

/** HR zones against LTHR (Friel), else max HR (Garmin), else none. */
function hrZones(hr: ActivityStream["values"] | null, settings: AthleteSettings) {
  const basis =
    typeof settings.lthrBpm === "number" && settings.lthrBpm > 0
      ? { name: "lthr" as const, threshold: settings.lthrBpm, table: FRIEL_HR_ZONES }
      : typeof settings.maxHrBpm === "number" && settings.maxHrBpm > 0
        ? { name: "max_hr" as const, threshold: settings.maxHrBpm, table: GARMIN_HR_MAX_ZONES }
        : null;
  if (!basis || !hr) return { basis: null, zones: null };
  return { basis: basis.name, zones: zoneRows(basis.table, zoneSeconds(hr, basis.threshold, basis.table)) };
}

// ---------------------------------------------------------------------------
// FTP and weight shared by power_curve and weight_history

/**
 * Decision 10, resolved as sync resolves it for a ride starting now (`resolveFtp`): the manual
 * FTP when set, else the latest FTP history entry in force (its source, e.g. `peloton_test`),
 * else eFTP (`estimated`; 0.95 × the best 20-minute power of the 90 days ending today).
 */
function ftpNow(
  activities: readonly ExternalActivity[],
  settings: AthleteSettings,
  history: readonly FtpHistoryEntry[],
  today: string,
) {
  const rides = activities.map((a) => ({ startedAt: a.startedAt, mmp20minW: mmp20(a.powerCurve) }));
  const resolved = resolveFtp(endOfDay(today), { settings, ftpHistory: history, priorRides: rides });
  return { eftpW: eftp(rides, today), ftpW: resolved.ftpW, source: resolved.source };
}

function weighIns(rows: readonly BodyWeight[]) {
  return rows.map((w) => ({ measuredAt: w.measuredAt, weightKg: w.weightKg }));
}

// ---------------------------------------------------------------------------
// activity_stats

function totalsRow(from: string | null, to: string, t: PeriodTotals) {
  return {
    from,
    to,
    count: t.count,
    moving_s: r1(t.movingS),
    distance_m: r1(t.distanceM),
    distance_mi: convert(t.distanceM, mToMi),
    indoor_distance_m: r1(t.indoorDistanceM),
    indoor_distance_mi: convert(t.indoorDistanceM, mToMi),
    elevation_gain_m: r1(t.elevationM),
    elevation_gain_ft: convert(t.elevationM, mToFt),
    tss: r1(t.tss),
    work_kj: r1(t.workKj),
  };
}

/** `as_of`'s day of the year, in the previous year (clamped to its last day). */
function previousYearCutoff(asOf: string): string {
  const year = Number(asOf.slice(0, 4));
  const doy = dayNumber(asOf)! - dayNumber(`${year}-01-01`)!;
  const prevStart = dayNumber(`${String(year - 1).padStart(4, "0")}-01-01`)!;
  const prevEnd = dayNumber(`${String(year - 1).padStart(4, "0")}-12-31`)!;
  return dateFromDayNumber(Math.min(prevStart + doy, prevEnd));
}

// ---------------------------------------------------------------------------
// The handlers

export function createRideToolHandlers(withReads: WithRideReads, opts: RideToolOptions = {}): RideToolHandlers {
  const clock = opts.now ?? (() => new Date());

  function tool<K extends RideToolName>(
    name: K,
    body: (reads: RideReads, input: ToolInput<K>, today: string) => Promise<CallToolResult>,
  ): RideToolHandlers[K] {
    const handler = (input: ToolInput<K>) =>
      withReads((reads) => guarded(name, () => body(reads, input, utcToday(clock()))));
    return handler as RideToolHandlers[K];
  }

  return {
    list_activities: tool("list_activities", async (reads, input) => {
      const start = parseDate("list_activities", "start_date", input.start_date);
      const end = parseDate("list_activities", "end_date", input.end_date);
      const limit = intParam("list_activities", "limit", input.limit, 1, 500, DEFAULT_LIST_LIMIT);
      // Read a day either side and every source and environment, so a pair whose two
      // recordings straddle a bound or a filter still collapses; then cut to the request.
      const rows = await reads.listExternalActivities({
        ...(start !== undefined ? { from: startOfDay(addDays(start, -1)) } : {}),
        ...(end !== undefined ? { to: endOfDay(addDays(end, 1)) } : {}),
      });
      const fromMs = start === undefined ? -Infinity : Date.parse(startOfDay(start));
      const toMs = end === undefined ? Infinity : Date.parse(endOfDay(end));
      const shown = visibleActivities(rows).filter((a) => {
        const t = Date.parse(a.startedAt);
        return (
          t >= fromMs &&
          t <= toMs &&
          (input.environment === undefined || a.environment === input.environment) &&
          (input.source === undefined || a.source === input.source)
        );
      });
      return toolResult({ activities: shown.slice(0, limit).map(listRow) });
    }),

    get_activity: tool("get_activity", async (reads, { activity_id }) => {
      const invalid = invalidIdError("get_activity", "activity_id", activity_id);
      if (invalid) return invalid;
      const activity = await reads.getExternalActivity(activity_id);
      if (!activity) return toolError("Activity not found");

      const efforts = storedBestEfforts(activity.bestEfforts);
      const [streams, settings, all, partner] = await Promise.all([
        reads.getActivityStreams(activity.id),
        reads.getAthleteSettings(),
        // The records are only compared with this ride's own efforts.
        efforts.length > 0 ? reads.listExternalActivities({}) : Promise.resolve([]),
        activity.pairedActivityId ? reads.getExternalActivity(activity.pairedActivityId) : Promise.resolve(null),
      ]);

      const power = streamValues(streams, "power");
      const powerZones = power ? zoneRows(COGGAN_POWER_ZONES, zoneSeconds(power, activity.ftpUsedW, COGGAN_POWER_ZONES)) : null;
      const hr = hrZones(streamValues(streams, "heart_rate"), settings);

      const records = recordsFromStored(visibleActivities(all));
      const bestEfforts = efforts.map((e) => {
        const record = records.distances.find((d) => d.label === e.label)?.record ?? null;
        return {
          label: e.label,
          distance_m: e.distanceM,
          distance_mi: convert(e.distanceM, mToMi),
          seconds: e.seconds,
          record_seconds: record?.value ?? null,
          is_pr: activity.environment === "outdoor" && record !== null && record.activityId === activity.id,
        };
      });

      return toolResult({
        ...activityRow(activity),
        max_power_w: activity.maxPowerW,
        avg_speed_mps: activity.avgSpeedMps,
        max_speed_mps: activity.maxSpeedMps,
        max_hr_bpm: activity.maxHrBpm,
        avg_cadence_rpm: activity.avgCadenceRpm,
        calories: activity.calories,
        tss_source: activity.tssSource,
        ftp_used_w: activity.ftpUsedW,
        ftp_source: activity.ftpSource,
        power_zones_s: powerZones,
        hr_zone_basis: hr.zones === null ? null : hr.basis,
        hr_zones_s: hr.zones,
        best_efforts: bestEfforts,
        biggest_climb_m: activity.biggestClimbM,
        biggest_climb_ft: convert(activity.biggestClimbM, mToFt),
        paired_with: pairedSummary(partner),
      });
    }),

    activity_stats: tool("activity_stats", async (reads, input, today) => {
      const asOf = parseDate("activity_stats", "as_of", input.as_of) ?? today;
      // A day past as_of covers every time zone's local as_of; later rows are cut per row below.
      const all = await reads.listExternalActivities({ to: endOfDay(addDays(asOf, 1)) });
      const dated = visibleActivities(all)
        .map((a) => ({ a, date: activityDate(a) }))
        .filter((x): x is { a: VisibleActivity; date: string } => x.date !== null && x.date <= asOf);
      const between = (from: string) => dated.filter(({ date }) => date >= from).map(({ a }) => a);
      const year = asOf.slice(0, 4);
      const prevFrom = `${String(Number(year) - 1).padStart(4, "0")}-01-01`;
      const prevTo = previousYearCutoff(asOf);
      const fourWeeksFrom = addDays(asOf, -27);
      const upToAsOf = dated.map(({ a }) => a);
      const byId = new Map(upToAsOf.map((a) => [a.id, a]));
      const startedAt = (r: RecordValue | null) => (r ? (byId.get(r.activityId)?.startedAt ?? null) : null);

      const records = recordsFromStored(upToAsOf);
      const metres = (label: string, r: RecordValue | null) => ({
        label,
        distance_m: r?.value ?? null,
        distance_mi: convert(r?.value, mToMi),
        activity_id: r?.activityId ?? null,
        started_at: startedAt(r),
      });
      const climb = (label: string, r: RecordValue | null) => ({
        label,
        elevation_m: r?.value ?? null,
        elevation_ft: convert(r?.value, mToFt),
        activity_id: r?.activityId ?? null,
        started_at: startedAt(r),
      });
      const bestEfforts = [
        metres("Longest ride", records.longestRideM),
        climb("Biggest climb", records.biggestClimbM),
        climb("Most elevation", records.mostElevationM),
        ...records.distances.map((d) => ({
          label: d.label,
          distance_m: d.distanceM,
          distance_mi: convert(d.distanceM, mToMi),
          seconds: d.record?.value ?? null,
          activity_id: d.record?.activityId ?? null,
          started_at: startedAt(d.record),
        })),
      ];

      const curve = bestPowerCurve(upToAsOf);
      const powerBests = POWER_BEST_DURATIONS_S.map((seconds) => {
        const p: PowerCurvePoint | undefined = curve.find((c) => c.durationS === seconds);
        return { seconds, watts: p?.watts ?? null, activity_id: p?.activityId ?? null, started_at: p?.startedAt ?? null };
      });

      return toolResult({
        as_of: asOf,
        last_4_weeks: totalsRow(fourWeeksFrom, asOf, periodTotals(between(fourWeeksFrom))),
        year_to_date: totalsRow(`${year}-01-01`, asOf, periodTotals(between(`${year}-01-01`))),
        previous_year_to_date: totalsRow(
          prevFrom,
          prevTo,
          periodTotals(dated.filter(({ date }) => date >= prevFrom && date <= prevTo).map(({ a }) => a)),
        ),
        all_time: totalsRow(null, asOf, periodTotals(upToAsOf)),
        best_efforts: bestEfforts,
        power_bests: powerBests,
      });
    }),

    training_load: tool("training_load", async (reads, input, today) => {
      const days = intParam("training_load", "days", input.days, 7, 730, DEFAULT_LOAD_DAYS);
      const settings = await reads.getAthleteSettings();
      const daysFrom = addDays(today, -(days - 1));
      const currentWeek = weekStartOf(today, settings.weekStart);
      const weeks = Array.from({ length: WEEKLY_TSS_WEEKS }, (_, i) => addDays(currentWeek, -7 * (WEEKLY_TSS_WEEKS - 1 - i)));
      // A week more than either window, for the ramp rate's CTL a week back.
      const rows = await reads.listDailyTrainingLoad(addDays(minDate(daysFrom, weeks[0]), -7), today);

      let latest: (typeof rows)[number] | undefined;
      for (const r of rows) if (r.date <= today && Number.isFinite(r.tsb) && (!latest || r.date > latest.date)) latest = r;
      const ramp = latest ? rampRate(rows, latest.date) : null;

      const weekIndex = new Map(weeks.map((w, i) => [w, i]));
      const weekly = weeks.map((w) => ({ week_start: w, total: 0, by_source: Object.fromEntries(LOAD_SOURCES.map((s) => [s, 0])) }));
      const hasRow = weeks.map(() => false);
      for (const r of rows) {
        const k = weekIndex.get(weekStartOf(r.date, settings.weekStart));
        if (k === undefined || r.date > today) continue;
        hasRow[k] = true;
        for (const s of LOAD_SOURCES) {
          const v = r.tssBySource?.[s];
          if (typeof v === "number" && Number.isFinite(v)) {
            weekly[k].by_source[s] += v;
            weekly[k].total += v;
          }
        }
      }
      // Weeks before the first stored day are not shown (none at all on an empty account).
      const firstWeek = hasRow.indexOf(true);

      return toolResult({
        days: rows
          .filter((r) => r.date >= daysFrom && r.date <= today)
          .map((r) => ({
            date: r.date,
            tss: r1(r.tssTotal),
            tss_by_source: Object.fromEntries(Object.entries(r.tssBySource ?? {}).map(([s, v]) => [s, r1(v)])),
            ctl: r1(r.ctl),
            atl: r1(r.atl),
            tsb: r1(r.tsb),
          })),
        today: latest
          ? {
              date: latest.date,
              is_today: latest.date === today,
              ctl: r1(latest.ctl),
              atl: r1(latest.atl),
              tsb: r1(latest.tsb),
              tsb_band: tsbBand(latest.tsb),
            }
          : null,
        ramp_rate: r1(ramp),
        week_start: settings.weekStart,
        weekly_tss:
          firstWeek === -1
            ? []
            : weekly.slice(firstWeek).map((w) => ({
                week_start: w.week_start,
                total: r1(w.total),
                by_source: Object.fromEntries(Object.entries(w.by_source).map(([s, v]) => [s, r1(v)])),
              })),
      });
    }),

    power_curve: tool("power_curve", async (reads, input, today) => {
      const windowDays = intParam("power_curve", "window_days", input.window_days, 1, 3650);
      const [all, settings, history, weights] = await Promise.all([
        reads.listExternalActivities({}),
        reads.getAthleteSettings(),
        reads.listFtpHistory(),
        reads.listBodyWeights(startOfDay(addDays(today, -6)), endOfDay(today)),
      ]);
      const visible = visibleActivities(all);
      const kg7d = weightTrend(weighIns(weights), today).avg7Kg;
      const ftp = ftpNow(visible, settings, history, today);
      const fromIso = windowDays === undefined ? undefined : startOfDay(addDays(today, -(windowDays - 1)));
      return toolResult({
        window_days: windowDays ?? null,
        points: bestPowerCurve(visible, fromIso).map((p) => ({
          seconds: p.durationS,
          watts: p.watts,
          w_per_kg: r1(wPerKg(p.watts, kg7d)),
          activity_id: p.activityId,
          started_at: p.startedAt,
        })),
        eftp_w: r1(ftp.eftpW),
        ftp_w: r1(ftp.ftpW),
        ftp_source: ftp.source,
        weight_kg_7d: r1(kg7d),
        weight_lb_7d: convert(kg7d, kgToLb),
      });
    }),

    weight_history: tool("weight_history", async (reads, input, today) => {
      const days = intParam("weight_history", "days", input.days, 7, 3650, DEFAULT_WEIGHT_DAYS);
      const daysFrom = addDays(today, -(days - 1));
      // The 4-week change compares with the 7 days ending 28 days ago.
      const [weights, recent, settings, history] = await Promise.all([
        reads.listBodyWeights(startOfDay(minDate(daysFrom, addDays(today, -34))), endOfDay(today)),
        // eFTP only looks at the last 90 days.
        reads.listExternalActivities({ from: startOfDay(addDays(today, -EFTP_WINDOW_DAYS)) }),
        reads.getAthleteSettings(),
        reads.listFtpHistory(),
      ]);
      const trend = weightTrend(weighIns(weights), today);
      const rate = weightRatePerWeek(trend);
      const ftp = ftpNow(visibleActivities(recent), settings, history, today);
      const wkg = wPerKg(ftp.ftpW, trend.avg7Kg);
      const fromMs = Date.parse(startOfDay(daysFrom));
      return toolResult({
        weigh_ins: weights
          .filter((w) => Date.parse(w.measuredAt) >= fromMs)
          .map((w) => ({ measured_at: w.measuredAt, weight_kg: w.weightKg, weight_lb: convert(w.weightKg, kgToLb) })),
        avg_7d_kg: r1(trend.avg7Kg),
        avg_7d_lb: convert(trend.avg7Kg, kgToLb),
        change_4w_kg: r1(trend.change4wKg),
        change_4w_lb: convert(trend.change4wKg, kgToLb),
        rate_per_week_kg: r1(rate),
        rate_per_week_lb: convert(rate, kgToLb),
        ftp_w: r1(ftp.ftpW),
        ftp_source: ftp.source,
        w_per_kg: r1(wkg),
        w_per_kg_band: wPerKgBand(wkg),
      });
    }),

    sync_status: tool("sync_status", async (reads) => {
      const rows = await reads.listSyncState();
      return toolResult({
        sources: rows.map((s) => ({
          source: s.source,
          last_run_at: s.lastRunAt,
          last_success_at: s.lastSuccessAt,
          items_fetched: s.itemsFetched,
          items_upserted: s.itemsUpserted,
          last_error: s.lastError,
          backfill_complete: s.backfillComplete,
          auth_status: s.authStatus,
        })),
      });
    }),
  };
}
