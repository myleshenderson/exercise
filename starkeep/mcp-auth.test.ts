// @vitest-environment node
/**
 * `POST /mcp` per-user token auth (AI-605).
 *
 * Real: the Hono app, `mcp-auth.ts`, the sealed token, `signedFetch` and the
 * MCP transport. Stubbed: the app credential (`loadAppCredentials`), the data
 * server (global `fetch`, a {@link FakeDataPlane}), and in cloud mode the
 * Cognito exchange (`refreshTokens`) and pool config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDataPlane, fakeJwt, INITIALIZE, mcpHeaders, TEST_CREDS } from "./test-support.js";
import type { ExerciseMcpDeps } from "./mcp.js";

const cognito = vi.hoisted(() => ({
  refreshTokens: vi.fn<(cfg: unknown, rt: string) => Promise<{ idToken: string; accessToken: string; expiresIn: number }>>(),
}));

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: async () => TEST_CREDS };
});

vi.mock("@starkeep/app-client/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client/auth")>();
  return {
    ...actual,
    poolConfig: () => ({ region: "us-east-1", userPoolId: "pool", userPoolClientId: "client" }),
    refreshTokens: cognito.refreshTokens,
  };
});

const { createApp } = await import("./server.js");
const { CognitoError } = await import("@starkeep/app-client/auth");
const { bearerToken, resetMcpAuthCaches } = await import("./mcp-auth.js");

let plane: FakeDataPlane;
let seen: ExerciseMcpDeps[];
let app: ReturnType<typeof createApp>;

function post(token?: string, headers: Record<string, string> = {}) {
  return app.request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders(token), ...headers },
    body: JSON.stringify(INITIALIZE),
  });
}

beforeEach(async () => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  resetMcpAuthCaches();
  cognito.refreshTokens.mockReset();
  plane = new FakeDataPlane();
  vi.stubGlobal("fetch", plane.fetch);
  seen = [];
  const { handleMcpRequest } = await import("./mcp.js");
  app = createApp({
    mcpHandler: (req, deps) => {
      seen.push(deps);
      return handleMcpRequest(req, deps);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.STARKEEP_APP_CLIENT_MODE;
});

describe("POST /mcp, local mode", () => {
  it("no Authorization header → 401 unauthorized", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("garbage tokens → 401 unauthorized, without touching the data plane", async () => {
    for (const token of ["garbage", "exr_garbage", "exr_!!!!"]) {
      const res = await post(token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    const res = await post(undefined, { authorization: "Basic abc" });
    expect(res.status).toBe(401);
    expect(plane.requests).toEqual([]);
  });

  it("valid token with no mcp_tokens row → 401 unauthorized", async () => {
    const { token, id } = plane.seed();
    plane.rows = [];
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(plane.requests[0]!.path).toBe(
      `/app-data/db/mcp_tokens?where=${encodeURIComponent(JSON.stringify({ id }))}&limit=1`,
    );
  });

  it("valid token with an expired row → 401 token_expired", async () => {
    const { token } = plane.seed({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token_expired" });
  });

  it("valid token with a live row → 200, initialize succeeds, context reaches the MCP deps", async () => {
    const { token, id } = plane.seed();
    const res = await post(token);
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { result?: { serverInfo?: { name?: string } }; error?: unknown };
    expect(reply.error).toBeUndefined();
    expect(reply.result?.serverInfo?.name).toBe("exercise");
    expect(seen).toEqual([{ context: { sub: null, userToken: undefined, tokenId: id } }]);
    // Local: HMAC only, never a user token.
    for (const r of plane.requests) {
      expect(r.headers["x-starkeep-app-sig"]).toBeTruthy();
      expect(r.headers["x-starkeep-user-token"]).toBeUndefined();
    }
  });

  it("writes last_used_at at most once a minute per token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
    const { token, id } = plane.seed();

    expect((await post(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);
    expect(plane.requestsTo("PATCH")).toHaveLength(1);
    expect(plane.rows.find((r) => r.id === id)!.last_used_at).toBe("2026-11-07T12:00:00.000Z");

    vi.setSystemTime(new Date("2026-11-07T12:00:59.000Z"));
    expect((await post(token)).status).toBe(200);
    expect(plane.requestsTo("PATCH")).toHaveLength(1);

    vi.setSystemTime(new Date("2026-11-07T12:01:01.000Z"));
    expect((await post(token)).status).toBe(200);
    expect(plane.requestsTo("PATCH")).toHaveLength(2);
    expect(plane.requestsTo("PATCH")[1]!.body).toEqual({
      where: { id },
      patch: { last_used_at: "2026-11-07T12:01:01.000Z" },
    });
  });

  it("a cold process honours a recent last_used_at from the row", async () => {
    const { token } = plane.seed({ lastUsedAt: new Date(Date.now() - 10_000).toISOString() });
    expect((await post(token)).status).toBe(200);
    expect(plane.requestsTo("PATCH")).toHaveLength(0);
  });

  it("data plane failure → 502, not a pass", async () => {
    const { token } = plane.seed();
    plane.failWith = 500;
    const res = await post(token);
    expect(res.status).toBe(502);
  });

  it("GET /mcp → 405", async () => {
    const { token } = plane.seed();
    const res = await app.request("/mcp", { method: "GET", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("POST /mcp, cloud mode", () => {
  const T0 = Date.parse("2026-11-07T12:00:00.000Z");

  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    let n = 0;
    cognito.refreshTokens.mockImplementation(async () => {
      n += 1;
      const idToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "user-a" }) + n;
      return { idToken, accessToken: "access", expiresIn: 3600 };
    });
    // The fake plane scopes rows by the user the ID token was minted for.
    plane.ownerOf = (t) => (t ? "user-a" : null);
  });

  it("mints one ID token for repeated calls and sends it as X-Starkeep-User-Token on the row read", async () => {
    const { token, id } = plane.seed({ owner: "user-a", rt: "refresh-a", sub: "user-a" });
    expect((await post(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);
    expect((await post(token)).status).toBe(200);

    expect(cognito.refreshTokens).toHaveBeenCalledTimes(1);
    expect(cognito.refreshTokens.mock.calls[0]![1]).toBe("refresh-a");
    const idToken = (await cognito.refreshTokens.mock.results[0]!.value).idToken as string;
    const reads = plane.requestsTo("GET");
    expect(reads).toHaveLength(3);
    for (const r of reads) {
      expect(r.headers["x-starkeep-user-token"]).toBe(idToken);
      expect(r.headers["x-starkeep-app-sig"]).toBeTruthy();
    }
    expect(seen.at(-1)).toEqual({ context: { sub: "user-a", userToken: idToken, tokenId: id } });
  });

  it("re-mints within 60 s of the ID token's exp", async () => {
    const { token } = plane.seed({ owner: "user-a", rt: "refresh-a", sub: "user-a" });
    expect((await post(token)).status).toBe(200);

    vi.setSystemTime(T0 + 3600_000 - 61_000);
    expect((await post(token)).status).toBe(200);
    expect(cognito.refreshTokens).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 3600_000 - 59_000);
    expect((await post(token)).status).toBe(200);
    expect(cognito.refreshTokens).toHaveBeenCalledTimes(2);
    const second = (await cognito.refreshTokens.mock.results[1]!.value).idToken as string;
    expect(plane.requestsTo("GET").at(-1)!.headers["x-starkeep-user-token"]).toBe(second);
  });

  it("concurrent first calls share one Cognito exchange", async () => {
    const { token } = plane.seed({ owner: "user-a", rt: "refresh-a", sub: "user-a" });
    const results = await Promise.all([post(token), post(token), post(token)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(cognito.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("Cognito refusing the refresh token → 401 token_expired, no row read", async () => {
    cognito.refreshTokens.mockRejectedValue(
      new CognitoError("Refresh Token has expired", "NotAuthorizedException", 400),
    );
    const { token } = plane.seed({ owner: "user-a", rt: "refresh-a", sub: "user-a" });
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token_expired" });
    expect(plane.requests).toEqual([]);
  });

  it("Cognito failing (5xx, throttling, network) → 503 auth_unavailable, and the next call retries", async () => {
    const { token } = plane.seed({ owner: "user-a", rt: "refresh-a", sub: "user-a" });
    const ok = cognito.refreshTokens.getMockImplementation()!;
    for (const err of [
      new CognitoError("Internal", "InternalErrorException", 500),
      new CognitoError("Slow down", "TooManyRequestsException", 400),
      new TypeError("fetch failed"),
    ]) {
      cognito.refreshTokens.mockRejectedValueOnce(err);
      const res = await post(token);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "auth_unavailable" });
    }
    cognito.refreshTokens.mockImplementation(ok);
    expect((await post(token)).status).toBe(200);
  });

  it("an ID token for a different sub than the sealed one → 401 unauthorized", async () => {
    const { token } = plane.seed({ owner: "user-a", rt: "refresh-a", sub: "user-z" });
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(plane.requests).toEqual([]);
  });

  it("a failed row read drops the cached ID token, so the next call re-mints", async () => {
    const { token } = plane.seed({ owner: "user-a", rt: "refresh-a", sub: "user-a" });
    expect((await post(token)).status).toBe(200);
    plane.failWith = 401;
    expect((await post(token)).status).toBe(502);
    plane.failWith = null;
    expect((await post(token)).status).toBe(200);
    expect(cognito.refreshTokens).toHaveBeenCalledTimes(2);
  });

  it("a locally minted token (no refresh token) → 401 unauthorized", async () => {
    const { token } = plane.seed({ owner: "user-a" });
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(cognito.refreshTokens).not.toHaveBeenCalled();
  });

  it("another user's row is invisible → 401 unauthorized", async () => {
    const { token } = plane.seed({ owner: "user-b", rt: "refresh-a", sub: "user-a" });
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("expired row → 401 token_expired", async () => {
    const { token } = plane.seed({
      owner: "user-a",
      rt: "refresh-a",
      sub: "user-a",
      expiresAt: new Date(T0 - 1).toISOString(),
    });
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token_expired" });
  });
});

describe("bearerToken", () => {
  it("parses only a single-token Bearer header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
