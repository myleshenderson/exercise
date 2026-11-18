// @vitest-environment node
/**
 * Smoke test for the local Starkeep server: a real Starkeep-mode build of the
 * SPA, served by the platform's `serveLocal` with `serve.ts`'s options on a
 * free loopback port, driven over `node:http` the way a browser or MCP client
 * reaches it.
 *
 * `node:http` rather than `fetch`: `fetch` will not set a `Host` header, and
 * the global `fetch` is stubbed for the data server, which would also catch
 * the test's own requests.
 */
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localPort, serveLocal } from "@starkeep/app-client/local";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { INITIALIZE, mcpHeaders, TEST_CREDS } from "./test-support.js";
import { assertStarkeepMainChunk, BACKEND_MARKER, mainChunkPath } from "./spa-build.js";

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return { ...actual, loadAppCredentials: async () => TEST_CREDS };
});

// After the mock: `serve.ts` loads `server.ts`, which must see it.
const { ensureStarkeepDist, localServerOptions } = await import("./serve.js");

const BUILD_TIMEOUT = 180_000;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
}

let tempDir: string;
let outDir: string;
let server: ReturnType<typeof serveLocal> | undefined;
let port: number;

function request(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          done({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString("utf8") });
        });
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "exercise-serve-"));
  outDir = join(tempDir, "dist");
  // The directory is empty, so this builds it.
  await ensureStarkeepDist(outDir);
  await new Promise<void>((listening) => {
    server = serveLocal({ ...localServerOptions(outDir), port: 0, onListen: () => listening() });
  });
  port = (server!.address() as AddressInfo).port;
}, BUILD_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** Requests that reached the (stubbed) data server. */
let dataHits: number;
beforeEach(() => {
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  dataHits = 0;
  vi.stubGlobal("fetch", async () => {
    dataHits += 1;
    return Response.json({ rows: [], truncated: false, page_token: null });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the local server (real Starkeep build)", () => {
  it("rebuilt the missing dist/ as a Starkeep build", () => {
    expect(readFileSync(join(outDir, BACKEND_MARKER), "utf8").trim()).toBe("starkeep");
    expect(() => assertStarkeepMainChunk(outDir)).not.toThrow();
  });

  it("answers the shell for / and the client routes, and 404 for any other path", async () => {
    const root = await request("/");
    expect(root.status).toBe(200);
    expect(root.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(root.text).toContain('<div id="root">');

    for (const route of ["/mcp-login", "/history/2026-11-17", "/activities/42"]) {
      const res = await request(route);
      expect(res.status, route).toBe(200);
      expect(res.text, route).toBe(root.text);
    }

    expect((await request("/some/client/route")).status).toBe(404);
    expect((await request("/_immutable/nonexistent.js")).status).toBe(404);
  });

  it("serves the main chunk byte-identical, cached as immutable", async () => {
    const chunk = mainChunkPath(outDir);
    const urlPath = "/" + relative(outDir, chunk).split(sep).join("/");
    expect(urlPath.startsWith("/_immutable/")).toBe(true);
    const served = await request(urlPath);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(served.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(served.body.equals(readFileSync(chunk))).toBe(true);
  });

  it("GET /mcp is 405 with Allow: POST", async () => {
    const res = await request("/mcp");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  it("POST /mcp from a loopback client without a token answers initialize", async () => {
    const res = await request("/mcp", { method: "POST", headers: mcpHeaders(), body: JSON.stringify(INITIALIZE) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ result: { serverInfo: { name: "exercise" } } });
  });

  it("refuses POST /mcp sent by a page on another site with 403, before the app runs", async () => {
    const res = await request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders(), "sec-fetch-site": "cross-site" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(403);
    expect(dataHits).toBe(0);
  });

  it("refuses a data proxy write from another site with 403, before it reaches the data server", async () => {
    const body = JSON.stringify({ rows: [{ id: "p1", name: "x" }] });
    const bySite = await request("/api/local-data/app-data/db/programs", {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site" },
      body,
    });
    expect(bySite.status).toBe(403);
    // A browser without Sec-Fetch-Site still names the page's Origin.
    const byOrigin = await request("/api/local-data/app-data/db/programs", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body,
    });
    expect(byOrigin.status).toBe(403);
    expect(dataHits).toBe(0);
  });

  it("refuses a non-loopback Host with 403", async () => {
    const res = await request("/", { headers: { host: "not-loopback.example" } });
    expect(res.status).toBe(403);
  });

  it("GET /starkeep-runtime-config is 200 JSON", async () => {
    const res = await request("/starkeep-runtime-config");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(() => JSON.parse(res.text)).not.toThrow();
  });
});

describe("the port flag", () => {
  it("is the flag serveLocal reads, so admin-web's port reaches the server", () => {
    expect(localPort(["node", "serve.ts", manifest.localRun.portFlag, "5199"], {})).toBe(5199);
  });
});
