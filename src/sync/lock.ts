/**
 * Sync run serialisation (AI-659). Every entry point that runs `runSync` (cron GET and owner
 * POST in api/sync.ts, `npm run sync` in scripts/sync.ts) goes through `withSyncLock`, so two
 * runs never refresh the rotating Peloton token or move the `sync_state` cursors at once.
 *
 * The guard is the `sync_lock` lease row (migration 20261111221500_sync_lock.sql), not an
 * advisory lock: those are session-scoped and unreliable through PostgREST's pooled connections.
 *
 * - Acquire: `acquire_sync_lock(holder, ttl)` is one upsert on the database clock: it writes
 *   `lease_until = now() + ttl, holder = <run id>` only when the `sync` row is missing (it
 *   self-heals) or its lease has run out (a crashed holder is taken over). False means a live
 *   lease is held elsewhere: `SyncLockBusyError`. The TTL is 15 minutes by default (the CLI);
 *   the HTTP paths pass 120 s, because Vercel kills them at 60 s.
 * - Renew: while `fn` runs, `renew_sync_lock` pushes the lease forward (every 5 minutes, or a
 *   third of the TTL when that is shorter), only while `holder` is still this run, so a long CLI
 *   backfill keeps it; a crashed run stops renewing and its lease lapses within the TTL.
 * - Lost: `fn` gets `lease.lost()`, true once a renewal finds another holder or the lease's TTL
 *   has passed on this process's clock since the last successful acquire or renewal. The runner
 *   checks it between items (with its deadline) and ends the run with `sync lock lost`, so a
 *   stale run never keeps going beside the new holder.
 * - Release: in `finally`, `lease_until = 'epoch', holder = null` only where `holder` is still
 *   this run. Clearing `holder` makes a renewal still in flight a no-op.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { errorMessage } from "./garmin/runShared.js";

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
  /** This process's clock, for `lost()`'s TTL check. Defaults to `Date.now`. */
  now?: () => number;
}

/** What `fn` gets: whether this run still holds the lease. */
export interface SyncLease {
  /** True once the lease is known lost or may have lapsed; the run must stop. */
  lost: () => boolean;
}

/** The slice of a Supabase client the lock uses. */
export type SyncLockClient = Pick<SupabaseClient, "from" | "rpc">;

export async function withSyncLock<T>(
  client: SyncLockClient,
  fn: (lease: SyncLease) => Promise<T>,
  opts: SyncLockOptions = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? SYNC_LOCK_TTL_MS;
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  const renewMs = opts.renewMs ?? Math.min(SYNC_LOCK_RENEW_MS, Math.floor(ttlMs / 3));
  const now = opts.now ?? Date.now;
  const holder = `${opts.label ?? "sync"}:${randomUUID()}`;
  const args = { p_holder: holder, p_ttl_seconds: ttlSeconds };

  // Measured from before each call, so this process never believes the lease outlives the row.
  const sentAt = now();
  const { data, error } = await client.rpc("acquire_sync_lock", args);
  if (error) throw new Error(`sync lock acquire failed: ${errorMessage(error)}`);
  if (data !== true) throw new SyncLockBusyError();
  let validUntil = sentAt + ttlMs;
  let taken = false;
  const lease: SyncLease = { lost: () => taken || now() >= validUntil };

  const renew = setInterval(() => {
    const at = now();
    Promise.resolve(client.rpc("renew_sync_lock", args)).then(
      ({ data: kept, error: e }) => {
        if (e) console.error(`sync lock renew failed: ${errorMessage(e)}`);
        else if (kept !== true) {
          taken = true;
          console.error(`sync lock lost: ${holder} no longer holds the lease`);
        } else validUntil = Math.max(validUntil, at + ttlMs);
      },
      (e: unknown) => console.error(`sync lock renew failed: ${errorMessage(e)}`),
    );
  }, renewMs);
  // Never keep the CLI process alive for the timer alone.
  renew.unref?.();

  try {
    return await fn(lease);
  } finally {
    clearInterval(renew);
    try {
      const { error: e } = await client
        .from(SYNC_LOCK_TABLE)
        .update({ lease_until: EPOCH, holder: null })
        .eq("name", SYNC_LOCK_NAME)
        .eq("holder", holder);
      // Not fatal: the lease lapses on its own within the TTL. Never mask fn's result or error.
      if (e) console.error(`sync lock release failed: ${errorMessage(e)}`);
    } catch (e) {
      console.error(`sync lock release failed: ${errorMessage(e)}`);
    }
  }
}
