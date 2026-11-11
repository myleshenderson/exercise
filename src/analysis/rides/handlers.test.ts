// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  bestEffortDistances,
  eftp,
  localDate,
  mToMi,
  tsbBand,
  visibleActivities,
  weightTrend,
  wPerKgBand,
} from "../../metrics/index.js";
import { FIXTURE_TIMEZONE, RIDE_FIXTURE_IDS, type RideFixtures } from "../../rides/testing/fixtures.js";
import { createRideToolHandlers, RIDE_TOOL_NAMES, type RideToolHandlers } from "./handlers.js";
import type { RideReads } from "./reads.js";
import { buildUuidRideFixtures, EMPTY_READS, FIXTURE_NOW, fixtureReads } from "./testFixtures.js";

const TODAY = "2026-11-11";
const MISSING = "f0000000-0000-4000-8000-00000000ffff";

function handlersOver(reads: RideReads, now: Date = FIXTURE_NOW): RideToolHandlers {
  return createRideToolHandlers((run) => run(reads), { now: () => now, defaultTimeZone: FIXTURE_TIMEZONE });
}

function setup(edit?: (f: RideFixtures) => void) {
  const fx = buildUuidRideFixtures(FIXTURE_NOW, edit);
  return { ...fx, tools: handlersOver(fixtureReads(fx.fixtures)) };
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: CallToolResult): any => {
  expect(r.isError).toBeFalsy();
  return JSON.parse(text(r));
};

describe("list_activities", () => {
  it("hides the fragment, collapses the pair to the Peloton row and lists newest first", async () => {
    const { tools, ids, fixtures } = setup();
    const { activities } = body(await tools.list_activities({}));
    const listed = activities.map((a: { id: string }) => a.id);
    expect(listed).not.toContain(ids.fragment);
    expect(listed).not.toContain(ids.pairedGarmin);
    expect(listed).toContain(ids.outdoor);
    expect(listed).toContain(ids.estimated);

    const indoor = activities.find((a: { id: string }) => a.id === ids.indoor);
    expect(indoor.source).toBe("peloton");
    expect(indoor.paired_with).toMatchObject({ id: ids.pairedGarmin, source: "garmin" });

    const starts = activities.map((a: { started_at: string }) => Date.parse(a.started_at));
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    expect(activities).toHaveLength(Math.min(100, visibleActivities(fixtures.activities).length));
  });

  it("prints the row with unit twins, as stored, and flags estimated TSS", async () => {
    const { tools, ids, fixtures } = setup();
    const { activities } = body(await tools.list_activities({}));
    const stored = fixtures.activities.find((a) => a.id === ids.estimated)!;
    const row = activities.find((a: { id: string }) => a.id === ids.estimated);
    expect(Object.keys(row)).toEqual([
      "id", "source", "started_at", "timezone", "title", "environment", "sub_type", "elapsed_s", "moving_s",
      "distance_m", "distance_mi", "elevation_gain_m", "elevation_gain_ft", "avg_power_w", "normalized_power_w",
      "intensity_factor", "tss", "tss_estimated", "work_kj", "avg_hr_bpm", "paired_with",
    ]);
    expect(row).toMatchObject({
      started_at: stored.startedAt,
      distance_m: 41800,
      distance_mi: 26,
      elevation_gain_m: 310,
      elevation_gain_ft: 1017.1,
      tss: stored.tss,
      tss_estimated: true,
      avg_power_w: null,
      paired_with: null,
    });
    const outdoor = activities.find((a: { id: string }) => a.id === ids.outdoor);
    expect(outdoor.tss_estimated).toBe(false);
  });

  it("filters by environment, source, UTC date range and limit", async () => {
    const { tools, ids } = setup();
    const indoor = body(await tools.list_activities({ environment: "indoor" })).activities;
    expect(indoor.length).toBeGreaterThan(0);
    expect(indoor.every((a: { environment: string }) => a.environment === "indoor")).toBe(true);

    // The Garmin half of a pair stays folded into its Peloton row even when only Garmin is asked for.
    const garmin = body(await tools.list_activities({ source: "garmin" })).activities;
    expect(garmin.every((a: { source: string }) => a.source === "garmin")).toBe(true);
    expect(garmin.map((a: { id: string }) => a.id)).not.toContain(ids.pairedGarmin);

    const day = body(await tools.list_activities({ start_date: TODAY, end_date: TODAY })).activities;
    expect(day.length).toBeGreaterThan(0);
    for (const a of day) expect(a.started_at.slice(0, 10)).toBe(TODAY);

    expect(body(await tools.list_activities({ limit: 3 })).activities).toHaveLength(3);
  });

  it("reads only the newest 2 × limit + 50 rows", async () => {
    const { fixtures } = setup();
    const inner = fixtureReads(fixtures);
    const limits: Array<number | undefined> = [];
    const tools = handlersOver({
      ...inner,
      listExternalActivities: (f) => {
        limits.push(f.limit);
        return inner.listExternalActivities(f);
      },
    });
    expect(body(await tools.list_activities({ limit: 3 })).activities).toHaveLength(3);
    expect(limits).toEqual([56]);
  });

  it("rejects a malformed date or limit with a tool error", async () => {
    const { tools } = setup();
    expect(await tools.list_activities({ start_date: "11/11/2026" })).toEqual({
      isError: true,
      content: [{ type: "text", text: 'list_activities failed: start_date must be a date (YYYY-MM-DD), got "11/11/2026".' }],
    });
    expect(text(await tools.list_activities({ limit: 0 }))).toBe(
      "list_activities failed: limit must be an integer between 1 and 500, got 0.",
    );
    expect((await tools.list_activities({ limit: 2.5 })).isError).toBe(true);
  });
});

