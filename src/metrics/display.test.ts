import type { ExternalActivity } from "../types";
import {
  COGGAN_POWER_ZONES,
  FRIEL_HR_ZONES,
  GARMIN_HR_MAX_ZONES,
  TSB_BANDS,
  bestPowerCurve,
  formatDuration,
  groupByWeek,
  isEstimatedTss,
  periodTotals,
  rampRate,
  recordsFromStored,
  storedBestEfforts,
  tsbBand,
  visibleActivities,
  wPerKgBand,
  weekStartOf,
  weightRatePerWeek,
  weightSeries,
  zoneSeconds,
} from "./display";
import * as metrics from "./index";

function act(id: string, over: Partial<ExternalActivity> = {}): ExternalActivity {
  return {
    id,
    source: "garmin",
    sourceId: id,
    startedAt: "2026-11-10T12:00:00Z",
    timezone: "UTC",
    sport: "cycling",
    subType: null,
    environment: "outdoor",
    title: null,
    elapsedS: 3600,
    movingS: 3500,
    distanceM: 30000,
    elevationGainM: 300,
    avgSpeedMps: null,
    maxSpeedMps: null,
    avgPowerW: null,
    maxPowerW: null,
    normalizedPowerW: null,
    intensityFactor: null,
    tss: 60,
    workKj: 700,
    calories: null,
    avgHrBpm: null,
    maxHrBpm: null,
    avgCadenceRpm: null,
    biggestClimbM: null,
    tssSource: "power",
    ftpUsedW: null,
    ftpSource: null,
    hasPower: true,
    hasHr: false,
    powerCurve: null,
    bestEfforts: null,
    pairedActivityId: null,
    syncedAt: "2026-11-10T13:00:00Z",
    ...over,
  };
}

test("index re-exports the display helpers", () => {
  for (const name of ["formatDuration", "visibleActivities", "groupByWeek", "recordsFromStored", "tsbBand", "zoneSeconds", "wPerKgBand"]) {
    expect(metrics).toHaveProperty(name);
  }
});

describe("formatDuration", () => {
  test("short", () => {
    expect(formatDuration(3 * 3600 + 28 * 60, "short")).toBe("3h 28m");
    expect(formatDuration(3 * 3600 + 28 * 60 + 31)).toBe("3h 29m");
    expect(formatDuration(45 * 60, "short")).toBe("45m");
    expect(formatDuration(0, "short")).toBe("0m");
    expect(formatDuration(778 * 3600 + 50 * 60, "short")).toBe("778h 50m");
  });
  test("clock", () => {
    expect(formatDuration(7 * 3600 + 25 * 60 + 23, "clock")).toBe("7:25:23");
    expect(formatDuration(12 * 60 + 6, "clock")).toBe("12:06");
    expect(formatDuration(3600, "clock")).toBe("1:00:00");
    expect(formatDuration(5.6, "clock")).toBe("0:06");
  });
  test("missing", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined, "clock")).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });
});

describe("visibleActivities", () => {
  test("drops Garmin fragments under 60 s only", () => {
    const rows = [
      act("frag", { elapsedS: 40 }),
      act("edge", { elapsedS: 60 }),
      act("nullElapsed", { elapsedS: null }),
      act("pelotonShort", { source: "peloton", elapsedS: 30 }),
    ];
    expect(visibleActivities(rows).map((r) => r.id)).toEqual(["edge", "nullElapsed", "pelotonShort"]);
  });

  test("collapses a pair to the Peloton row with pairedWith set, either direction", () => {
    const g = act("g", { pairedActivityId: "p", environment: "indoor" });
    const p = act("p", { source: "peloton", pairedActivityId: "g", environment: "indoor" });
    const other = act("o");
    const out = visibleActivities([g, other, p]);
    expect(out.map((r) => r.id)).toEqual(["o", "p"]);
    expect(out[1].pairedWith?.id).toBe("g");
    expect(out[0].pairedWith).toBeNull();

    // Only the Garmin row points at its partner.
    const one = visibleActivities([act("g2", { pairedActivityId: "p2" }), act("p2", { source: "peloton" })]);
    expect(one.map((r) => [r.id, r.pairedWith?.id])).toEqual([["p2", "g2"]]);
    // Only the Peloton row points.
    const two = visibleActivities([act("g3"), act("p3", { source: "peloton", pairedActivityId: "g3" })]);
    expect(two.map((r) => [r.id, r.pairedWith?.id])).toEqual([["p3", "g3"]]);
  });

  test("keeps a Garmin row whose Peloton partner is outside the list", () => {
    const out = visibleActivities([act("g", { pairedActivityId: "missing" })]);
    expect(out.map((r) => r.id)).toEqual(["g"]);
  });
});

