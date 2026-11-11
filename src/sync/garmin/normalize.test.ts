import { describe, expect, it } from "vitest";
import { garminToProvider, garminWeighIns } from "./normalize.js";
import { LIST_PAGE, WEIGHT_RANGE } from "./__fixtures__/garmin.js";

describe("garminToProvider", () => {
  it("maps a power road ride", () => {
    const item = LIST_PAGE[0]!;
    const a = garminToProvider(item, "America/New_York");
    expect(a).toEqual({
      source: "garmin",
      sourceId: "900000003",
      startedAt: "2026-06-03T12:00:00.000Z",
      timezone: "America/New_York",
      subType: "road_biking",
      environment: "outdoor",
      title: "Synthetic Road Ride",
      elapsedS: 3700,
      movingS: 3600,
      distanceM: 30000,
      elevationGainM: 250,
      avgSpeedMps: 8.33,
      maxSpeedMps: 15.2,
      calories: 800,
      avgPowerW: 200,
      maxPowerW: 650,
      workKj: null,
      avgHrBpm: null,
      maxHrBpm: null,
      avgCadenceRpm: 88,
      providerPayload: item,
    });
    expect(a.providerPayload).toBe(item);
  });

  it("gives null for keys a no-power ride and a fragment omit", () => {
    const gravel = garminToProvider(LIST_PAGE[1]!, null);
    expect(gravel.subType).toBe("gravel_cycling");
    expect([gravel.avgPowerW, gravel.maxPowerW, gravel.avgCadenceRpm, gravel.timezone]).toEqual([null, null, null, null]);
    const frag = garminToProvider(LIST_PAGE[2]!, null);
    expect(frag.elapsedS).toBe(4);
    expect([frag.movingS, frag.distanceM, frag.calories, frag.elevationGainM]).toEqual([null, null, null, null]);
  });

  it("marks indoor_cycling and virtual_ride indoor", () => {
    for (const typeKey of ["indoor_cycling", "virtual_ride"]) {
      expect(garminToProvider({ ...LIST_PAGE[2]!, activityType: { typeKey } }, null).environment).toBe("indoor");
    }
  });

  it("falls back to startTimeGMT without beginTimestamp", () => {
    const { beginTimestamp: _b, ...rest } = LIST_PAGE[2]!;
    expect(garminToProvider(rest, null).startedAt).toBe("2026-06-01T14:00:00.000Z");
  });
});

describe("garminWeighIns", () => {
  it("(g) converts grams to kg and takes the instant from timestampGMT", () => {
    const rows = garminWeighIns(WEIGHT_RANGE);
    expect(rows).toHaveLength(2);
    const entry = WEIGHT_RANGE.dailyWeightSummaries![0]!.allWeightMetrics![0]!;
    expect(rows[0]).toEqual({
      source: "garmin",
      sourceId: "700000002",
      measuredAt: "2026-06-02T07:30:00.000Z",
      weightKg: 80,
      bmi: 24.5,
      bodyFatPct: 18.2,
      bodyWaterPct: 55.1,
      muscleMassKg: 36,
      boneMassKg: 3.5,
      providerPayload: entry,
    });
    expect(rows[1]!.weightKg).toBe(80.5);
  });
});
