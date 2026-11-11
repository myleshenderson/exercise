// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySyncStore } from "../src/sync/testing/memoryStore.js";
import type { SyncDeps } from "../src/sync/runner.js";
import type { SyncRunResult } from "../src/sync/types.js";
import { SyncLoadError } from "../src/sync/runner.js";
import handler, {
  CRON_BUDGET_MS,
  bearerMatches,
  handleOwnerSync,
  handleSync,
  type HandleOwnerSyncDeps,
  type HandleSyncDeps,
} from "./sync.js";

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
  vi.restoreAllMocks();
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
    });
    expect(opts.today()).toBe("2026-11-11");
    expect(CRON_BUDGET_MS).toBe(50_000);
    expect(opts.now()).toBe(START);
  });

  it("today is the owner's local date, not the UTC one", async () => {
    const { deps } = setup();
    const late = Date.parse("2026-11-11T03:00:00.000Z"); // 22:00 on the 10th in New York
    await handleSync({ authorization: `Bearer ${SECRET}`, method: "GET" }, { ...deps, now: () => late });
    expect((deps.runSync.mock.calls[0] as unknown as Parameters<HandleSyncDeps["runSync"]>)[1].today()).toBe("2026-11-10");
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
  it("(b) answers 405 to PUT", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = fakeRes();
    await handler({ method: "PUT", headers: { authorization: `Bearer ${SECRET}` } }, res);
    expect(res.statusCode).toBe(405);
  });

  it("(AI-653) answers 401 to POST with the cron secret, without reading the sync env", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "");
    const res = fakeRes();
    await handler({ method: "POST", url: "/api/sync", headers: { authorization: [`Bearer ${SECRET}`] } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
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

  it("(a) answers 401 when CRON_SECRET is unset, without naming it", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const res = fakeRes();
    await handler({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(JSON.stringify(res.body)).not.toContain("CRON_SECRET");
  });

  it("logs a thrown error before answering 500, never the bearer", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("SUPABASE_URL", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await handler({ method: "GET", headers: { authorization: `Bearer ${SECRET}` } }, res);
    expect(res.statusCode).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/^sync cron: Missing required env vars: SUPABASE_URL/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });
});

describe("handler logging", () => {
  it("logs each failed source's counts and error, and nothing for clean ones", async () => {
    const { syncDeps } = setup();
    const failed: SyncRunResult = { ...RESULT, source: "peloton", fetched: 4, upserted: 0, skipped: 1, done: false, error: "PelotonHttpError: 503" };
    vi.resetModules();
    vi.doMock("../src/sync/nodeDeps.js", () => ({ createNodeSyncDeps: () => syncDeps }));
    vi.doMock("../src/sync/runner.js", async (orig) => ({
      ...(await orig<typeof import("../src/sync/runner.js")>()),
      runSync: async () => [RESULT, failed],
    }));
    const { default: mockedHandler } = await import("./sync.js");
    for (const [k, v] of Object.entries(syncDeps.env)) vi.stubEnv(k, v ?? undefined);
    vi.stubEnv("CRON_SECRET", SECRET);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await mockedHandler({ method: "GET", headers: { authorization: `Bearer ${SECRET}` } }, res);
    vi.doUnmock("../src/sync/nodeDeps.js");
    vi.doUnmock("../src/sync/runner.js");
    expect(res.statusCode).toBe(200);
    expect(log.mock.calls).toEqual([
      ["sync cron: peloton failed (fetched 4, upserted 0, skipped 1, done false): PelotonHttpError: 503"],
    ]);
  });
});

const TOKEN = "eyJ.owner-access-token.sig";
const OWNER = "owner";

function ownerSetup(user: { id: string } | null = { id: OWNER }) {
  const { syncDeps } = setup();
  const deps = {
    cronSecret: SECRET,
    verifyUser: vi.fn(async (_token: string) => user),
    ownerUserId: OWNER,
    now: () => START,
    makeDeps: vi.fn((_sources: readonly string[]) => syncDeps),
    runSync: vi.fn(async () => [RESULT]),
    recomputeAll: vi.fn(async () => ({ activities: 12, days: 40 })),
  } satisfies HandleOwnerSyncDeps;
  return { deps, syncDeps };
}

const post = (authorization: string | undefined, url = "/api/sync") => ({ authorization, method: "POST", url });

function expectNoWork(deps: ReturnType<typeof ownerSetup>["deps"]) {
  expect(deps.makeDeps).not.toHaveBeenCalled();
  expect(deps.runSync).not.toHaveBeenCalled();
  expect(deps.recomputeAll).not.toHaveBeenCalled();
}

describe("handleOwnerSync (AI-653)", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["unprefixed", TOKEN],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["empty bearer", "Bearer "],
    ["two-part bearer", `Bearer ${TOKEN} extra`],
  ])("answers 401 Unauthorized to a %s bearer without verifying it", async (_label, authorization) => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync(post(authorization), deps);
    expect(r).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(deps.verifyUser).not.toHaveBeenCalled();
    expectNoWork(deps);
  });

  it("answers 401 to the cron secret on POST and never sends it to Supabase", async () => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync(post(`Bearer ${SECRET}`), deps);
    expect(r).toEqual({ status: 401, body: { error: "Unauthorized" } });
    expect(deps.verifyUser).not.toHaveBeenCalled();
    expectNoWork(deps);
  });

  it("answers 401 Invalid session when Supabase knows no user for the token", async () => {
    const { deps } = ownerSetup(null);
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r).toEqual({ status: 401, body: { error: "Invalid session" } });
    expect(deps.verifyUser).toHaveBeenCalledWith(TOKEN);
    expectNoWork(deps);
  });

  it("answers 403 to a signed-in user who is not the owner", async () => {
    const { deps } = ownerSetup({ id: "second-user" });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r).toEqual({ status: 403, body: { error: "Sync is limited to the owner account" } });
    expectNoWork(deps);
  });

  it("answers 403 to everyone when the owner id is unset", async () => {
    const { deps } = ownerSetup({ id: "" });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), { ...deps, ownerUserId: "" });
    expect(r.status).toBe(403);
    expectNoWork(deps);
  });

  it.each(["GET", "PUT", undefined])("answers 405 to %s", async (method) => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync({ ...post(`Bearer ${TOKEN}`), method }, deps);
    expect(r.status).toBe(405);
    expectNoWork(deps);
  });

  it("the owner's sync passes the cron options (incremental Garmin + Peloton, 50 s deadline)", async () => {
    const { deps, syncDeps } = ownerSetup();
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r).toEqual({ status: 200, body: { kind: "sync", results: [RESULT] } });
    expect(deps.makeDeps).toHaveBeenCalledWith(["garmin", "peloton"]);
    const [passedDeps, opts] = deps.runSync.mock.calls[0] as unknown as Parameters<HandleSyncDeps["runSync"]>;
    expect(passedDeps).toBe(syncDeps);
    expect(opts).toMatchObject({ sources: ["garmin", "peloton"], mode: "incremental", deadlineMs: START + 50_000 });
    expect(opts.now()).toBe(START);
    expect(opts.today()).toBe("2026-11-11");
    expect(deps.recomputeAll).not.toHaveBeenCalled();
  });

  it("?recompute=all recomputes with the env time zone and the owner's today, without provider env", async () => {
    const { deps, syncDeps } = ownerSetup();
    const late = Date.parse("2026-11-11T03:00:00.000Z"); // 22:00 on the 10th in New York
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=all"), { ...deps, now: () => late });
    expect(r).toEqual({ status: 200, body: { kind: "recompute", activities: 12, days: 40 } });
    expect(deps.makeDeps).toHaveBeenCalledWith([]);
    expect(deps.recomputeAll).toHaveBeenCalledWith(syncDeps.store, {
      defaultTimeZone: "America/New_York",
      today: "2026-11-10",
    });
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it.each(["/api/sync?recompute=some", "/api/sync?recompute=", "/api/sync?recompute=all&recompute=all", "/api/sync?recompute=ALL"])(
    "answers 400 to %s",
    async (url) => {
      const { deps } = ownerSetup();
      const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, url), deps);
      expect(r).toEqual({ status: 400, body: { error: "recompute must be 'all'" } });
      expectNoWork(deps);
    },
  );

  it("starts the 50 s budget before verifying the session", async () => {
    const { deps } = ownerSetup();
    let t = START;
    const verifyUser = vi.fn(async () => {
      t += 3_000;
      return { id: OWNER };
    });
    await handleOwnerSync(post(`Bearer ${TOKEN}`), { ...deps, verifyUser, now: () => t });
    expect((deps.runSync.mock.calls[0] as unknown as Parameters<HandleSyncDeps["runSync"]>)[1].deadlineMs).toBe(START + 50_000);
  });

  it("reads the query by URL rules", async () => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?x=1&recompute=all#frag"), deps);
    expect(r.body).toMatchObject({ kind: "recompute" });
  });

  it("checks the session before the query, so a stranger learns nothing from a bad recompute", async () => {
    const { deps } = ownerSetup(null);
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=nope"), deps);
    expect(r.status).toBe(401);
  });
});

