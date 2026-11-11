/**
 * Daily Vercel cron (AI-641): GET /api/sync with `Authorization: Bearer ${CRON_SECRET}` runs an
 * incremental Garmin + Peloton sync inside the 60 s function limit. The answer carries counts and
 * error strings only, never tokens.
 */
import { timingSafeEqual } from "node:crypto";
import { createNodeSyncDeps } from "../src/sync/nodeDeps.js";
import { SyncLoadError, readSyncEnv, runSync, todayIn, type SyncDeps, type SyncOptions, type SyncProvider } from "../src/sync/runner.js";
import type { SyncRunResult } from "../src/sync/types.js";

interface VercelLikeRequest {
  method?: string;
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

const makeDeps = (): SyncDeps => createNodeSyncDeps(readSyncEnv(process.env, CRON_SOURCES));

/** One log line per failed source: counts and the error string only, never tokens. */
function logFailures(results: readonly SyncRunResult[]): void {
  for (const r of results) {
    if (r.error === null) continue;
    console.error(
      `sync cron: ${r.source} failed (fetched ${r.fetched}, upserted ${r.upserted}, skipped ${r.skipped}, done ${r.done}): ${r.error}`,
    );
  }
}

export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  const header = req.headers.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
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
