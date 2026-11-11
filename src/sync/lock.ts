/**
 * Sync run serialisation (AI-659). Every entry point that runs `runSync` (cron GET and owner
 * POST in api/sync.ts, `npm run sync` in scripts/sync.ts) goes through `withSyncLock`, so two
 * runs never refresh the rotating Peloton token or move the `sync_state` cursors at once.
 *
 * The guard is the `sync_lock` lease row (migration 20261111221500_sync_lock.sql), not an
 * advisory lock: those are session-scoped and unreliable through PostgREST's pooled connections.
 *
 * - Acquire: `acquire_sync_lock(holder, ttl)` is one conditional update, `lease_until = now() +
 *   15 min, holder = <run id> where name = 'sync' and lease_until < now()`, on the database
 *   clock. False means a live lease is held elsewhere: `SyncLockBusyError`. A lease that has run
 *   out (a crashed holder) is taken over.
 * - Renew: while `fn` runs, `renew_sync_lock` pushes the lease forward every 5 minutes, only
 *   while `holder` is still this run, so a long CLI backfill keeps it; a crashed run stops
 *   renewing and its lease lapses within 15 minutes. A renewal that finds the lease gone is
 *   logged (fn cannot be interrupted safely mid-run).
 * - Release: in `finally`, `lease_until = 'epoch', holder = null` only where `holder` is still
 *   this run. Clearing `holder` makes a renewal still in flight a no-op.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const SYNC_LOCK_TABLE = "sync_lock";
export const SYNC_LOCK_NAME = "sync";
export const SYNC_LOCK_TTL_MS = 15 * 60 * 1000;
export const SYNC_LOCK_RENEW_MS = 5 * 60 * 1000;
const EPOCH = "1970-01-01T00:00:00.000Z";

/** Another run holds a live lease. HTTP answers 409; the CLI prints `sync already running`. */
export class SyncLockBusyError extends Error {
  constructor() {
    super("sync already running");
    this.name = "SyncLockBusyError";
  }
}

export interface SyncLockOptions {
  /** Prefixed to the random holder id so the row shows which entry point holds it. */
  label?: string;
  ttlMs?: number;
  renewMs?: number;
}

/** The slice of a Supabase client the lock uses. */
export type SyncLockClient = Pick<SupabaseClient, "from" | "rpc">;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function withSyncLock<T>(
  client: SyncLockClient,
  fn: () => Promise<T>,
  opts: SyncLockOptions = {},
): Promise<T> {
  const ttlSeconds = Math.ceil((opts.ttlMs ?? SYNC_LOCK_TTL_MS) / 1000);
  const renewMs = opts.renewMs ?? SYNC_LOCK_RENEW_MS;
  const holder = `${opts.label ?? "sync"}:${randomUUID()}`;
  const lease = { p_holder: holder, p_ttl_seconds: ttlSeconds };

  const { data, error } = await client.rpc("acquire_sync_lock", lease);
  if (error) throw new Error(`sync lock acquire failed: ${error.message}`);
  if (data !== true) throw new SyncLockBusyError();

  const renew = setInterval(() => {
    Promise.resolve(client.rpc("renew_sync_lock", lease)).then(
      ({ data: kept, error: e }) => {
        if (e) console.error(`sync lock renew failed: ${e.message}`);
        else if (kept !== true) console.error(`sync lock lost: ${holder} no longer holds the lease`);
      },
      (e: unknown) => console.error(`sync lock renew failed: ${message(e)}`),
    );
  }, renewMs);
  // Never keep the CLI process alive for the timer alone.
  renew.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(renew);
    try {
      const { error: e } = await client
        .from(SYNC_LOCK_TABLE)
        .update({ lease_until: EPOCH, holder: null })
        .eq("name", SYNC_LOCK_NAME)
        .eq("holder", holder);
      // Not fatal: the lease lapses on its own within the TTL. Never mask fn's result or error.
      if (e) console.error(`sync lock release failed: ${e.message}`);
    } catch (e) {
      console.error(`sync lock release failed: ${message(e)}`);
    }
  }
}
