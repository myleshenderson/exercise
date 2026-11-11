/**
 * The one sync runner (AI-641) behind both entry points: `scripts/sync.ts` (owner-run backfill)
 * and `api/sync.ts` (the daily Vercel cron). Pure: the caller injects env, fetch, sleep, the
 * store and the SecretBox, so nothing here reads process.env or imports node:*.
 */
import { dateFromDayNumber, dayNumber, localDate, type EftpRide } from "../metrics/index.js";
import type { SyncSource } from "../types.js";
import { createGarminClient, runGarminActivities, runGarminWeight } from "./garmin/index.js";
import { errorMessage } from "./garmin/runShared.js";
import type { FetchLike } from "./http.js";
import { recomputeDailyLoad } from "./load.js";
import { createPelotonClient, getPelotonAccessToken, runPeloton, type SecretBox } from "./peloton/index.js";
import type { SyncStore } from "./store.js";
import type { IngestContext, SyncRunResult } from "./types.js";

export type SyncProvider = "garmin" | "peloton";

export const DEFAULT_SYNC_TIMEZONE = "America/New_York";

export interface SyncEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SYNC_OWNER_USER_ID: string;
  /** Set when `garmin` was requested. */
  GARMIN_API_KEY: string | null;
  /** Set when `peloton` was requested. */
  PELOTON_AUTH0_CLIENT_ID: string | null;
  /** Base64 of 32 bytes; set when `peloton` was requested. */
  CREDENTIALS_KEY: string | null;
  /** Bootstrap only: the stored credential wins once it exists. */
  PELOTON_REFRESH_TOKEN: string | null;
  SYNC_DEFAULT_TIMEZONE: string;
}

const present = (v: string | undefined): string | null => (v !== undefined && v.trim() !== "" ? v.trim() : null);

/** Reads the variables the requested sources need; throws one error naming every missing one. */
export function readSyncEnv(env: Record<string, string | undefined>, sources: readonly SyncProvider[]): SyncEnv {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SYNC_OWNER_USER_ID"];
  if (sources.includes("garmin")) required.push("GARMIN_API_KEY");
  if (sources.includes("peloton")) required.push("PELOTON_AUTH0_CLIENT_ID", "CREDENTIALS_KEY");
  const missing = required.filter((name) => present(env[name]) === null);
  if (missing.length > 0) throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  return {
    SUPABASE_URL: present(env.SUPABASE_URL)!,
    SUPABASE_SERVICE_ROLE_KEY: present(env.SUPABASE_SERVICE_ROLE_KEY)!,
    SYNC_OWNER_USER_ID: present(env.SYNC_OWNER_USER_ID)!,
    GARMIN_API_KEY: present(env.GARMIN_API_KEY),
    PELOTON_AUTH0_CLIENT_ID: present(env.PELOTON_AUTH0_CLIENT_ID),
    CREDENTIALS_KEY: present(env.CREDENTIALS_KEY),
    PELOTON_REFRESH_TOKEN: present(env.PELOTON_REFRESH_TOKEN),
    SYNC_DEFAULT_TIMEZONE: present(env.SYNC_DEFAULT_TIMEZONE) ?? DEFAULT_SYNC_TIMEZONE,
  };
}

export interface SyncDeps {
  store: SyncStore;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  box: SecretBox;
  env: SyncEnv;
}

export interface SyncOptions {
  sources: readonly SyncProvider[];
  mode: "full" | "incremental";
  /** Epoch ms; each source stops starting new items at it. */
  deadlineMs: number;
  now: () => number;
  /** `YYYY-MM-DD` in SYNC_DEFAULT_TIMEZONE; the daily-load recompute ends here. */
  today: string;
}

/** `YYYY-MM-DD` of an instant in `timeZone` (UTC when the zone is unknown). */
export function todayIn(timeZone: string, nowMs: number): string {
  return localDate(new Date(nowMs).toISOString(), timeZone) ?? new Date(nowMs).toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const n = dayNumber(date);
  if (n === null) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return dateFromDayNumber(n + days);
}

/** Days before `today` the daily-load recompute always covers (strength sessions logged this week). */
export const RECENT_LOAD_DAYS = 7;

/**
 * First day of the daily-load recompute: the earlier of (the earliest affected UTC date minus a
 * day, which covers any local time zone) and (`today` minus 7 days).
 */
export function dailyLoadFrom(results: readonly SyncRunResult[], today: string): string {
  let from = shiftDate(today, -RECENT_LOAD_DAYS);
  for (const r of results) {
    if (r.earliestAffected === null) continue;
    const ms = Date.parse(r.earliestAffected);
    if (Number.isNaN(ms)) continue;
    const day = shiftDate(new Date(ms).toISOString().slice(0, 10), -1);
    if (day < from) from = day;
  }
  return from;
}