describe("get_activity", () => {
  it("malformed id is invalidIdError, unknown id is 'Activity not found'", async () => {
    const { tools } = setup();
    expect(await tools.get_activity({ activity_id: "ride-outdoor-1" })).toEqual({
      isError: true,
      content: [{ type: "text", text: 'get_activity failed: expected a UUID for activity_id, got "ride-outdoor-1".' }],
    });
    expect(await tools.get_activity({ activity_id: MISSING })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Activity not found" }],
    });
  });

  it("the outdoor ride: zones from its streams, best efforts against the outdoor records", async () => {
    const { tools, ids, fixtures } = setup();
    const a = body(await tools.get_activity({ activity_id: ids.outdoor }));
    const stored = fixtures.activities.find((x) => x.id === ids.outdoor)!;
    expect(a).toMatchObject({ id: ids.outdoor, ftp_used_w: 250, hr_zone_basis: "lthr", paired_with: null });
    expect(a.biggest_climb_m).toBe(stored.biggestClimbM);
    expect(a.biggest_climb_ft).toBe(Math.round((stored.biggestClimbM! / 0.3048) * 10) / 10);

    // Every power sample is >= 0 and power counts 0 W, so the zones cover the whole 2 h stream.
    expect(a.power_zones_s).toHaveLength(7);
    expect(a.power_zones_s[0].zone).toBe("Z1 Active recovery");
    expect(a.power_zones_s.reduce((s: number, z: { seconds: number }) => s + z.seconds, 0)).toBe(7200);
    expect(a.hr_zones_s.map((z: { zone: string }) => z.zone)).toEqual([
      "Z1 Recovery", "Z2 Aerobic", "Z3 Tempo", "Z4 Threshold", "Z5 Anaerobic",
    ]);

    expect(a.best_efforts.length).toBeGreaterThan(0);
    for (const e of a.best_efforts) {
      expect(Object.keys(e)).toEqual(["label", "distance_m", "distance_mi", "seconds", "record_seconds", "is_pr"]);
      expect(e.record_seconds).not.toBeNull();
      expect(e.record_seconds).toBeLessThanOrEqual(e.seconds);
      expect(e.is_pr).toBe(e.record_seconds === e.seconds);
    }
  });

  it("HR zones fall back to max HR, then to none", async () => {
    const maxOnly = setup((f) => (f.settings = { ...f.settings, lthrBpm: null }));
    const a = body(await maxOnly.tools.get_activity({ activity_id: maxOnly.ids.outdoor }));
    expect(a.hr_zone_basis).toBe("max_hr");
    expect(a.hr_zones_s[0].zone).toBe("Z1 Warm up");

    const none = setup((f) => (f.settings = { ...f.settings, lthrBpm: null, maxHrBpm: null }));
    const b = body(await none.tools.get_activity({ activity_id: none.ids.outdoor }));
    expect(b.hr_zone_basis).toBeNull();
    expect(b.hr_zones_s).toBeNull();
  });

  it("an indoor ride is never a distance PR, however fast its stored efforts", async () => {
    const { tools, ids } = setup((f) => {
      const indoor = f.activities.find((a) => a.id === "ride-indoor-1")!;
      indoor.bestEfforts = [{ label: "10K", distanceM: 10000, seconds: 1 }];
    });
    const a = body(await tools.get_activity({ activity_id: ids.indoor }));
    expect(a.best_efforts).toEqual([
      { label: "10K", distance_m: 10000, distance_mi: 6.2, seconds: 1, record_seconds: expect.any(Number), is_pr: false },
    ]);
    expect(a.best_efforts[0].record_seconds).toBeGreaterThan(1);
    expect(a.paired_with).toMatchObject({ id: ids.pairedGarmin, source: "garmin" });

    const stats = body(await tools.activity_stats({}));
    const tenK = stats.best_efforts.find((r: { label: string }) => r.label === "10K");
    expect(tenK.activity_id).not.toBe(ids.indoor);
  });

  it("a ride without streams has null zones", async () => {
    const { tools, ids } = setup();
    const a = body(await tools.get_activity({ activity_id: ids.estimated }));
    expect(a.power_zones_s).toBeNull();
    expect(a.hr_zones_s).toBeNull();
    expect(a.tss_estimated).toBe(true);
  });
});

