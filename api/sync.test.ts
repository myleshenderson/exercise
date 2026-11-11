// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySyncStore } from "../src/sync/testing/memoryStore.js";
import type { SyncDeps } from "../src/sync/runner.js";
import type { SyncRunResult } from "../src/sync/types.js";
import { SyncLoadError, SyncLockLostError } from "../src/sync/runner.js";
import { SyncLockBusyError, type SyncLease } from "../src/sync/lock.js";
import handler, {
  CRON_BUDGET_MS,
  HTTP_SYNC_LOCK_TTL_MS,
  bearerMatches,
  budgetedSyncOptions,
  verifySupabaseUser,
  handleOwnerSync,
  handleSync,
  type HandleOwnerSyncDeps,
  type HandleSyncDeps,
  type VerifyUserResult,
} from "./sync.js";

const SECRET = "cron-secret-value";
const START = Date.parse("2026-11-11T10:00:00.000Z");

/** The lease every fake lock hands its fn (AI-659). */
const LEASE: SyncLease = { lost: () => false };
const CRON_CLIENT = { name: "cron service-role client" };

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
    makeDeps: vi.fn(() => ({ deps: syncDeps, client: CRON_CLIENT })),
    runSync: vi.fn(async () => [RESULT]),
    withSyncLock: vi.fn(<T,>(_client: typeof CRON_CLIENT, fn: (lease: SyncLease) => Promise<T>) => fn(LEASE)),
  } satisfies HandleSyncDeps<typeof CRON_CLIENT>;
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

