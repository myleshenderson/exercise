/** Garmin payloads to the sync core's inputs (AI-638). Pure. */
import type { BodyWeightInput } from "../../types.js";
import type { ProviderActivity } from "../types.js";
import type { GarminListItem, GarminWeightEntry, GarminWeightRange } from "./types.js";

const INDOOR_TYPES = new Set(["indoor_cycling", "virtual_ride"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const grams = (v: unknown): number | null => {
  const g = num(v);
  return g === null ? null : g / 1000;
};

/** The start instant: `beginTimestamp` (ms), else `startTimeGMT` (`YYYY-MM-DD HH:MM:SS`, UTC). */
function startInstant(item: GarminListItem): string {
  const ms = num(item.beginTimestamp);
  if (ms !== null) return new Date(ms).toISOString();
  if (typeof item.startTimeGMT === "string") {
    const t = Date.parse(item.startTimeGMT.replace(" ", "T") + "Z");
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  throw new Error(`Garmin activity ${String(item.activityId)} has no start time`);
}

/** One activity-list item to a ProviderActivity. `timeZone` comes from the detail call. */
export function garminToProvider(item: GarminListItem, timeZone: string | null): ProviderActivity {
  if (num(item.activityId) === null) throw new Error("Garmin activity has no activityId");
  const subType = item.activityType?.typeKey ?? null;
  return {
    source: "garmin",
    sourceId: String(item.activityId),
    startedAt: startInstant(item),
    timezone: timeZone,
    subType,
    environment: subType !== null && INDOOR_TYPES.has(subType) ? "indoor" : "outdoor",
    title: typeof item.activityName === "string" ? item.activityName : null,
    elapsedS: num(item.elapsedDuration),
    movingS: num(item.movingDuration),
    distanceM: num(item.distance),
    elevationGainM: num(item.elevationGain),
    avgSpeedMps: num(item.averageSpeed),
    maxSpeedMps: num(item.maxSpeed),
    calories: num(item.calories),
    avgPowerW: num(item.avgPower),
    maxPowerW: num(item.maxPower),
    workKj: null,
    avgHrBpm: num(item.averageHR),
    maxHrBpm: num(item.maxHR),
    avgCadenceRpm: num(item.averageBikingCadenceInRevPerMinute),
    // trainingStressScore, intensityFactor, normPower and maxAvgPower_* stay here only.
    providerPayload: item,
  };
}

/** One row per weigh-in. Entries without samplePk, timestampGMT or weight are dropped. */
export function garminWeighIns(range: GarminWeightRange): BodyWeightInput[] {
  const rows: BodyWeightInput[] = [];
  for (const day of range.dailyWeightSummaries ?? []) {
    for (const e of (day.allWeightMetrics ?? []) as GarminWeightEntry[]) {
      const pk = num(e.samplePk);
      const at = num(e.timestampGMT);
      const weightKg = grams(e.weight);
      if (pk === null || at === null || weightKg === null) continue;
      rows.push({
        source: "garmin",
        sourceId: String(pk),
        // timestampGMT is the instant; `date` is local wall clock encoded as epoch.
        measuredAt: new Date(at).toISOString(),
        weightKg,
        bmi: num(e.bmi),
        bodyFatPct: num(e.bodyFat),
        bodyWaterPct: num(e.bodyWater),
        muscleMassKg: grams(e.muscleMass),
        boneMassKg: grams(e.boneMass),
        providerPayload: e,
      });
    }
  }
  return rows;
}
