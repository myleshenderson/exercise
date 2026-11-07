// @vitest-environment node
/**
 * The browser data proxy at `/api/local-data/*` (AI-603).
 *
 * The real `createDataProxyHandler` and `sessionAuth()` from
 * `@starkeep/app-client` run in every test. Two things are stubbed:
 *
 *   - the session: `sessionAuth()` is wrapped so a test can swap its
 *     `verifySession` for a stub, which stands in for a Cognito cookie. The
 *     stubbed form also sets `allowAnonymousLocal: false`, so the check runs
 *     on the local surface too: cloud mode would load the HMAC secret from
 *     SSM, which a unit test cannot reach. The 401 test uses the real
 *     verifier in cloud mode, where it fails before any credential load;
 *   - the upstream: global `fetch` is stubbed, so nothing reaches a data server
 *     (or Cognito), and the forwarded request can be inspected.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as appClient from "@starkeep/app-client";

const state = vi.hoisted(() => ({
  /** null: the real `verifySession`. true/false: a stubbed session. */
  stubSession: null as boolean | null,
  verifyCalls: 0,
  proxyOptions: [] as unknown[],
}));

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return {
    ...actual,
    createDataProxyHandler: (opts: Parameters<typeof actual.createDataProxyHandler>[0]) => {
      state.proxyOptions.push(opts);
      return actual.createDataProxyHandler(opts);
    },
    sessionAuth: (opts?: Parameters<typeof actual.sessionAuth>[0]) => {
      const real = actual.sessionAuth(opts);
      const stub = state.stubSession;
      if (stub === null || real.auth !== "session") return real;
      return {
        ...real,
        allowAnonymousLocal: false,
        verifySession: async () => {
          state.verifyCalls += 1;
          return stub;
        },
      };
    },
  };
});

const { createApp } = await import("./server.js");

const PROGRAMS = "/api/local-data/app-data/db/programs";
const ENV_KEYS = ["STARKEEP_APP_CLIENT_MODE", "STARKEEP_DIR"] as const;

let savedEnv: Record<string, string | undefined>;
let starkeepDir: string;
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  starkeepDir = mkdtempSync(join(tmpdir(), "exercise-proxy-"));
  mkdirSync(join(starkeepDir, "app-creds"));
  writeFileSync(
    join(starkeepDir, "app-creds", "exercise.json"),
    JSON.stringify({ appId: "exercise", hmacSecret: "test-secret", dataServerUrl: "http://data.test" }),
  );
  process.env.STARKEEP_DIR = starkeepDir;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  appClient.clearAppCredentialsCache();
  state.stubSession = null;
  state.verifyCalls = 0;
  state.proxyOptions.length = 0;
  fetchStub = vi.fn(async () =>
    Response.json({ rows: [], truncated: false, page_token: null }, { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  appClient.clearAppCredentialsCache();
  rmSync(starkeepDir, { recursive: true, force: true });
});

describe("/api/local-data/* data proxy", () => {
  it("is built exactly as photos builds it: appId + sessionAuth() with default options", () => {
    createApp();
    expect(state.proxyOptions).toHaveLength(1);
    const opts = state.proxyOptions[0] as appClient.DataProxyOptions;
    expect(opts.appId).toBe("exercise");
    expect(opts.endUserAuth.auth).toBe("session");
    expect(opts.endUserAuth).not.toHaveProperty("allowAnonymousLocal");
    expect(opts.onUnauthenticated).toBeUndefined();
    expect(opts.onMissingCredentials).toBeUndefined();
  });

  it("cloud, no session → 401 from sessionAuth(), nothing forwarded", async () => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const app = createApp();
    const res = await app.request(PROGRAMS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("stubbed session rejected → 401, nothing forwarded", async () => {
    state.stubSession = false;
    const app = createApp();
    // JSON, as the browser sends: a text/plain POST is refused locally by the
    // Content-Type gate (AI-606) before sessionAuth() runs.
    const res = await app.request(PROGRAMS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(state.verifyCalls).toBe(1);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("stubbed valid session → forwarded, signed, to the data server path after the mount", async () => {
    state.stubSession = true;
    const app = createApp();
    const res = await app.request(`${PROGRAMS}?where=%7B%22archived_at%22%3A%7B%22is%22%3Anull%7D%7D&limit=5`);
    expect(res.status).toBe(200);
    expect(state.verifyCalls).toBe(1);
    expect(await res.json()).toEqual({ rows: [], truncated: false, page_token: null });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://data.test/app-data/db/programs?where=%7B%22archived_at%22%3A%7B%22is%22%3Anull%7D%7D&limit=5",
    );
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Starkeep-App-Id"]).toBe("exercise");
    expect(headers["X-Starkeep-App-Sig"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("forwards %s with its JSON body", async (method) => {
    state.stubSession = true;
    const app = createApp();
    const body = JSON.stringify({ id: "p1", name: "Push", archived_at: "2026-11-07T00:00:00.000Z" });
    const res = await app.request(`${PROGRAMS}/p1`, {
      method,
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(state.verifyCalls).toBe(1);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://data.test/app-data/db/programs/p1");
    expect(init.method).toBe(method);
    expect(init.body).toBe(body);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("local mode, no session → forwarded (local stays open, the sessionAuth() default)", async () => {
    const app = createApp();
    const res = await app.request(PROGRAMS);
    expect(res.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