describe("activity_stats", () => {
  it("period totals, the 15 outdoor record rows and the power-bests strip", async () => {
    const { tools, fixtures } = setup();
    const s = body(await tools.activity_stats({}));
    expect(s.as_of).toBe(TODAY);
    const visible = visibleActivities(fixtures.activities);
    expect(s.all_time.count).toBe(visible.length);
    expect(s.all_time.from).toBeNull();
    expect(s.last_4_weeks).toMatchObject({ from: "2026-10-15", to: TODAY });
    expect(s.year_to_date).toMatchObject({ from: "2026-01-01", to: TODAY });
    expect(s.previous_year_to_date).toMatchObject({ from: "2025-01-01", to: "2025-11-11", count: 0 });
    // 16 weeks of fixtures, all in 2026: year to date is all time.
    expect(s.year_to_date.count).toBe(s.all_time.count);

    const indoorM = visible.filter((a) => a.environment === "indoor").reduce((t, a) => t + (a.distanceM ?? 0), 0);
    expect(s.all_time.indoor_distance_m).toBe(Math.round(indoorM * 10) / 10);
    expect(s.all_time.indoor_distance_mi).toBe(Math.round(mToMi(indoorM) * 10) / 10);

    expect(s.best_efforts).toHaveLength(15);
    expect(s.best_efforts.slice(0, 3).map((r: { label: string }) => r.label)).toEqual(["Longest ride", "Biggest climb", "Most elevation"]);
    expect(s.best_efforts.slice(3).map((r: { label: string }) => r.label)).toEqual(bestEffortDistances.map((d) => d.label));
    const outdoorIds = new Set(visible.filter((a) => a.environment === "outdoor").map((a) => a.id));
    for (const r of s.best_efforts) if (r.activity_id !== null) expect(outdoorIds.has(r.activity_id)).toBe(true);

    expect(s.power_bests.map((p: { seconds: number }) => p.seconds)).toEqual([5, 60, 300, 1200, 3600]);
    for (const p of s.power_bests) expect(p.watts).toBeGreaterThan(0);
  });

  it("a row stored without a zone (Strava archive) counts on its day in the athlete's zone", async () => {
    // 02:00Z on 1 January is 21:00 on 31 December in New York: last year's ride.
    const { tools } = setup((f) => {
      const a = f.activities.find((x) => x.id === RIDE_FIXTURE_IDS.estimated)!;
      Object.assign(a, { source: "strava_export", timezone: null, startedAt: "2026-01-01T02:00:00.000Z" });
    });
    // The fixtures' other rides are all after 1 March 2026.
    const s = body(await tools.activity_stats({ as_of: "2026-03-01" }));
    expect(s.year_to_date.count).toBe(0);
    expect(s.all_time.count).toBe(1);
    expect(body(await tools.activity_stats({ as_of: "2025-12-31" })).year_to_date).toMatchObject({ from: "2025-01-01", count: 1 });
  });

  it("as_of cuts every period at that day, and the previous year at the same day of year", async () => {
    const { tools } = setup();
    const s = body(await tools.activity_stats({ as_of: "2026-03-01" }));
    expect(s.all_time.count).toBe(0);
    expect(s.previous_year_to_date).toMatchObject({ from: "2025-01-01", to: "2025-03-01" });
    expect(s.best_efforts.every((r: { activity_id: string | null }) => r.activity_id === null)).toBe(true);
    expect(text(await tools.activity_stats({ as_of: "2026-02-30" }))).toBe(
      'activity_stats failed: as_of must be a date (YYYY-MM-DD), got "2026-02-30".',
    );
  });
});

