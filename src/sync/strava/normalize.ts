/** A Strava archive CSV row to the sync core's ProviderActivity (AI-640). Pure. */
import type { ActivityEnvironment } from "../../types.js";
import type { ProviderActivity } from "../types.js";
import type { StravaRow } from "./csv.js";

/**
 * `providerPayload` is the row's every column (`Relative Effort`, `Weighted Average Power`, ...);
 * nothing beyond the core summary is promoted to a typed column. Needs a parsed `startedAt` and `id`.
 */
export function stravaToProvider(row: StravaRow, environment: ActivityEnvironment): ProviderActivity {
  if (row.id === null || row.startedAt === null) throw new Error("stravaToProvider needs a row with an id and a parsed date");
  return {
    source: "strava_export",
    sourceId: row.id,
    startedAt: row.startedAt,
    timezone: null,
    subType: row.type,
    environment,
    title: row.name,
    elapsedS: row.elapsedS,
    movingS: row.movingS,
    distanceM: row.distanceM,
    elevationGainM: row.elevationGainM,
    avgSpeedMps: row.avgSpeedMps,
    maxSpeedMps: row.maxSpeedMps,
    calories: row.calories,
    avgPowerW: row.avgPowerW,
    maxPowerW: row.maxPowerW,
    workKj: null,
    avgHrBpm: row.avgHrBpm,
    maxHrBpm: row.maxHrBpm,
    avgCadenceRpm: row.avgCadenceRpm,
    providerPayload: row.raw,
  };
}