describe("weeks", () => {
  // 2026-11-11 is a Wednesday.
  test("weekStartOf monday and sunday", () => {
    expect(weekStartOf("2026-11-11", "monday")).toBe("2026-11-09");
    expect(weekStartOf("2026-11-11", "sunday")).toBe("2026-11-08");
    expect(weekStartOf("2026-11-09", "monday")).toBe("2026-11-09");
    expect(weekStartOf("2026-11-08", "monday")).toBe("2026-11-02");
    expect(weekStartOf("2026-11-08", "sunday")).toBe("2026-11-08");
    expect(weekStartOf("2026-11-14", "sunday")).toBe("2026-11-08");
    expect(weekStartOf("1969-12-31", "monday")).toBe("1969-12-29");
    expect(() => weekStartOf("nope", "monday")).toThrow(RangeError);
  });

  test("groupByWeek uses the local date and the week start", () => {
    const items = [
      // Sunday 2026-11-08 23:30 in New York is Monday 04:30 UTC.
      { id: "a", startedAt: "2026-11-09T04:30:00Z", timezone: "America/New_York" },
      { id: "b", startedAt: "2026-11-10T12:00:00Z", timezone: null },
      { id: "c", startedAt: "2026-11-01", timezone: undefined },
      { id: "bad", startedAt: "garbage" },
    ];
    expect(groupByWeek(items, "monday").map((g) => [g.weekStart, g.items.map((i) => i.id)])).toEqual([
      ["2026-11-09", ["b"]],
      ["2026-11-02", ["a"]],
      ["2026-10-26", ["c"]],
    ]);
    expect(groupByWeek(items, "sunday").map((g) => [g.weekStart, g.items.map((i) => i.id)])).toEqual([
      ["2026-11-08", ["a", "b"]],
      ["2026-11-01", ["c"]],
    ]);
  });

  test("periodTotals keeps indoor distance separate", () => {
    const t = periodTotals([
      act("o", { distanceM: 40000, elevationGainM: 500, movingS: 5000, tss: 80, workKj: 900 }),
      act("i", { environment: "indoor", distanceM: 20000, elevationGainM: null, movingS: null, elapsedS: 2700, tss: 45.5, workKj: null }),
    ]);
    expect(t).toEqual({ count: 2, movingS: 7700, distanceM: 60000, indoorDistanceM: 20000, elevationM: 500, tss: 125.5, workKj: 900 });
    expect(periodTotals([])).toEqual({ count: 0, movingS: 0, distanceM: 0, indoorDistanceM: 0, elevationM: 0, tss: 0, workKj: 0 });
  });
});

