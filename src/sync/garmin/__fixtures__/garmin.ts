/**
 * Hand-written Garmin payloads in the shapes of the AI-627 payload facts (sections 1, 2, 4).
 * Every id, name, time and value is synthetic: no real ids, names, coordinates or weights.
 */
import { zipSync } from "fflate";
import { BT, data, def, encodeFit, type FitItem } from "../../../fit/testing/encodeFit.js";
import type { GarminDetail, GarminListItem, GarminWeightRange } from "../types.js";

/** A JWT with the given claims; the signature is a fixed dummy. */
export function makeJwt(claims: Record<string, unknown>): string {
  const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c3ludGhldGljLXNpZ25hdHVyZQ`;
}

/** 2026-01-01T00:00:00Z in epoch seconds; the synthetic JWT lives 24 h from then. */
export const JWT_IAT = 1_767_225_600;
export const SYNTHETIC_JWT = makeJwt({ sub: "synthetic-user", iat: JWT_IAT, exp: JWT_IAT + 86_400 });

/** Newest first: a power road ride, a no-power gravel ride, and a 4 s fragment missing most keys. */
export const LIST_PAGE: GarminListItem[] = [
  {
    activityId: 900000003,
    activityUUID: "00000000-0000-4000-8000-000000000003",
    activityName: "Synthetic Road Ride",
    activityType: { typeId: 10, typeKey: "road_biking", parentTypeId: 2 },
    sportTypeId: 2,
    startTimeLocal: "2026-06-03 08:00:00",
    startTimeGMT: "2026-06-03 12:00:00",
    beginTimestamp: Date.UTC(2026, 5, 3, 12, 0, 0),
    duration: 3700,
    elapsedDuration: 3700,
    movingDuration: 3600,
    distance: 30000,
    elevationGain: 250,
    elevationLoss: 250,
    averageSpeed: 8.33,
    maxSpeed: 15.2,
    calories: 800,
    avgPower: 200,
    maxPower: 650,
    normPower: 215,
    max20MinPower: 230,
    maxAvgPower_1: 650,
    maxAvgPower_5: 600,
    maxAvgPower_1200: 230,
    powerTimeInZone_1: 600,
    trainingStressScore: 70.5,
    intensityFactor: 0.82,
    averageBikingCadenceInRevPerMinute: 88,
    maxBikingCadenceInRevPerMinute: 120,
    activityTrainingLoad: 95.2,
    lapCount: 1,
    manufacturer: "GARMIN",
  },
  {
    activityId: 900000002,
    activityUUID: "00000000-0000-4000-8000-000000000002",
    activityName: "Synthetic Gravel Ride",
    activityType: { typeId: 143, typeKey: "gravel_cycling", parentTypeId: 2 },
    sportTypeId: 2,
    startTimeLocal: "2026-06-02 09:00:00",
    startTimeGMT: "2026-06-02 13:00:00",
    beginTimestamp: Date.UTC(2026, 5, 2, 13, 0, 0),
    duration: 7300,
    elapsedDuration: 7300,
    movingDuration: 7200,
    distance: 50000,
    elevationGain: 600,
    averageSpeed: 6.9,
    maxSpeed: 14.1,
    calories: 1400,
    activityTrainingLoad: 2.1,
    lapCount: 1,
    manufacturer: "GARMIN",
  },
  {
    activityId: 900000001,
    activityName: "Synthetic Fragment",
    activityType: { typeId: 10, typeKey: "road_biking", parentTypeId: 2 },
    startTimeGMT: "2026-06-01 14:00:00",
    beginTimestamp: Date.UTC(2026, 5, 1, 14, 0, 0),
    duration: 4,
    elapsedDuration: 4,
  },
];

export const DETAIL: GarminDetail = {
  activityId: 900000003,
  activityName: "Synthetic Road Ride",
  timeZoneUnitDTO: { timeZone: "America/New_York" },
  metadataDTO: { sensors: null, lapCount: 1 },
  summaryDTO: { distance: 30000 },
};

/** Two weigh-in days, masses in grams. */
export const WEIGHT_RANGE: GarminWeightRange = {
  dailyWeightSummaries: [
    {
      summaryDate: "2026-06-02",
      numOfWeightEntries: 1,
      allWeightMetrics: [
        {
          samplePk: 700000002,
          date: Date.UTC(2026, 5, 2, 2, 30), // local wall clock as epoch
          calendarDate: "2026-06-02",
          timestampGMT: Date.UTC(2026, 5, 2, 7, 30),
          weight: 80000,
          bmi: 24.5,
          bodyFat: 18.2,
          bodyWater: 55.1,
          boneMass: 3500,
          muscleMass: 36000,
          physiqueRating: null,
          visceralFat: null,
          metabolicAge: null,
          sourceType: "INDEX_SCALE",
          weightDelta: null,
        },
      ],
    },
    {
      summaryDate: "2026-06-01",
      numOfWeightEntries: 1,
      allWeightMetrics: [
        {
          samplePk: 700000001,
          date: Date.UTC(2026, 5, 1, 2, 0),
          calendarDate: "2026-06-01",
          timestampGMT: Date.UTC(2026, 5, 1, 7, 0),
          weight: 80500,
          bmi: 24.6,
          bodyFat: 18.4,
          bodyWater: 55.0,
          boneMass: 3500,
          muscleMass: 35900,
          sourceType: "INDEX_SCALE",
        },
      ],
    },
  ],
  totalAverage: { weight: 80250 },
  previousDateWeight: null,
  nextDateWeight: null,
};

export const EMPTY_WEIGHT_RANGE: GarminWeightRange = { dailyWeightSummaries: [] };

/** A zipped FIT with 1 Hz timestamp + distance (cm) records, built in memory. */
export function fitZip(seconds = 5): Uint8Array {
  const T0 = 1_000_000_000;
  const items: FitItem[] = [def(0, 20, [{ num: 253, baseType: BT.uint32 }, { num: 5, baseType: BT.uint32 }])];
  for (let i = 0; i < seconds; i++) items.push(data(0, [T0 + i, i * 500]));
  return zipSync({ "900000003_ACTIVITY.fit": encodeFit(items) });
}
