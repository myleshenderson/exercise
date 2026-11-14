import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import manifest from "../../starkeep.manifest.json";
import { DEFAULT_ATHLETE_SETTINGS } from "./DataLayer";
import { createStarkeepDataLayer } from "./starkeep";
import { createFakeTransport, type FakeRequest, type FakeTable, type FakeTransport } from "./starkeep/fakeTransport";
import { withRideTables } from "./starkeep/rideTablesFake";
import {
  activityStreamId,
  bodyWeightId,
  calendarDate,
  dailyTrainingLoadId,
  externalActivityId,
  externalActivityPayload,
  fromSyncStateRow,
  ftpHistoryId,
  isoInstant,
  RideRowJsonError,
  syncStateId,
  toSyncStateRow,
  type ExternalActivityRow,
  type SyncStateRow,
} from "./starkeep/rideRows";
import type { RowClient } from "./starkeep/rows";
import { createRideAnalytics } from "./starkeep/rideAnalytics";
import type { ExternalActivityInput, SyncState } from "../types";
import { buildUuidRideFixtures, FIXTURE_NOW } from "../analysis/rides/testFixtures";

// The Starkeep ride analytics methods (AI-825) over the strict fake row API,
// mirroring mock.rideAnalytics.test.ts and supabase.test.ts: the same upsert
// keys, column defaults and ordering, plus what is Starkeep's own (the
// deterministic ids, JSON in text, the requests each method makes).

