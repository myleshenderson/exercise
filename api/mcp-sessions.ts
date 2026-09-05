import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requiredEnv } from "./_env.js";

interface VercelLikeRequest {
  method?: string;
  body?: unknown;
}

interface VercelLikeResponse {
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
}

interface SessionsDeps {
  client: Pick<SupabaseClient, "auth" | "from">;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastUsedAt: string;
}

export type ListResult = { ok: true; sessions: SessionSummary[] } | { ok: false; status: number; error: string };

export async function listMcpSessions(input: { accessToken: string }, deps: SessionsDeps): Promise<ListResult> {
  const { accessToken } = input;
  if (!accessToken) {
    return { ok: false, status: 400, error: "access_token is required" };
  }

  const { data, error: authError } = await deps.client.auth.getUser(accessToken);
  if (authError || !data.user) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const { data: rows, error: selectError } = await deps.client
    .from("mcp_sessions")
    .select("id, created_at, last_used_at")
    .eq("user_id", data.user.id)
    .order("created_at", { ascending: false });
  if (selectError) {
    return { ok: false, status: 500, error: "Could not list sessions" };
  }

  const sessions = ((rows as { id: string; created_at: string; last_used_at: string }[] | null) ?? []).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
  return { ok: true, sessions };
}

export type RevokeResult = { ok: true } | { ok: false; status: number; error: string };

export async function revokeMcpSession(
  input: { accessToken: string; sessionId: string },
  deps: SessionsDeps,
): Promise<RevokeResult> {
  const { accessToken, sessionId } = input;
  if (!accessToken || !sessionId) {
    return { ok: false, status: 400, error: "access_token and session_id are required" };
  }

  const { data, error: authError } = await deps.client.auth.getUser(accessToken);
  if (authError || !data.user) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const { error: deleteError, count } = await deps.client
    .from("mcp_sessions")
    .delete({ count: "exact" })
    .eq("id", sessionId)
    .eq("user_id", data.user.id);
  if (deleteError) {
    return { ok: false, status: 500, error: "Could not revoke session" };
  }
  if (!count) {
    return { ok: false, status: 404, error: "Session not found" };
  }

  return { ok: true };
}

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));

  if (req.method === "POST") {
    const body = req.body as { access_token?: unknown } | undefined;
    const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
    const result = await listMcpSessions({ accessToken }, { client });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(200).json({ sessions: result.sessions });
    return;
  }

  if (req.method === "DELETE") {
    const body = req.body as { access_token?: unknown; session_id?: unknown } | undefined;
    const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
    const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
    const result = await revokeMcpSession({ accessToken, sessionId }, { client });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(200).json({ ok: true });
  }
}
