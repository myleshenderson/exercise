/**
 * Cross-origin gate for `/api/*` on the local surface (AI-606).
 *
 * Locally the `/api/local-data/*` signing proxy is open (`sessionAuth()`'s
 * `allowAnonymousLocal` default) and `serve.ts` only checks `Host`, which
 * stops DNS rebinding but not a page on another site sending a "simple"
 * request (`POST` + `text/plain`, `mode: "no-cors"`) straight to
 * `http://127.0.0.1:<port>`. Two header checks close that, before any handler
 * runs:
 *
 *   - `Origin`, when present, must be `http://` + `127.0.0.1`, `localhost` or
 *     `[::1]` on this server's own port, else 403 `forbidden_origin`. No
 *     `Origin` passes: same-origin navigations, curl and MCP clients send none.
 *   - `POST`/`PUT`/`PATCH`/`DELETE` must carry `Content-Type:
 *     application/json`, else 415. The browser code only ever sends JSON, and a simple cross-site
 *     request cannot set that type without a preflight, which nothing here
 *     answers.
 *
 * Cloud mode (`STARKEEP_APP_CLIENT_MODE=cloud`) is a no-op: API Gateway and
 * Starkeep's session/JWT authorizers guard that surface. `/mcp` is not under
 * `/api/*` and is not gated: it is authenticated by bearer token, and MCP
 * clients may send any `Origin` or none.
 */

import type { MiddlewareHandler } from "hono";
import { isCloudMode, isJsonRequest } from "./caller.js";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
// PUT too: the browser never sends it, and `/api/local-data/*` forwards every
// method, so a non-JSON PUT has no business reaching the proxy either.
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether `origin` is a loopback origin on the port this request reached.
 * The request URL's port is the server's own: `@hono/node-server` builds the
 * URL from the `Host` header, which `serve.ts` has already held to loopback,
 * and a cross-site browser request cannot forge `Host`.
 */
export function isLoopbackOrigin(origin: string, requestUrl: string): boolean {
  let sent: URL;
  let reached: URL;
  try {
    sent = new URL(origin);
    reached = new URL(requestUrl);
  } catch {
    return false; // includes the opaque `Origin: null`
  }
  return (
    sent.protocol === "http:" &&
    LOOPBACK_HOSTNAMES.has(sent.hostname.toLowerCase()) &&
    sent.port === reached.port
  );
}

/** Hono middleware for `/api/*`; see the module comment. */
export function localOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (isCloudMode()) return next();
    const req = c.req.raw;
    const origin = req.headers.get("origin");
    if (origin !== null && !isLoopbackOrigin(origin, req.url)) {
      return Response.json({ error: "forbidden_origin" }, { status: 403 });
    }
    if (BODY_METHODS.has(req.method.toUpperCase()) && !isJsonRequest(req)) {
      return Response.json({ error: "Expected application/json" }, { status: 415 });
    }
    return next();
  };
}
