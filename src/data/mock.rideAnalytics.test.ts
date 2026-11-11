import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockDataLayer } from "./mock";
import { DEFAULT_ATHLETE_SETTINGS } from "./DataLayer";
import type { ExternalActivityInput } from "../types";

// The mock's ride analytics methods (AI-631) mirror supabase.ts: the same
// upsert keys, column defaults and ordering.

const NOW = "2026-11-11T12:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

const ride = (sourceId: string, startedAt: string, over: Partial<ExternalActivityInput> = {}): ExternalActivityInput => ({
  source: "garmin",
  sourceId,
  startedAt,
  sport: "cycling",
  environment: "outdoor",
  providerPayload: { trainingStressScore: 99 },
  ...over,
});

describe("external activities", () => {
  test("upsert fills omitted fields with null/false, never returns the payload, and keeps the id on conflict", async () => {
    const db = createMockDataLayer({ seed: false });
    const [first] = await db.upsertExternalActivities([ride("g-1", "2026-11-01T10:00:00Z", { tss: 50, hasPower: true })]);
    expect(first).toMatchObject({ source: "garmin", sourceId: "g-1", tss: 50, hasPower: true, hasHr: false, title: null, timezone: null, powerCurve: null, syncedAt: NOW });
    expect(first).not.toHaveProperty("providerPayload");

    vi.setSystemTime(Date.parse("2026-11-12T00:00:00.000Z"));
    const [second] = await db.upsertExternalActivities([ride("g-1", "2026-11-01T10:00:00Z", { title: "Renamed" })]);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ title: "Renamed", tss: null, hasPower: false, syncedAt: "2026-11-12T00:00:00.000Z" });
    expect(await db.getExternalActivity(first.id)).toEqual(second);
    expect(await db.listExternalActivities({})).toHaveLength(1);

    // Same source_id from another source is a different activity.
    await db.upsertExternalActivities([ride("g-1", "2026-11-01T10:00:00Z", { source: "peloton" })]);
    expect(await db.listExternalActivities({})).toHaveLength(2);
  });

  test("a batch repeating a key keeps the last row; ftpUsedW is rounded to whole watts", async () => {
    const db = createMockDataLayer({ seed: false });
    const out = await db.upsertExternalActivities([
      ride("g-1", NOW, { title: "old" }),
      ride("g-1", NOW, { title: "new", ftpUsedW: 251.6 }),
    ]);
    expect(out.map((a) => [a.title, a.ftpUsedW])).toEqual([["new", 252]]);
    expect(await db.listExternalActivities({})).toHaveLength(1);
  });

  test("list is newest first and applies from/to (inclusive), source, environment and limit", async () => {
    const db = createMockDataLayer({ seed: false });
    await db.upsertExternalActivities([
      ride("a", "2026-11-01T10:00:00Z"),
      ride("b", "2026-11-03T10:00:00Z", { source: "peloton", environment: "indoor" }),
      ride("c", "2026-11-02T10:00:00+00:00"),
    ]);
    const ids = async (f: Parameters<typeof db.listExternalActivities>[0]) => (await db.listExternalActivities(f)).map((a) => a.sourceId);
    expect(await ids({})).toEqual(["b", "c", "a"]);
    expect(await ids({ from: "2026-11-02T10:00:00.000Z" })).toEqual(["b", "c"]);
    expect(await ids({ to: "2026-11-02T10:00:00Z" })).toEqual(["c", "a"]);
    expect(await ids({ source: "garmin" })).toEqual(["c", "a"]);
    expect(await ids({ environment: "indoor" })).toEqual(["b"]);
    expect(await ids({ limit: 1 })).toEqual(["b"]);
  });

  test("getExternalActivity is null when missing; returned rows are copies", async () => {
    const db = createMockDataLayer({ seed: false });
    expect(await db.getExternalActivity("nope")).toBeNull();
    const [a] = await db.upsertExternalActivities([ride("g-1", NOW, { powerCurve: { "5": 900 } })]);
    (a.powerCurve as Record<string, number>)["5"] = 1;
    expect((await db.getExternalActivity(a.id))?.powerCurve).toEqual({ "5": 900 });
  });
});

