import { randomBytes, createHash } from "node:crypto";
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

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type MintResult = { ok: true; token: string } | { ok: false; status: number; error: string };

interface MintDeps {
  // Never call .auth.verifyOtp() (or any other session-establishing auth method) on
  // this client — see AuthDeps in mcp-auth.ts. getUser(accessToken) is stateless and
  // doesn't mutate the ambient session, so it's safe alongside the mcp_sessions
  // insert below, which needs the service-role identity intact.
  client: Pick<SupabaseClient, "auth" | "from">;
  // Used only to redeem the admin-generated magic link into a brand-new session for
  // the MCP token. Never share this client's instance with `client` above:
  // verifyOtp() success swaps this client's ambient session, which would otherwise
  // downgrade the mcp_sessions insert from service_role to the new session's role.
  authClient: Pick<SupabaseClient, "auth">;
}

// mints an independent Supabase session for the caller — decoupled from whatever
// refresh_token their browser tab currently holds — so this token's rotation
// lifecycle can never be raced or invalidated by the browser's own auto-refresh,
// cross-tab sync, or a fresh sign-in/re-auth on the same account. admin.generateLink
// doesn't send an email or touch the caller's existing session; verifyOtp redeems it
// server-side into a fresh, unrelated access/refresh token pair.
async function mintIndependentRefreshToken(
  email: string,
  deps: MintDeps,
): Promise<{ ok: true; refreshToken: string } | { ok: false }> {
  const { data: link, error: linkError } = await deps.client.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link) return { ok: false };

  const { data: verified, error: verifyError } = await deps.authClient.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyError || !verified.session) return { ok: false };

  return { ok: true, refreshToken: verified.session.refresh_token };
}

// The `token` column stores sha256Hex(token), never the raw value — the raw
// token is returned to the caller exactly once and is not retrievable again.
export async function mintMcpToken(input: { accessToken: string }, deps: MintDeps): Promise<MintResult> {
  const { accessToken } = input;
  if (!accessToken) {
    return { ok: false, status: 400, error: "access_token is required" };
  }

  const { data, error: authError } = await deps.client.auth.getUser(accessToken);
  if (authError || !data.user || !data.user.email) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const minted = await mintIndependentRefreshToken(data.user.email, deps);
  if (!minted.ok) {
    return { ok: false, status: 500, error: "Could not create token" };
  }

  const token = generateOpaqueToken();
  const { error: insertError } = await deps.client
    .from("mcp_sessions")
    .insert({ user_id: data.user.id, token: sha256Hex(token), refresh_token: minted.refreshToken });
  if (insertError) {
    return { ok: false, status: 500, error: "Could not create token" };
  }

  return { ok: true, token };
}

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as { access_token?: unknown } | undefined;
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";

  const url = requiredEnv("SUPABASE_URL");
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  // Two separate client instances, not one shared: mintMcpToken's authClient calls
  // .auth.verifyOtp(), which would otherwise silently swap the service-role identity
  // for the new session's on every subsequent .from() call on the same client (see
  // MintDeps' comment).
  const result = await mintMcpToken(
    { accessToken },
    { client: createClient(url, key), authClient: createClient(url, key) },
  );

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(200).json({ token: result.token });
}