describe("training_load", () => {
  it("daily rows, today's form and band, ramp rate and 12 weeks of TSS by source", async () => {
    const { tools, fixtures } = setup();
    const t = body(await tools.training_load({}));
    expect(t.days).toHaveLength(90);
    expect(t.days[0].date).toBe("2026-08-14");
    expect(t.days.at(-1).date).toBe(TODAY);
    expect(Object.keys(t.days[0])).toEqual(["date", "tss", "tss_by_source", "ctl", "atl", "tsb"]);

    const latest = fixtures.dailyLoad[fixtures.dailyLoad.length - 1];
    expect(latest.date).toBe(localDate(FIXTURE_NOW.toISOString(), "America/New_York"));
    const r1 = (v: number) => Math.round(v * 10) / 10;
    expect(t.today).toEqual({ date: latest.date, is_today: true, ctl: r1(latest.ctl), atl: r1(latest.atl), tsb: r1(latest.tsb), tsb_band: tsbBand(latest.tsb) });
    const weekAgo = fixtures.dailyLoad.find((d) => d.date === "2026-11-04")!;
    expect(t.ramp_rate).toBe(r1(latest.ctl - weekAgo.ctl));

    expect(t.week_start).toBe("monday");
    expect(t.weekly_tss).toHaveLength(12);
    expect(t.weekly_tss.at(-1).week_start).toBe("2026-11-09");
    expect(Object.keys(t.weekly_tss[0].by_source)).toEqual(["garmin", "peloton", "strava_export", "strength"]);
    const week = t.weekly_tss.at(-2);
    const expected = fixtures.dailyLoad
      .filter((d) => d.date >= week.week_start && d.date <= "2026-11-08")
      .reduce((s, d) => s + d.tssTotal, 0);
    expect(week.total).toBe(r1(expected));
  });

  it("today is the latest stored day, flagged when it is not today", async () => {
    const { tools } = setup((f) => (f.dailyLoad = f.dailyLoad.filter((d) => d.date <= "2026-11-08")));
    const t = body(await tools.training_load({}));
    expect(t.today).toMatchObject({ date: "2026-11-08", is_today: false });
    expect(t.days.at(-1).date).toBe("2026-11-08");
  });

  it("today is the athlete's day: at 01:00Z it is still yesterday in New York", async () => {
    const fx = buildUuidRideFixtures(FIXTURE_NOW);
    const tools = handlersOver(fixtureReads(fx.fixtures), new Date("2026-11-12T01:00:00.000Z"));
    const t = body(await tools.training_load({}));
    expect(t.today).toMatchObject({ date: TODAY, is_today: true });
    expect(t.days.at(-1).date).toBe(TODAY);
    expect(body(await tools.activity_stats({})).as_of).toBe(TODAY);
  });

  it("the weekly total is the stored day total, whatever by_source holds", async () => {
    const { tools } = setup((f) => {
      const last = f.dailyLoad[f.dailyLoad.length - 1];
      f.dailyLoad = [...f.dailyLoad.filter((d) => d.date < "2026-11-09"), { ...last, date: "2026-11-10", tssTotal: 80, tssBySource: {} }];
    });
    const week = body(await tools.training_load({})).weekly_tss.at(-1);
    expect(week).toMatchObject({ week_start: "2026-11-09", total: 80, by_source: { garmin: 0, peloton: 0, strava_export: 0, strength: 0 } });
  });

  it("reads the settings and the daily rows together, from a week before the oldest possible week start", async () => {
    const calls: string[] = [];
    let settingsPending = true;
    const tools = handlersOver({
      ...EMPTY_READS,
      getAthleteSettings: async () => {
        calls.push("settings");
        await Promise.resolve();
        settingsPending = false;
        return EMPTY_READS.getAthleteSettings();
      },
      listDailyTrainingLoad: async (from, to) => {
        calls.push(`load ${from}..${to} settingsPending=${settingsPending}`);
        return [];
      },
    });
    await tools.training_load({ days: 7 });
    // 12 weeks back from a Wednesday can start no earlier than 83 days ago; then 7 more.
    expect(calls).toEqual(["settings", "load 2026-08-13..2026-11-11 settingsPending=true"]);
  });

  it("days bounds the daily rows; out-of-range days is a tool error", async () => {
    const { tools } = setup();
    expect(body(await tools.training_load({ days: 7 })).days).toHaveLength(7);
    expect(text(await tools.training_load({ days: 6 }))).toBe("training_load failed: days must be an integer between 7 and 730, got 6.");
  });

  it("week starts on Sunday when the settings say so", async () => {
    const { tools } = setup((f) => (f.settings = { ...f.settings, weekStart: "sunday" }));
    expect(body(await tools.training_load({})).weekly_tss.at(-1).week_start).toBe("2026-11-08");
  });
});

