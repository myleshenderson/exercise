// @vitest-environment node
/**
 * `/api/mcp-sessions` (AI-605). Shapes follow `api/mcp-sessions.ts` and
 * `api/mcp-sessions.test.ts`: list → `{ sessions: [{ id, createdAt,
 * lastUsedAt }] }`, revoke → `{ ok: true }`, 404 "Session not found",
 * 401 "Invalid session", 500 "Could not list sessions" / "Could not revoke
 * session", 405 "Method not allowed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDataPlane, fakeJwt, INITIALIZE, mcpHeaders, TEST_CREDS } from "./test-support.js";

const session = vi.hoisted(() => ({
  minted: null as null | { token: string; claims: { sub: string; exp: number }; setCookie?: string },
  refreshTokens: vi.fn(),
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
    mintIdToken: async (req: Request) =>
      actual.readCookie(req, actual.SESSION_COOKIE) ? session.minted : null,
  };
});

const { createApp } = await import("./server.js");
const { resetMcpAuthCaches } = await import("./mcp-auth.js");

let plane: FakeDataPlane;
const app = createApp();

function sessions(method: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return app.request("/api/mcp-sessions", {
    method,
    headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}

function mcp(token: string) {
  return app.request("/mcp", { method: "POST", headers: mcpHeaders(token), body: JSON.stringify(INITIALIZE) });
}

beforeEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  resetMcpAuthCaches();
  plane = new FakeDataPlane();
  vi.stubGlobal("fetch", plane.fetch);
  session.minted = null;
  session.refreshTokens.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STARKEEP_APP_CLIENT_MODE;
});

describe("/api/mcp-sessions, local mode", () => {
  it("POST lists { id, createdAt, lastUsedAt } newest first; lastUsedAt falls back to createdAt", async () => {
    const older = plane.seed({ lastUsedAt: "2026-11-06T09:00:00.000Z" });
    plane.rows[0]!.created_at = "2026-11-01T00:00:00.000Z";
    const newer = plane.seed();
    plane.rows[1]!.created_at = "2026-11-05T00:00:00.000Z";

    const res = await sessions("POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessions: [
        { id: newer.id, createdAt: "2026-11-05T00:00:00.000Z", lastUsedAt: "2026-11-05T00:00:00.000Z" },
        { id: older.id, createdAt: "2026-11-01T00:00:00.000Z", lastUsedAt: "2026-11-06T09:00:00.000Z" },
      ],
    });
  });

  it("GET lists too; an empty table is { sessions: [] }", async () => {
    const res = await sessions("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });

  it("list failure → 500 Could not list sessions", async () => {
    plane.failWith = 500;
    const res = await sessions("POST", {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not list sessions" });
  });

  it("DELETE revokes: { ok: true }, the row is gone, and /mcp with that token is 401", async () => {
    const { id, token } = plane.seed();
    expect((await mcp(token)).status).toBe(200);

    const res = await sessions("DELETE", { session_id: id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(plane.rows).toEqual([]);
    expect(plane.requestsTo("DELETE")[0]!.body).toEqual({ where: { id } });

    const after = await mcp(token);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "unauthorized" });
  });

  it("DELETE of an unknown id → 404 Session not found", async () => {
    const res = await sessions("DELETE", { session_id: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("DELETE without session_id → 400", async () => {
    const res = await sessions("DELETE", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "session_id is required" });
  });

  it("DELETE failure → 500 Could not revoke session", async () => {
    plane.failWith = 500;
    const res = await sessions("DELETE", { session_id: "x" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not revoke session" });
  });

  it("other methods → 405 Method not allowed", async () => {
    const res = await sessions("PUT", {});
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed" });
  });
});

describe("/api/mcp-sessions, cloud mode", () => {
  const idToken = fakeJwt({ exp: 1_900_000_000, sub: "user-a" });

  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    session.minted = { token: idToken, claims: { sub: "user-a", exp: 1_900_000_000 } };
    plane.ownerOf = (t) => (t === idToken ? "user-a" : null);
  });

  it("no session → 401 Invalid session", async () => {
    for (const method of ["POST", "DELETE"]) {
      const res = await sessions(method, { session_id: "x" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid session" });
    }
    expect(plane.requests).toEqual([]);
  });

  it("lists and revokes only the caller's rows, with the user token attached", async () => {
    const mine = plane.seed({ owner: "user-a" });
    const theirs = plane.seed({ owner: "user-b" });

    const list = await sessions("POST", {}, "sk_session=refresh-a");
    expect(((await list.json()) as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([mine.id]);

    const denied = await sessions("DELETE", { session_id: theirs.id }, "sk_session=refresh-a");
    expect(denied.status).toBe(404);
    expect(plane.rows.map((r) => r.id)).toContain(theirs.id);

    const ok = await sessions("DELETE", { session_id: mine.id }, "sk_session=refresh-a");
    expect(ok.status).toBe(200);
    expect(plane.rows.map((r) => r.id)).toEqual([theirs.id]);

    for (const r of plane.requests) expect(r.headers["x-starkeep-user-token"]).toBe(idToken);
  });

  it("echoes a re-minted sk_token cookie", async () => {
    session.minted = { ...session.minted!, setCookie: "sk_token=new; Path=/apps/exercise" };
    const res = await sessions("POST", {}, "sk_session=refresh-a");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("sk_token=new");
  });
});
