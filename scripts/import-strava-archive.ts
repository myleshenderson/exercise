/**
 * One-off Strava archive gap import (AI-640):
 *
 *   npx tsx --env-file=.env.local scripts/import-strava-archive.ts <unzipped-archive-dir> [--dry-run]
 *
 * Imports the archive's rides that no Garmin or Peloton row covers (±600 s) as strava_export
 * rows. Run it only after both backfills are complete; it refuses otherwise. Run --dry-run
 * first and check `sample` against Strava. The logic lives in src/sync/strava/importArchive.ts.
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_SYNC_TIMEZONE, buildIngestContext, todayIn } from "../src/sync/runner.js";
import { createSupabaseSyncStore } from "../src/sync/store.js";
import { StravaCsvError, importStravaArchive } from "../src/sync/strava/importArchive.js";

const USAGE = `Usage: npx tsx --env-file=.env.local scripts/import-strava-archive.ts <unzipped-archive-dir> [--dry-run]

Imports the rides of a Strava bulk export that no Garmin or Peloton activity covers
(start within ±600 s) as strava_export activities, then recomputes the daily load.

  <unzipped-archive-dir>  the unzipped export; reads activities.csv and the files it names
  --dry-run               parse and report only; writes nothing
  --help                  this text

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SYNC_OWNER_USER_ID, SYNC_DEFAULT_TIMEZONE (optional).
Refuses to run until sync_state garmin_activities and peloton both have backfill_complete = true.
Prints the report as JSON.`;

class UsageError extends Error {}

function parseArgs(argv: string[]): { help: boolean; dir: string | null; dryRun: boolean } {
  let dir: string | null = null;
  let dryRun = false;
  let help = false;
  for (const a of argv) {
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (dir === null) dir = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  return { help, dir, dryRun };
}

const present = (v: string | undefined) => (v !== undefined && v.trim() !== "" ? v.trim() : null);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.dir === null) throw new UsageError("missing <unzipped-archive-dir>");
  const dir = existsSync(args.dir) ? realpathSync(resolve(args.dir)) : resolve(args.dir);
  const csvPath = join(dir, "activities.csv");
  if (!existsSync(csvPath)) throw new Error(`${csvPath} not found: pass the unzipped archive directory`);

  const missingEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SYNC_OWNER_USER_ID"].filter((n) => present(process.env[n]) === null);
  if (missingEnv.length > 0) throw new Error(`Missing required env vars: ${missingEnv.join(", ")}`);
  const timeZone = present(process.env.SYNC_DEFAULT_TIMEZONE) ?? DEFAULT_SYNC_TIMEZONE;

  const client = createClient(present(process.env.SUPABASE_URL)!, present(process.env.SUPABASE_SERVICE_ROLE_KEY)!, {
    auth: { persistSession: false },
  });
  const store = createSupabaseSyncStore(client, present(process.env.SYNC_OWNER_USER_ID)!);

  const [garmin, peloton] = await Promise.all([store.getSyncState("garmin_activities"), store.getSyncState("peloton")]);
  const incomplete = [
    ...(garmin?.backfillComplete ? [] : ["garmin_activities"]),
    ...(peloton?.backfillComplete ? [] : ["peloton"]),
  ];
  if (incomplete.length > 0) {
    console.error(
      `refusing to import: sync_state backfill_complete is not true for ${incomplete.join(" and ")}. ` +
        "Finish the Garmin and Peloton backfills first (npm run sync -- --source all --full), or the gap rule would import rides they still cover.",
    );
    return 1;
  }

  const readFile = (relPath: string): Uint8Array | null => {
    try {
      // Only files inside the archive (symlinks resolved).
      const path = realpathSync(resolve(dir, relPath));
      const rel = relative(dir, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return statSync(path).isFile() ? new Uint8Array(readFileSync(path)) : null;
    } catch {
      return null;
    }
  };

  const report = await importStravaArchive(
    { csvText: readFileSync(csvPath, "utf8"), readFile },
    store,
    { dryRun: args.dryRun, ingestContext: await buildIngestContext(store), defaultTimeZone: timeZone, today: todayIn(timeZone, Date.now()) },
  );
  console.log(JSON.stringify({ dryRun: args.dryRun, ...report }, null, 2));
  if (report.rides > 0 && report.unparsedDate === report.rides) {
    console.error('no ride date parsed: activities.csv "Activity Date" is not in the form "Mon D, YYYY, h:mm:ss AM" (export locale?)');
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(
      e instanceof StravaCsvError ? `import stopped: ${e.message}` : `import failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  },
);
