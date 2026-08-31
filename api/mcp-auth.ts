import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex } from "./mcp-login.js";

export type IdentityResult =
  | { ok: true; userId: string; accessToken: string }
  | { ok: false; error: string };

interface AuthDeps {
  client: Pick<SupabaseClient, "auth" | "from">;
}

interface SessionRow {
  id: string;
  user_id: string;
  refresh_token: string;
}

const REMINT_HINT = "Please re-mint a token from /mcp-login.";
const SESSION_EXPIRED: IdentityResult = { ok: false, error: `Your MCP session has expired. ${REMINT_HINT}` };

// Supabase refresh tokens are single-use, and a client can legitimately have several
// tool calls for the same session in flight at once (each a separate stateless
// invocation of this route) — so more than one may read the same not-yet-rotated
// refresh_token before any of them writes the rotated value back. Bounded by the
// number of tools this route exposes: that's the realistic ceiling on how many calls
// for one session could race each other.
const MAX_REFRESH_ATTEMPTS = 3;

async function fetchSessionRow(
  bearerToken: string,
  client: AuthDeps["client"],
): Promise<{ row: SessionRow | null; error: unknown }> {
  const { data, error } = await client
    .from("mcp_sessions")
    .select("id, user_id, refresh_token")
    .eq("token", sha256Hex(bearerToken))
    .maybeSingle();
  return { row: (data as SessionRow | null) ?? null, error };
}

// Every mcp_sessions row stores a Supabase refresh_token, which Supabase rotates on
// each use — so the row is only ever good for one exchange before it must be
// rewritten. Called once per tool invocation (never for initialize/tools-list, which
// don't need a user identity), this looks the bearer token up, exchanges its stored
// refresh_token for a live access_token, and writes the newly-rotated refresh_token
// back so the next call still has a usable one.
export async function resolveIdentity(bearerToken: string | undefined, deps: AuthDeps): Promise<IdentityResult> {
  if (!bearerToken) {
    return { ok: false, error: `Missing bearer token. ${REMINT_HINT}` };
  }

  const { row, error: lookupError } = await fetchSessionRow(bearerToken, deps.client);

  if (lookupError) {
    console.error("mcp_sessions lookup failed", lookupError);
    return { ok: false, error: "Could not verify your session right now. Please try again." };
  }
  if (!row) {
    return { ok: false, error: `Invalid bearer token. ${REMINT_HINT}` };
  }

  let current = row;
  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    const { data: refreshed, error: refreshError } = await deps.client.auth.refreshSession({
      refresh_token: current.refresh_token,
    });

    if (refreshError || !refreshed.session) {
      if (attempt === MAX_REFRESH_ATTEMPTS) return SESSION_EXPIRED;

      // The exchange may have failed because a concurrent call for this same session
      // already consumed this refresh_token and rotated it — re-read the row and, if
      // someone else's rotation landed, retry with their value instead of failing.
      const { row: latest, error: refetchError } = await fetchSessionRow(bearerToken, deps.client);
      if (refetchError || !latest || latest.refresh_token === current.refresh_token) return SESSION_EXPIRED;
      current = latest;
      continue;
    }

    const { error: updateError } = await deps.client
      .from("mcp_sessions")
      .update({ refresh_token: refreshed.session.refresh_token })
      .eq("id", current.id);

    if (updateError) {
      return { ok: false, error: `Could not persist the refreshed session. ${REMINT_HINT}` };
    }

    return { ok: true, userId: current.user_id, accessToken: refreshed.session.access_token };
  }

  return SESSION_EXPIRED;
}
