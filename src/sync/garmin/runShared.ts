/** Helpers both Garmin runs share (AI-638). */
import { DAY_MS } from "../../metrics/index.js";
import type { SyncSource } from "../../types.js";
import type { SyncStore } from "../store.js";
import type { SyncRunResult } from "../types.js";
import { GarminAuthError } from "./client.js";

export { DAY_MS };
/** The incremental window reaches back this far before last_success_at. */
export const LOOKBACK_DAYS = 3;

/** `YYYY-MM-DD` of an epoch-ms instant in UTC. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A readable message for anything thrown. Supabase rethrows `PostgrestError` values, which are
 * plain objects (not `Error` instances), so their fields are spelled out rather than letting
 * `String(e)` render `[object Object]` (AI-660).
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    const { message, code, details, hint } = e as { message: string; code?: unknown; details?: unknown; hint?: unknown };
    let out = message;
    if (typeof code === "string" && code !== "") out += ` (code ${code})`;
    if (typeof details === "string" && details !== "") out += `: ${details}`;
    if (typeof hint === "string" && hint !== "") out += `. ${hint}`;
    return out;
  }
  try {
    const json = JSON.stringify(e);
    // JSON.stringify returns undefined for undefined, functions and symbols.
    if (typeof json === "string") return json;
  } catch {
    // Circular structures and BigInt throw; fall through.
  }
  return String(e);
}

export interface FinishArgs {
  source: SyncSource;
  cursor: unknown;
  backfillComplete: boolean;
  fetched: number;
  upserted: number;
  skipped: number;
  done: boolean;
  earliestAffected: string | null;
  error: unknown;
  /** True once a token exchange succeeded in this run. */
  tokenOk: boolean;
  /**
   * Non-fatal notes on items the run stored but flagged. With no error they become last_error
   * (joined by "; ") and the result's `notes`; they do not fail the run.
   */
  notes?: string[];
  /** Epoch ms the run began; last_success_at records this, so nothing newer is assumed read. */
  startedMs: number;
  /** False keeps the stored last_success_at even without an error; see successAdvances. */
  advanceSuccess: boolean;
}

/** Writes the sync_state row for the run's end and builds its result. */
export async function finishRun(store: SyncStore, now: () => number, a: FinishArgs): Promise<SyncRunResult> {
  const error = a.error === null ? null : errorMessage(a.error);
  const notes = a.notes ?? [];
  const lastError = error ?? (notes.length > 0 ? notes.join("; ") : null);
  const at = new Date(now()).toISOString();
  const authFailed = a.error instanceof GarminAuthError;
  await store.saveSyncState({
    source: a.source,
    cursor: a.cursor,
    backfillComplete: a.backfillComplete,
    lastRunAt: at,
    itemsFetched: a.fetched,
    itemsUpserted: a.upserted,
    lastError,
    ...(error === null && a.advanceSuccess ? { lastSuccessAt: new Date(a.startedMs).toISOString() } : {}),
    ...(authFailed ? { authStatus: "reconnect_required" as const } : a.tokenOk ? { authStatus: "ok" as const } : {}),
  });
  return {
    source: a.source,
    fetched: a.fetched,
    upserted: a.upserted,
    skipped: a.skipped,
    done: a.done && error === null,
    earliestAffected: a.earliestAffected,
    error,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Whether an error-free run may move last_success_at to now. last_success_at anchors the next
 * incremental window (it reaches back 3 days from it), so it must not pass anything unread:
 * - during a backfill it is set once, by the first run, and then held. A backfill reads the
 *   newest items only on that first run, so the first incremental window must start from it;
 * - an incremental run cut short by the deadline keeps the old value.
 */
export function successAdvances(backfill: boolean, done: boolean, lastSuccessAt: string | null | undefined): boolean {
  return backfill ? !lastSuccessAt : done;
}
