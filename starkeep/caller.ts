/**
 * Who is calling `/api/mcp-login` or `/api/mcp-sessions` from the browser.
 *
 * Cloud (`STARKEEP_APP_CLIENT_MODE=cloud`): the platform session. The
 * `sk_session` cookie is the user's Cognito refresh token; `mintIdToken`
 * resolves (and if needed re-mints) the ID token from it, verifies it, and
 * reports a `Set-Cookie` to echo when it re-minted. This is the same check
 * `sessionAuth()` makes for the data proxy (`sessionAuth` → `requireSession`
 * → the same resolver), called once here because these routes also need the
 * token itself, for `X-Starkeep-User-Token`, and the claims' `sub`.
 *
 * `/api/mcp-login` passes `proveRefreshToken`: it is about to seal the
 * refresh token into a long-lived MCP token, so it exchanges that refresh
 * token with Cognito (`refreshTokens`) and verifies the resulting ID token
 * (`verifyIdToken`) instead of trusting a still-fresh `sk_token` cookie. A
 * dead refresh token then fails here, as 401, rather than producing a token
 * that is dead on arrival, and the sealed `sub` is taken from the same
 * exchange as the sealed refresh token.
 *
 * Local: open. The local server binds loopback, refuses a non-loopback
 * `Host`, and the library has a single owner, which is the `sessionAuth()`
 * default (`allowAnonymousLocal: true`) too. No user token, no `sub`.
 */

import {
  mintIdToken,
  poolConfig,
  readCookie,
  refreshTokens,
  SESSION_COOKIE,
  verifyIdToken,
} from "@starkeep/app-client/auth";
import manifest from "../starkeep.manifest.json" with { type: "json" };

export function isCloudMode(): boolean {
  return process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
}

export interface BrowserCaller {
  /** ID token for `X-Starkeep-User-Token`; undefined locally. */
  userToken: string | undefined;
  /** Cognito `sub`; null locally. */
  sub: string | null;
  /** The session's Cognito refresh token (`sk_session`); null locally. */
  refreshToken: string | null;
  /** A re-minted `sk_token` cookie the response must carry, if any. */
  setCookie?: string;
}

/** The caller, or null when cloud mode has no valid session. */
export async function resolveBrowserCaller(
  req: Request,
  opts: { proveRefreshToken?: boolean } = {},
): Promise<BrowserCaller | null> {
  if (!isCloudMode()) return { userToken: undefined, sub: null, refreshToken: null };
  const refreshToken = readCookie(req, SESSION_COOKIE);
  if (!refreshToken) return null;

  if (opts.proveRefreshToken) {
    const cfg = poolConfig();
    if (!cfg) return null;
    let idToken: string;
    try {
      idToken = (await refreshTokens(cfg, refreshToken)).idToken;
    } catch {
      return null;
    }
    const claims = await verifyIdToken(idToken, cfg);
    if (!claims) return null;
    return { userToken: idToken, sub: claims.sub, refreshToken };
  }
  const minted = await mintIdToken(req, manifest.id);
  if (!minted) return null;
  return {
    userToken: minted.token,
    sub: minted.claims.sub,
    refreshToken,
    ...(minted.setCookie ? { setCookie: minted.setCookie } : {}),
  };
}

/** JSON response that also carries the caller's re-minted cookie, if any. */
export function jsonFor(caller: BrowserCaller | null, body: unknown, status = 200): Response {
  const res = Response.json(body, { status });
  if (caller?.setCookie) res.headers.append("Set-Cookie", caller.setCookie);
  return res;
}

/**
 * State-changing calls must be JSON. A cross-site HTML form cannot send
 * `application/json` without a CORS preflight this server never answers, so
 * this keeps another origin from minting or revoking tokens with the user's
 * cookie (cloud) or against the loopback server (local).
 */
export function isJsonRequest(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}
