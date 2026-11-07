/**
 * Per-user bearer-token gate for `POST /mcp`.
 *
 * The manifest declares the route `auth: "public"`: a remote MCP client cannot
 * carry the platform's session cookie or a Cognito JWT, so the gateway lets
 * the request through and this check is the boundary. The token is the
 * sealed blob `token.ts` describes, minted by `POST /api/mcp-login` from the
 * user's own session.
 *
 * Order of checks, each failing closed:
 *
 *   1. `Authorization: Bearer exr_…` that unseals under the app's key, else
 *      401 `unauthorized`.
 *   2. Cloud only: an ID token for the sealed refresh token, from the
 *      module-scope cache or `refreshTokens`. Cognito refusing it (a 4xx such
 *      as `NotAuthorizedException`: expired or revoked refresh token) is 401
 *      `token_expired`; a 5xx, throttling or network failure is 503
 *      `auth_unavailable`, so the client retries instead of dropping the token.
 *      An ID token whose `sub` is not the sealed `sub` is 401 `unauthorized`.
 *   3. The `mcp_tokens` row for the sealed id, read with that ID token as
 *      `X-Starkeep-User-Token` (cloud) or HMAC only (local). No row (revoked,
 *      or another user's) is 401 `unauthorized`; `expires_at` in the past is
 *      401 `token_expired`.
 *   4. `last_used_at` is written at most once a minute per token.
 *
 * The result is the {@link McpRequestContext} the tool handlers act under.
 */

import { timingSafeEqual } from "node:crypto";
import { loadAppCredentials } from "@starkeep/app-client";
import { CognitoError, poolConfig, refreshTokens, unsafeDecodeExp } from "@starkeep/app-client/auth";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { isCloudMode } from "./caller.js";
import { findTokenRow, touchTokenRow } from "./mcpTokens.js";
import { createServerTransport } from "./serverTransport.js";
import { tokenIdHash, unsealToken } from "./token.js";

/** Who an authenticated `/mcp` request acts for. */
export interface McpRequestContext {
  /** Cognito `sub` of the user who minted the token; null locally. */
  sub: string | null;
  /** That user's current ID token, for `createServerTransport`; undefined locally. */
  userToken: string | undefined;
  /** `mcp_tokens.id`. */
  tokenId: string;
}

export type McpAuthResult = { ok: true; context: McpRequestContext } | { ok: false; response: Response };

/** Re-mint an ID token this long before its `exp`. */
export const REMINT_WINDOW_MS = 60_000;
/** Write `last_used_at` at most this often per token. */
export const TOUCH_INTERVAL_MS = 60_000;

function deny(status: number, error: string): McpAuthResult {
  const headers: Record<string, string> = {};
  if (status === 401) {
    headers["WWW-Authenticate"] =
      error === "unauthorized"
        ? 'Bearer realm="exercise-mcp"'
        : `Bearer realm="exercise-mcp", error="invalid_token", error_description="${error}"`;
  }
  return { ok: false, response: Response.json({ error }, { status, headers }) };
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1]! : null;
}

// ---- ID-token cache (cloud) -------------------------------------------------
//
// Keyed by token id (`mcp_tokens.id`), not by refresh token, so the refresh
// token is never a map key and two MCP tokens minted from one browser session
// keep separate entries. Lives for the process (a warm Lambda, or the local
// server). An entry is used until REMINT_WINDOW_MS before the ID token's
// `exp`. Concurrent misses for one id share a single Cognito call.

interface CachedIdToken {
  idToken: string;
  /** ms epoch after which the entry must be re-minted. */
  useUntil: number;
}

const idTokens = new Map<string, CachedIdToken>();
const inflight = new Map<string, Promise<CachedIdToken>>();
const lastTouched = new Map<string, number>();

/** Drop everything cached for a token that no longer authenticates. */
function forget(tokenId: string): void {
  idTokens.delete(tokenId);
  lastTouched.delete(tokenId);
}

/** Test seam: forget every cached ID token and touch time. */
export function resetMcpAuthCaches(): void {
  idTokens.clear();
  inflight.clear();
  lastTouched.clear();
}

class CognitoRefused extends Error {}

/** Whether Cognito refused the refresh token itself, as opposed to failing. */
function isRefusal(err: unknown): boolean {
  return (
    err instanceof CognitoError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.code !== "TooManyRequestsException" &&
    err.code !== "LimitExceededException"
  );
}

