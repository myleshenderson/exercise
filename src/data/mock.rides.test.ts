import { createMockDataLayer } from "./mock";
import { DEFAULT_ATHLETE_SETTINGS } from "./DataLayer";
import { buildRideFixtures } from "../rides/testing/fixtures";

const NOW = new Date("2026-11-11T17:00:00Z");

test("without rides every ride collection starts empty (default unchanged)", async () => {
  const db = createMockDataLayer();
  expect(await db.listExternalActivities({})).toEqual([]);
  expect(await db.listBodyWeights("1970-01-01T00:00:00Z", NOW.toISOString())).toEqual([]);
  expect(await db.getAthleteSettings()).toEqual(DEFAULT_ATHLETE_SETTINGS);
  expect(await db.listFtpHistory()).toEqual([]);
  expect(await db.listDailyTrainingLoad("2000-01-01", "2100-01-01")).toEqual([]);
  expect(await db.listSyncState()).toEqual([]);
  expect((await db.listSessions()).length).toBeGreaterThan(0); // strength seed still there
});

test("rides preloads every ride collection, keeping fixture ids", async () => {
  const fx = buildRideFixtures(NOW);
  const db = createMockDataLayer({ rides: fx });
  const acts = await db.listExternalActivities({});
  expect(acts.map((a) => a.id)).toEqual(fx.activities.map((a) => a.id));
  expect(await db.getActivityStreams("ride-outdoor-1")).toHaveLength(4);
  expect(await db.listBodyWeights("1970-01-01T00:00:00Z", NOW.toISOString())).toHaveLength(fx.bodyWeights.length);
  expect(await db.getAthleteSettings()).toEqual(fx.settings);
  expect(await db.listFtpHistory()).toEqual(fx.ftpHistory);
  expect(await db.listDailyTrainingLoad("2000-01-01", "2100-01-01")).toEqual(fx.dailyLoad);
  expect((await db.listSyncState()).map((s) => s.source)).toEqual(["garmin_activities", "garmin_weight", "peloton"]);
});

test("preloaded rows are copies: writes do not leak into the fixtures or other instances", async () => {
  const fx = buildRideFixtures(NOW);
  const a = createMockDataLayer({ rides: fx });
  const b = createMockDataLayer({ rides: fx });
  await a.saveAthleteSettings({ manualFtpW: 300 });
  await a.replaceActivityStreams("ride-outdoor-1", []);
  (await a.listSyncState())[0].lastError = "mutated";
  expect(fx.settings.manualFtpW).toBe(250);
  expect((await b.getAthleteSettings()).manualFtpW).toBe(250);
  expect(await b.getActivityStreams("ride-outdoor-1")).toHaveLength(4);
  expect((await a.listSyncState())[0].lastError).toBeNull();
});

test("rides can be combined with seed: false", async () => {
  const db = createMockDataLayer({ seed: false, rides: buildRideFixtures(NOW) });
  expect(await db.listSessions()).toEqual([]);
  expect((await db.listExternalActivities({ limit: 1 })).length).toBe(1);
});
