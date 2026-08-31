import { randomBytes, createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requiredEnv } from "./_env";

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
  client: Pick<SupabaseClient, "auth" | "from">;
}

// The `token` column stores sha256Hex(token), never the raw value — the raw
// token is returned to the caller exactly once and is not retrievable again.
export async function mintMcpToken(
  input: { accessToken: string; refreshToken: string },
  deps: MintDeps,
): Promise<MintResult> {
  const { accessToken, refreshToken } = input;
  if (!accessToken || !refreshToken) {
    return { ok: false, status: 400, error: "access_token and refresh_token are required" };
  }

  const { data, error: authError } = await deps.client.auth.getUser(accessToken);
  if (authError || !data.user) {
    return { ok: false, status: 401, error: "Invalid session" };
  }

  const token = generateOpaqueToken();
  const { error: insertError } = await deps.client
    .from("mcp_sessions")
    .insert({ user_id: data.user.id, token: sha256Hex(token), refresh_token: refreshToken });
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

  const body = req.body as { access_token?: unknown; refresh_token?: unknown } | undefined;
  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : "";

  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const result = await mintMcpToken({ accessToken, refreshToken }, { client });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(200).json({ token: result.token });
}
