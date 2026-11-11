/**
 * Daily Vercel cron (AI-641): GET /api/sync with `Authorization: Bearer ${CRON_SECRET}` runs an
 * incremental Garmin + Peloton sync inside the 60 s function limit. The answer carries counts and
 * error strings only, never tokens.
 *
 * Settings "Sync now" (AI-653): POST /api/sync with `Authorization: Bearer <Supabase access
 * token>` runs the same sync for the owner account only; POST /api/sync?recompute=all recomputes
 * every activity's TSS and the daily load instead. CRON_SECRET is never accepted on POST.
 */
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createNodeSyncDeps } from "../src/sync/nodeDeps.js";
import { recomputeAll } from "../src/sync/recompute.js";
import { SyncLoadError, readSyncEnv, runSync, todayIn, type SyncDeps, type SyncOptions, type SyncProvider } from "../src/sync/runner.js";
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

export interface HandleSyncDeps {
  cronSecret: string;
  now: () => number;
  /** Builds the runner deps; called only once the request is authorised. */
  makeDeps: () => SyncDeps;
  runSync: (deps: SyncDeps, opts: SyncOptions) => Promise<SyncRunResult[]>;
}

export type HandleSyncResult = { status: 200; body: SyncRunResult[] } | { status: number; body: { error: string } };

/** True when `authorization` is exactly `Bearer ${secret}`, compared in constant time. */
export function bearerMatches(authorization: string | undefined, secret: string): boolean {
  if (!authorization || !secret) return false;
  const given = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleSync(
  input: { authorization: string | undefined; method: string | undefined },
  deps: HandleSyncDeps,
): Promise<HandleSyncResult> {
  if (input.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };
  if (!bearerMatches(input.authorization, deps.cronSecret)) return { status: 401, body: { error: "Unauthorized" } };

  const start = deps.now();
  const syncDeps = deps.makeDeps();
  const results = await deps.runSync(syncDeps, {
    sources: CRON_SOURCES,
    mode: "incremental",
    deadlineMs: start + CRON_BUDGET_MS,
    now: deps.now,
    today: () => todayIn(syncDeps.env.SYNC_DEFAULT_TIMEZONE, deps.now()),
  });
  return { status: 200, body: results };
}

export interface HandleOwnerSyncDeps {
  /** Never accepted on POST: a bearer equal to it is refused before any Supabase call. */
  cronSecret: string;
  /** Stateless Supabase `auth.getUser(token)`; null for an error or no user. */
  verifyUser: (token: string) => Promise<{ id: string } | null>;
  /** SYNC_OWNER_USER_ID; empty refuses every user. */
  ownerUserId: string;
  now: () => number;
  /** Builds the runner deps for `sources` ([] for a recompute); called only once authorised. */
  makeDeps: (sources: readonly SyncProvider[]) => SyncDeps;
  runSync: (deps: SyncDeps, opts: SyncOptions) => Promise<SyncRunResult[]>;
  recomputeAll: typeof recomputeAll;
}

export type HandleOwnerSyncResult =
  | { status: 200; body: { kind: "sync"; results: SyncRunResult[] } }
  | { status: 200; body: { kind: "recompute"; activities: number; days: number } }
  | { status: number; body: { error: string } };

const BEARER = /^Bearer ([^\s]+)$/;

/** `recompute` query values: null when absent, else every value given. */
function recomputeParam(url: string | undefined): string[] | null {
  const values = new URL(url ?? "/", "http://localhost").searchParams.getAll("recompute");
  return values.length === 0 ? null : values;
}

export async function handleOwnerSync(
  input: { authorization: string | undefined; method: string | undefined; url: string | undefined },
  deps: HandleOwnerSyncDeps,
): Promise<HandleOwnerSyncResult> {
  // The budget counts from the request's arrival, so the getUser round trip is inside it.
  const start = deps.now();
  if (input.method !== "POST") return { status: 405, body: { error: "Method not allowed" } };
  const token = BEARER.exec(input.authorization ?? "")?.[1];
  // The cron secret is refused here and never sent to Supabase as a would-be access token.
  if (token === undefined || bearerMatches(input.authorization, deps.cronSecret)) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  const user = await deps.verifyUser(token);
  if (!user) return { status: 401, body: { error: "Invalid session" } };
  if (!deps.ownerUserId || user.id !== deps.ownerUserId) {
    return { status: 403, body: { error: "Sync is limited to the owner account" } };
  }

  const recompute = recomputeParam(input.url);
  if (recompute !== null) {
    if (recompute.length !== 1 || recompute[0] !== "all") return { status: 400, body: { error: "recompute must be 'all'" } };
    const syncDeps = deps.makeDeps([]);
    const tz = syncDeps.env.SYNC_DEFAULT_TIMEZONE;
    const counts = await deps.recomputeAll(syncDeps.store, { defaultTimeZone: tz, today: todayIn(tz, deps.now()) });
    return { status: 200, body: { kind: "recompute", activities: counts.activities, days: counts.days } };
  }

  const syncDeps = deps.makeDeps(CRON_SOURCES);
  const results = await deps.runSync(syncDeps, {
    sources: CRON_SOURCES,
    mode: "incremental",
    deadlineMs: start + CRON_BUDGET_MS,
    now: deps.now,
    today: () => todayIn(syncDeps.env.SYNC_DEFAULT_TIMEZONE, deps.now()),
  });
  return { status: 200, body: { kind: "sync", results } };
}

const makeDeps = (): SyncDeps => createNodeSyncDeps(readSyncEnv(process.env, CRON_SOURCES));

const makeOwnerDeps = (sources: readonly SyncProvider[]): SyncDeps => createNodeSyncDeps(readSyncEnv(process.env, sources));

/**
 * The same stateless check as api/mcp-login.ts: getUser(token) on a service-role client. Never
 * call a session-establishing auth method on this client.
 */
async function verifySupabaseUser(token: string): Promise<{ id: string } | null> {
  let env;
  try {
    env = readSyncEnv(process.env, []);
  } catch (e) {
    // The caller is not authenticated yet: name the missing variables in the log only.
    console.error(`sync owner: ${e instanceof Error ? e.message : String(e)}`);
    throw new Error("Sync is not configured");
  }
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id };
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
        verifyUser: verifySupabaseUser,
        ownerUserId: (process.env.SYNC_OWNER_USER_ID ?? "").trim(),
        now: () => Date.now(),
        makeDeps: makeOwnerDeps,
        runSync,
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
    if (e instanceof SyncLoadError) logFailures(e.results, "sync owner");
    res.status(500).json(e instanceof SyncLoadError ? { error, results: e.results } : { error });
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
      { cronSecret: process.env.CRON_SECRET ?? "", now: () => Date.now(), makeDeps, runSync },
    );
    if (result.status === 200) logFailures(result.body as SyncRunResult[]);
    res.status(result.status).json(result.body);
  } catch (e) {
    // Env and daily-load failures (only reachable once authorised): report the message (the code
    // never puts a token in one), with the per-source results when the sources ran.
    const error = e instanceof Error ? e.message : String(e);
    console.error(`sync cron: ${error}`);
    if (e instanceof SyncLoadError) logFailures(e.results);
    res.status(500).json(e instanceof SyncLoadError ? { error, results: e.results } : { error });
  }
}