/** The `sub` claim of a JWT, unverified. Only compared, never trusted alone. */
function unsafeDecodeSub(jwt: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

async function idTokenFor(tokenId: string, refreshToken: string): Promise<CachedIdToken> {
  const now = Date.now();
  const cached = idTokens.get(tokenId);
  if (cached && cached.useUntil > now) return cached;

  const pending = inflight.get(tokenId);
  if (pending) return pending;

  const cfg = poolConfig();
  if (!cfg) throw new Error("no user pool configured");

  const mint = (async () => {
    let minted;
    try {
      minted = await refreshTokens(cfg, refreshToken);
    } catch (err) {
      if (isRefusal(err)) throw new CognitoRefused(String(err));
      throw err;
    }
    const expSeconds = unsafeDecodeExp(minted.idToken);
    const expMs = expSeconds !== null ? expSeconds * 1000 : Date.now() + minted.expiresIn * 1000;
    const entry = { idToken: minted.idToken, useUntil: expMs - REMINT_WINDOW_MS };
    // Drop stale entries while we are here, so the map holds live tokens only.
    for (const [id, e] of idTokens) if (e.useUntil <= Date.now()) idTokens.delete(id);
    idTokens.set(tokenId, entry);
    return entry;
  })();
  inflight.set(tokenId, mint);
  try {
    return await mint;
  } finally {
    inflight.delete(tokenId);
  }
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function authenticateMcpRequest(req: Request): Promise<McpAuthResult> {
  const presented = bearerToken(req.headers.get("authorization"));
  if (presented === null) return deny(401, "unauthorized");

  let creds;
  try {
    creds = await loadAppCredentials(manifest.id);
  } catch {
    return deny(503, "credentials_unavailable");
  }
  if (!creds) return deny(503, "app_not_installed");

  const payload = unsealToken(presented, creds.hmacSecret);
  if (!payload) return deny(401, "unauthorized");

  const cloud = isCloudMode();
  let userToken: string | undefined;
  if (cloud) {
    // A token minted locally (rt null) is meaningless in the cloud.
    if (!payload.rt || !payload.sub) return deny(401, "unauthorized");
    if (!poolConfig()) return deny(503, "user_pool_not_configured");
    try {
      userToken = (await idTokenFor(payload.id, payload.rt)).idToken;
    } catch (err) {
      if (err instanceof CognitoRefused) return deny(401, "token_expired");
      return deny(503, "auth_unavailable");
    }
    // The sealed sub and refresh token come from one Cognito exchange at mint
    // time; check they still name the same person, so `context.sub` and the
    // data plane's scoping (by `userToken`) can never disagree.
    if (unsafeDecodeSub(userToken) !== payload.sub) {
      forget(payload.id);
      return deny(401, "unauthorized");
    }
  }

  const transport = createServerTransport({ userToken });
  let row;
  try {
    row = await findTokenRow(transport, payload.id);
  } catch {
    // Possibly the data plane rejecting a cached ID token: drop it so the
    // next call re-mints instead of failing the same way until it expires.
    idTokens.delete(payload.id);
    return deny(502, "token_lookup_failed");
  }
  if (!row || !sameHash(row.token_hash, tokenIdHash(payload.id))) {
    forget(payload.id);
    return deny(401, "unauthorized");
  }

  const now = Date.now();
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    forget(payload.id);
    return deny(401, "token_expired");
  }

  const lastUsed = Math.max(lastTouched.get(payload.id) ?? 0, row.last_used_at ? Date.parse(row.last_used_at) || 0 : 0);
  if (now - lastUsed >= TOUCH_INTERVAL_MS) {
    // Entries older than the interval no longer suppress anything; drop them.
    for (const [id, at] of lastTouched) if (now - at >= TOUCH_INTERVAL_MS) lastTouched.delete(id);
    lastTouched.set(payload.id, now);
    // Awaited so a Lambda cannot freeze mid-write; a failure only costs the
    // timestamp, never the request.
    await touchTokenRow(transport, payload.id, new Date(now).toISOString()).catch(() => undefined);
  }

  return { ok: true, context: { sub: cloud ? payload.sub : null, userToken, tokenId: payload.id } };
}