describe("power_curve", () => {
  it("best power per stored duration with W/kg, eFTP and the manual FTP", async () => {
    const { tools, fixtures } = setup();
    const p = body(await tools.power_curve({}));
    // Every stored row, as sync's eFTP reads them.
    const expectedEftp = eftp(
      fixtures.activities.map((a) => ({ startedAt: a.startedAt, mmp20minW: (a.powerCurve as Record<string, number> | null)?.["1200"] ?? null })),
      TODAY,
    )!;
    expect(p.eftp_w).toBe(Math.round(expectedEftp * 10) / 10);
    expect(p).toMatchObject({ window_days: null, ftp_w: 250, ftp_source: "manual" });

    const kg = weightTrend(fixtures.bodyWeights, TODAY).avg7Kg!;
    expect(p.weight_kg_7d).toBe(Math.round(kg * 10) / 10);
    expect(p.points.map((x: { seconds: number }) => x.seconds)).toEqual([1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200]);
    for (const x of p.points) {
      expect(Object.keys(x)).toEqual(["seconds", "watts", "w_per_kg", "activity_id", "started_at"]);
      expect(x.w_per_kg).toBe(Math.round((x.watts / kg) * 10) / 10);
    }
  });

  it("without a manual FTP, the latest FTP history entry in force is in use, with its source", async () => {
    const { tools } = setup((f) => {
      f.settings = { ...f.settings, manualFtpW: null };
      f.ftpHistory = f.ftpHistory.filter((e) => e.source === "peloton_test"); // 232 W, then 244 W
    });
    expect(body(await tools.power_curve({}))).toMatchObject({ ftp_w: 244, ftp_source: "peloton_test" });
    expect(body(await tools.weight_history({}))).toMatchObject({ ftp_w: 244, ftp_source: "peloton_test" });
  });

  it("with neither a manual FTP nor history the estimated one is in use; window_days narrows the rides", async () => {
    const { tools } = setup((f) => {
      f.settings = { ...f.settings, manualFtpW: null };
      f.ftpHistory = [];
    });
    const p = body(await tools.power_curve({ window_days: 2 }));
    expect(p.ftp_source).toBe("estimated");
    // Sync's resolveFtp: the estimate in whole watts.
    expect(p.ftp_w).toBe(Math.round(p.eftp_w));
    for (const x of p.points) expect(Date.parse(x.started_at)).toBeGreaterThanOrEqual(Date.parse("2026-11-10T00:00:00.000Z"));
    expect(text(await tools.power_curve({ window_days: 0 }))).toBe(
      "power_curve failed: window_days must be an integer between 1 and 3650, got 0.",
    );
  });
});

