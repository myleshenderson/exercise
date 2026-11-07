// @vitest-environment node
/**
 * `POST /api/mcp-login` (AI-605). Response shapes follow `api/mcp-login.ts`
 * and `api/mcp-login.test.ts`: `{ token }` on success (plus `expires_at`,
 * which the screen shows), `{ error }` otherwise, 405 "Method not allowed",
 * 401 "Invalid session", 500 "Could not create token".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDataPlane, fakeJwt, INITIALIZE, mcpHeaders, TEST_CREDS, TEST_SECRET } from "./test-support.js";
import { tokenIdHash, unsealToken } from "./token.js";

const session = vi.hoisted(() => ({
  /** Login proves the refresh token: `refreshTokens` then `verifyIdToken`. */
  refreshTokens: vi.fn(),
  verifyIdToken: vi.fn(),
  mintIdToken: vi.fn(),
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
    refreshTokens: session.refreshTokens,
    verifyIdToken: session.verifyIdToken,
    mintIdToken: session.mintIdToken,
  };
});

const { createApp } = await import("./server.js");
const { resetMcpAuthCaches } = await import("./mcp-auth.js");
const { CognitoError } = await import("@starkeep/app-client/auth");

let plane: FakeDataPlane;
const app = createApp();

function login(init: { method?: string; cookie?: string; contentType?: string | null; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.contentType !== null) headers["content-type"] = init.contentType ?? "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  const method = init.method ?? "POST";
  return app.request("/api/mcp-login", {
    method,
    headers,
    ...(method === "GET" ? {} : { body: init.body ?? "{}" }),
  });
}

beforeEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  resetMcpAuthCaches();
  plane = new FakeDataPlane();
  vi.stubGlobal("fetch", plane.fetch);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
  session.refreshTokens.mockReset();
  session.verifyIdToken.mockReset();
  session.mintIdToken.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.STARKEEP_APP_CLIENT_MODE;
});

describe("POST /api/mcp-login, local mode", () => {
  it("mints a token with no session, returning { token, expires_at } ten years out", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expires_at: string };
    expect(Object.keys(body).sort()).toEqual(["expires_at", "token"]);
    expect(body.token).toMatch(/^exr_[A-Za-z0-9_-]+$/);
    expect(body.expires_at).toBe("2036-11-04T12:00:00.000Z");

    const payload = unsealToken(body.token, TEST_SECRET)!;
    expect(payload).toEqual({ v: 1, id: expect.any(String), rt: null, sub: null });
    expect(plane.requestsTo("POST")[0]!.headers["x-starkeep-user-token"]).toBeUndefined();
  });

  it("stores only sha256(id), never the token", async () => {
    const body = (await (await login()).json()) as { token: string };
    const { id } = unsealToken(body.token, TEST_SECRET)!;
    expect(plane.requestsTo("POST")[0]!.body).toEqual({
      row: {
        id,
        token_hash: tokenIdHash(id),
        label: null,
        created_at: "2026-11-07T12:00:00.000Z",
        last_used_at: null,
        expires_at: "2036-11-04T12:00:00.000Z",
      },
    });
    expect(JSON.stringify(plane.requests)).not.toContain(body.token);
  });

  it("the minted token works on /mcp", async () => {
    const { token } = (await (await login()).json()) as { token: string };
    const res = await app.request("/mcp", { method: "POST", headers: mcpHeaders(token), body: JSON.stringify(INITIALIZE) });
    expect(res.status).toBe(200);
  });

  it("non-POST → 405 Method not allowed", async () => {
    const res = await login({ method: "GET" });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed" });
  });

  it("refuses a non-JSON request (cross-site form) → 415", async () => {
    const res = await login({ contentType: "application/x-www-form-urlencoded", body: "a=b" });
    expect(res.status).toBe(415);
    expect(plane.requests).toEqual([]);
  });

  it("insert failure → 500 Could not create token", async () => {
    plane.failWith = 500;
    const res = await login();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not create token" });
  });
});

describe("POST /api/mcp-login, cloud mode", () => {
  const idToken = fakeJwt({ exp: 1_900_000_000, sub: "user-a" });

  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    session.refreshTokens.mockResolvedValue({ idToken, accessToken: "a", expiresIn: 3600 });
    session.verifyIdToken.mockImplementation(async (t: string) =>
      t === idToken ? { sub: "user-a", exp: 1_900_000_000 } : null,
    );
  });

  it("no session → 401 Invalid session, nothing written", async () => {
    const res = await login();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid session" });
    expect(plane.requests).toEqual([]);
  });

  it("seals the session's refresh token and sub, expires in 30 days, writes with the user token", async () => {
    const res = await login({ cookie: "sk_session=refresh-a" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expires_at: string };
    expect(body.expires_at).toBe("2026-12-07T12:00:00.000Z");
    const payload = unsealToken(body.token, TEST_SECRET)!;
    expect(payload).toMatchObject({ rt: "refresh-a", sub: "user-a" });

    const insert = plane.requestsTo("POST")[0]!;
    expect(insert.headers["x-starkeep-user-token"]).toBe(idToken);
    expect(insert.body).toEqual({
      row: expect.objectContaining({ id: payload.id, token_hash: tokenIdHash(payload.id) }),
    });
    // Neither the token nor the refresh token is ever sent to storage.
    const sent = JSON.stringify(plane.requests.map((r) => r.body));
    expect(sent).not.toContain("refresh-a");
    expect(sent).not.toContain(body.token);
  });

  it("proves the refresh token with Cognito, even when sk_token is fresh", async () => {
    const res = await login({ cookie: `sk_session=refresh-a; sk_token=${idToken}` });
    expect(res.status).toBe(200);
    expect(session.refreshTokens).toHaveBeenCalledTimes(1);
    expect(session.refreshTokens.mock.calls[0]![1]).toBe("refresh-a");
    expect(session.mintIdToken).not.toHaveBeenCalled();
  });

  it("a refresh token Cognito refuses → 401 Invalid session, nothing written", async () => {
    session.refreshTokens.mockRejectedValue(new CognitoError("expired", "NotAuthorizedException", 400));
    const res = await login({ cookie: "sk_session=dead" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid session" });
    expect(plane.requests).toEqual([]);
  });

  it("an ID token that fails verification → 401 Invalid session", async () => {
    session.verifyIdToken.mockResolvedValue(null);
    const res = await login({ cookie: "sk_session=refresh-a" });
    expect(res.status).toBe(401);
    expect(plane.requests).toEqual([]);
  });
});