const NOW = "2026-11-11T12:00:00.000Z";
const TABLES = withRideTables(manifest.infraRequirements.appSpecificSyncable.tables as FakeTable[]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(fake: FakeTransport = createFakeTransport(TABLES)) {
  return { db: createStarkeepDataLayer(fake.transport, { claimSettleMs: 0 }), fake };
}

const ride = (sourceId: string, startedAt: string, over: Partial<ExternalActivityInput> = {}): ExternalActivityInput => ({
  source: "garmin",
  sourceId,
  startedAt,
  sport: "cycling",
  environment: "outdoor",
  providerPayload: { trainingStressScore: 99 },
  ...over,
});

/** The requests since `from`, as `METHOD table` with the decoded query. */
function calls(fake: FakeTransport, from = 0) {
  return fake.requests.slice(from).map((r: FakeRequest) => ({
    call: `${r.method} ${r.table}`,
    ...(r.params.where ? { where: JSON.parse(r.params.where) } : {}),
    ...(r.params.order ? { order: r.params.order } : {}),
  }));
}

/** No request may write user_id or updated_at (dropped and reserved on Starkeep). */
function expectNoForbiddenColumns(fake: FakeTransport) {
  for (const r of fake.requests) {
    const text = JSON.stringify(r.body ?? {}) + JSON.stringify(r.params);
    expect(text).not.toContain("user_id");
    expect(text).not.toContain("updated_at");
    expect(text).not.toContain("deleted_at");
  }
}

describe("external activities", () => {
  test("upsert stores <source>:<source_id> ids and JSON text, fills omitted fields with null/false, never returns the payload", async () => {
    const { db, fake } = setup();
    const [first] = await db.upsertExternalActivities([
      ride("g-1", "2026-11-01T10:00:00Z", { tss: 50, hasPower: true, powerCurve: { "5": 900 }, bestEfforts: [{ m: 1000, s: 90 }] }),
    ]);
    expect(first).toMatchObject({
      id: "garmin:g-1", source: "garmin", sourceId: "g-1", startedAt: "2026-11-01T10:00:00.000Z", tss: 50, hasPower: true,
      hasHr: false, title: null, timezone: null, powerCurve: { "5": 900 }, bestEfforts: [{ m: 1000, s: 90 }], syncedAt: NOW,
    });
    expect(first).not.toHaveProperty("providerPayload");
    expect(fake.tables.external_activities).toEqual([
      expect.objectContaining({
        id: "garmin:g-1",
        started_at: "2026-11-01T10:00:00.000Z",
        power_curve: '{"5":900}',
        best_efforts: '[{"m":1000,"s":90}]',
        provider_payload: '{"trainingStressScore":99}',
        synced_at: NOW,
        created_at: NOW,
        has_hr: false,
        elapsed_s: null,
      }),
    ]);
    expect(externalActivityPayload(fake.tables.external_activities[0] as ExternalActivityRow)).toEqual({ trainingStressScore: 99 });

    // Same key again: the row is replaced in place, created_at kept, every column rewritten.
    vi.setSystemTime(Date.parse("2026-11-12T00:00:00.000Z"));
    const [second] = await db.upsertExternalActivities([ride("g-1", "2026-11-01T10:00:00Z", { title: "Renamed" })]);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ title: "Renamed", tss: null, hasPower: false, powerCurve: null, syncedAt: "2026-11-12T00:00:00.000Z" });
    expect(fake.tables.external_activities).toHaveLength(1);
    expect(fake.tables.external_activities[0]).toMatchObject({ created_at: NOW, synced_at: "2026-11-12T00:00:00.000Z" });
    expect(await db.getExternalActivity(first.id)).toEqual(second);

    // Same source_id from another source is a different activity.
    await db.upsertExternalActivities([ride("g-1", "2026-11-01T10:00:00Z", { source: "peloton" })]);
    expect((await db.listExternalActivities({})).map((a) => a.id).sort()).toEqual(["garmin:g-1", "peloton:g-1"]);
    expectNoForbiddenColumns(fake);
  });

  test("a batch repeating a key keeps the last row; ftpUsedW is rounded; one lookup for created_at, then one POST per row", async () => {
    const { db, fake } = setup();
    const out = await db.upsertExternalActivities([
      ride("g-1", NOW, { title: "old" }),
      ride("g-2", NOW),
      ride("g-1", NOW, { title: "new", ftpUsedW: 251.6 }),
    ]);
    expect(out.map((a) => [a.id, a.title, a.ftpUsedW])).toEqual([["garmin:g-1", "new", 252], ["garmin:g-2", null, null]]);
    expect(calls(fake)).toEqual([
      { call: "GET external_activities", where: { id: { in: ["garmin:g-1", "garmin:g-2"] } } },
      { call: "POST external_activities" },
      { call: "POST external_activities" },
    ]);
  });

  test("an input syncedAt is kept (the sync store may set it); otherwise now", async () => {
    const { db } = setup();
    const [a] = await db.upsertExternalActivities([{ ...ride("g-1", NOW), syncedAt: "2026-11-10T00:00:00Z" } as ExternalActivityInput]);
    expect(a.syncedAt).toBe("2026-11-10T00:00:00.000Z");
  });

  test("list: newest first; from/to inclusive on started_at, source, environment and limit go into the where clause", async () => {
    const { db, fake } = setup();
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

    const before = fake.requests.length;
    await db.listExternalActivities({ from: "2026-11-01 10:00:00+00", to: "2026-11-02T10:00:00Z", source: "garmin", environment: "outdoor", limit: 5 });
    expect(calls(fake, before)).toEqual([
      {
        call: "GET external_activities",
        where: {
          started_at: { gte: "2026-11-01T10:00:00.000Z", lte: "2026-11-02T10:00:00.000Z" },
          source: "garmin",
          environment: "outdoor",
        },
        order: "started_at.desc,id.asc",
      },
    ]);
    const params = fake.requests[before].params;
    expect(params.limit).toBe("5");
    expect(params.select.split(",")).not.toContain("provider_payload");
  });

  test("ties on started_at break on id", async () => {
    const { db } = setup();
    await db.upsertExternalActivities([ride("b", NOW), ride("a", NOW), ride("c", NOW)]);
    expect((await db.listExternalActivities({})).map((a) => a.sourceId)).toEqual(["a", "b", "c"]);
  });

  test("a sub-millisecond lower bound rounds up, an upper bound down; garbage is a RangeError", async () => {
    const { db } = setup();
    await db.upsertExternalActivities([ride("g", "2026-11-01T10:00:00.001Z")]);
    expect(await db.listExternalActivities({ from: "2026-11-01T10:00:00.0005Z" })).toHaveLength(1);
    expect(await db.listExternalActivities({ from: "2026-11-01T10:00:00.0015Z" })).toHaveLength(0);
    expect(await db.listExternalActivities({ to: "2026-11-01T10:00:00.0019Z" })).toHaveLength(1);
    await expect(db.listExternalActivities({ from: "not a time" })).rejects.toBeInstanceOf(RangeError);
  });

  test("getExternalActivity: null when missing, never selects the payload", async () => {
    const { db, fake } = setup();
    expect(await db.getExternalActivity("garmin:nope")).toBeNull();
    expect(fake.requests[0].params.select.split(",")).not.toContain("provider_payload");
    expect(fake.requests[0].params.where).toBe('{"id":"garmin:nope"}');
  });

  test("upsert refuses a row without providerPayload and writes nothing", async () => {
    const { db, fake } = setup();
    for (const bad of [undefined, null]) {
      await expect(db.upsertExternalActivities([ride("g-1", NOW), ride("g-2", NOW, { providerPayload: bad })])).rejects.toThrow(
        "external activity garmin/g-2 has no providerPayload",
      );
    }
    expect(fake.requests).toEqual([]);
  });

  test("a bad startedAt fails the whole batch before any write", async () => {
    const { db, fake } = setup();
    await expect(db.upsertExternalActivities([ride("g-1", NOW), ride("g-2", "yesterday")])).rejects.toThrow(
      'external_activities.started_at must be an ISO 8601 instant, got "yesterday"',
    );
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("an empty upsert makes no request", async () => {
    const { db, fake } = setup();
    expect(await db.upsertExternalActivities([])).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  test("a malformed JSON cell throws naming the table, row and column", async () => {
    const { db, fake } = setup();
    await db.upsertExternalActivities([ride("g-1", NOW, { powerCurve: { "1": 1 } })]);
    fake.tables.external_activities[0].power_curve = "{oops";
    const err = await db.getExternalActivity("garmin:g-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RideRowJsonError);
    expect((err as Error).message).toMatch(/^Starkeep external_activities row "garmin:g-1": column power_curve is not valid JSON/);
    expect(err).toMatchObject({ table: "external_activities", rowId: "garmin:g-1", column: "power_curve" });
  });
});

describe("listExternalActivities: more rows than one page", () => {
  const TOTAL = 1203;
  async function seeded() {
    const { db, fake } = setup();
    const base = Date.parse(NOW);
    // Newest first: ride i starts i minutes before NOW. Seeded straight into the table.
    fake.tables.external_activities = Array.from({ length: TOTAL }, (_, i) => ({
      id: `garmin:r-${i}`, source: "garmin", source_id: `r-${i}`, started_at: new Date(base - i * 60_000).toISOString(),
      sport: "cycling", environment: "outdoor", has_power: false, has_hr: false, provider_payload: "{}", synced_at: NOW, created_at: NOW,
    }));
    return { db, fake };
  }

  test("no limit reads every page (nothing cut at 500)", async () => {
    const { db, fake } = await seeded();
    const out = await db.listExternalActivities({});
    expect(out).toHaveLength(TOTAL);
    expect(out[TOTAL - 1].sourceId).toBe(`r-${TOTAL - 1}`);
    expect(fake.requests).toHaveLength(3);
  });

  test.each([0, 1, 50, 500, 501, 1000, 1203, 5000])("limit %i returns the newest rows up to the limit", async (limit) => {
    const { db } = await seeded();
    const out = await db.listExternalActivities({ limit });
    const want = Math.min(limit, TOTAL);
    expect(out.map((a) => a.sourceId)).toEqual(Array.from({ length: want }, (_, i) => `r-${i}`));
  });

  test.each([-1, 1.5, NaN, Infinity])("limit %s throws a RangeError without a request", async (limit) => {
    const { db, fake } = setup();
    await expect(db.listExternalActivities({ limit })).rejects.toThrow(new RangeError("limit must be a non-negative integer"));
    expect(fake.requests).toEqual([]);
  });
});

describe("activity streams", () => {
  test("stored one row per (activity, channel) with id <activity_id>:<channel> and values as JSON; read ordered by channel", async () => {
    const { db, fake } = setup();
    const [a1, a2] = await db.upsertExternalActivities([ride("g-1", NOW), ride("g-2", NOW)]);
    await db.replaceActivityStreams(a1.id, [
      { channel: "power", values: [100, null] },
      { channel: "cadence", startOffsetS: 2, values: [90] },
    ]);
    await db.replaceActivityStreams(a2.id, [{ channel: "speed", values: [5] }]);
    expect(fake.tables.activity_streams).toEqual(
      expect.arrayContaining([
        { id: "garmin:g-1:power", activity_id: "garmin:g-1", channel: "power", start_offset_s: 0, values: "[100,null]", created_at: NOW },
        { id: "garmin:g-1:cadence", activity_id: "garmin:g-1", channel: "cadence", start_offset_s: 2, values: "[90]", created_at: NOW },
      ]),
    );
    const before = fake.requests.length;
    expect(await db.getActivityStreams(a1.id)).toEqual([
      { activityId: a1.id, channel: "cadence", startOffsetS: 2, values: [90] },
      { activityId: a1.id, channel: "power", startOffsetS: 0, values: [100, null] },
    ]);
    expect(calls(fake, before)).toEqual([
      { call: "GET activity_streams", where: { activity_id: "garmin:g-1" }, order: "channel.asc" },
    ]);
    expect(await db.getActivityStreams("missing")).toEqual([]);
  });

  test("replace: deletes the channels not passed, then upserts the rest; created_at of kept channels survives", async () => {
    const { db, fake } = setup();
    const [a1, a2] = await db.upsertExternalActivities([ride("g-1", NOW), ride("g-2", NOW)]);
    await db.replaceActivityStreams(a1.id, [
      { channel: "power", values: [100] },
      { channel: "heart_rate", values: [140] },
    ]);
    await db.replaceActivityStreams(a2.id, [{ channel: "heart_rate", values: [150] }]);

    vi.setSystemTime(Date.parse("2026-11-12T00:00:00.000Z"));
    const before = fake.requests.length;
    await db.replaceActivityStreams(a1.id, [{ channel: "power", values: [110] }]);
    expect(calls(fake, before)).toEqual([
      { call: "GET external_activities", where: { id: "garmin:g-1" } },
      { call: "GET activity_streams", where: { activity_id: "garmin:g-1" } },
      { call: "DELETE activity_streams" },
      { call: "POST activity_streams" },
    ]);
    expect(fake.requests[before + 2].body).toEqual({ where: { id: { in: ["garmin:g-1:heart_rate"] } } });
    expect(await db.getActivityStreams(a1.id)).toEqual([{ activityId: a1.id, channel: "power", startOffsetS: 0, values: [110] }]);
    expect(fake.tables.activity_streams.find((r) => r.id === "garmin:g-1:power")).toMatchObject({ created_at: NOW });
    expect((await db.getActivityStreams(a2.id)).map((s) => s.channel)).toEqual(["heart_rate"]);

    // An empty list deletes them all and writes nothing.
    const mark = fake.requests.length;
    await db.replaceActivityStreams(a1.id, []);
    expect(calls(fake, mark).map((c) => c.call)).toEqual(["GET activity_streams", "DELETE activity_streams"]);
    expect(await db.getActivityStreams(a1.id)).toEqual([]);
    expect((await db.getActivityStreams(a2.id)).map((s) => s.channel)).toEqual(["heart_rate"]);
  });

  test("a channel passed twice keeps the last one", async () => {
    const { db } = setup();
    const [a] = await db.upsertExternalActivities([ride("g-1", NOW)]);
    await db.replaceActivityStreams(a.id, [{ channel: "power", values: [1] }, { channel: "power", values: [2] }]);
    expect((await db.getActivityStreams(a.id)).map((s) => s.values)).toEqual([[2]]);
  });

  test("streams of an unknown activity throw (the activity_id foreign key) and write nothing", async () => {
    const { db, fake } = setup();
    await expect(db.replaceActivityStreams("nope", [{ channel: "power", values: [1] }])).rejects.toThrow("External activity nope not found");
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("a values cell that is not a JSON array throws", async () => {
    const { db, fake } = setup();
    const [a] = await db.upsertExternalActivities([ride("g-1", NOW)]);
    await db.replaceActivityStreams(a.id, [{ channel: "power", values: [1] }]);
    fake.tables.activity_streams[0].values = '{"0":1}';
    await expect(db.getActivityStreams(a.id)).rejects.toThrow('activity_streams row "garmin:g-1:power": column values is not valid JSON (not a JSON array)');
    fake.tables.activity_streams[0].values = "[1,";
    await expect(db.getActivityStreams(a.id)).rejects.toBeInstanceOf(RideRowJsonError);
  });
});

describe("body weights", () => {
  const w = (sourceId: string, measuredAt: string, weightKg: number) => ({
    source: "garmin" as const, sourceId, measuredAt, weightKg, providerPayload: { weight: weightKg * 1000 },
  });

  test("upsert on <source>:<source_id>; list measuredAt in [from, to], oldest first, without the payload", async () => {
    const { db, fake } = setup();
    await db.upsertBodyWeights([w("2", "2026-11-02T07:00:00Z", 81), w("1", "2026-11-01T07:00:00Z", 80)]);
    await db.upsertBodyWeights([w("2", "2026-11-02T07:00:00Z", 80.5)]);
    expect(fake.tables.body_weights.map((r) => [r.id, r.provider_payload])).toEqual([
      ["garmin:2", '{"weight":80500}'],
      ["garmin:1", '{"weight":80000}'],
    ]);
    const before = fake.requests.length;
    const list = await db.listBodyWeights("2026-11-01T07:00:00Z", "2026-11-02T07:00:00Z");
    expect(calls(fake, before)).toEqual([
      {
        call: "GET body_weights",
        where: { measured_at: { gte: "2026-11-01T07:00:00.000Z", lte: "2026-11-02T07:00:00.000Z" } },
        order: "measured_at.asc,id.asc",
      },
    ]);
    expect(list.map((x) => [x.id, x.sourceId, x.weightKg])).toEqual([["garmin:1", "1", 80], ["garmin:2", "2", 80.5]]);
    expect(list[0]).toMatchObject({ bmi: null, bodyFatPct: null, muscleMassKg: null, measuredAt: "2026-11-01T07:00:00.000Z" });
    expect(list[0]).not.toHaveProperty("providerPayload");
    expect(await db.listBodyWeights("2026-11-01T07:00:01Z", "2026-11-01T23:00:00Z")).toEqual([]);
    expectNoForbiddenColumns(fake);
  });

  test("a weigh-in without providerPayload is refused before any write; an empty upsert makes no request", async () => {
    const { db, fake } = setup();
    await expect(db.upsertBodyWeights([{ ...w("1", NOW, 80), providerPayload: undefined }])).rejects.toThrow(
      "body weight garmin/1 has no providerPayload",
    );
    await db.upsertBodyWeights([]);
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
});

describe("athlete settings", () => {
  test("defaults with no row (a copy); then only defined fields change, in the one 'settings' row", async () => {
    const { db, fake } = setup();
    const defaults = await db.getAthleteSettings();
    expect(defaults).toEqual(DEFAULT_ATHLETE_SETTINGS);
    defaults.units = "metric";
    expect((await db.getAthleteSettings()).units).toBe("imperial");

    expect(await db.saveAthleteSettings({ manualFtpW: 250, units: "metric" })).toEqual({
      ...DEFAULT_ATHLETE_SETTINGS, manualFtpW: 250, units: "metric",
    });
    expect(fake.tables.athlete_settings).toEqual([
      {
        id: "settings", manual_ftp_w: 250, lthr_bpm: null, max_hr_bpm: null, resting_hr_bpm: null, strength_session_tss: 50,
        no_power_tss_per_hour: 55, units: "metric", week_start: "monday", created_at: NOW,
      },
    ]);

    const before = fake.requests.length;
    const after = await db.saveAthleteSettings({ units: undefined, manualFtpW: null, weekStart: "sunday" });
    expect(after).toEqual({ ...DEFAULT_ATHLETE_SETTINGS, units: "metric", weekStart: "sunday" });
    expect(calls(fake, before).map((c) => c.call)).toEqual(["GET athlete_settings", "PATCH athlete_settings"]);
    expect(fake.requests[before + 1].body).toEqual({ where: { id: "settings" }, patch: { manual_ftp_w: null, week_start: "sunday" } });
    expect(await db.getAthleteSettings()).toEqual(after);
    expect(fake.tables.athlete_settings).toHaveLength(1);
    expectNoForbiddenColumns(fake);
  });

  test("values the Postgres columns refuse are refused before any request", async () => {
    const { db, fake } = setup();
    const bad: Partial<Record<string, unknown>>[] = [
      { units: "furlongs" }, { weekStart: "friday" }, { manualFtpW: 250.7 }, { lthrBpm: "170" },
      { strengthSessionTss: null }, { noPowerTssPerHour: Number.NaN }, { units: null },
    ];
    for (const patch of bad) await expect(db.saveAthleteSettings(patch as never)).rejects.toBeInstanceOf(RangeError);
    expect(fake.requests).toEqual([]);
    expect(await db.saveAthleteSettings({ manualFtpW: null, strengthSessionTss: 42.5 })).toMatchObject({ manualFtpW: null, strengthSessionTss: 42.5 });
  });

  test("an empty patch writes nothing and returns the current settings", async () => {
    const { db, fake } = setup();
    expect(await db.saveAthleteSettings({ units: undefined })).toEqual(DEFAULT_ATHLETE_SETTINGS);
    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
});

describe("FTP history", () => {
  test("id <effective_from>|<source>; oldest first; unique on (effectiveFrom, source); positive integers only", async () => {
    const { db, fake } = setup();
    const b = await db.addFtpHistoryEntry({ effectiveFrom: "2026-10-01T00:00:00Z", ftpW: 260, source: "peloton_test", sourceRef: "w-1" });
    vi.setSystemTime(Date.parse(NOW) + 1);
    const a = await db.addFtpHistoryEntry({ effectiveFrom: "2026-09-01T00:00:00Z", ftpW: 250, source: "manual", sourceRef: null });
    vi.setSystemTime(Date.parse(NOW) + 2);
    const c = await db.addFtpHistoryEntry({ effectiveFrom: "2026-10-01T00:00:00Z", ftpW: 255, source: "manual", sourceRef: null });
    expect(b).toEqual({ id: "2026-10-01T00:00:00.000Z|peloton_test", effectiveFrom: "2026-10-01T00:00:00.000Z", ftpW: 260, source: "peloton_test", sourceRef: "w-1" });
    const before = fake.requests.length;
    expect(await db.listFtpHistory()).toEqual([a, b, c]);
    expect(calls(fake, before)).toEqual([{ call: "GET ftp_history", order: "effective_from.asc,created_at.asc,id.asc" }]);

    await expect(
      db.addFtpHistoryEntry({ effectiveFrom: "2026-10-01 00:00:00+00", ftpW: 270, source: "peloton_test", sourceRef: null }),
    ).rejects.toThrow("An FTP entry from peloton_test at 2026-10-01T00:00:00.000Z already exists");
    await expect(db.addFtpHistoryEntry({ effectiveFrom: NOW, ftpW: 0, source: "manual", sourceRef: null })).rejects.toThrow(/positive/);
    await expect(db.addFtpHistoryEntry({ effectiveFrom: NOW, ftpW: 250.5, source: "manual", sourceRef: null })).rejects.toThrow(/positive integer/);
    expect(await db.listFtpHistory()).toHaveLength(3);
    expect(fake.tables.ftp_history.find((r) => r.id === b.id)).toMatchObject({ ftp_w: 260 });
  });

  test("equal effectiveFrom orders by created_at (insertion), as supabase.ts does", async () => {
    const { db } = setup();
    await db.addFtpHistoryEntry({ effectiveFrom: NOW, ftpW: 250, source: "peloton_test", sourceRef: null });
    vi.setSystemTime(Date.parse(NOW) + 1);
    await db.addFtpHistoryEntry({ effectiveFrom: NOW, ftpW: 240, source: "manual", sourceRef: null });
    expect((await db.listFtpHistory()).map((e) => e.source)).toEqual(["peloton_test", "manual"]);
  });
});

describe("daily training load", () => {
  const d = (date: string, ctl: number) => ({ date, tssTotal: 50, tssBySource: { garmin: 50 }, ctl, atl: 40, tsb: ctl - 40 });

  test("upsert on id <date>; tssBySource as JSON; list date in [from, to] oldest first", async () => {
    const { db, fake } = setup();
    await db.upsertDailyTrainingLoad([d("2026-11-03", 3), d("2026-11-01", 1), d("2026-11-02", 2)]);
    vi.setSystemTime(Date.parse("2026-11-12T00:00:00.000Z"));
    await db.upsertDailyTrainingLoad([d("2026-11-02", 22)]);
    expect(fake.tables.daily_training_load.find((r) => r.id === "2026-11-02")).toEqual({
      id: "2026-11-02", date: "2026-11-02", tss_total: 50, tss_by_source: '{"garmin":50}', ctl: 22, atl: 40, tsb: -18, created_at: NOW,
    });
    const before = fake.requests.length;
    const list = await db.listDailyTrainingLoad("2026-11-01", "2026-11-02");
    expect(calls(fake, before)).toEqual([
      { call: "GET daily_training_load", where: { date: { gte: "2026-11-01", lte: "2026-11-02" } }, order: "date.asc" },
    ]);
    expect(list).toEqual([d("2026-11-01", 1), d("2026-11-02", 22)]);
    expect(await db.listDailyTrainingLoad("2026-12-01", "2026-12-31")).toEqual([]);
    // A bound with a time keeps just its date, as a Postgres cast to date does.
    expect(await db.listDailyTrainingLoad("2026-11-03T12:00:00Z", "2026-11-03T00:00:00Z")).toEqual([d("2026-11-03", 3)]);
    await expect(db.listDailyTrainingLoad("Nov 1", "2026-11-02")).rejects.toThrow('from must be a date (YYYY-MM-DD), got "Nov 1"');
    await expect(db.upsertDailyTrainingLoad([d("2026-13-45", 1)])).rejects.toBeInstanceOf(RangeError);
  });

  test("an empty upsert makes no request", async () => {
    const { db, fake } = setup();
    await db.upsertDailyTrainingLoad([]);
    expect(fake.requests).toEqual([]);
  });
});

describe("sync state", () => {
  const state = (source: SyncState["source"], cursor: unknown): SyncState => ({
    source, cursor, lastRunAt: NOW, lastSuccessAt: null, itemsFetched: 3, itemsUpserted: 2, lastError: null,
    backfillComplete: false, authStatus: "ok",
  });

  test("empty with no rows; ordered by source; cursor parsed from JSON", async () => {
    const { db, fake } = setup();
    expect(await db.listSyncState()).toEqual([]);
    expect(calls(fake)).toEqual([{ call: "GET sync_state", order: "source.asc" }]);
    // Only the sync (wave 2) writes sync_state: seed rows through the shared mapper.
    fake.tables.sync_state = [
      toSyncStateRow(state("peloton", { newestWorkoutId: "w" }), { now: NOW }),
      toSyncStateRow(state("garmin_weight", null), { now: NOW }),
      toSyncStateRow(state("garmin_activities", { lastStart: NOW }), { now: NOW }),
    ];
    expect(fake.tables.sync_state[0]).toMatchObject({ id: "peloton", cursor: '{"newestWorkoutId":"w"}' });
    expect(await db.listSyncState()).toEqual([
      state("garmin_activities", { lastStart: NOW }),
      state("garmin_weight", null),
      state("peloton", { newestWorkoutId: "w" }),
    ]);
  });

  test("a malformed cursor throws naming sync_state, the source and cursor", () => {
    const row = { ...toSyncStateRow(state("peloton", 1), { now: NOW }), cursor: "nope" } as SyncStateRow;
    expect(() => fromSyncStateRow(row)).toThrow(/^Starkeep sync_state row "peloton": column cursor is not valid JSON/);
  });
});

describe("rideRows ids and value helpers", () => {
  test("the id scheme of decision 1", () => {
    expect(externalActivityId("garmin", "123")).toBe("garmin:123");
    expect(bodyWeightId("garmin", "456")).toBe("garmin:456");
    expect(activityStreamId("peloton:abc", "power")).toBe("peloton:abc:power");
    expect(ftpHistoryId("2026-10-01T00:00:00Z", "manual")).toBe("2026-10-01T00:00:00.000Z|manual");
    expect(dailyTrainingLoadId("2026-11-01")).toBe("2026-11-01");
    expect(syncStateId("garmin_weight")).toBe("garmin_weight");
  });

  test("isoInstant and calendarDate", () => {
    expect(isoInstant("2026-11-01T05:00:00-05:00", "x")).toBe("2026-11-01T10:00:00.000Z");
    expect(isoInstant("2026-11-01 10:00:00", "x")).toBe("2026-11-01T10:00:00.000Z"); // no offset: UTC, as Postgres in UTC
    expect(isoInstant("2026-11-01T10:00:00.0001Z", "x", "up")).toBe("2026-11-01T10:00:00.001Z");
    expect(isoInstant("2026-11-01T10:00:00.000Z", "x", "up")).toBe("2026-11-01T10:00:00.000Z");
    expect(() => isoInstant("soon", "x")).toThrow(RangeError);
    expect(calendarDate("2026-11-01T23:00:00Z", "d")).toBe("2026-11-01");
    expect(() => calendarDate("11/01/2026", "d")).toThrow(RangeError);
    expect(() => calendarDate("2026-02-30", "d")).toThrow(RangeError);
    expect(calendarDate("2028-02-29", "d")).toBe("2028-02-29");
  });
});

describe("the ride fixtures round-trip through the row API", () => {
  test("every fixture table written through the DataLayer reads back equal (ids aside)", async () => {
    const { fixtures } = buildUuidRideFixtures(FIXTURE_NOW);
    const { db } = setup();
    const sourceKey = new Map(fixtures.activities.map((a) => [a.id, externalActivityId(a.source, a.sourceId)]));
    await db.upsertExternalActivities(
      fixtures.activities.map(({ id: _id, syncedAt: _s, ...a }) => ({
        ...a,
        pairedActivityId: a.pairedActivityId === null ? null : sourceKey.get(a.pairedActivityId)!,
        providerPayload: { fixture: true },
      })),
    );
    const byActivity = new Map<string, typeof fixtures.streams>();
    for (const s of fixtures.streams) byActivity.set(s.activityId, [...(byActivity.get(s.activityId) ?? []), s]);
    for (const [id, streams] of byActivity) {
      await db.replaceActivityStreams(sourceKey.get(id)!, streams.map(({ activityId: _a, ...s }) => s));
    }
    await db.upsertBodyWeights(fixtures.bodyWeights.map(({ id: _id, ...w }) => ({ ...w, providerPayload: {} })));
    await db.saveAthleteSettings(fixtures.settings);
    for (const { id: _id, ...e } of fixtures.ftpHistory) await db.addFtpHistoryEntry(e);
    await db.upsertDailyTrainingLoad(fixtures.dailyLoad);

    const activities = await db.listExternalActivities({});
    expect(activities).toHaveLength(fixtures.activities.length);
    const expected = fixtures.activities.map((a) => ({
      ...a,
      id: sourceKey.get(a.id),
      pairedActivityId: a.pairedActivityId === null ? null : sourceKey.get(a.pairedActivityId),
      syncedAt: NOW,
    }));
    expect(activities).toEqual(expected);
    for (const [id, streams] of byActivity) {
      const key = sourceKey.get(id)!;
      expect(await db.getActivityStreams(key)).toEqual(
        streams.map((s) => ({ ...s, activityId: key })).sort((x, y) => (x.channel < y.channel ? -1 : 1)),
      );
    }
    expect(await db.listBodyWeights("1970-01-01T00:00:00.000Z", FIXTURE_NOW.toISOString())).toEqual(
      fixtures.bodyWeights.map((w) => ({ ...w, id: bodyWeightId(w.source, w.sourceId) })),
    );
    expect(await db.getAthleteSettings()).toEqual(fixtures.settings);
    expect(await db.listFtpHistory()).toEqual(fixtures.ftpHistory.map((e) => ({ ...e, id: ftpHistoryId(e.effectiveFrom, e.source) })));
    expect(await db.listDailyTrainingLoad("1970-01-01", "2999-12-31")).toEqual(fixtures.dailyLoad);
  });
});

test("createRideAnalytics works over any RowClient (the wave 2 sync store's seam)", async () => {
  const fake = createFakeTransport(TABLES);
  const { createRowClient } = await import("./starkeep/rows");
  const rows: RowClient = createRowClient(fake.transport);
  const ride = createRideAnalytics(rows);
  expect(await ride.listSyncState()).toEqual([]);
});