describe("power_curve over every stored row", () => {
  it("a Garmin recording paired to a weaker Peloton row contributes its 20-minute best", async () => {
    const { tools, ids } = setup((f) => {
      f.settings = { ...f.settings, manualFtpW: null };
      f.ftpHistory = [];
      const peloton = f.activities.find((a) => a.source === "peloton" && a.pairedActivityId !== null)!;
      const garmin = f.activities.find((a) => a.id === peloton.pairedActivityId)!;
      peloton.powerCurve = { "1200": 150 };
      garmin.powerCurve = { "1200": 900 };
    });
    const p = body(await tools.power_curve({}));
    const point = p.points.find((x: { seconds: number }) => x.seconds === 1200);
    expect(point).toMatchObject({ watts: 900, activity_id: ids.pairedGarmin });
    expect(p.eftp_w).toBe(855);
    expect(p).toMatchObject({ ftp_w: 855, ftp_source: "estimated" });
  });
});

describe("weight_history", () => {
  it("weigh-ins in kg and lb, the 7-day average, 4-week change, rate and W/kg band", async () => {
    const { tools, fixtures } = setup();
    const w = body(await tools.weight_history({ days: 30 }));
    const from = Date.parse("2026-10-13T00:00:00.000Z");
    expect(w.weigh_ins).toHaveLength(fixtures.bodyWeights.filter((b) => Date.parse(b.measuredAt) >= from).length);
    expect(Object.keys(w.weigh_ins[0])).toEqual(["measured_at", "weight_kg", "weight_lb"]);
    expect(w.weigh_ins[0].weight_lb).toBe(Math.round((w.weigh_ins[0].weight_kg / 0.45359237) * 10) / 10);

    const trend = weightTrend(fixtures.bodyWeights, TODAY);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    expect(w).toMatchObject({
      avg_7d_kg: r1(trend.avg7Kg!),
      change_4w_kg: r1(trend.change4wKg!),
      rate_per_week_kg: r1(trend.change4wKg! / 4),
      ftp_w: 250,
      ftp_source: "manual",
      w_per_kg: r1(250 / trend.avg7Kg!),
      w_per_kg_band: wPerKgBand(250 / trend.avg7Kg!),
    });
    expect(w.change_4w_kg).toBeLessThan(0);
    expect(w.change_4w_lb).toBe(r1(trend.change4wKg! / 0.45359237));
  });
});