describe("recordsFromStored", () => {
  test("15 rows from stored columns, outdoor only, fastest time wins", () => {
    const rows = [
      act("o1", { distanceM: 100000, elevationGainM: 1200, biggestClimbM: 300, bestEfforts: [
        { label: "5 mile", distanceM: 8046.72, seconds: 800 },
        { label: "100K", distanceM: 100000, seconds: 12000 },
      ] }),
      act("o2", { distanceM: 50000, elevationGainM: 2000, biggestClimbM: 250, bestEfforts: [
        { label: "5 mile", distanceM: 8046.72, seconds: 726 },
        { label: "bogus", distanceM: 1, seconds: 1 },
        { nope: true },
      ] }),
      act("i1", { environment: "indoor", source: "peloton", distanceM: 200000, elevationGainM: 9999, biggestClimbM: 9999, bestEfforts: [
        { label: "5 mile", distanceM: 8046.72, seconds: 100 },
      ] }),
    ];
    const rec = recordsFromStored(rows);
    expect(rec.longestRideM).toEqual({ value: 100000, activityId: "o1" });
    expect(rec.mostElevationM).toEqual({ value: 2000, activityId: "o2" });
    expect(rec.biggestClimbM).toEqual({ value: 300, activityId: "o1" });
    expect(rec.distances).toHaveLength(12);
    expect(rec.distances[0]).toMatchObject({ label: "5 mile", record: { value: 726, activityId: "o2" } });
    expect(rec.distances.find((d) => d.label === "100K")?.record).toEqual({ value: 12000, activityId: "o1" });
    expect(rec.distances.find((d) => d.label === "10K")?.record).toBeNull();
  });

  test("indoor rides never hold a record", () => {
    const rec = recordsFromStored([act("i", { environment: "indoor", biggestClimbM: 10, bestEfforts: [{ label: "10K", distanceM: 10000, seconds: 900 }] })]);
    expect(rec.longestRideM).toBeNull();
    expect(rec.biggestClimbM).toBeNull();
    expect(rec.mostElevationM).toBeNull();
    expect(rec.distances.every((d) => d.record === null)).toBe(true);
  });

  test("storedBestEfforts tolerates junk", () => {
    expect(storedBestEfforts(null)).toEqual([]);
    expect(storedBestEfforts({})).toEqual([]);
    expect(storedBestEfforts([null, 3, { label: "10K", seconds: "x" }])).toEqual([]);
  });
});

describe("tsbBand", () => {
  test.each([
    [-30.01, "overreaching"],
    [-30, "productive"],
    [-10.01, "productive"],
    [-10, "grey"],
    [4.99, "grey"],
    [5, "fresh"],
    [25, "fresh"],
    [25.01, "transition"],
    [-100, "overreaching"],
    [100, "transition"],
  ])("%s is %s", (tsb, band) => {
    expect(tsbBand(tsb)).toBe(band);
  });

  test("TSB_BANDS agree with tsbBand at each band's lower edge", () => {
    for (const b of TSB_BANDS.slice(1, -1)) expect(tsbBand(b.min)).toBe(b.band);
  });
});

test("rampRate is CTL today minus CTL a week ago", () => {
  const rows = [
    { date: "2026-11-04", ctl: 40 },
    { date: "2026-11-10", ctl: 44 },
    { date: "2026-11-11", ctl: 45.5 },
  ];
  expect(rampRate(rows, "2026-11-11")).toBeCloseTo(5.5);
  expect(rampRate(rows, "2026-11-10")).toBeNull();
  expect(rampRate(rows, "bad")).toBeNull();
});

describe("zoneSeconds", () => {
  test("Coggan boundaries against FTP 200", () => {
    // % FTP: 0, 54, 55.5, 56, 75, 76, 90, 91, 105, 106, 120, 121, 150, 151, 300
    const w = [0, 108, 111, 112, 150, 152, 180, 182, 210, 212, 240, 242, 300, 302, 600, null, -5];
    expect(zoneSeconds(w, 200, COGGAN_POWER_ZONES)).toEqual([3, 2, 2, 2, 2, 2, 2]);
  });

  test("Friel boundaries against LTHR 100, zeros skipped", () => {
    const hr = [0, 80, 81, 89, 90, 93, 94, 99, 100, 110];
    expect(zoneSeconds(hr, 100, FRIEL_HR_ZONES)).toEqual([1, 2, 2, 2, 2]);
  });

  test("Garmin % max boundaries, below 50% uncounted", () => {
    const hr = [49, 50, 59, 60, 70, 80, 89, 90, 100, 120];
    expect(zoneSeconds(hr, 100, GARMIN_HR_MAX_ZONES)).toEqual([2, 1, 1, 2, 3]);
  });

  test("tables have 7, 5 and 5 zones; missing threshold gives null", () => {
    expect(COGGAN_POWER_ZONES.zones).toHaveLength(7);
    expect(FRIEL_HR_ZONES.zones).toHaveLength(5);
    expect(GARMIN_HR_MAX_ZONES.zones).toHaveLength(5);
    expect(zoneSeconds([100], null, COGGAN_POWER_ZONES)).toBeNull();
    expect(zoneSeconds([100], 0, COGGAN_POWER_ZONES)).toBeNull();
  });
});

