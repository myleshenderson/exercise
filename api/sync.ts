/**
 * Daily Vercel cron (AI-641): GET /api/sync with `Authorization: Bearer ${CRON_SECRET}` runs an
 * incremental Garmin + Peloton sync inside the 60 s function limit. The answer carries counts and
 * error strings only, never tokens.
 *
 * Settings "Sync now" (AI-653): POST /api/sync with `Authorization: Bearer <Supabase access
 * token>` runs the same sync for the owner account only; POST /api/sync?recompute=all[&offset=n]
 * recomputes every activity's TSS and the daily load instead, in budgeted passes the client
 * repeats with `offset=nextOffset` until `done`. CRON_SECRET is never accepted on POST.
 *
 * Every POST and GET that does work (sync or recompute) runs inside `withSyncLock` (AI-659): while
 * another run (cron, owner or `npm run sync`) holds the lease the answer is 409
 * `{ "error": "sync already running" }`. The lease TTL here is 120 s (Vercel kills the function at
 * 60 s), so a killed run blocks the next one for 2 minutes at most. A run that loses its lease
 * ends with 500 `sync lock lost`.
 */
import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SyncLockBusyError, withSyncLock, type SyncLease } from "../src/sync/lock.js";
import { createNodeSyncDeps, createServiceClient } from "../src/sync/nodeDeps.js";
import { recomputeAll } from "../src/sync/recompute.js";
import {
  SyncLoadError,
  SyncLockLostError,
  readSyncEnv,
  runSync,
  todayIn,
  type SyncDeps,
  type SyncEnv,
  type SyncOptions,
  type SyncProvider,
} from "../src/sync/runner.js";
import type { SyncRunResult } from "../src/sync/types.js";

interface VercelLikeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface VercelLikeResponse {
  status(code: number): VercelLikeResponse;
  json(body: unknown): void;
}

export const CRON_SOURCES: SyncProvider[] = ["garmin", "peloton"];
/** Leaves 10 s of the 60 s limit for the daily-load recompute and the response. */
export const CRON_BUDGET_MS = 50_000;

/** Lease TTL for both HTTP paths: twice the 60 s `maxDuration` in vercel.json. */
export const HTTP_SYNC_LOCK_TTL_MS = 120_000;

/** `withSyncLock` on the request's client; throws `SyncLockBusyError` when another run holds the lease. */
export type WithSyncLock<Client> = <T>(client: Client, fn: (lease: SyncLease) => Promise<T>) => Promise<T>;

export interface HandleSyncDeps<Client = SupabaseClient> {
  cronSecret: string;
  now: () => number;
  /** Builds the service client and the runner deps on it; called only once the request is authorised. */
  makeDeps: () => { deps: SyncDeps; client: Client };
  runSync: (deps: SyncDeps, opts: SyncOptions) => Promise<SyncRunResult[]>;
  withSyncLock: WithSyncLock<Client>;
}

const SYNC_BUSY = { status: 409, body: { error: "sync already running" } } as const;

/** Runs `fn` under the lease; `null` when another run holds it (the caller answers 409). */
async function lockedOrBusy<T>(
  lock: (fn: (lease: SyncLease) => Promise<T>) => Promise<T>,
  fn: (lease: SyncLease) => Promise<T>,
): Promise<T | null> {
  try {
    return await lock(fn);
  } catch (e) {
    if (e instanceof SyncLockBusyError) return null;
    throw e;
  }
}

export type HandleSyncResult = { status: 200; body: SyncRunResult[] } | { status: number; body: { error: string } };

