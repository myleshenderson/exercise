/** A provider's ride plus its 1 Hz channels to an external_activities row and its streams. */
import {
  STANDARD_DURATIONS_S,
  bestEffortDistances,
  biggestClimbM,
  elevationGainM,
  fastestDistance,
  intensityFactor,
  meanMaxPower,
  normalizedPower,
  smoothAltitude,
  tssForActivity,
  workKj,
  type Stream,
} from "../metrics/index.js";
import type { ActivityStreamInput, AthleteSettings, ExternalActivity, StreamChannel } from "../types.js";
import { resolveFtp, type ResolvedFtp } from "./ftp.js";
import type { Channels, IngestContext, IngestResult, ProviderActivity } from "./types.js";

/** Durations (s) of the stored power curve. */
export const POWER_CURVE_DURATIONS_S: readonly number[] = [1, ...STANDARD_DURATIONS_S, 5400, 7200];

export interface BestEffort {
  label: string;
  distanceM: number;
  seconds: number;
}

/** The TSS columns `ingestActivity` and `recomputeAll` both write. */
export type TssFields = Pick<
  ExternalActivity,
  "normalizedPowerW" | "intensityFactor" | "tss" | "tssSource" | "ftpUsedW" | "ftpSource"
>;

/** True when the power channel has a sample above 0 W. */
export function streamHasPower(power: Stream | null | undefined): boolean {
  return !!power && power.some((v) => typeof v === "number" && v > 0);
}

/**
 * NP, IF and TSS for one ride. `power` is the 1 Hz power channel (null without one);
 * NP and IF are set only when the TSS comes from power.
 */
export function tssFields(
  power: Stream | null,
  durations: { movingS: number | null; elapsedS: number | null },
  ftp: ResolvedFtp,
  settings: Pick<AthleteSettings, "noPowerTssPerHour">,
): TssFields {
  const hasPower = streamHasPower(power);
  const result = tssForActivity(
    {
      power: power ?? undefined,
      hasPower,
      movingSeconds: durations.movingS ?? durations.elapsedS ?? 0,
      elapsedSeconds: durations.elapsedS ?? power?.length ?? 0,
      ftpW: ftp.ftpW,
    },
    { noPowerTssPerHour: settings.noPowerTssPerHour },
  );
  const fromPower = result.source === "power";
  const np = fromPower && power ? normalizedPower(power) : null;
  return {
    normalizedPowerW: np,
    intensityFactor: fromPower ? intensityFactor(np, ftp.ftpW) : null,
    tss: result.tss,
    // tssForActivity never returns "strength_fixed".
    tssSource: result.source === "power" ? "power" : "estimated_flat",
    ftpUsedW: ftp.ftpW,
    ftpSource: ftp.source,
  };
}

/** Mean of the non-null samples above 0, and the max of them; nulls when there is none. */
function streamStats(values: Stream | null | undefined): { avg: number | null; max: number | null } {
  if (!values) return { avg: null, max: null };
  let sum = 0;
  let count = 0;
  let max = -Infinity;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    sum += v;
    count++;
    if (v > max) max = v;
  }
  return count === 0 ? { avg: null, max: null } : { avg: sum / count, max };
}

/** `{ "<seconds>": watts }` for the stored power curve. */
function powerCurveOf(power: Stream): Record<string, number> {
  const curve: Record<string, number> = {};
  for (const [d, w] of Object.entries(meanMaxPower(power, POWER_CURVE_DURATIONS_S))) curve[d] = w;
  return curve;
}

function bestEffortsOf(cumDistance: Stream): BestEffort[] {
  const out: BestEffort[] = [];
  for (const d of bestEffortDistances) {
    const seconds = fastestDistance(cumDistance, d.distanceM);
    if (seconds !== null) out.push({ label: d.label, distanceM: d.distanceM, seconds });
  }
  return out;
}

export function ingestActivity(a: ProviderActivity, channels: Channels | null, ctx: IngestContext): IngestResult {
  const ch: Channels = channels ?? {};
  const power = ch.power ?? null;
  const hasPower = streamHasPower(power);
  const outdoor = a.environment === "outdoor";

  const ftp = resolveFtp(a.startedAt, ctx);
  const tss = tssFields(power, { movingS: a.movingS, elapsedS: a.elapsedS }, ftp, ctx.settings);

  const powerStats = streamStats(power);
  const hrStats = streamStats(ch.heart_rate);
  const cadenceStats = streamStats(ch.cadence);
  const avgHrBpm = hrStats.avg ?? a.avgHrBpm;
  const maxHrBpm = hrStats.max ?? a.maxHrBpm;

  const smoothed = ch.altitude ? smoothAltitude(ch.altitude) : null;

  const streams: ActivityStreamInput[] = [];
  for (const [channel, values] of Object.entries(ch) as [StreamChannel, (number | null)[] | undefined][]) {
    if (values && values.length > 0) streams.push({ channel, startOffsetS: 0, values });
  }

  return {
    row: {
      source: a.source,
      sourceId: a.sourceId,
      startedAt: a.startedAt,
      timezone: a.timezone,
      sport: "cycling",
      subType: a.subType,
      environment: a.environment,
      title: a.title,
      elapsedS: a.elapsedS,
      movingS: a.movingS,
      distanceM: a.distanceM,
      elevationGainM: a.elevationGainM ?? (smoothed ? elevationGainM(smoothed) : null),
      avgSpeedMps: a.avgSpeedMps,
      maxSpeedMps: a.maxSpeedMps,
      avgPowerW: powerStats.avg ?? a.avgPowerW,
      maxPowerW: powerStats.max ?? a.maxPowerW,
      ...tss,
      workKj: (hasPower && power ? workKj(power) : null) ?? a.workKj,
      calories: a.calories,
      avgHrBpm,
      maxHrBpm,
      avgCadenceRpm: cadenceStats.avg ?? a.avgCadenceRpm,
      biggestClimbM: outdoor && smoothed ? biggestClimbM(smoothed) : null,
      hasPower,
      hasHr: avgHrBpm !== null || maxHrBpm !== null,
      powerCurve: hasPower && power ? powerCurveOf(power) : null,
      // Decision 13: indoor rides never hold a distance best effort.
      bestEfforts: outdoor && ch.distance ? bestEffortsOf(ch.distance) : null,
      pairedActivityId: null,
      providerPayload: a.providerPayload,
    },
    streams,
  };
}