function mmp20(powerCurve: unknown): number | null {
  if (!powerCurve || typeof powerCurve !== "object") return null;
  const w = (powerCurve as Record<string, unknown>)["1200"];
  return typeof w === "number" && Number.isFinite(w) ? w : null;
}

/** Settings, FTP history and every stored ride's 20-minute best, for eFTP. */
export async function buildIngestContext(store: SyncStore): Promise<IngestContext> {
  const [settings, ftpHistory, activities] = await Promise.all([
    store.getAthleteSettings(),
    store.listFtpHistory(),
    store.listAllActivities(),
  ]);
  const priorRides: EftpRide[] = activities.map((a) => ({ startedAt: a.startedAt, mmp20minW: mmp20(a.powerCurve) }));
  return { settings, ftpHistory, priorRides };
}

/** Thrown when the daily-load recompute fails; `results` keeps what the sources did. */
export class SyncLoadError extends Error {
  constructor(
    message: string,
    readonly results: SyncRunResult[],
  ) {
    super(`daily load recompute failed: ${message}`);
    this.name = "SyncLoadError";
  }
}

/** Waits this short always run, so a polite pause near the deadline is not an error. */
export const ALWAYS_SLEEP_MS = 2_000;

/**
 * `sleep` that refuses a wait (a Retry-After or a long backoff) ending past the deadline: the
 * adapters check the deadline only between items, and a cron function past its limit is killed
 * before it can save its cursor. The refusal is an error the adapter records like any other.
 */
export function deadlineSleep(sleep: (ms: number) => Promise<void>, deadlineMs: number, now: () => number) {
  return (ms: number): Promise<void> => {
    if (ms > ALWAYS_SLEEP_MS && now() + ms > deadlineMs) {
      return Promise.reject(new Error(`provider asked to wait ${Math.ceil(ms / 1000)} s, past this run's deadline; rerun later`));
    }
    return sleep(ms);
  };
}

function failed(source: SyncSource, e: unknown): SyncRunResult {
  return { source, fetched: 0, upserted: 0, skipped: 0, done: false, earliestAffected: null, error: errorMessage(e) };
}

/**
 * Runs each requested source in turn (Garmin activities, Garmin weight, Peloton), each in its own
 * try/catch so one failure leaves the others running, then recomputes daily_training_load from
 * the earliest affected day. The adapters write their own sync_state rows; when one throws
 * before doing so, the runner records the error there. A failed recompute throws SyncLoadError,
 * which still carries the per-source results.
 */
export async function runSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncRunResult[]> {
  const { store, fetch, box, env } = deps;
  const { mode, deadlineMs, now } = opts;
  const sleep = deadlineSleep(deps.sleep, deadlineMs, now);

  let ctx: Promise<IngestContext> | null = null;
  const ingestContext = () => (ctx ??= buildIngestContext(store));
  const runOpts = { mode, deadlineMs, now, ingestContext };

  const jobs: [SyncSource, () => Promise<SyncRunResult>][] = [];
  if (opts.sources.includes("garmin")) {
    const client = () => {
      if (!env.GARMIN_API_KEY) throw new Error("GARMIN_API_KEY is not set");
      return createGarminClient({ fetch, apiKey: env.GARMIN_API_KEY, sleep, now });
    };
    let garmin: ReturnType<typeof createGarminClient> | null = null;
    const shared = () => (garmin ??= client());
    jobs.push(["garmin_activities", () => runGarminActivities(shared(), store, runOpts)]);
    jobs.push(["garmin_weight", () => runGarminWeight(shared(), store, runOpts)]);
  }
  if (opts.sources.includes("peloton")) {
    jobs.push([
      "peloton",
      () => {
        const clientId = env.PELOTON_AUTH0_CLIENT_ID;
        if (!clientId) throw new Error("PELOTON_AUTH0_CLIENT_ID is not set");
        const client = createPelotonClient({
          fetch,
          getToken: () =>
            getPelotonAccessToken({ fetch, clientId, box, store, bootstrapRefreshToken: env.PELOTON_REFRESH_TOKEN, now, sleep }),
          sleep,
        });
        return runPeloton(client, store, runOpts);
      },
    ]);
  }

  const results: SyncRunResult[] = [];
  for (const [source, run] of jobs) {
    try {
      results.push(await run());
    } catch (e) {
      const result = failed(source, e);
      results.push(result);
      try {
        await store.saveSyncState({ source, lastRunAt: new Date(now()).toISOString(), lastError: result.error });
      } catch {
        // The result still carries the error; a store that is down cannot record it anyway.
      }
    }
  }

  try {
    await recomputeDailyLoad(store, dailyLoadFrom(results, opts.today), opts.today, {
      defaultTimeZone: env.SYNC_DEFAULT_TIMEZONE,
    });
  } catch (e) {
    throw new SyncLoadError(errorMessage(e), results);
  }
  return results;
}
