/** Peloton workout + performance graph (or CSV row) to the sync core's ProviderActivity and Channels. */
import type { StreamChannel } from "../../types.js";
import type { Channels, ProviderActivity } from "../types.js";
import { csvNumber, workoutTitle } from "./csv.js";
import type {
  PelotonCsvRow,
  PelotonGraphMetric,
  PelotonGraphSummary,
  PelotonPerformanceGraph,
  PelotonWorkout,
  PelotonWorkoutDetail,
} from "./types.js";

export const METERS_PER_MILE = 1609.344;
export const MPS_PER_MPH = 0.44704;

/** The Peloton payload stored on the row, objects unmodified. */
export interface PelotonProviderPayload {
  workout: PelotonWorkout | PelotonWorkoutDetail;
  isFtpTest: boolean | null;
  csv: PelotonCsvRow | null;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Peloton reports a missing average as 0 (no HR strap, no power): treat it as absent. */
const positive = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n > 0 ? n : null;
};

/** Metres for a distance in `unit` (`mi` or `km`); null for any other unit. */
export function distanceToM(value: number | null, unit: string | null | undefined): number | null {
  if (value === null) return null;
  const u = (unit ?? "").toLowerCase();
  if (u === "mi") return value * METERS_PER_MILE;
  if (u === "km") return value * 1000;
  return null;
}

/** m/s for a speed in `unit` (`mph` or `kph`); null for any other unit. */
export function speedToMps(value: number | null, unit: string | null | undefined): number | null {
  if (value === null) return null;
  const u = (unit ?? "").toLowerCase();
  if (u === "mph") return value * MPS_PER_MPH;
  if (u === "kph" || u === "km/h") return value / 3.6;
  return null;
}

const summary = (list: PelotonGraphSummary[] | undefined, slug: string) => list?.find((s) => s.slug === slug) ?? null;
const metric = (graph: PelotonPerformanceGraph | null, slug: string): PelotonGraphMetric | null =>
  graph?.metrics?.find((m) => m.slug === slug) ?? null;

export function pelotonToProvider(
  w: PelotonWorkout,
  detail: PelotonWorkoutDetail | null,
  graph: PelotonPerformanceGraph | null,
  csvRow: PelotonCsvRow | null,
  isFtpTest: boolean | null = null,
): ProviderActivity {
  const start = finite(w.start_time);
  const end = finite(w.end_time);
  const durationS = start !== null && end !== null && end >= start ? end - start : null;

  let distanceM: number | null = null;
  const dist = summary(graph?.summaries, "distance");
  if (dist) distanceM = distanceToM(finite(dist.value), dist.display_unit);
  if (distanceM === null && !graph && csvRow) distanceM = distanceToM(csvNumber(csvRow["Distance (mi)"]), "mi");

  const avg = graph?.average_summaries;
  const avgSpeed = summary(avg, "avg_speed");
  const speedMetric = metric(graph, "speed");
  const hrMetric = metric(graph, "heart_rate");
  const csv = (col: keyof PelotonCsvRow) => (csvRow ? positive(csvNumber(csvRow[col])) : null);

  const totalWork = finite(w.total_work);
  const payload: PelotonProviderPayload = { workout: detail ?? w, isFtpTest, csv: csvRow };

  return {
    source: "peloton",
    sourceId: w.id,
    // start_time is the instant; device_time_created_at is local wall clock posing as epoch.
    startedAt: new Date((start ?? NaN) * 1000).toISOString(),
    timezone: w.timezone ?? null,
    subType: w.fitness_discipline ?? null,
    environment: w.is_outdoor === true ? "outdoor" : "indoor",
    title: workoutTitle(w),
    elapsedS: durationS,
    movingS: durationS,
    distanceM,
    elevationGainM: null,
    avgSpeedMps:
      positive(speedToMps(finite(avgSpeed?.value), avgSpeed?.display_unit)) ?? speedToMps(csv("Avg. Speed (mph)"), "mph"),
    maxSpeedMps: positive(speedToMps(finite(speedMetric?.max_value), speedMetric?.display_unit)),
    calories: finite(w.calories) ?? csv("Calories Burned"),
    avgPowerW: positive(summary(avg, "avg_output")?.value) ?? csv("Avg. Watts"),
    maxPowerW: positive(metric(graph, "output")?.max_value),
    workKj: totalWork !== null ? totalWork / 1000 : csv("Total Output"),
    avgHrBpm: positive(hrMetric?.average_value) ?? csv("Avg. Heartrate"),
    maxHrBpm: positive(hrMetric?.max_value),
    avgCadenceRpm: positive(summary(avg, "avg_cadence")?.value) ?? csv("Avg. Cadence (RPM)"),
    providerPayload: payload,
  };
}

const CHANNEL_OF_SLUG: Record<string, StreamChannel> = {
  output: "power",
  cadence: "cadence",
  resistance: "resistance",
  heart_rate: "heart_rate",
  speed: "speed",
};

/**
 * 1 Hz channels from an every_n=1 graph: `values[k]` lands at index
 * `seconds_since_pedaling_start[k]` (offset 0 = start_time); seconds without a sample are null.
 * Speed is converted to m/s by its display_unit; a speed in an unknown unit is dropped.
 */
export function graphToChannels(graph: PelotonPerformanceGraph): Channels {
  const seconds = graph.seconds_since_pedaling_start ?? [];
  let length = 0;
  for (const s of seconds) if (Number.isInteger(s) && s >= 0 && s + 1 > length) length = s + 1;
  const channels: Channels = {};
  if (length === 0) return channels;

  for (const m of graph.metrics ?? []) {
    const channel = CHANNEL_OF_SLUG[m.slug];
    if (!channel || channels[channel]) continue;
    let convert = (v: number) => v;
    if (channel === "speed") {
      if (speedToMps(1, m.display_unit) === null) continue;
      convert = (v) => speedToMps(v, m.display_unit) as number;
    }
    const out: (number | null)[] = new Array<number | null>(length).fill(null);
    m.values.forEach((v, k) => {
      const s = seconds[k];
      if (s === undefined || !Number.isInteger(s) || s < 0) return;
      out[s] = typeof v === "number" && Number.isFinite(v) ? convert(v) : null;
    });
    channels[channel] = out;
  }
  return channels;
}
