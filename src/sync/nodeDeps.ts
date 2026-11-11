/// <reference types="node" />
/**
 * Node wiring for the sync runner (AI-641), shared by `scripts/sync.ts` and `api/sync.ts`: the
 * service-role Supabase store, the AES-GCM SecretBox, global fetch and a real sleep.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createNodeSecretBox, loadCredentialsKey } from "./credentials.js";
import { defaultSleep } from "./http.js";
import type { SecretBox } from "./peloton/index.js";
import type { SyncDeps, SyncEnv } from "./runner.js";
import { createSupabaseSyncStore } from "./store.js";

/** A SecretBox for runs without CREDENTIALS_KEY (Garmin only): any use rejects. */
const missingKeyBox = (): SecretBox => {
  const noKey = async (): Promise<never> => Promise.reject(new Error("CREDENTIALS_KEY is not set"));
  return { encrypt: noKey, decrypt: noKey };
};

/** The service-role client the store writes through (no session is ever persisted on it). */
export function createServiceClient(env: SyncEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

/** `client` lets a caller that already made the service-role client (api/sync.ts POST) reuse it. */
export function createNodeSyncDeps(env: SyncEnv, client: SupabaseClient = createServiceClient(env)): SyncDeps {
  const store = createSupabaseSyncStore(client, env.SYNC_OWNER_USER_ID);
  const box = env.CREDENTIALS_KEY ? createNodeSecretBox(loadCredentialsKey(env.CREDENTIALS_KEY)) : missingKeyBox();
  return { store, fetch: (url, init) => fetch(url, init), sleep: defaultSleep, box, env };
}
