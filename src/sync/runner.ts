/**
 * The one sync runner (AI-641) behind both entry points: `scripts/sync.ts` (owner-run backfill)
 * and `api/sync.ts` (the daily Vercel cron). Pure: the caller injects env, fetch, sleep, the
 * store and the SecretBox, so nothing here reads process.env or imports node:*.
 */
import { localDate, type EftpRide } from "../metrics/index.js";
import type { SyncSource } from "../types.js";
import { createGarminClient, runGarminActivities, runGarminWeight } from "./garmin/index.js";
import { errorMessage } from "./garmin/runShared.js";
import { SyncDeadlineError, type FetchLike } from "./http.js";
import { addDays, recomputeDailyLoad } from "./load.js";
import { createPelotonClient, getPelotonAccessToken, runPeloton, type SecretBox } from "./peloton/index.js";
import { mmp20 } from "./recompute.js";
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
  /**
   * Epoch ms; the whole run's budget. Each source (Garmin activities, Garmin weight and Peloton
   * count as one slot each) gets an equal share of what is left when it starts.
   */
  deadlineMs: number;
  now: () => number;
  /**
   * `YYYY-MM-DD` in SYNC_DEFAULT_TIMEZONE, read when the daily-load recompute starts (a long run
   * can cross midnight); the recompute ends here.
   */
  today: () => string;
  /** Skip the closing daily-load recompute (the CLI's `--recompute-all` does a full one after). */
  skipDailyLoadRecompute?: boolean;
}

/** `YYYY-MM-DD` of an instant in `timeZone` (UTC when the zone is unknown). */
export function todayIn(timeZone: string, nowMs: number): string {
  return localDate(new Date(nowMs).toISOString(), timeZone) ?? new Date(nowMs).toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const shifted = addDays(date, days);
  if (shifted === null) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return shifted;
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
 * before it can save its cursor. The refusal is a SyncDeadlineError, which the adapters let end
 * the run (cursor saved, the item in hand left for the next run). `deadlineMs` may be a getter,
 * so one client can serve sources with different deadlines.
 */
export function deadlineSleep(
  sleep: (ms: number) => Promise<void>,
  deadlineMs: number | (() => number),
  now: () => number,
) {
  const deadline = typeof deadlineMs === "number" ? () => deadlineMs : deadlineMs;
  return (ms: number): Promise<void> => {
    if (ms > ALWAYS_SLEEP_MS && now() + ms > deadline()) {
      return Promise.reject(
        new SyncDeadlineError(`provider asked to wait ${Math.ceil(ms / 1000)} s, past this run's deadline; rerun later`),
      );
    }
    return sleep(ms);
  };
}

/** Calls `f` once and caches its promise; a rejection is not cached, so the next call retries. */
export function memoizeUntilRejected<T>(f: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () =>
    (cached ??= f().catch((e: unknown) => {
      cached = null;
      throw e;
    }));
}

function failed(source: SyncSource, e: unknown): SyncRunResult {
  return { source, fetched: 0, upserted: 0, skipped: 0, done: false, earliestAffected: null, error: errorMessage(e) };
}

/**
 * Runs each requested source in turn (Garmin activities, Garmin weight, Peloton), each in its own
 * try/catch so one failure leaves the others running, each with an equal share of the budget
 * left when it starts (time a source does not use passes to the later ones), then recomputes
 * daily_training_load from the earliest affected day. The adapters write their own sync_state
 * rows; when one throws before doing so, the runner records the error there. A failed recompute
 * throws SyncLoadError, which still carries the per-source results.
 */
export async function runSync(deps: SyncDeps, opts: SyncOptions): Promise<SyncRunResult[]> {
  const { store, fetch, box, env } = deps;
  const { mode, now } = opts;
  /** The running source's deadline; the guarded sleep and the adapters read it. */
  let jobDeadline = opts.deadlineMs;
  const sleep = deadlineSleep(deps.sleep, () => jobDeadline, now);

  const ingestContext = memoizeUntilRejected(() => buildIngestContext(store));
  const runOpts = () => ({ mode, deadlineMs: jobDeadline, now, ingestContext });

  const jobs: [SyncSource, () => Promise<SyncRunResult>][] = [];
  if (opts.sources.includes("garmin")) {
    const client = () => {
      if (!env.GARMIN_API_KEY) throw new Error("GARMIN_API_KEY is not set");
      return createGarminClient({ fetch, apiKey: env.GARMIN_API_KEY, sleep, now });
    };
    let garmin: ReturnType<typeof createGarminClient> | null = null;
    const shared = () => (garmin ??= client());
    jobs.push(["garmin_activities", () => runGarminActivities(shared(), store, runOpts())]);
    jobs.push(["garmin_weight", () => runGarminWeight(shared(), store, runOpts())]);
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
        return runPeloton(client, store, runOpts());
      },
    ]);
  }

  const results: SyncRunResult[] = [];
  for (const [i, [source, run]] of jobs.entries()) {
    const start = now();
    jobDeadline = Math.min(opts.deadlineMs, start + Math.max(0, opts.deadlineMs - start) / (jobs.length - i));
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

  if (opts.skipDailyLoadRecompute) return results;
  try {
    const today = opts.today();
    await recomputeDailyLoad(store, dailyLoadFrom(results, today), today, {
      defaultTimeZone: env.SYNC_DEFAULT_TIMEZONE,
    });
  } catch (e) {
    throw new SyncLoadError(errorMessage(e), results);
  }
  return results;
}