describe("handler POST (AI-653)", () => {
  const ENV = {
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-value",
    SYNC_OWNER_USER_ID: OWNER,
    GARMIN_API_KEY: "garmin-key-value",
    PELOTON_AUTH0_CLIENT_ID: "peloton-client",
    CREDENTIALS_KEY: "credentials-key-value",
    CRON_SECRET: SECRET,
  };
  const SECRETS = [TOKEN, SECRET, ENV.SUPABASE_SERVICE_ROLE_KEY, ENV.GARMIN_API_KEY, ENV.CREDENTIALS_KEY];

  // After resetModules the handler's runner module (and SyncLoadError class) is a fresh copy.
  let LoadError: typeof SyncLoadError = SyncLoadError;

  async function mockedHandler(runSyncImpl: () => Promise<SyncRunResult[]>, userId = OWNER) {
    const { syncDeps } = setup();
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        auth: {
          getUser: async (token: string) =>
            token === TOKEN ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: new Error("bad jwt") },
        },
      }),
    }));
    vi.doMock("../src/sync/nodeDeps.js", () => ({ createNodeSyncDeps: () => syncDeps }));
    vi.doMock("../src/sync/runner.js", async (orig) => ({
      ...(await orig<typeof import("../src/sync/runner.js")>()),
      runSync: runSyncImpl,
    }));
    vi.doMock("../src/sync/recompute.js", () => ({ recomputeAll: async () => ({ activities: 3, days: 9 }) }));
    const mod = await import("./sync.js");
    LoadError = (await import("../src/sync/runner.js")).SyncLoadError;
    vi.doUnmock("@supabase/supabase-js");
    vi.doUnmock("../src/sync/nodeDeps.js");
    vi.doUnmock("../src/sync/runner.js");
    vi.doUnmock("../src/sync/recompute.js");
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    return mod.default;
  }

  it("answers 200 with the sync results and logs each failed source once", async () => {
    const failed: SyncRunResult = { ...RESULT, source: "peloton", error: "PelotonHttpError: 503" };
    const h = await mockedHandler(async () => [RESULT, failed]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: [`Bearer ${TOKEN}`, "Bearer other"] } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ kind: "sync", results: [RESULT, failed] });
    expect(log.mock.calls).toEqual([
      ["sync owner: peloton failed (fetched 2, upserted 1, skipped 1, done true): PelotonHttpError: 503"],
    ]);
    for (const s of SECRETS) expect(JSON.stringify([res.body, log.mock.calls])).not.toContain(s);
  });

  it("answers 200 with the recompute counts", async () => {
    const h = await mockedHandler(async () => [RESULT]);
    const res = fakeRes();
    await h({ method: "POST", url: "/api/sync?recompute=all", headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ kind: "recompute", activities: 3, days: 9 });
  });

  it("answers 500 with the results on a SyncLoadError, logging the error and each failed source", async () => {
    const failed: SyncRunResult = { ...RESULT, source: "garmin_weight", error: "GarminHttpError: 500" };
    const h = await mockedHandler(async () => {
      throw new LoadError("boom", [RESULT, failed]);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "daily load recompute failed: boom", results: [RESULT, failed] });
    expect(log.mock.calls).toEqual([
      ["sync owner: daily load recompute failed: boom"],
      ["sync owner: garmin_weight failed (fetched 2, upserted 1, skipped 1, done true): GarminHttpError: 500"],
    ]);
    for (const s of SECRETS) expect(JSON.stringify([res.body, log.mock.calls])).not.toContain(s);
  });

  it("names no env var to an unauthenticated caller when the Supabase env is missing", async () => {
    const h = await mockedHandler(async () => [RESULT]);
    vi.stubEnv("SUPABASE_URL", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Sync is not configured" });
    expect(String(log.mock.calls[0]![0])).toMatch(/^sync owner: Missing required env vars: SUPABASE_URL/);
  });

  it("answers 401 Invalid session and 403 without leaking a secret", async () => {
    let h = await mockedHandler(async () => [RESULT]);
    let res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: "Bearer someone-elses-token" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid session" });

    h = await mockedHandler(async () => [RESULT], "second-user");
    res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(403);
    for (const s of SECRETS) expect(JSON.stringify(res.body)).not.toContain(s);
  });
});
