import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Lazy: only construct the client when first needed, so importing this module
// (which happens even under the mock backend / in tests) never throws on missing env.
export function getSupabase(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL as string;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
    client = createClient(url, key);
  }
  return client;
}