describe("handleSync lease (AI-659)", () => {
  it("runs the sync inside withSyncLock on the client makeDeps built, passing the lease's lost()", async () => {
    const { deps } = setup();
    deps.withSyncLock.mockImplementation(async <T,>(client: typeof CRON_CLIENT, fn: (lease: SyncLease) => Promise<T>) => {
      expect(client).toBe(CRON_CLIENT);
      expect(deps.runSync).not.toHaveBeenCalled();
      const r = await fn(LEASE);
      expect(deps.runSync).toHaveBeenCalledTimes(1);
      return r;
    });
    const r = await handleSync({ authorization: `Bearer ${SECRET}`, method: "GET" }, deps);
    expect(r.status).toBe(200);
    expect(deps.withSyncLock).toHaveBeenCalledTimes(1);
    expect((deps.runSync.mock.calls[0] as unknown as Parameters<HandleSyncDeps["runSync"]>)[1].lost).toBe(LEASE.lost);
  });

  it("answers 409 'sync already running' while another run holds the lease", async () => {
    const { deps } = setup();
    deps.withSyncLock.mockImplementation(async () => {
      throw new SyncLockBusyError();
    });
    const r = await handleSync({ authorization: `Bearer ${SECRET}`, method: "GET" }, deps);
    expect(r).toEqual({ status: 409, body: { error: "sync already running" } });
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it("does not take the lease for an unauthorised call", async () => {
    const { deps } = setup();
    await handleSync({ authorization: "Bearer nope", method: "GET" }, deps);
    expect(deps.withSyncLock).not.toHaveBeenCalled();
  });

  it("lets a lock database error through as a 500-bound throw, not a 409", async () => {
    const { deps } = setup();
    deps.withSyncLock.mockImplementation(async () => {
      throw new Error("sync lock acquire failed: boom");
    });
    await expect(handleSync({ authorization: `Bearer ${SECRET}`, method: "GET" }, deps)).rejects.toThrow(/acquire failed/);
  });
});

describe("handler logging", () => {
  it("logs each failed source's counts and error, and nothing for clean ones", async () => {
    const { syncDeps } = setup();
    const failed: SyncRunResult = { ...RESULT, source: "peloton", fetched: 4, upserted: 0, skipped: 1, done: false, error: "PelotonHttpError: 503" };
    vi.resetModules();
    const client = { name: "service-role client" };
    const lock = vi.fn(<T,>(_client: unknown, fn: (lease: SyncLease) => Promise<T>, _opts?: unknown) => fn(LEASE));
    vi.doMock("../src/sync/nodeDeps.js", () => ({ createNodeSyncDeps: () => syncDeps, createServiceClient: () => client }));
    vi.doMock("../src/sync/lock.js", async (orig) => ({
      ...(await orig<typeof import("../src/sync/lock.js")>()),
      withSyncLock: lock,
    }));
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
    vi.doUnmock("../src/sync/lock.js");
    expect(res.statusCode).toBe(200);
    // The cron run held the lease on the client makeDeps built (AI-659).
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.calls[0]![0]).toBe(client);
    expect(lock.mock.calls[0]![2]).toEqual({ label: "cron", ttlMs: HTTP_SYNC_LOCK_TTL_MS });
    expect(HTTP_SYNC_LOCK_TTL_MS).toBe(120_000);
    expect(log.mock.calls).toEqual([
      ["sync cron: peloton failed (fetched 4, upserted 0, skipped 1, done false): PelotonHttpError: 503"],
    ]);
  });
});

const TOKEN = "eyJ.owner-access-token.sig";
const OWNER = "owner";

const CLIENT = { name: "service-role client" };

function ownerSetup(user: VerifyUserResult = { kind: "user", id: OWNER }) {
  const { syncDeps } = setup();
  const deps = {
    cronSecret: SECRET,
    now: () => START,
    readEnv: vi.fn((_sources: readonly string[]) => syncDeps.env),
    createClient: vi.fn((_env: unknown) => CLIENT),
    verifyUser: vi.fn(async (_client: typeof CLIENT, _token: string) => user),
    makeDeps: vi.fn((_env: unknown, _client: typeof CLIENT) => syncDeps),
    runSync: vi.fn(async () => [RESULT]),
    withSyncLock: vi.fn(<T,>(_client: typeof CLIENT, fn: (lease: SyncLease) => Promise<T>) => fn(LEASE)),
    recomputeAll: vi.fn(async () => ({ activities: 12, days: 40, done: true, nextOffset: null })),
  } satisfies HandleOwnerSyncDeps<typeof CLIENT>;
  return { deps, syncDeps };
}

const post = (authorization: string | undefined, url = "/api/sync") => ({ authorization, method: "POST", url });

function expectNoWork(deps: ReturnType<typeof ownerSetup>["deps"]) {
  expect(deps.makeDeps).not.toHaveBeenCalled();
  expect(deps.runSync).not.toHaveBeenCalled();
  expect(deps.recomputeAll).not.toHaveBeenCalled();
}

describe("handleOwnerSync lease (AI-659)", () => {
  it("runs the owner's sync inside withSyncLock on the request's client", async () => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r.status).toBe(200);
    expect(deps.withSyncLock).toHaveBeenCalledTimes(1);
    expect(deps.withSyncLock.mock.calls[0]![0]).toBe(CLIENT);
  });

  it("answers 409 'sync already running' while another run holds the lease", async () => {
    const { deps } = ownerSetup();
    deps.withSyncLock.mockImplementation(async () => {
      throw new SyncLockBusyError();
    });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r).toEqual({ status: 409, body: { error: "sync already running" } });
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it("runs ?recompute=all inside withSyncLock on the request's client", async () => {
    const { deps } = ownerSetup();
    deps.withSyncLock.mockImplementation(async <T,>(client: typeof CLIENT, fn: (lease: SyncLease) => Promise<T>) => {
      expect(client).toBe(CLIENT);
      expect(deps.recomputeAll).not.toHaveBeenCalled();
      return fn(LEASE);
    });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=all"), deps);
    expect(r.status).toBe(200);
    expect(deps.withSyncLock).toHaveBeenCalledTimes(1);
    expect(deps.recomputeAll).toHaveBeenCalledTimes(1);
  });

  it("answers 409 to ?recompute=all while another run holds the lease", async () => {
    const { deps } = ownerSetup();
    deps.withSyncLock.mockImplementation(async () => {
      throw new SyncLockBusyError();
    });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=all"), deps);
    expect(r).toEqual({ status: 409, body: { error: "sync already running" } });
    expect(deps.recomputeAll).not.toHaveBeenCalled();
  });

  it("does not take the lease for a non-owner", async () => {
    const { deps } = ownerSetup({ kind: "user", id: "someone-else" });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r.status).toBe(403);
    expect(deps.withSyncLock).not.toHaveBeenCalled();
  });
});

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
    const { deps } = ownerSetup({ kind: "invalid" });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r).toEqual({ status: 401, body: { error: "Invalid session" } });
    expect(deps.verifyUser).toHaveBeenCalledWith(CLIENT, TOKEN);
    expectNoWork(deps);
  });

  it("answers 503 when Supabase Auth is unavailable, logging the status but never the token", async () => {
    const { deps } = ownerSetup({ kind: "unavailable", status: 503 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r).toEqual({ status: 503, body: { error: "Auth service unavailable" } });
    expect(log.mock.calls).toEqual([["sync owner: auth service unavailable (status 503)"]]);
    expectNoWork(deps);
  });

  it("answers 403 to a signed-in user who is not the owner", async () => {
    const { deps } = ownerSetup({ kind: "user", id: "second-user" });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(r).toEqual({ status: 403, body: { error: "Sync is limited to the owner account" } });
    expectNoWork(deps);
  });

  it("answers 500 Sync is not configured when the owner id is unset, before verifying anyone", async () => {
    const { deps, syncDeps } = ownerSetup({ kind: "user", id: "" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`), {
      ...deps,
      readEnv: () => ({ ...syncDeps.env, SYNC_OWNER_USER_ID: "" }),
    });
    expect(r).toEqual({ status: 500, body: { error: "Sync is not configured" } });
    expect(log).toHaveBeenCalledWith("sync owner: SYNC_OWNER_USER_ID is not set");
    expect(deps.verifyUser).not.toHaveBeenCalled();
    expectNoWork(deps);
  });

  it("reads the env and creates the client once, sharing the client between the token check and the store", async () => {
    const { deps, syncDeps } = ownerSetup();
    await handleOwnerSync(post(`Bearer ${TOKEN}`), deps);
    expect(deps.readEnv.mock.calls).toEqual([[["garmin", "peloton"]]]);
    expect(deps.createClient.mock.calls).toEqual([[syncDeps.env]]);
    expect(deps.verifyUser).toHaveBeenCalledWith(CLIENT, TOKEN);
    expect(deps.makeDeps.mock.calls).toEqual([[syncDeps.env, CLIENT]]);
  });

  it("answers 400 Bad request URL to a URL the parser rejects", async () => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "//"), deps);
    expect(r).toEqual({ status: 400, body: { error: "Bad request URL" } });
    expect(deps.verifyUser).not.toHaveBeenCalled();
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
    expect(deps.readEnv).toHaveBeenCalledWith(["garmin", "peloton"]);
    const [passedDeps, opts] = deps.runSync.mock.calls[0] as unknown as Parameters<HandleSyncDeps["runSync"]>;
    expect(passedDeps).toBe(syncDeps);
    expect(opts).toMatchObject({ sources: ["garmin", "peloton"], mode: "incremental", deadlineMs: START + 50_000 });
    expect(opts.now()).toBe(START);
    expect(opts.today()).toBe("2026-11-11");
    expect(deps.recomputeAll).not.toHaveBeenCalled();
  });

  it("?recompute=all recomputes with the env time zone, the owner's today and the 50 s deadline, without provider env", async () => {
    const { deps, syncDeps } = ownerSetup();
    const late = Date.parse("2026-11-11T03:00:00.000Z"); // 22:00 on the 10th in New York
    const now = () => late;
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=all"), { ...deps, now });
    expect(r).toEqual({ status: 200, body: { kind: "recompute", activities: 12, days: 40, done: true, nextOffset: null } });
    expect(deps.readEnv).toHaveBeenCalledWith([]);
    expect(deps.recomputeAll).toHaveBeenCalledWith(syncDeps.store, {
      defaultTimeZone: "America/New_York",
      today: "2026-11-10",
      deadlineMs: late + 50_000,
      offset: 0,
      now,
    });
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it("?recompute=all&offset=n resumes at n and passes through a pass that stopped at its deadline", async () => {
    const { deps } = ownerSetup();
    deps.recomputeAll.mockResolvedValueOnce({ activities: 300, days: 0, done: false, nextOffset: 340 } as never);
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=all&offset=40"), deps);
    expect(r).toEqual({ status: 200, body: { kind: "recompute", activities: 300, days: 0, done: false, nextOffset: 340 } });
    expect(deps.recomputeAll.mock.calls[0]![1]).toMatchObject({ offset: 40, deadlineMs: START + 50_000 });
  });

  it.each(["-1", "1.5", "abc", "", "1e3", "99999999999999999999"])("answers 400 to offset=%s", async (offset) => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, `/api/sync?recompute=all&offset=${offset}`), deps);
    expect(r).toEqual({ status: 400, body: { error: "offset must be a non-negative integer" } });
    expectNoWork(deps);
  });

  it("answers 400 to a repeated offset", async () => {
    const { deps } = ownerSetup();
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=all&offset=1&offset=2"), deps);
    expect(r.status).toBe(400);
    expectNoWork(deps);
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
    const verifyUser = vi.fn(async (): Promise<VerifyUserResult> => {
      t += 3_000;
      return { kind: "user", id: OWNER };
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
    const { deps } = ownerSetup({ kind: "invalid" });
    const r = await handleOwnerSync(post(`Bearer ${TOKEN}`, "/api/sync?recompute=nope"), deps);
    expect(r.status).toBe(401);
  });
});

describe("budgetedSyncOptions (AI-653)", () => {
  it("is the one source of the cron and owner run options", async () => {
    const cron = setup();
    await handleSync({ authorization: `Bearer ${SECRET}`, method: "GET" }, cron.deps);
    const owner = ownerSetup();
    await handleOwnerSync(post(`Bearer ${TOKEN}`), owner.deps);
    const expected = budgetedSyncOptions(cron.syncDeps.env, START, () => START, LEASE.lost);
    for (const opts of [cron.deps.runSync.mock.calls[0], owner.deps.runSync.mock.calls[0]].map(
      (c) => (c as unknown as Parameters<HandleSyncDeps["runSync"]>)[1],
    )) {
      expect(Object.keys(opts).sort()).toEqual(Object.keys(expected).sort());
      expect({ ...opts, now: opts.now(), today: opts.today() }).toEqual({ ...expected, now: START, today: "2026-11-11" });
    }
  });
});

describe("verifySupabaseUser (AI-653)", () => {
  const client = (result: { data: { user: { id: string } | null }; error: unknown }) =>
    ({ auth: { getUser: vi.fn(async () => result) } }) as unknown as Parameters<typeof verifySupabaseUser>[0];
  const authError = (name: string, status: number | undefined) => Object.assign(new Error("x"), { name, status });

  it("returns the user id for a valid token", async () => {
    expect(await verifySupabaseUser(client({ data: { user: { id: OWNER } }, error: null }), TOKEN)).toEqual({ kind: "user", id: OWNER });
  });

  it.each([
    ["a 401 rejection", authError("AuthApiError", 401)],
    ["a 403 bad jwt", authError("AuthApiError", 403)],
    ["an error without a status", authError("AuthSessionMissingError", undefined)],
  ])("treats %s as an invalid session", async (_label, error) => {
    expect(await verifySupabaseUser(client({ data: { user: null }, error }), TOKEN)).toEqual({ kind: "invalid" });
  });

  it("treats no user without an error as an invalid session", async () => {
    expect(await verifySupabaseUser(client({ data: { user: null }, error: null }), TOKEN)).toEqual({ kind: "invalid" });
  });

  it.each([
    ["a 503", authError("AuthApiError", 503), 503],
    ["a 500", authError("AuthUnknownError", 500), 500],
    ["status 0", authError("AuthApiError", 0), 0],
    ["AuthRetryableFetchError", authError("AuthRetryableFetchError", 429), 429],
  ])("treats %s as the auth service being unavailable", async (_label, error, status) => {
    expect(await verifySupabaseUser(client({ data: { user: null }, error }), TOKEN)).toEqual({ kind: "unavailable", status });
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
  let LockLostError: typeof SyncLockLostError = SyncLockLostError;
  let createdClients: [string, string][] = [];
  let lockCalls: unknown[] = [];
  beforeEach(() => {
    createdClients = [];
    lockCalls = [];
  });

  async function mockedHandler(
    runSyncImpl: () => Promise<SyncRunResult[]>,
    userId = OWNER,
    authFailure: { name: string; status: number } = { name: "AuthApiError", status: 403 },
  ) {
    const { syncDeps } = setup();
    vi.resetModules();
    const fakeClient = {
      auth: {
        getUser: async (token: string) =>
          token === TOKEN
            ? { data: { user: { id: userId } }, error: null }
            : { data: { user: null }, error: Object.assign(new Error("bad jwt"), authFailure) },
      },
    };
    vi.doMock("../src/sync/nodeDeps.js", () => ({
      createNodeSyncDeps: () => syncDeps,
      createServiceClient: (env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }) => {
        createdClients.push([env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY]);
        return fakeClient;
      },
    }));
    vi.doMock("../src/sync/runner.js", async (orig) => ({
      ...(await orig<typeof import("../src/sync/runner.js")>()),
      runSync: runSyncImpl,
    }));
    vi.doMock("../src/sync/recompute.js", () => ({
      recomputeAll: async () => ({ activities: 3, days: 9, done: true, nextOffset: null }),
    }));
    // The lease itself is covered in src/sync/lock.test.ts; here it must wrap the run on this client.
    vi.doMock("../src/sync/lock.js", async (orig) => ({
      ...(await orig<typeof import("../src/sync/lock.js")>()),
      withSyncLock: async <T,>(client: unknown, fn: (lease: SyncLease) => Promise<T>, opts: unknown) => {
        expect(client).toBe(fakeClient);
        lockCalls.push(opts);
        return fn(LEASE);
      },
    }));
    const mod = await import("./sync.js");
    ({ SyncLoadError: LoadError, SyncLockLostError: LockLostError } = await import("../src/sync/runner.js"));
    vi.doUnmock("../src/sync/nodeDeps.js");
    vi.doUnmock("../src/sync/runner.js");
    vi.doUnmock("../src/sync/recompute.js");
    vi.doUnmock("../src/sync/lock.js");
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
    expect(lockCalls).toEqual([{ label: "owner", ttlMs: HTTP_SYNC_LOCK_TTL_MS }]);
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
    expect(res.body).toEqual({ kind: "recompute", activities: 3, days: 9, done: true, nextOffset: null });
    expect(lockCalls).toEqual([{ label: "owner", ttlMs: HTTP_SYNC_LOCK_TTL_MS }]);
    expect(createdClients).toEqual([[ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY]]);
  });

  it("answers 503 Auth service unavailable when getUser fails with a 5xx, logging the status only", async () => {
    const h = await mockedHandler(async () => [RESULT], OWNER, { name: "AuthRetryableFetchError", status: 502 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: "Bearer another-token" } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "Auth service unavailable" });
    expect(log.mock.calls).toEqual([["sync owner: auth service unavailable (status 502)"]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("another-token");
  });

  it("answers 500 Sync is not configured when SYNC_OWNER_USER_ID is unset", async () => {
    const h = await mockedHandler(async () => [RESULT]);
    vi.stubEnv("SYNC_OWNER_USER_ID", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Sync is not configured" });
  });

  it("answers 400 Bad request URL instead of 500 for an unparseable URL", async () => {
    const h = await mockedHandler(async () => [RESULT]);
    const res = fakeRes();
    await h({ method: "POST", url: "//", headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Bad request URL" });
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

  it("answers 500 'sync lock lost' with the results when the run lost its lease (AI-659)", async () => {
    const h = await mockedHandler(async () => {
      throw new LockLostError([RESULT]);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    await h({ method: "POST", url: "/api/sync", headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "sync lock lost", results: [RESULT] });
    expect(log.mock.calls).toEqual([["sync owner: sync lock lost"]]);
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
