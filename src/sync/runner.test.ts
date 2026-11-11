import { describe, expect, it, vi } from "vitest";
import type { DailyTrainingLoad } from "../types.js";
import { fakeGarmin, pagedSearch } from "./garmin/__fixtures__/fakeGarmin.js";
import { JWT_IAT, LIST_PAGE } from "./garmin/__fixtures__/garmin.js";
import { SyncDeadlineError } from "./http.js";
import { PELOTON_TOKEN_URL } from "./peloton/index.js";
import {
  DEFAULT_SYNC_TIMEZONE,
  SyncLoadError,
  dailyLoadFrom,
  deadlineSleep,
  memoizeUntilRejected,
  readSyncEnv,
  runSync,
  todayIn,
  type SyncEnv,
} from "./runner.js";
import { createMemorySyncStore } from "./testing/memoryStore.js";
import type { SyncRunResult } from "./types.js";

const FULL_ENV = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "srk",
  SYNC_OWNER_USER_ID: "owner",
  GARMIN_API_KEY: "garmin-key",
  PELOTON_AUTH0_CLIENT_ID: "client-id",
  CREDENTIALS_KEY: "a2V5",
};

describe("readSyncEnv", () => {
  it("(e) names every missing variable in one error", () => {
    expect(() => readSyncEnv({}, ["garmin", "peloton"])).toThrowError(
      "Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SYNC_OWNER_USER_ID, GARMIN_API_KEY, PELOTON_AUTH0_CLIENT_ID, CREDENTIALS_KEY",
    );
  });

  it("(e) requires only what the requested sources need; blank counts as missing", () => {
    const { GARMIN_API_KEY: _g, ...noGarmin } = FULL_ENV;
    expect(() => readSyncEnv({ ...noGarmin, SYNC_OWNER_USER_ID: "  " }, ["garmin"])).toThrowError(
      "Missing required env vars: SYNC_OWNER_USER_ID, GARMIN_API_KEY",
    );
    expect(readSyncEnv(noGarmin, ["peloton"]).GARMIN_API_KEY).toBeNull();
    const { PELOTON_AUTH0_CLIENT_ID: _p, CREDENTIALS_KEY: _c, ...garminOnly } = FULL_ENV;
    expect(readSyncEnv(garminOnly, ["garmin"]).CREDENTIALS_KEY).toBeNull();
    expect(() => readSyncEnv(garminOnly, ["peloton"])).toThrowError(
      "Missing required env vars: PELOTON_AUTH0_CLIENT_ID, CREDENTIALS_KEY",
    );
  });

  it("reads the optional refresh token and defaults the time zone", () => {
    const env = readSyncEnv(FULL_ENV, ["garmin", "peloton"]);
    expect(env).toMatchObject({ ...FULL_ENV, PELOTON_REFRESH_TOKEN: null, SYNC_DEFAULT_TIMEZONE: "America/New_York" });
    expect(DEFAULT_SYNC_TIMEZONE).toBe("America/New_York");
    const withOptional = readSyncEnv(
      { ...FULL_ENV, PELOTON_REFRESH_TOKEN: "rt", SYNC_DEFAULT_TIMEZONE: "Europe/London" },
      ["peloton"],
    );
    expect(withOptional).toMatchObject({ PELOTON_REFRESH_TOKEN: "rt", SYNC_DEFAULT_TIMEZONE: "Europe/London" });
  });
});

const result = (earliestAffected: string | null, over: Partial<SyncRunResult> = {}): SyncRunResult => ({
  source: "garmin_activities",
  fetched: 0,
  upserted: 0,
  skipped: 0,
  done: true,
  earliestAffected,
  error: null,
  ...over,
});

