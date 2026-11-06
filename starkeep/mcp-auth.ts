/**
 * Bearer-token gate for `POST /mcp`.
 *
 * The manifest declares the route `auth: "public"`: a remote MCP client cannot
 * carry the platform's session cookie or a Cognito JWT, so the gateway lets
 * the request through and this check is the boundary. The token is a
 * per-install secret held in env `STARKEEP_MCP_TOKEN`.
 *
 * Fail closed: an unset or empty token answers 503 for every request, never
 * open access.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const MCP_TOKEN_ENV = "STARKEEP_MCP_TOKEN";

const UNAUTHORIZED = { error: "unauthorized" } as const;
const NOT_CONFIGURED = { error: "mcp_token_not_configured" } as const;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time string equality. Both sides are hashed first so
 * `timingSafeEqual` always compares two 32-byte buffers, which also keeps the
 * expected token's length out of the timing.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1]! : null;
}

/**
 * Check a request against the configured token. Returns the error response to
 * send, or null when the request may proceed.
 */
export function checkMcpAuth(
  authorization: string | null | undefined,
  expectedToken: string | undefined,
): Response | null {
  if (!expectedToken) return Response.json(NOT_CONFIGURED, { status: 503 });
  const presented = bearerToken(authorization);
  if (presented === null || !tokensMatch(presented, expectedToken)) {
    return Response.json(UNAUTHORIZED, {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="exercise-mcp"' },
    });
  }
  return null;
}