test("bestPowerCurve takes the max per duration and the ride holding it", () => {
  const rows = [
    act("a", { startedAt: "2026-06-01T10:00:00Z", powerCurve: { "5": 700, "60": 400, "1200": 260 } }),
    act("b", { startedAt: "2026-10-01T10:00:00Z", powerCurve: { "5": 650, "60": 420, "1200": 260, junk: 1, "30": "x" } }),
    act("c", { startedAt: "2026-11-01T10:00:00Z", powerCurve: null }),
    act("d", { startedAt: "2026-11-02T10:00:00Z", powerCurve: [1, 2] }),
  ];
  expect(bestPowerCurve(rows)).toEqual([
    { durationS: 5, watts: 700, activityId: "a", startedAt: "2026-06-01T10:00:00Z" },
    { durationS: 60, watts: 420, activityId: "b", startedAt: "2026-10-01T10:00:00Z" },
    { durationS: 1200, watts: 260, activityId: "a", startedAt: "2026-06-01T10:00:00Z" },
  ]);
  expect(bestPowerCurve(rows, "2026-09-01T00:00:00Z").map((p) => [p.durationS, p.watts, p.activityId])).toEqual([
    [5, 650, "b"],
    [60, 420, "b"],
    [1200, 260, "b"],
  ]);
});

describe("weight", () => {
  test("weightSeries groups by local day with a 7-day mean", () => {
    const series = weightSeries([
      { measuredAt: "2026-11-01T12:00:00Z", weightKg: 80 },
      { measuredAt: "2026-11-05T08:00:00Z", weightKg: 79 },
      { measuredAt: "2026-11-05T20:00:00Z", weightKg: 81 },
      { measuredAt: "2026-11-08T12:00:00Z", weightKg: 78 },
      { measuredAt: "2026-11-09T02:00:00Z", timezone: "America/New_York", weightKg: 77 }, // Nov 8 local
      { measuredAt: "bad", weightKg: 70 },
      { measuredAt: "2026-11-09T12:00:00Z", weightKg: null },
    ]);
    expect(series.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-05", "2026-11-08"]);
    expect(series[1].weighInsKg).toEqual([79, 81]);
    expect(series[1].avg7Kg).toBeCloseTo(80);
    // Nov 2..8: 79, 81, 78, 77 (Nov 1 is out of the window)
    expect(series[2].avg7Kg).toBeCloseTo(78.75);
  });

  test("weightRatePerWeek is the 4-week change over 4", () => {
    expect(weightRatePerWeek({ change4wKg: -2 })).toBe(-0.5);
    expect(weightRatePerWeek({ change4wKg: null })).toBeNull();
  });

  test.each([
    [null, null],
    [1.5, "untrained"],
    [2.22, "untrained"],
    [2.23, "fair"],
    [2.79, "good"],
    [3.92, "good"],
    [3.93, "excellent"],
    [5.05, "superior"],
  ])("wPerKgBand(%s) = %s", (wkg, band) => {
    expect(wPerKgBand(wkg)).toBe(band);
  });
});

test("isEstimatedTss", () => {
  expect(isEstimatedTss({ tssSource: "estimated_flat" })).toBe(true);
  expect(isEstimatedTss({ tssSource: "power" })).toBe(false);
  expect(isEstimatedTss({ tssSource: null })).toBe(false);
});
