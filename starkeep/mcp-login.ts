/**
 * `POST /api/mcp-login`: mint a per-user MCP bearer token.
 *
 * Same contract as `api/mcp-login.ts` for the browser (`src/screens/MCPLogin.tsx`):
 * success is `200 { token, expires_at }`, failure is `{ error }` with the
 * Supabase endpoint's status and message (401 "Invalid session", 500 "Could
 * not create token", 405 "Method not allowed"). The body carries no
 * credential under Starkeep: the session is the platform cookie.
 *
 * Only the row (`id`, `token_hash` = sha256(id), timestamps) is stored. The
 * token itself, and the refresh token sealed inside it, are returned once and
 * never written anywhere.
 */

import { randomUUID } from "node:crypto";
import { loadAppCredentials } from "@starkeep/app-client";
import manifest from "../starkeep.manifest.json" with { type: "json" };
import { isCloudMode, isJsonRequest, jsonFor, resolveBrowserCaller } from "./caller.js";
import { insertTokenRow } from "./mcpTokens.js";
import { createServerTransport } from "./serverTransport.js";
import { sealToken, tokenIdHash } from "./token.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cognito refresh tokens for cloud apps live 30 days; the MCP token cannot outlive its. */
export const CLOUD_TOKEN_LIFETIME_MS = 30 * DAY_MS;
/** Locally nothing expires underneath the token; ten years is "until revoked". */
export const LOCAL_TOKEN_LIFETIME_MS = 3650 * DAY_MS;

export async function handleMcpLogin(req: Request): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (!isJsonRequest(req)) return Response.json({ error: "Expected application/json" }, { status: 415 });

  const caller = await resolveBrowserCaller(req, { proveRefreshToken: true });
  if (!caller) return jsonFor(null, { error: "Invalid session" }, 401);

  let creds;
  try {
    creds = await loadAppCredentials(manifest.id);
  } catch {
    creds = null;
  }
  if (!creds) return jsonFor(caller, { error: "Could not create token" }, 503);

  const now = Date.now();
  const id = randomUUID();
  const lifetime = isCloudMode() ? CLOUD_TOKEN_LIFETIME_MS : LOCAL_TOKEN_LIFETIME_MS;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + lifetime).toISOString();

  try {
    await insertTokenRow(createServerTransport({ userToken: caller.userToken }), {
      id,
      token_hash: tokenIdHash(id),
      label: null,
      created_at: createdAt,
      last_used_at: null,
      expires_at: expiresAt,
    });
  } catch {
    return jsonFor(caller, { error: "Could not create token" }, 500);
  }

  const token = sealToken({ v: 1, id, rt: caller.refreshToken, sub: caller.sub }, creds.hmacSecret);
  return jsonFor(caller, { token, expires_at: expiresAt });
}