/** True when `authorization` is exactly `Bearer ${secret}`, compared in constant time. */
export function bearerMatches(authorization: string | undefined, secret: string): boolean {
  if (!authorization || !secret) return false;
  const given = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleSync<Client>(
  input: { authorization: string | undefined; method: string | undefined },
  deps: HandleSyncDeps<Client>,
): Promise<HandleSyncResult> {
  if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
  if (!bearerMatches(input.authorization, deps.cronSecret)) return { status: 401, body: { error: "Unauthorized" } };

  const start = deps.now();
  const { deps: syncDeps, client } = deps.makeDeps();
  const results = await lockedOrBusy<SyncRunResult[]>(
    (fn) => deps.withSyncLock(client, fn),
    (lease) => deps.runSync(syncDeps, budgetedSyncOptions(syncDeps.env, start, deps.now, lease.lost)),
  );
  if (results === null) return SYNC_BUSY;
  return { status: 200, body: results };
}

/** The cron's run, shared by GET and the owner's POST: incremental, both providers, 50 s budget. */
export function budgetedSyncOptions(env: SyncEnv, start: number, now: () => number, lost?: () => boolean): SyncOptions {
  return {
    lost,
    sources: CRON_SOURCES,
    mode: "incremental",
    deadlineMs: start + CRON_BUDGET_MS,
    now,
    today: () => todayIn(env.SYNC_DEFAULT_TIMEZONE, now()),
  };
}

/** The outcome of the stateless token check. */
export type VerifyUserResult =
  | { kind: "user"; id: string }
  | { kind: "invalid" }
  /** Supabase Auth could not answer (5xx, network): not the caller's fault. */
  | { kind: "unavailable"; status: number | undefined };

export interface HandleOwnerSyncDeps<Client = SupabaseClient> {
  /** Never accepted on POST: a bearer equal to it is refused before any Supabase call. */
  cronSecret: string;
  now: () => number;
  /** `readSyncEnv(process.env, sources)`; throws naming the missing variables. */
  readEnv: (sources: readonly SyncProvider[]) => SyncEnv;
  /** The one service-role client of this request, shared by the token check and the store. */
  createClient: (env: SyncEnv) => Client;
  /** Stateless `auth.getUser(token)` on that client. */
  verifyUser: (client: Client, token: string) => Promise<VerifyUserResult>;
  /** Builds the runner deps on that client; called only once authorised. */
  makeDeps: (env: SyncEnv, client: Client) => SyncDeps;
  runSync: (deps: SyncDeps, opts: SyncOptions) => Promise<SyncRunResult[]>;
  withSyncLock: WithSyncLock<Client>;
  recomputeAll: typeof recomputeAll;
}

export type HandleOwnerSyncResult =
  | { status: 200; body: { kind: "sync"; results: SyncRunResult[] } }
  | {
      status: 200;
      body: { kind: "recompute"; activities: number; days: number; done: boolean; nextOffset: number | null };
    }
  | { status: number; body: { error: string } };

const BEARER = /^Bearer ([^\s]+)$/;
const NOT_CONFIGURED = { status: 500, body: { error: "Sync is not configured" } } as const;

export async function handleOwnerSync<Client>(
  input: { authorization: string | undefined; method: string | undefined; url: string | undefined },
  deps: HandleOwnerSyncDeps<Client>,
): Promise<HandleOwnerSyncResult> {
  // The budget counts from the request's arrival, so the getUser round trip is inside it.
  const start = deps.now();
  if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed" } };
  const token = BEARER.exec(input.authorization ?? "")?.[1];
  // The cron secret is refused here and never sent to Supabase as a would-be access token.
  if (token === undefined || bearerMatches(input.authorization, deps.cronSecret)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }

  let query: URLSearchParams;
  try {
    query = new URL(input.url ?? "/", "http://localhost").searchParams;
  } catch (e) {
    if (e instanceof TypeError) return { status: 400, body: { error: "Bad request URL" } };
    throw e;
  }
  const recompute = query.getAll("recompute");
  // One env and one client per request: the recompute needs no provider variables.
  let env: SyncEnv;
  let client: Client;
  try {
    env = deps.readEnv(recompute.length > 0 ? [] : CRON_SOURCES);
    client = deps.createClient(env);
  } catch (e) {
    // The caller is not authenticated yet: name the missing variables in the log only.
    console.error(`sync owner: ${e instanceof Error ? e.message : String(e)}`);
    return NOT_CONFIGURED;
  }
  if (!env.SYNC_OWNER_USER_ID) {
    console.error("sync owner: SYNC_OWNER_USER_ID is not set");
    return NOT_CONFIGURED;
  }

  const user = await deps.verifyUser(client, token);
  if (user.kind === "unavailable") {
    console.error(`sync owner: auth service unavailable (status ${user.status ?? "none"})`);
    return { status: 503, body: { error: "Auth service unavailable" } };
  }
  if (user.kind === "invalid") return { status: 401, body: { error: "Invalid session" } };
  if (user.id !== env.SYNC_OWNER_USER_ID) {
    return { status: 403, body: { error: "Sync is limited to the owner account" } };
  }

  if (recompute.length > 0) {
    if (recompute.length !== 1 || recompute[0] !== "all") return { status: 400, body: { error: "recompute must be 'all'" } };
    const offsets = query.getAll("offset");
    const offset = offsets.length === 0 ? 0 : offsets.length === 1 && /^\d+$/.test(offsets[0]!) ? Number(offsets[0]) : NaN;
    if (!Number.isSafeInteger(offset)) return { status: 400, body: { error: "offset must be a non-negative integer" } };
    const syncDeps = deps.makeDeps(env, client);
    const tz = env.SYNC_DEFAULT_TIMEZONE;
    // Under the lease too: a concurrent runSync writes the same daily_training_load rows.
    const r = await lockedOrBusy(
      (fn) => deps.withSyncLock(client, fn),
      () =>
        deps.recomputeAll(syncDeps.store, {
          defaultTimeZone: tz,
          today: todayIn(tz, deps.now()),
          deadlineMs: start + CRON_BUDGET_MS,
          offset,
          now: deps.now,
        }),
    );
    if (r === null) return SYNC_BUSY;
    return {
      status: 200,
      body: { kind: "recompute", activities: r.activities, days: r.days, done: r.done, nextOffset: r.nextOffset },
    };
  }

  const syncDeps = deps.makeDeps(env, client);
  const results = await lockedOrBusy<SyncRunResult[]>(
    (fn) => deps.withSyncLock(client, fn),
    (lease) => deps.runSync(syncDeps, budgetedSyncOptions(env, start, deps.now, lease.lost)),
  );
  if (results === null) return SYNC_BUSY;
  return { status: 200, body: { kind: "sync", results } };
}

/** An outage rather than a rejection: no HTTP answer (0), a 5xx, or the client's retryable error. */
function authUnavailable(error: { status?: number; name?: string }): boolean {
  return error.name === "AuthRetryableFetchError" || error.status === 0 || (error.status !== undefined && error.status >= 500);
}

/**
 * The same stateless check as api/mcp-login.ts: getUser(token) on a service-role client. Never
 * call a session-establishing auth method on this client.
 */
export async function verifySupabaseUser(
  client: Pick<SupabaseClient, "auth">,
  token: string,
): Promise<VerifyUserResult> {
  const { data, error } = await client.auth.getUser(token);
  if (error) return authUnavailable(error) ? { kind: "unavailable", status: error.status } : { kind: "invalid" };
  return data.user ? { kind: "user", id: data.user.id } : { kind: "invalid" };
}

/** One log line per failed source: counts and the error string only, never tokens. */
function logFailures(results: readonly SyncRunResult[], prefix = "sync cron"): void {
  for (const r of results) {
    if (r.error === null) continue;
    console.error(
      `${prefix}: ${r.source} failed (fetched ${r.fetched}, upserted ${r.upserted}, skipped ${r.skipped}, done ${r.done}): ${r.error}`,
    );
  }
}

async function ownerHandler(req: VercelLikeRequest, res: VercelLikeResponse, authorization: string | undefined): Promise<void> {
  try {
    const result = await handleOwnerSync(
      { authorization, method: req.method, url: req.url },
      {
        cronSecret: process.env.CRON_SECRET ?? "",
        now: () => Date.now(),
        readEnv: (sources) => readSyncEnv(process.env, sources),
        createClient: createServiceClient,
        verifyUser: verifySupabaseUser,
        makeDeps: createNodeSyncDeps,
        runSync,
        withSyncLock: (client, fn) => withSyncLock(client, fn, { label: "owner", ttlMs: HTTP_SYNC_LOCK_TTL_MS }),
        recomputeAll,
      },
    );
    if (result.status === 200 && "kind" in result.body && result.body.kind === "sync") {
      logFailures(result.body.results, "sync owner");
    }
    res.status(result.status).json(result.body);
  } catch (e) {
    // Same shape as the cron path; the message never carries the bearer (it is not in any error
    // the runner, the store or getUser builds).
    const error = e instanceof Error ? e.message : String(e);
    console.error(`sync owner: ${error}`);
    const results = e instanceof SyncLoadError || e instanceof SyncLockLostError ? e.results : null;
    if (results) logFailures(results, "sync owner");
    res.status(500).json(results ? { error, results } : { error });
  }
}

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  const header = req.headers.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
  if (req.method === "POST") return ownerHandler(req, res, authorization);
  try {
    // An unset or empty CRON_SECRET refuses every bearer (401) and is never named to the caller.
    const result = await handleSync(
      { authorization, method: req.method },
      {
        cronSecret: process.env.CRON_SECRET ?? "",
        now: () => Date.now(),
        makeDeps: () => {
          const env = readSyncEnv(process.env, CRON_SOURCES);
          const client = createServiceClient(env);
          return { deps: createNodeSyncDeps(env, client), client };
        },
        runSync,
        withSyncLock: (client, fn) => withSyncLock(client, fn, { label: "cron", ttlMs: HTTP_SYNC_LOCK_TTL_MS }),
      },
    );
    if (result.status === 200) logFailures(result.body as SyncRunResult[]);
    res.status(result.status).json(result.body);
  } catch (e) {
    // Env and daily-load failures (only reachable once authorised): report the message (the code
    // never puts a token in one), with the per-source results when the sources ran.
    const error = e instanceof Error ? e.message : String(e);
    console.error(`sync cron: ${error}`);
    const results = e instanceof SyncLoadError || e instanceof SyncLockLostError ? e.results : null;
    if (results) logFailures(results);
    res.status(500).json(results ? { error, results } : { error });
  }
}