describe("weight_history reads", () => {
  function counting(edit?: (f: RideFixtures) => void) {
    const { fixtures } = setup(edit);
    const inner = fixtureReads(fixtures);
    let activityReads = 0;
    const tools = handlersOver({
      ...inner,
      listExternalActivities: (f) => {
        activityReads++;
        return inner.listExternalActivities(f);
      },
    });
    return { tools, reads: () => activityReads };
  }

  it("reads no activities when a manual FTP or an FTP history entry is in force", async () => {
    const manual = counting();
    expect(body(await manual.tools.weight_history({}))).toMatchObject({ ftp_w: 250, ftp_source: "manual" });
    expect(manual.reads()).toBe(0);
    const history = counting((f) => (f.settings = { ...f.settings, manualFtpW: null }));
    expect(body(await history.tools.weight_history({})).ftp_w).not.toBeNull();
    expect(history.reads()).toBe(0);
  });

  it("reads the activities for the estimate when there is neither", async () => {
    const est = counting((f) => {
      f.settings = { ...f.settings, manualFtpW: null };
      f.ftpHistory = [];
    });
    expect(body(await est.tools.weight_history({})).ftp_source).toBe("estimated");
    expect(est.reads()).toBe(1);
  });
});

describe("sync_status", () => {
  it("one row per source, never the cursor", async () => {
    const { tools } = setup();
    const { sources } = body(await tools.sync_status({}));
    expect(sources.map((s: { source: string }) => s.source)).toEqual(["garmin_activities", "garmin_weight", "peloton"]);
    for (const s of sources) {
      expect(Object.keys(s)).toEqual([
        "source", "last_run_at", "last_success_at", "items_fetched", "items_upserted", "last_error", "backfill_complete", "auth_status",
      ]);
    }
    expect(sources[2]).toMatchObject({ auth_status: "reconnect_required", last_error: expect.stringContaining("invalid_grant") });
  });
});

describe("an empty account", () => {
  it("every tool answers with empty arrays and nulls, never an error (but get_activity's not-found)", async () => {
    const tools = handlersOver(EMPTY_READS);
    expect(body(await tools.list_activities({}))).toEqual({ activities: [] });
    expect(text(await tools.get_activity({ activity_id: MISSING }))).toBe("Activity not found");

    const stats = body(await tools.activity_stats({}));
    expect(stats.all_time).toMatchObject({ count: 0, distance_m: 0, indoor_distance_mi: 0 });
    expect(stats.best_efforts).toHaveLength(15);
    expect(stats.best_efforts.every((r: { activity_id: unknown }) => r.activity_id === null)).toBe(true);
    expect(stats.power_bests.every((r: { watts: unknown }) => r.watts === null)).toBe(true);

    expect(body(await tools.training_load({}))).toEqual({ days: [], today: null, ramp_rate: null, week_start: "monday", weekly_tss: [] });
    expect(body(await tools.power_curve({}))).toEqual({
      window_days: null, points: [], eftp_w: null, ftp_w: null, ftp_source: null, weight_kg_7d: null, weight_lb_7d: null,
    });
    expect(body(await tools.weight_history({}))).toEqual({
      weigh_ins: [], avg_7d_kg: null, avg_7d_lb: null, change_4w_kg: null, change_4w_lb: null,
      rate_per_week_kg: null, rate_per_week_lb: null, ftp_w: null, ftp_source: null, w_per_kg: null, w_per_kg_band: null,
    });
    expect(body(await tools.sync_status({}))).toEqual({ sources: [] });
  });
});

describe("plumbing", () => {
  it("returns exactly the seven ride handlers", () => {
    expect(Object.keys(handlersOver(EMPTY_READS)).sort()).toEqual([...RIDE_TOOL_NAMES].sort());
  });

  it("a failing read is a '<tool> failed:' tool error", async () => {
    const tools = handlersOver({ ...EMPTY_READS, listSyncState: async () => Promise.reject(new Error("boom")) });
    expect(await tools.sync_status({})).toEqual({ isError: true, content: [{ type: "text", text: "sync_status failed: boom" }] });
  });

  it("a backend that refuses the caller answers with its own error and never reads", async () => {
    const denied: CallToolResult = { isError: true, content: [{ type: "text", text: "Invalid bearer token" }] };
    const tools = createRideToolHandlers(async () => denied, { defaultTimeZone: FIXTURE_TIMEZONE });
    for (const name of RIDE_TOOL_NAMES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await (tools[name] as any)({ activity_id: MISSING })).toBe(denied);
    }
  });
});
