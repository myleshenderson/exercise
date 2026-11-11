import type { ExternalActivity } from "../../types";
import { buildFeedRows, weekTotalsText } from "./feedRows";

function ride(id: string, over: Partial<ExternalActivity>): ExternalActivity {
  return {
    id,
    source: "peloton",
    sourceId: id,
    startedAt: "2026-11-10T12:00:00Z",
    timezone: "America/New_York",
    sport: "cycling",
    subType: null,
    environment: "indoor",
    title: null,
    elapsedS: 2700,
    movingS: 2700,
    distanceM: 20000,
    elevationGainM: null,
    avgSpeedMps: null,
    maxSpeedMps: null,
    avgPowerW: null,
    maxPowerW: null,
    normalizedPowerW: null,
    intensityFactor: null,
    tss: 50,
    workKj: null,
    calories: null,
    avgHrBpm: null,
    maxHrBpm: null,
    avgCadenceRpm: null,
    biggestClimbM: null,
    tssSource: null,
    ftpUsedW: null,
    ftpSource: null,
    hasPower: false,
    hasHr: false,
    powerCurve: null,
    bestEfforts: null,
    pairedActivityId: null,
    syncedAt: "2026-11-10T13:00:00Z",
    ...over,
  } as ExternalActivity;
}

const rowsOf = (activities: ExternalActivity[]) => buildFeedRows(activities, [], [], { strengthSessionTss: 50 }, "2026-11-01");

describe("weekTotalsText kJ segment (AI-672)", () => {
  test("a week with no power omits kJ instead of printing 0 kJ", () => {
    const text = weekTotalsText(rowsOf([ride("a", { workKj: null }), ride("b", { workKj: 0, startedAt: "2026-11-09T12:00:00Z" })]));
    expect(text).toBe("2 rides · 1h 30m · 100 TSS");
    expect(text).not.toMatch(/kJ/);
  });
  test("a week with power keeps the kJ segment", () => {
    const text = weekTotalsText(rowsOf([ride("a", { workKj: 1234.4, hasPower: true }), ride("b", { workKj: null, startedAt: "2026-11-09T12:00:00Z" })]));
    expect(text).toBe("2 rides · 1h 30m · 100 TSS · 1,234 kJ");
  });
});
