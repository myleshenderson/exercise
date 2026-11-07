// @vitest-environment node
/**
 * The local Origin and Content-Type gate in front of `/api/*` (AI-606).
 *
 * Real: the Hono app, the guard, the data proxy and `sessionAuth()` (local
 * default: open), the MCP token gate. Stubbed: the data server (global
 * `fetch`: a {@link FakeDataPlane} for `mcp_tokens`, a canned page for
 * `programs`) and `loadAppCredentials` for the MCP gate; the proxy reads its
 * credential from a temp `STARKEEP_DIR`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as appClient from "@starkeep/app-client";
import { FakeDataPlane, INITIALIZE, mcpHeaders, TEST_CREDS } from "./test-support.js";

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: async () => TEST_CREDS };
});

const { createApp } = await import("./server.js");
const { resetMcpAuthCaches } = await import("./mcp-auth.js");
const { isLoopbackOrigin } = await import("./originGuard.js");

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const PROGRAMS = `${BASE}/api/local-data/app-data/db/programs`;
const MCP_LOGIN = `${BASE}/api/mcp-login`;
const EVIL = "https://evil.example";
const ENV_KEYS = ["STARKEEP_APP_CLIENT_MODE", "STARKEEP_DIR"] as const;
const JSON_TYPE = { "content-type": "application/json" };

let savedEnv: Record<string, string | undefined>;
let starkeepDir: string;
let plane: FakeDataPlane;
/** Requests that reached the data server's `programs` table. */
let programsHits: number;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  starkeepDir = mkdtempSync(join(tmpdir(), "exercise-guard-"));
  mkdirSync(join(starkeepDir, "app-creds"));
  writeFileSync(join(starkeepDir, "app-creds", "exercise.json"), JSON.stringify(TEST_CREDS));
  process.env.STARKEEP_DIR = starkeepDir;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  appClient.clearAppCredentialsCache();
  resetMcpAuthCaches();
  plane = new FakeDataPlane();
  programsHits = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.startsWith("/app-data/db/programs")) {
      programsHits += 1;
      return Response.json({ rows: [], truncated: false, page_token: null });
    }
    return plane.fetch(input, init);
  });
  app = createApp();
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

