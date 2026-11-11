// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySyncStore } from "../src/sync/testing/memoryStore.js";
import type { SyncDeps } from "../src/sync/runner.js";
import type { SyncRunResult } from "../src/sync/types.js";
import handler, { CRON_BUDGET_MS, bearerMatches, handleSync, type HandleSyncDeps } from "./sync.js";

const SECRET = "cron-secret-value";
const START = Date.parse("2026-11-11T10:00:00.000Z");

const RESULT: SyncRunResult = {
  source: "garmin_activities",
  fetched: 2,
  upserted: 1,
  skipped: 1,
  done: true,
  earliestAffected: "2026-11-10T12:00:00.000Z",
  error: null,
};

function setup() {
  const syncDeps: SyncDeps = {
    store: createMemorySyncStore("owner"),
    fetch: vi.fn(),
    sleep: async () => {},
    box: { encrypt: vi.fn(), decrypt: vi.fn() },
    env: {
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "srk",
      SYNC_OWNER_USER_ID: "owner",
      GARMIN_API_KEY: "g",
      PELOTON_AUTH0_CLIENT_ID: "c",
      CREDENTIALS_KEY: "k",
      PELOTON_REFRESH_TOKEN: null,
      SYNC_DEFAULT_TIMEZONE: "America/New_York",
    },
  };
  const deps = {
    cronSecret: SECRET,
    now: () => START,
    makeDeps: vi.fn(() => syncDeps),
    runSync: vi.fn(async () => [RESULT]),
  } satisfies HandleSyncDeps;
  return { deps, syncDeps };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("handleSync", () => {
  it.each([
    ["missing", undefined],
    ["wrong", "Bearer not-the-secret"],
    ["unprefixed", SECRET],
    ["wrong scheme", `Basic ${SECRET}`],
    ["trailing space", `Bearer ${SECRET} `],
  ])("(a) answers 401 to a %s bearer and does no work", async (_label, authorization) => {
    const { deps } = setup();
    const r = await handleSync({ authorization, method: "GET" }, deps);
    expect(r.status).toBe(401);
    expect(deps.makeDeps).not.toHaveBeenCalled();
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it("(a) refuses every bearer when CRON_SECRET is empty", async () => {
    const { deps } = setup();
    const r = await handleSync({ authorization: "Bearer ", method: "GET" }, { ...deps, cronSecret: "" });
    expect(r.status).toBe(401);
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "DELETE", undefined])("(b) answers 405 to %s, even with a good bearer", async (method) => {
    const { deps } = setup();
    const r = await handleSync({ authorization: `Bearer ${SECRET}`, method }, deps);
    expect(r.status).toBe(405);
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it("(c) a good bearer runs an incremental Garmin + Peloton sync with a 50 s deadline", async () => {
    const { deps, syncDeps } = setup();
    const r = await handleSync({ authorization: `Bearer ${SECRET}`, method: "GET" }, deps);
    expect(r).toEqual({ status: 200, body: [RESULT] });
    expect(deps.runSync).toHaveBeenCalledTimes(1);
    const [passedDeps, opts] = deps.runSync.mock.calls[0] as unknown as Parameters<HandleSyncDeps["runSync"]>;
    expect(passedDeps).toBe(syncDeps);
    expect(opts).toMatchObject({
      sources: ["garmin", "peloton"],
      mode: "incremental",
      deadlineMs: START + 50_000,
      today: "2026-11-11",
    });
    expect(CRON_BUDGET_MS).toBe(50_000);
    expect(opts.now()).toBe(START);
  });

  it("today is the owner's local date, not the UTC one", async () => {
    const { deps } = setup();
    const late = Date.parse("2026-11-11T03:00:00.000Z"); // 22:00 on the 10th in New York
    await handleSync({ authorization: `Bearer ${SECRET}`, method: "GET" }, { ...deps, now: () => late });
    expect((deps.runSync.mock.calls[0] as unknown as Parameters<HandleSyncDeps["runSync"]>)[1].today).toBe("2026-11-10");
  });
});

describe("bearerMatches", () => {
  it("matches only the exact header", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(bearerMatches(undefined, SECRET)).toBe(false);
  });
});

describe("handler", () => {
  it("(b) answers 405 to POST", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = fakeRes();
    await handler({ method: "POST", headers: { authorization: `Bearer ${SECRET}` } }, res);
    expect(res.statusCode).toBe(405);
  });

  it("(a) answers 401 without reading the sync env", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "");
    const res = fakeRes();
    await handler({ method: "GET", headers: { authorization: "Bearer nope" } }, res);
    // A 500 (missing SUPABASE_URL) would mean the sync deps were built before the check.
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
