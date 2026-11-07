/**
 * Exercise's server half on Starkeep, as a Hono app.
 *
 * The same `app.fetch` runs on both surfaces: `serve.ts` puts it behind
 * `@hono/node-server` locally, and `handler.ts` puts it behind
 * `createWebAppHandler` in the cloud. Routes are written app-relative;
 * `honoUpstream` strips the `/apps/exercise` mount before Hono routes.
 *
 * What lives here:
 *   - `POST /mcp`: the MCP endpoint, gated by a bearer token (`mcp-auth.ts`).
 *     Any other method answers 405, as `api/mcp.ts` does for GET.
 *   - `GET /starkeep-runtime-config`: the runtime config every Starkeep
 *     browser app reads (authoring guide §3).
 *   - `/api/session` and `/api/session/*`: the platform session routes,
 *     mounted exactly as photos mounts them.
 *   - `/api/local-data/*`: the browser's signing proxy to the data plane,
 *     mounted exactly as photos mounts it. The browser calls
 *     `${BASE_URL}api/local-data/<data-server path>`, e.g.
 *     `api/local-data/app-data/db/programs?where=...`; the segments after
 *     `/api/local-data/` (plus the query string) are forwarded with the
 *     app's HMAC signature.
 *
 * The SPA itself is not here: `index.html` and the built assets are files,
 * answered from disk by `serve.ts` locally and by the web adapter in the cloud.
 */

import { Hono } from "hono";
import {
  createDataProxyHandler,
  createRuntimeConfigHandler,
  sessionAuth,
} from "@starkeep/app-client";
import { createSessionRoutes } from "@starkeep/app-client/auth";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { checkMcpAuth, MCP_TOKEN_ENV } from "./mcp-auth.js";
import { handleMcpRequest, type ExerciseMcpDeps } from "./mcp.js";

export interface ExerciseAppOptions {
  /** The per-install MCP bearer token. Unset or empty: `/mcp` answers 503. */
  mcpToken: string | undefined;
  mcpDeps?: ExerciseMcpDeps;
}

/**
 * The paths the server half owns; everything else belongs to the client.
 * `serve.ts` splits the local surface on this.
 */
export function isServerPath(pathname: string): boolean {
  return (
    pathname === "/mcp" ||
    pathname === "/starkeep-runtime-config" ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
  );
}

export function createApp(opts: ExerciseAppOptions): Hono {
  const app = new Hono();
  const mcpToken = opts.mcpToken;
  const mcpDeps = opts.mcpDeps ?? {};

  // Stateless JSON-only transport: no standalone GET stream (a buffered
  // Lambda response cannot carry one) and no session to DELETE. Answered
  // before the token check, as `api/mcp.ts` does, since it reveals nothing.
  app.on(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"], "/mcp", () =>
    Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } }),
  );

  app.post("/mcp", async (c) => {
    const denied = checkMcpAuth(c.req.header("authorization"), mcpToken);
    if (denied) return denied;
    return handleMcpRequest(c.req.raw, mcpDeps);
  });

  const runtimeConfig = createRuntimeConfigHandler();
  app.get("/starkeep-runtime-config", () => runtimeConfig());

  // Copied from photos' `src/server-app.ts`. Both spellings, because
  // `GET /api/session` is the signed-in probe and a router's `*` does not
  // match the prefix itself.
  const sessionRoutes = createSessionRoutes({ appId: manifest.id });
  const session = (c: { req: { raw: Request; path: string; method: string } }) => {
    const rest = c.req.path.slice("/api/session".length);
    const action = rest.split("/").filter(Boolean);
    const ctx = { params: Promise.resolve({ action }) };
    if (c.req.method === "POST") return sessionRoutes.POST(c.req.raw, ctx);
    if (c.req.method === "GET") return sessionRoutes.GET(c.req.raw, ctx);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  };
  app.all("/api/session", session);
  app.all("/api/session/*", session);

  // The signing proxy, copied from photos' `src/routes/local-data.ts` and
  // `src/server-app.ts`. It holds the app's HMAC credential and signs whatever
  // reaches it, so `sessionAuth()` refuses a caller with no valid session
  // (401) before the credential is loaded. Cloud only: local mode stays open,
  // the package default, because on loopback the browser, the data and the
  // person are on one machine. The handler reads the mode
  // (`STARKEEP_APP_CLIENT_MODE`) on every request.
  const proxy = createDataProxyHandler({ appId: manifest.id, endUserAuth: sessionAuth() });
  app.all("/api/local-data/*", (c) => {
    const path = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
    return proxy(c.req.raw, { params: Promise.resolve({ path }) });
  });

  app.notFound((c) =>
    Response.json({ error: `Exercise has no route for ${c.req.path}` }, { status: 404 }),
  );

  return app;
}

/**
 * The app both entries serve. The token is read once, at startup; a token
 * set later needs a restart (locally) or a redeploy (cloud).
 */
export const app = createApp({ mcpToken: process.env[MCP_TOKEN_ENV] });
