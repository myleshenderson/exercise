/**
 * Owner-run sync (AI-641): `npm run sync -- --source garmin|peloton|all --full|--incremental`.
 * Env comes from .env.local (see docs/ride-sync.md); the logic lives in src/sync/runner.ts.
 * The run (reseed, sync, recompute-all) holds the sync lease (AI-659): while the cron or a
 * Settings "Sync now" holds it, this prints `sync already running` and exits 1.
 */
import { SYNC_USAGE, SyncUsageError, parseSyncArgs, providersOf } from "../src/sync/cli.js";
import { SyncLockBusyError, withSyncLock } from "../src/sync/lock.js";
import { createNodeSyncDeps, createServiceClient } from "../src/sync/nodeDeps.js";
import { seedPelotonCredential } from "../src/sync/peloton/index.js";
import { recomputeAll } from "../src/sync/recompute.js";
import { SyncLoadError, SyncLockLostError, readSyncEnv, runSync, todayIn } from "../src/sync/runner.js";
import type { SyncRunResult } from "../src/sync/types.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const notes = (r: SyncRunResult) => (r.notes?.length ? `, notes ${r.notes.join("; ")}` : "");
const print = (results: SyncRunResult[]) =>
  results.forEach((r) => console.log(`${r.source}: fetched ${r.fetched}, upserted ${r.upserted}, skipped ${r.skipped}, done ${r.done}, error ${r.error ?? "none"}${notes(r)}`));

async function main(): Promise<number> {
  const args = parseSyncArgs(process.argv.slice(2));
  if (args.help) {
    console.log(SYNC_USAGE);
    return 0;
  }
  const sources = providersOf(args.source);
  const env = readSyncEnv(process.env, sources);
  if (args.reseedPelotonToken && !env.PELOTON_REFRESH_TOKEN) throw new Error("--reseed-peloton-token needs PELOTON_REFRESH_TOKEN");

  // A Garmin-only run never touches credentials, so it does not need CREDENTIALS_KEY.
  const client = createServiceClient(env);
  const deps = createNodeSyncDeps(env, client);
  const now = () => Date.now();
  // Read at each recompute: a six-hour backfill can cross midnight.
  const today = () => todayIn(env.SYNC_DEFAULT_TIMEZONE, now());

  return withSyncLock(client, async ({ lost }) => {
    if (args.reseedPelotonToken) {
      await seedPelotonCredential(deps.store, deps.box, env.PELOTON_REFRESH_TOKEN!, now);
      console.log("peloton: credential reseeded from PELOTON_REFRESH_TOKEN");
    }

    // --recompute-all rebuilds the daily load from the first ride, so the range recompute is skipped.
    const deadlineMs = now() + SIX_HOURS_MS;
    const results = await runSync(deps, { sources, mode: args.mode, deadlineMs, now, today, skipDailyLoadRecompute: args.recomputeAll, lost });
    print(results);

    if (args.recomputeAll) {
      if (lost()) throw new SyncLockLostError(results);
      const r = await recomputeAll(deps.store, { defaultTimeZone: env.SYNC_DEFAULT_TIMEZONE, today: today() });
      console.log(`recompute-all: ${r.activities} activities, ${r.days} days, done ${r.done}`);
    }
    return results.some((r) => r.error !== null) ? 1 : 0;
  }, { label: "cli" });
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof SyncLockBusyError) {
      console.error(e.message); // "sync already running"
      process.exit(1);
    }
    if (e instanceof SyncLoadError || e instanceof SyncLockLostError) print(e.results);
    console.error(e instanceof SyncUsageError ? e.message : `sync failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof SyncUsageError ? 2 : 1);
  },
);
