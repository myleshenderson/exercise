/**
 * The one-off Strava archive gap import (AI-640, decision 9 of AI-627): the archive's rides that
 * no Garmin or Peloton row covers become `strava_export` rows. Pure: the caller injects the CSV
 * text, a file reader and the store.
 */
import type { EftpRide } from "../../metrics/index.js";
import { ingestActivity } from "../ingest.js";
import { addDays, recomputeDailyLoad } from "../load.js";
import { persistActivity } from "../persist.js";
import { mmp20 } from "../recompute.js";
import { DEFAULT_SYNC_TIMEZONE, todayIn } from "../runner.js";
import type { SyncStore } from "../store.js";
import type { IngestContext, ProviderActivity } from "../types.js";
import { parseActivitiesCsvWithHeader, requiredColumnsMissing, rideEnvironment } from "./csv.js";
import { coveredBy } from "./gap.js";
import { stravaToProvider } from "./normalize.js";
import { stravaStream } from "./streams.js";

export interface StravaImportReport {
  /** CSV data rows. */
  rows: number;
  /** Rows of an imported ride type (including those with an unparsed date). */
  rides: number;
  /** Rides within PAIR_WINDOW_S of a garmin or peloton row: not imported. */
  covered: number;
  /** Rides whose id strava_export already holds: not imported. */
  alreadyImported: number;
  /** Rides written (with dryRun: the rides that would be written). */
  imported: number;
  /** Imported rides without channels (file missing, unsupported or unparseable): summary only. */
  noStream: number;
  /** Rides skipped because `Activity Date` (or `Activity ID`) did not parse. */
  unparsedDate: number;
  /** The first 3 parsed rides, for the owner to check against Strava. */
  sample: ProviderActivity[];
  /** Daily-load rows rewritten at the end (0 with dryRun or when no ride is imported or already imported). */
  dailyLoadDays: number;
  /** Remarks for the operator, e.g. a FIT whose start is far from the CSV's. */
  notes: string[];
}

export class StravaCsvError extends Error {
  constructor(readonly missingColumns: string[]) {
    super(`activities.csv is missing required columns: ${missingColumns.join(", ")}`);
    this.name = "StravaCsvError";
  }
}

export interface StravaImportOptions {
  dryRun: boolean;
  ingestContext: IngestContext;
  /** For the closing daily-load recompute; defaults to DEFAULT_SYNC_TIMEZONE. */
  defaultTimeZone?: string;
  /** `YYYY-MM-DD` the recompute ends at; defaults to today in `defaultTimeZone`. */
  today?: string;
}

export async function importStravaArchive(
  input: { csvText: string; readFile: (relPath: string) => Uint8Array | null },
  store: SyncStore,
  opts: StravaImportOptions,
): Promise<StravaImportReport> {
  const { header, rows } = parseActivitiesCsvWithHeader(input.csvText);
  const missing = requiredColumnsMissing(header);
  if (missing.length > 0) throw new StravaCsvError(missing);

  const report: StravaImportReport = {
    rows: rows.length,
    rides: 0,
    covered: 0,
    alreadyImported: 0,
    imported: 0,
    noStream: 0,
    unparsedDate: 0,
    sample: [],
    dailyLoadDays: 0,
    notes: [],
  };

  const existing = await store.listAllActivities();
  const stravaIds = new Set(existing.filter((a) => a.source === "strava_export").map((a) => a.sourceId));

  const rides: { provider: ProviderActivity; filename: string | null }[] = [];
  for (const row of rows) {
    const environment = rideEnvironment(row.type);
    if (environment === null) continue;
    report.rides++;
    if (row.startedAt === null || row.id === null) {
      report.unparsedDate++;
      continue;
    }
    const provider = stravaToProvider(row, environment);
    if (report.sample.length < 3) report.sample.push(provider);
    rides.push({ provider, filename: row.filename });
  }
  // Oldest first, so each ride's eFTP sees the rides imported before it.
  rides.sort((a, b) => Date.parse(a.provider.startedAt) - Date.parse(b.provider.startedAt));

  const ctx: IngestContext = { ...opts.ingestContext, priorRides: [...opts.ingestContext.priorRides] };
  const priorRides = ctx.priorRides as EftpRide[];
  /** The earliest ride imported now or by an earlier run: a rerun after a failed run still recomputes its days. */
  let earliest: string | null = null;
  const earlier = (a: string | null, b: string) => (a === null || Date.parse(b) < Date.parse(a) ? b : a);

  for (const { provider, filename } of rides) {
    if (coveredBy(provider.startedAt, existing)) {
      report.covered++;
      continue;
    }
    if (stravaIds.has(provider.sourceId)) {
      report.alreadyImported++;
      earliest = earlier(earliest, provider.startedAt);
      continue;
    }
    stravaIds.add(provider.sourceId);

    const bytes = filename ? input.readFile(filename) : null;
    const stream = filename && bytes ? stravaStream(filename, bytes, provider.startedAt) : null;
    if (!stream) report.noStream++;
    else if (!stream.offsetOk) {
      report.notes.push(`activity ${provider.sourceId}: FIT start is more than an hour from ${provider.startedAt}; streams stored at offset 0`);
    }
    const result = ingestActivity(provider, stream?.channels ?? null, ctx, stream?.offsetS ?? 0);
    priorRides.push({ startedAt: provider.startedAt, mmp20minW: mmp20(result.row.powerCurve) });
    report.imported++;
    if (opts.dryRun) continue;
    await persistActivity(store, result);
    earliest = earlier(earliest, provider.startedAt);
  }

  if (!opts.dryRun && earliest !== null) {
    const timeZone = opts.defaultTimeZone ?? DEFAULT_SYNC_TIMEZONE;
    const today = opts.today ?? todayIn(timeZone, Date.now());
    // The UTC date less a day covers the ride's local date in any time zone.
    const day = earliest.slice(0, 10);
    const from = addDays(day, -1) ?? day;
    if (from <= today) report.dailyLoadDays = await recomputeDailyLoad(store, from, today, { defaultTimeZone: timeZone });
  }
  return report;
}