describe("dailyLoadFrom", () => {
  it("(g) covers at least the last 7 days when nothing was written", () => {
    expect(dailyLoadFrom([], "2026-11-11")).toBe("2026-11-04");
    expect(dailyLoadFrom([result(null), result(null, { error: "boom" })], "2026-03-03")).toBe("2026-02-24");
  });

  it("(g) reaches back to the day before the earliest affected ride", () => {
    expect(
      dailyLoadFrom(
        [result("2026-06-01T14:00:00.000Z"), result("2026-03-02T01:00:00-05:00", { source: "peloton" }), result(null)],
        "2026-11-11",
      ),
    ).toBe("2026-03-01");
  });

  it("(g) keeps the 7-day floor when the earliest ride is recent", () => {
    expect(dailyLoadFrom([result("2026-11-10T23:00:00.000Z")], "2026-11-11")).toBe("2026-11-04");
  });
});

describe("todayIn", () => {
  it("is the calendar date in the zone", () => {
    const ms = Date.parse("2026-11-11T03:00:00.000Z");
    expect(todayIn("America/New_York", ms)).toBe("2026-11-10");
    expect(todayIn("UTC", ms)).toBe("2026-11-11");
  });
});

const NOW = JWT_IAT * 1000 + 3_600_000; // 2026-01-01T01:00Z, inside the synthetic Garmin token's life

const ENV: SyncEnv = {
  ...FULL_ENV,
  PELOTON_REFRESH_TOKEN: null,
  SYNC_DEFAULT_TIMEZONE: "America/New_York",
};

const loadRow = (date: string): DailyTrainingLoad => ({ date, tssTotal: 0, tssBySource: {}, ctl: 10, atl: 10, tsb: 0 });

function setup(today: string, seedDay: string) {
  const garmin = fakeGarmin({ search: pagedSearch(LIST_PAGE) });
  const pelotonCalls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url).hostname.endsWith("garmin.com")) return garmin.fetch(url, init);
    pelotonCalls.push(url);
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 403 });
  });
  // A stored row the day before the expected range start pins where the recompute begins.
  const store = createMemorySyncStore("owner", { dailyLoad: [loadRow(seedDay)] });
  const upsertLoad = vi.spyOn(store, "upsertDailyTrainingLoad");
  const listAll = vi.spyOn(store, "listAllActivities");
  const box = { encrypt: vi.fn(), decrypt: vi.fn() };
  const deps = { store, fetch, sleep: async () => {}, box, env: ENV };
  const opts = { mode: "incremental" as const, deadlineMs: NOW + 60_000, now: () => NOW, today: () => today };
  return { garmin, fetch, pelotonCalls, store, upsertLoad, listAll, deps, opts };
}