test("streams: upsert per (activity, channel), ordered by channel, start offset defaults to 0", async () => {
  const db = createMockDataLayer({ seed: false });
  await db.replaceActivityStreams("a-1", [
    { channel: "power", values: [100, null] },
    { channel: "cadence", startOffsetS: 2, values: [90] },
  ]);
  await db.replaceActivityStreams("a-1", [{ channel: "power", values: [200] }]);
  await db.replaceActivityStreams("a-2", [{ channel: "speed", values: [5] }]);
  expect(await db.getActivityStreams("a-1")).toEqual([
    { activityId: "a-1", channel: "cadence", startOffsetS: 2, values: [90] },
    { activityId: "a-1", channel: "power", startOffsetS: 0, values: [200] },
  ]);
  expect(await db.getActivityStreams("missing")).toEqual([]);
});

test("body weights: upsert on (source, sourceId), list inclusive and oldest first", async () => {
  const db = createMockDataLayer({ seed: false });
  const w = (sourceId: string, measuredAt: string, weightKg: number) => ({ source: "garmin" as const, sourceId, measuredAt, weightKg, providerPayload: { weight: weightKg * 1000 } });
  await db.upsertBodyWeights([w("2", "2026-11-02T07:00:00Z", 81), w("1", "2026-11-01T07:00:00Z", 80)]);
  await db.upsertBodyWeights([w("2", "2026-11-02T07:00:00Z", 80.5)]);
  const list = await db.listBodyWeights("2026-11-01T07:00:00Z", "2026-11-02T07:00:00Z");
  expect(list.map((x) => [x.sourceId, x.weightKg])).toEqual([["1", 80], ["2", 80.5]]);
  expect(list[0]).toMatchObject({ bmi: null, bodyFatPct: null, muscleMassKg: null });
  expect(list[0]).not.toHaveProperty("providerPayload");
  expect(await db.listBodyWeights("2026-11-01T07:00:01Z", "2026-11-01T23:00:00Z")).toEqual([]);
});

test("athlete settings: defaults with no row, then only defined fields change", async () => {
  const db = createMockDataLayer({ seed: false });
  expect(await db.getAthleteSettings()).toEqual(DEFAULT_ATHLETE_SETTINGS);
  expect(await db.saveAthleteSettings({ manualFtpW: 250, units: "metric" })).toEqual({ ...DEFAULT_ATHLETE_SETTINGS, manualFtpW: 250, units: "metric" });
  const after = await db.saveAthleteSettings({ units: undefined, manualFtpW: null, weekStart: "sunday" });
  expect(after).toEqual({ ...DEFAULT_ATHLETE_SETTINGS, units: "metric", weekStart: "sunday" });
  expect(await db.getAthleteSettings()).toEqual(after);
});

test("FTP history: oldest first, unique on (effectiveFrom, source), positive integers only", async () => {
  const db = createMockDataLayer({ seed: false });
  const b = await db.addFtpHistoryEntry({ effectiveFrom: "2026-10-01T00:00:00Z", ftpW: 260, source: "peloton_test", sourceRef: "w-1" });
  const a = await db.addFtpHistoryEntry({ effectiveFrom: "2026-09-01T00:00:00Z", ftpW: 250, source: "manual", sourceRef: null });
  const c = await db.addFtpHistoryEntry({ effectiveFrom: "2026-10-01T00:00:00Z", ftpW: 255, source: "manual", sourceRef: null });
  expect(await db.listFtpHistory()).toEqual([a, b, c]);
  await expect(db.addFtpHistoryEntry({ effectiveFrom: "2026-10-01T00:00:00.000Z", ftpW: 270, source: "peloton_test", sourceRef: null })).rejects.toThrow(/already exists/);
  await expect(db.addFtpHistoryEntry({ effectiveFrom: NOW, ftpW: 0, source: "manual", sourceRef: null })).rejects.toThrow(/positive/);
  expect(await db.listFtpHistory()).toHaveLength(3);
});

test("daily training load: upsert on date, list inclusive and oldest first", async () => {
  const db = createMockDataLayer({ seed: false });
  const d = (date: string, ctl: number) => ({ date, tssTotal: 50, tssBySource: { garmin: 50 }, ctl, atl: 40, tsb: ctl - 40 });
  await db.upsertDailyTrainingLoad([d("2026-11-03", 3), d("2026-11-01", 1), d("2026-11-02", 2)]);
  await db.upsertDailyTrainingLoad([d("2026-11-02", 22)]);
  expect((await db.listDailyTrainingLoad("2026-11-01", "2026-11-02")).map((x) => [x.date, x.ctl])).toEqual([["2026-11-01", 1], ["2026-11-02", 22]]);
  expect(await db.listDailyTrainingLoad("2026-12-01", "2026-12-31")).toEqual([]);
});

test("sync state is empty: only the service-role sync writes it", async () => {
  expect(await createMockDataLayer().listSyncState()).toEqual([]);
});
