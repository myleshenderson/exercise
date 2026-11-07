import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The Supabase client, loaded on first use.
 *
 * A dynamic import, so a Starkeep build never loads supabase-js and never
 * needs `VITE_SUPABASE_*`. The import promise is shared, so concurrent
 * callers (the auth listener, the MCP screen's session list and token button)
 * resolve to the one module.
 */
let loading: Promise<typeof import("../data/supabaseClient")> | null = null;

export async function loadSupabase(): Promise<SupabaseClient> {
  loading ??= import("../data/supabaseClient").catch((err: unknown) => {
    loading = null; // a failed chunk load (flaky network, stale deploy) can be retried
    throw err;
  });
  const { getSupabase } = await loading;
  return getSupabase();
}