describe("runSync", () => {
  it("(d) a throwing Peloton source leaves Garmin finished and the daily load recomputed", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    const realGetSyncState = s.store.getSyncState.bind(s.store);
    vi.spyOn(s.store, "getSyncState").mockImplementation(async (source) => {
      if (source === "peloton") throw new Error("peloton exploded");
      return realGetSyncState(source);
    });

    const results = await runSync(s.deps, { ...s.opts, sources: ["garmin", "peloton"] });

    expect(results.map((r) => r.source)).toEqual(["garmin_activities", "garmin_weight", "peloton"]);
    expect(results[0]).toMatchObject({ fetched: 3, upserted: 3, error: null, earliestAffected: "2026-06-01T14:00:00.000Z" });
    expect(results[1]).toMatchObject({ error: null });
    expect(results[2]).toEqual({
      source: "peloton",
      fetched: 0,
      upserted: 0,
      skipped: 0,
      done: false,
      earliestAffected: null,
      error: "peloton exploded",
    });
    expect(s.store.state.syncState.get("peloton")).toMatchObject({ lastError: "peloton exploded" });
    expect(s.store.state.activities.size).toBe(3);

    // (g) earliest affected 2026-06-01 − 1 day vs today − 7 days: the earlier one, 2026-05-29.
    expect(s.upsertLoad).toHaveBeenCalledTimes(1);
    const rows = s.upsertLoad.mock.calls[0]![0];
    expect(rows[0]!.date).toBe("2026-05-29");
    expect(rows[rows.length - 1]!.date).toBe("2026-06-05");
    expect(rows.find((r) => r.date === "2026-06-01")!.tssTotal).toBeGreaterThan(0);

    // One IngestContext for the whole run.
    expect(s.listAll).toHaveBeenCalledTimes(1);
  });

  it("(g) reaches back past the 7-day floor to the earliest affected day", async () => {
    const s = setup("2026-11-11", "2026-05-30");
    await runSync(s.deps, { ...s.opts, sources: ["garmin"] });
    const rows = s.upsertLoad.mock.calls[0]![0];
    expect(rows[0]!.date).toBe("2026-05-31");
    expect(rows[rows.length - 1]!.date).toBe("2026-11-11");
  });

  it("runs Peloton through the injected fetch and records its auth failure without stopping", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    const results = await runSync(
      { ...s.deps, env: { ...ENV, PELOTON_REFRESH_TOKEN: "bootstrap-token" } },
      { ...s.opts, sources: ["peloton"] },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("peloton");
    expect(results[0]!.error).toBeTruthy();
    expect(results[0]!.error).not.toContain("bootstrap-token");
    expect(s.pelotonCalls[0]).toBe(PELOTON_TOKEN_URL);
    expect(s.garmin.calls).toHaveLength(0);
    expect(s.upsertLoad).toHaveBeenCalledTimes(1);
    expect(s.upsertLoad.mock.calls[0]![0][0]!.date).toBe("2026-05-29");
  });

  it("runs only the requested sources", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    const results = await runSync(s.deps, { ...s.opts, sources: ["garmin"] });
    expect(results.map((r) => r.source)).toEqual(["garmin_activities", "garmin_weight"]);
    expect(s.pelotonCalls).toHaveLength(0);
  });

  it("a failed daily-load recompute throws SyncLoadError carrying the source results", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    s.upsertLoad.mockRejectedValueOnce(new Error("db down"));
    const err = await runSync(s.deps, { ...s.opts, sources: ["garmin"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncLoadError);
    expect((err as SyncLoadError).message).toBe("daily load recompute failed: db down");
    expect((err as SyncLoadError).results.map((r) => [r.source, r.upserted])).toEqual([
      ["garmin_activities", 3],
      ["garmin_weight", 0],
    ]);
  });

  it("a Retry-After past the deadline ends the source with an error instead of sleeping", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    const garmin = fakeGarmin({
      search: () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    });
    const sleep = vi.fn(async () => {});
    const results = await runSync(
      { ...s.deps, fetch: garmin.fetch, sleep },
      { ...s.opts, deadlineMs: NOW + 10_000, sources: ["garmin"] },
    );
    expect(results[0]!.error).toMatch(/wait 30 s, past this run's deadline/);
    expect(sleep).not.toHaveBeenCalledWith(30_000);
  });

  it("a Retry-After past the deadline on a FIT download leaves the ride unstored, not summary-only", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    const slowFit = () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    const garmin = fakeGarmin({ search: pagedSearch(LIST_PAGE), fit: slowFit });
    const results = await runSync(
      { ...s.deps, fetch: garmin.fetch },
      { ...s.opts, deadlineMs: NOW + 10_000, sources: ["garmin"] },
    );
    expect(results[0]).toMatchObject({ source: "garmin_activities", done: false, upserted: 0 });
    expect(results[0]!.error).toMatch(/SyncDeadlineError|past this run's deadline/);
    expect(s.store.state.activities.size).toBe(0);
    expect(s.store.state.syncState.get("garmin_activities")).toMatchObject({ cursor: { mode: "backfill", start: 0 } });

    // The next run, with time to spare, stores all three rides with their streams.
    const rerun = await runSync(s.deps, { ...s.opts, sources: ["garmin"] });
    expect(rerun[0]).toMatchObject({ upserted: 3, error: null });
    expect(s.store.state.streams.size).toBe(3);
  });

  it("gives each source a share of the budget, so a slow Garmin run still leaves Peloton time", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    let t = NOW;
    // Every Garmin ride takes 25 s; three would use the whole 60 s budget.
    const garmin = fakeGarmin({ search: pagedSearch(LIST_PAGE) });
    let tokenCalls = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      if (new URL(url).hostname.endsWith("garmin.com")) {
        if (new URL(url).pathname.startsWith("/activity-service/")) t += 25_000;
        return garmin.fetch(url, init);
      }
      // Peloton's token endpoint asks for a 5 s wait once, then refuses the token.
      return tokenCalls++ === 0
        ? new Response("slow down", { status: 429, headers: { "retry-after": "5" } })
        : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 403 });
    };
    const sleep = vi.fn(async () => {});
    const results = await runSync(
      { ...s.deps, fetch, sleep, env: { ...ENV, PELOTON_REFRESH_TOKEN: "bootstrap-token" } },
      { ...s.opts, now: () => t, deadlineMs: NOW + 60_000, sources: ["garmin", "peloton"] },
    );
    // Garmin activities stop at their 20 s share (one ride), not at the 60 s overall deadline.
    expect(results[0]).toMatchObject({ source: "garmin_activities", upserted: 1, done: false, error: null });
    // Peloton starts with 35 s left, so its 5 s wait runs instead of being refused.
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(results[2]!.source).toBe("peloton");
    expect(results[2]!.error).not.toMatch(/deadline/);
  });

  it("reads today when the daily-load recompute starts, so a run crossing midnight ends on the new day", async () => {
    const s = setup("unused", "2025-12-20");
    // Etc/GMT+1 is UTC-1: the run starts at 23:59:30 on 2025-12-31 there.
    let t = NOW - 30_000;
    const realGetSyncState = s.store.getSyncState.bind(s.store);
    vi.spyOn(s.store, "getSyncState").mockImplementation(async (source) => {
      if (source === "garmin_weight") t += 60_000; // the clock passes midnight mid-run
      return realGetSyncState(source);
    });
    const now = () => t;
    expect(todayIn("Etc/GMT+1", now())).toBe("2025-12-31");
    await runSync(s.deps, { ...s.opts, now, today: () => todayIn("Etc/GMT+1", now()), sources: ["garmin"] });
    const rows = s.upsertLoad.mock.calls[0]![0];
    expect(rows[rows.length - 1]!.date).toBe("2026-01-01");
  });

  it("skipDailyLoadRecompute leaves daily_training_load to the caller", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    const results = await runSync(s.deps, { ...s.opts, sources: ["garmin"], skipDailyLoadRecompute: true });
    expect(results[0]).toMatchObject({ upserted: 3 });
    expect(s.upsertLoad).not.toHaveBeenCalled();
  });

  it("rebuilds the ingest context after a failed build instead of caching the rejection", async () => {
    const s = setup("2026-06-05", "2026-05-28");
    s.listAll.mockRejectedValueOnce(new Error("db blip"));
    const results = await runSync(s.deps, { ...s.opts, sources: ["garmin"] });
    // The first ride's context build fails and ends that run; the cached promise is dropped.
    expect(results[0]!.error).toMatch(/db blip/);
    const rerun = await runSync(s.deps, { ...s.opts, sources: ["garmin"] });
    expect(rerun[0]).toMatchObject({ upserted: 3, error: null });
  });
});

describe("memoizeUntilRejected", () => {
  it("caches a resolved value but retries after a rejection", async () => {
    const f = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error("first")).mockResolvedValue(7);
    const get = memoizeUntilRejected(f);
    await expect(get()).rejects.toThrow("first");
    await expect(get()).resolves.toBe(7);
    await expect(get()).resolves.toBe(7);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("deadlineSleep", () => {
  it("runs short pauses always, and long waits only when they end by the deadline", async () => {
    const sleep = vi.fn(async () => {});
    const guarded = deadlineSleep(sleep, 10_000, () => 9_500);
    await guarded(1_000);
    await expect(guarded(4_000)).rejects.toThrow(SyncDeadlineError);
    await expect(guarded(4_000)).rejects.toThrow("wait 4 s");
    await deadlineSleep(sleep, 10_000, () => 0)(8_000);
    expect(sleep.mock.calls).toEqual([[1_000], [8_000]]);
  });
});
