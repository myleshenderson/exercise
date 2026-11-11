/**
 * Owner-run sync (AI-641): `npm run sync -- --source garmin|peloton|all --full|--incremental`.
 * Env comes from .env.local (see docs/ride-sync.md); the logic lives in src/sync/runner.ts.
 */
import { createClient } from "@supabase/supabase-js";
import { SYNC_USAGE, SyncUsageError, parseSyncArgs, providersOf } from "../src/sync/cli.js";
import { createNodeSecretBox, loadCredentialsKey } from "../src/sync/credentials.js";
import { defaultSleep } from "../src/sync/http.js";
import { seedPelotonCredential } from "../src/sync/peloton/index.js";
import { recomputeAll } from "../src/sync/recompute.js";
import { SyncLoadError, readSyncEnv, runSync, todayIn } from "../src/sync/runner.js";
import { createSupabaseSyncStore } from "../src/sync/store.js";
import type { SyncRunResult } from "../src/sync/types.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const print = (results: SyncRunResult[]) =>
  results.forEach((r) => console.log(`${r.source}: fetched ${r.fetched}, upserted ${r.upserted}, skipped ${r.skipped}, done ${r.done}, error ${r.error ?? "none"}`));

async function main(): Promise<number> {
  const args = parseSyncArgs(process.argv.slice(2));
  if (args.help) {
    console.log(SYNC_USAGE);
    return 0;
  }
  const sources = providersOf(args.source);
  const env = readSyncEnv(process.env, sources);
  if (args.reseedPelotonToken && !env.PELOTON_REFRESH_TOKEN) throw new Error("--reseed-peloton-token needs PELOTON_REFRESH_TOKEN");

  const store = createSupabaseSyncStore(createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY), env.SYNC_OWNER_USER_ID);
  // A Garmin-only run never touches credentials, so it does not need CREDENTIALS_KEY.
  const noKey = async (): Promise<never> => Promise.reject(new Error("CREDENTIALS_KEY is not set"));
  const box = env.CREDENTIALS_KEY ? createNodeSecretBox(loadCredentialsKey(env.CREDENTIALS_KEY)) : { encrypt: noKey, decrypt: noKey };
  const now = () => Date.now();
  const today = todayIn(env.SYNC_DEFAULT_TIMEZONE, now());

  if (args.reseedPelotonToken) {
    await seedPelotonCredential(store, box, env.PELOTON_REFRESH_TOKEN!, now);
    console.log("peloton: credential reseeded from PELOTON_REFRESH_TOKEN");
  }

  const results = await runSync(
    { store, fetch: (url, init) => fetch(url, init), sleep: defaultSleep, box, env },
    { sources, mode: args.mode, deadlineMs: now() + SIX_HOURS_MS, now, today },
  );
  print(results);

  if (args.recomputeAll) {
    const r = await recomputeAll(store, { defaultTimeZone: env.SYNC_DEFAULT_TIMEZONE, today });
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
