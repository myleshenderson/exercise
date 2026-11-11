import { describe, expect, it, vi } from "vitest";
import type { DailyTrainingLoad } from "../types.js";
import { fakeGarmin, pagedSearch } from "./garmin/__fixtures__/fakeGarmin.js";
import { JWT_IAT, LIST_PAGE } from "./garmin/__fixtures__/garmin.js";
import { PELOTON_TOKEN_URL } from "./peloton/index.js";
import {
  DEFAULT_SYNC_TIMEZONE,
  SyncLoadError,
  dailyLoadFrom,
  deadlineSleep,
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
  const opts = { mode: "incremental" as const, deadlineMs: NOW + 60_000, now: () => NOW, today };
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
});

describe("deadlineSleep", () => {
  it("runs short pauses always, and long waits only when they end by the deadline", async () => {
    const sleep = vi.fn(async () => {});
    const guarded = deadlineSleep(sleep, 10_000, () => 9_500);
    await guarded(1_000);
    await expect(guarded(4_000)).rejects.toThrow("wait 4 s");
    await deadlineSleep(sleep, 10_000, () => 0)(8_000);
    expect(sleep.mock.calls).toEqual([[1_000], [8_000]]);
  });
});
