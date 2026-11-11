/** Synthetic rides for the sync core tests. No personal values. */
import type { AthleteSettings } from "../../types.js";
import { DEFAULT_ATHLETE_SETTINGS } from "../../data/DataLayer.js";
import type { IngestContext, ProviderActivity } from "../types.js";

export function constant(seconds: number, value: number): number[] {
  return new Array<number>(seconds).fill(value);
}

export function ramp(seconds: number, f: (i: number) => number): number[] {
  return Array.from({ length: seconds }, (_, i) => f(i));
}

export function activity(overrides: Partial<ProviderActivity> = {}): ProviderActivity {
  return {
    source: "garmin",
    sourceId: "g-1",
    startedAt: "2026-06-01T10:00:00.000Z",
    timezone: "UTC",
    subType: "cycling",
    environment: "outdoor",
    title: "Synthetic ride",
    elapsedS: 3600,
    movingS: 3600,
    distanceM: null,
    elevationGainM: null,
    avgSpeedMps: null,
    maxSpeedMps: null,
    calories: null,
    avgPowerW: null,
    maxPowerW: null,
    workKj: null,
    avgHrBpm: null,
    maxHrBpm: null,
    avgCadenceRpm: null,
    providerPayload: { synthetic: true },
    ...overrides,
  };
}

export function context(settings: Partial<AthleteSettings> = {}, rest: Partial<IngestContext> = {}): IngestContext {
  return { settings: { ...DEFAULT_ATHLETE_SETTINGS, ...settings }, ftpHistory: [], priorRides: [], ...rest };
}
