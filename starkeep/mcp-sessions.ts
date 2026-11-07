/**
 * `/api/mcp-sessions`: list and revoke the caller's MCP tokens.
 *
 * Same contract as `api/mcp-sessions.ts` for the browser
 * (`src/screens/MCPLogin.tsx`):
 *
 *   - `POST` (and `GET`) → `200 { sessions: [{ id, createdAt, lastUsedAt }] }`,
 *     newest first. `lastUsedAt` falls back to `createdAt` for a token never
 *     used, as Supabase's `last_used_at not null default now()` did.
 *   - `DELETE { session_id }` → `200 { ok: true }`; 404 "Session not found"
 *     when no row matched; 400 "session_id is required".
 *   - 401 "Invalid session", 500 "Could not list sessions" / "Could not
 *     revoke session", 405 "Method not allowed".
 *
 * Scoping: in the cloud every row call carries the caller's ID token, so the
 * data plane only shows and deletes that user's rows; locally the library has
 * one owner. Revoking is deleting the row: the next `/mcp` call with that token
 * finds no row and gets 401.
 */

import { isJsonRequest, jsonFor, resolveBrowserCaller } from "./caller.js";
import { deleteTokenRow, listTokenRows } from "./mcpTokens.js";
import { createServerTransport } from "./serverTransport.js";

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastUsedAt: string;
}

async function readSessionId(req: Request): Promise<string> {
  try {
    const body = (await req.json()) as { session_id?: unknown } | null;
    return typeof body?.session_id === "string" ? body.session_id : "";
  } catch {
    return "";
  }
}

export async function handleMcpSessions(req: Request): Promise<Response> {
  const method = req.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (method !== "GET" && !isJsonRequest(req)) {
    return Response.json({ error: "Expected application/json" }, { status: 415 });
  }

  const caller = await resolveBrowserCaller(req);
  if (!caller) return jsonFor(null, { error: "Invalid session" }, 401);
  const transport = createServerTransport({ userToken: caller.userToken });

  if (method === "DELETE") {
    const sessionId = await readSessionId(req);
    if (!sessionId) return jsonFor(caller, { error: "session_id is required" }, 400);
    let changes: number;
    try {
      changes = await deleteTokenRow(transport, sessionId);
    } catch {
      return jsonFor(caller, { error: "Could not revoke session" }, 500);
    }
    if (!changes) return jsonFor(caller, { error: "Session not found" }, 404);
    return jsonFor(caller, { ok: true });
  }

  try {
    const rows = await listTokenRows(transport);
    const sessions: SessionSummary[] = rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? row.created_at,
    }));
    return jsonFor(caller, { sessions });
  } catch {
    return jsonFor(caller, { error: "Could not list sessions" }, 500);
  }
}