describe("local mode: Origin gate on /api/*", () => {
  it.each([PROGRAMS, MCP_LOGIN, `${BASE}/api/mcp-sessions`, `${BASE}/api/session`, `${BASE}/api/session/refresh`])(
    "Origin: https://evil.example → 403 forbidden_origin on %s",
    async (url) => {
      for (const method of ["GET", "POST"]) {
        const res = await app.request(url, {
          method,
          headers: { origin: EVIL, ...JSON_TYPE },
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden_origin" });
      }
      expect(programsHits).toBe(0);
      expect(plane.requests).toEqual([]);
    },
  );

  it.each([
    "null",
    "not a url",
    `http://evil.example:${PORT}`,
    `http://127.0.0.1:${PORT + 1}`,
    "http://127.0.0.1",
    `https://127.0.0.1:${PORT}`,
    `http://127.0.0.1.evil.example:${PORT}`,
  ])("Origin: %s → 403 on the proxy", async (origin) => {
    const res = await app.request(PROGRAMS, { headers: { origin } });
    expect(res.status).toBe(403);
    expect(programsHits).toBe(0);
  });

  it.each([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://LOCALHOST:${PORT}`, `http://[::1]:${PORT}`])(
    "Origin: %s → passes to the proxy, which forwards",
    async (origin) => {
      const get = await app.request(PROGRAMS, { headers: { origin } });
      expect(get.status).toBe(200);
      const post = await app.request(PROGRAMS, {
        method: "POST",
        headers: { origin, ...JSON_TYPE },
        body: JSON.stringify({ row: { id: "p1" } }),
      });
      expect(post.status).toBe(200);
      expect(programsHits).toBe(2);
    },
  );

  it("loopback Origin → /api/mcp-login reaches its handler", async () => {
    // The handler's own 405 proves it ran; the guard answers 403/415 only.
    const res = await app.request(MCP_LOGIN, { headers: { origin: `http://localhost:${PORT}` } });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Method not allowed" });

    const ok = await app.request(MCP_LOGIN, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${PORT}`, ...JSON_TYPE },
      body: "{}",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty("token");
  });

  it("no Origin → passes (curl, same-origin navigation)", async () => {
    expect((await app.request(PROGRAMS)).status).toBe(200);
    const login = await app.request(MCP_LOGIN, { method: "POST", headers: JSON_TYPE, body: "{}" });
    expect(login.status).toBe(200);
    expect(programsHits).toBe(1);
  });

  it("the port compared is the one the request reached", () => {
    expect(isLoopbackOrigin("http://localhost:8080", "http://127.0.0.1:8080/api/x")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:8080", "http://127.0.0.1:9090/api/x")).toBe(false);
    expect(isLoopbackOrigin("http://localhost", "http://localhost/api/x")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:80", "http://localhost/api/x")).toBe(true);
  });
});

describe("local mode: Content-Type gate on /api/*", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s /api/local-data/... with text/plain → 415, nothing forwarded", async (method) => {
    const res = await app.request(`${PROGRAMS}/p1`, {
      method,
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ row: { id: "p1" } }),
    });
    expect(res.status).toBe(415);
    expect(programsHits).toBe(0);
  });

  it.each([
    ["no Content-Type", {}],
    ["a form", { "content-type": "application/x-www-form-urlencoded" }],
    ["multipart", { "content-type": "multipart/form-data; boundary=x" }],
  ])("POST with %s → 415", async (_label, headers: Record<string, string>) => {
    const res = await app.request(PROGRAMS, { method: "POST", headers });
    expect(res.status).toBe(415);
    expect(programsHits).toBe(0);
  });

  it("the no-cors simple request a hostile page can send → refused", async () => {
    // What `fetch(url, { method: "POST", mode: "no-cors", body })` sends.
    const res = await app.request(PROGRAMS, {
      method: "POST",
      headers: { origin: EVIL, "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ row: { id: "planted" } }),
    });
    expect(res.status).toBe(403);
    // And from a page that sends no Origin at all, the type still stops it.
    const noOrigin = await app.request(PROGRAMS, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ row: { id: "planted" } }),
    });
    expect(noOrigin.status).toBe(415);
    expect(programsHits).toBe(0);
  });

  it("GET is not subject to the type gate; application/json with a charset passes", async () => {
    expect((await app.request(PROGRAMS, { headers: { "content-type": "text/plain" } })).status).toBe(200);
    const res = await app.request(PROGRAMS, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ row: { id: "p1" } }),
    });
    expect(res.status).toBe(200);
  });
});

describe("/mcp is outside the gate", () => {
  it("POST /mcp with Origin: https://anything and a valid token → reaches auth and succeeds", async () => {
    const { token } = plane.seed();
    const res = await app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders(token), origin: "https://anything.example" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result?: unknown }).result).toBeDefined();
  });

  it("POST /mcp with a foreign Origin and no token → 401 from the token gate, not 403", async () => {
    const res = await app.request(`${BASE}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders(), origin: EVIL, "content-type": "text/plain" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("cloud mode: the guard is a no-op", () => {
  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
  });

  it("foreign Origin and text/plain reach the handlers (sessionAuth answers, not the guard)", async () => {
    // No session cookie: the cloud proxy's own 401, not 403/415.
    const proxied = await app.request(PROGRAMS, {
      method: "POST",
      headers: { origin: EVIL, "content-type": "text/plain" },
      body: "{}",
    });
    expect(proxied.status).toBe(401);
    expect(await proxied.json()).toEqual({ error: "Not authenticated" });

    // mcp-login's own handler answers (405 for GET), not the guard's 403.
    const login = await app.request(MCP_LOGIN, { headers: { origin: EVIL } });
    expect(login.status).toBe(405);
    expect(programsHits).toBe(0);
  });
});
