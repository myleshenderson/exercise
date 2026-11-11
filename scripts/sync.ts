/**
 * Owner-run sync (AI-641): `npm run sync -- --source garmin|peloton|all --full|--incremental`.
 * Env comes from .env.local (see docs/ride-sync.md); the logic lives in src/sync/runner.ts.
 */
import { SYNC_USAGE, SyncUsageError, parseSyncArgs, providersOf } from "../src/sync/cli.js";
import { createNodeSyncDeps } from "../src/sync/nodeDeps.js";
import { seedPelotonCredential } from "../src/sync/peloton/index.js";
import { recomputeAll } from "../src/sync/recompute.js";
import { SyncLoadError, readSyncEnv, runSync, todayIn } from "../src/sync/runner.js";
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
  const deps = createNodeSyncDeps(env);
  const now = () => Date.now();
  // Read at each recompute: a six-hour backfill can cross midnight.
  const today = () => todayIn(env.SYNC_DEFAULT_TIMEZONE, now());

  if (args.reseedPelotonToken) {
    await seedPelotonCredential(deps.store, deps.box, env.PELOTON_REFRESH_TOKEN!, now);
    console.log("peloton: credential reseeded from PELOTON_REFRESH_TOKEN");
  }

  // --recompute-all rebuilds the daily load from the first ride, so the range recompute is skipped.
  const deadlineMs = now() + SIX_HOURS_MS;
  const results = await runSync(deps, { sources, mode: args.mode, deadlineMs, now, today, skipDailyLoadRecompute: args.recomputeAll });
  print(results);

  if (args.recomputeAll) {
    const r = await recomputeAll(deps.store, { defaultTimeZone: env.SYNC_DEFAULT_TIMEZONE, today: today() });
    console.log(`recompute-all: ${r.activities} activities, ${r.days} days`);
  }
  return results.some((r) => r.error !== null) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof SyncLoadError) print(e.results);
    console.error(e instanceof SyncUsageError ? e.message : `sync failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(e instanceof SyncUsageError ? 2 : 1);
  },
);
