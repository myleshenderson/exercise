import { dailyLoad, visibleActivities, recordsFromStored, isEstimatedTss } from "../../metrics";
import { RIDE_FIXTURE_IDS, buildRideFixtures, createRideFixtureDb } from "./fixtures";

const NOW = new Date("2026-11-11T17:00:00Z");

describe("buildRideFixtures", () => {
  const fx = buildRideFixtures(NOW);

  test("is deterministic for a fixed instant", () => {
    expect(buildRideFixtures(NOW)).toEqual(fx);
  });

  test("activities span 16 weeks before now, newest first, and none is in the future", () => {
    const starts = fx.activities.map((a) => Date.parse(a.startedAt));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    expect(Math.max(...starts)).toBeLessThan(NOW.getTime());
    const weeksBack = (NOW.getTime() - Math.min(...starts)) / (7 * 86_400_000);
    expect(weeksBack).toBeGreaterThan(15);
    expect(weeksBack).toBeLessThanOrEqual(16.5);
    expect(new Set(fx.activities.map((a) => a.id)).size).toBe(fx.activities.length);
  });

  test("covers the cases the screens need", () => {
    const byId = new Map(fx.activities.map((a) => [a.id, a]));
    const outdoor = fx.activities.filter((a) => a.source === "garmin" && a.environment === "outdoor");
    expect(outdoor.some((a) => a.hasPower)).toBe(true);
    expect(outdoor.some((a) => !a.hasPower && a.elapsedS !== null && a.elapsedS >= 60)).toBe(true);
    expect(fx.activities.filter((a) => a.source === "peloton").length).toBeGreaterThan(10);
    expect(byId.get(RIDE_FIXTURE_IDS.fragment)?.elapsedS).toBe(40);
    expect(isEstimatedTss(byId.get(RIDE_FIXTURE_IDS.estimated)!)).toBe(true);
    const peloton = byId.get(RIDE_FIXTURE_IDS.indoor)!;
    const garmin = byId.get(RIDE_FIXTURE_IDS.pairedGarmin)!;
    expect(peloton.pairedActivityId).toBe(garmin.id);
    expect(garmin.pairedActivityId).toBe(peloton.id);

    const visible = visibleActivities(fx.activities);
    expect(visible.find((a) => a.id === RIDE_FIXTURE_IDS.indoor)?.pairedWith?.id).toBe(RIDE_FIXTURE_IDS.pairedGarmin);
    expect(visible.some((a) => a.id === RIDE_FIXTURE_IDS.fragment || a.id === RIDE_FIXTURE_IDS.pairedGarmin)).toBe(false);
  });

  test("streams for the outdoor and indoor rides, consistent with their rows", () => {
    const channels = (id: string) => fx.streams.filter((s) => s.activityId === id).map((s) => s.channel).sort();
    expect(channels(RIDE_FIXTURE_IDS.outdoor)).toEqual(["altitude", "distance", "heart_rate", "power"]);
    expect(channels(RIDE_FIXTURE_IDS.indoor)).toEqual(["cadence", "heart_rate", "power", "resistance"]);
    const outdoor = fx.activities.find((a) => a.id === RIDE_FIXTURE_IDS.outdoor)!;
    const power = fx.streams.find((s) => s.activityId === outdoor.id && s.channel === "power")!;
    expect(power.values).toHaveLength(outdoor.movingS!);
    expect(outdoor.tss).toBeGreaterThan(50);
    expect(Array.isArray(outdoor.bestEfforts) && outdoor.bestEfforts.length).toBeGreaterThan(5);
  });

  test("records come from outdoor rides only", () => {
    const rec = recordsFromStored(fx.activities);
    const env = new Map(fx.activities.map((a) => [a.id, a.environment]));
    const holders = [rec.longestRideM, rec.biggestClimbM, rec.mostElevationM, ...rec.distances.map((d) => d.record)];
    for (const h of holders) if (h) expect(env.get(h.activityId)).toBe("outdoor");
    expect(rec.distances[0].record).not.toBeNull();
  });

  test("weigh-ins, settings, FTP history, daily load and sync state", () => {
    expect(fx.bodyWeights.length).toBeGreaterThan(90);
    const span = (NOW.getTime() - Date.parse(fx.bodyWeights[0].measuredAt)) / 86_400_000;
    expect(span).toBeGreaterThanOrEqual(119);
    expect(span).toBeLessThan(121);
    expect(fx.settings.units).toBe("imperial");
    expect(fx.ftpHistory.length).toBeGreaterThan(0);
    expect(fx.dailyLoad[fx.dailyLoad.length - 1].date).toBe("2026-11-11");
    expect(fx.dailyLoad.length).toBe(16 * 7 + 1);
    // Recomputing from the activities gives the same totals (pairs count once).
    const total = fx.dailyLoad.reduce((s, d) => s + d.tssTotal, 0);
    const again = dailyLoad(
      fx.activities.map((a) => ({ id: a.id, startedAt: a.startedAt, timezone: a.timezone!, source: a.source, tss: a.tss!, tssSource: a.tssSource!, pairedActivityId: a.pairedActivityId })),
      fx.dailyLoad[0].date,
      "2026-11-11",
    ).reduce((s, d) => s + d.tssTotal, 0);
    expect(total).toBeCloseTo(again, 0);
    expect(fx.syncState.map((s) => [s.source, s.authStatus])).toEqual([
      ["garmin_activities", "ok"],
      ["garmin_weight", "ok"],
      ["peloton", "reconnect_required"],
    ]);
  });

  test("dates move with now", () => {
    const later = buildRideFixtures(new Date(NOW.getTime() + 30 * 86_400_000));
    const shift = Date.parse(later.activities[0].startedAt) - Date.parse(fx.activities[0].startedAt);
    expect(shift).toBe(30 * 86_400_000);
  });
});

test("createRideFixtureDb serves the fixtures through the DataLayer", async () => {
  const db = createRideFixtureDb(NOW);
  const fx = buildRideFixtures(NOW);
  expect(await db.listExternalActivities({})).toHaveLength(fx.activities.length);
  expect(await db.getExternalActivity(RIDE_FIXTURE_IDS.outdoor)).toMatchObject({ id: RIDE_FIXTURE_IDS.outdoor });
  expect(await db.getActivityStreams(RIDE_FIXTURE_IDS.indoor)).toHaveLength(4);
  expect((await db.getAthleteSettings()).manualFtpW).toBe(250);
  expect((await db.listSyncState()).find((s) => s.source === "peloton")?.authStatus).toBe("reconnect_required");
  expect(await db.listDailyTrainingLoad("2026-11-01", "2026-11-11")).toHaveLength(11);
  expect((await db.listBodyWeights("2026-10-01T00:00:00Z", NOW.toISOString())).length).toBeGreaterThan(30);
  expect(await db.listFtpHistory()).toHaveLength(fx.ftpHistory.length);
});
