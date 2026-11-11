/**
 * One Peloton sync run (AI-639): cycling workouts to external_activities, streams and FTP history,
 * with sync_state row `peloton` holding the cursor. Bookkeeping follows the Garmin run (AI-638).
 */
import { ftpAt } from "../../metrics/index.js";
import type { FtpHistoryEntry } from "../../types.js";
import { ingestActivity } from "../ingest.js";
import { persistActivity } from "../persist.js";
import type { SyncStore } from "../store.js";
import type { IngestContext, SyncRunResult } from "../types.js";
import type { PelotonClient } from "./client.js";
import { matchCsvRow, parseWorkoutHistoryCsv } from "./csv.js";
import { PelotonHttpError } from "./errors.js";
import { ftpFromWorkout, looksLikeFtpTest } from "./ftp.js";
import { graphToChannels, pelotonToProvider } from "./normalize.js";
import type {
  PelotonCsvRow,
  PelotonCursor,
  PelotonPerformanceGraph,
  PelotonWorkout,
  PelotonWorkoutDetail,
} from "./types.js";

export interface PelotonRunOptions {
  /** Both modes behave alike: backfill while sync_state says it is incomplete, then incremental. */
  mode: "full" | "incremental";
  /** Epoch ms; checked before each workout and each list page. */
  deadlineMs: number;
  now: () => number;
  /** The run's context, or a factory called once on the first ingest. FTP entries found are appended to it. */
  ingestContext: IngestContext | (() => Promise<IngestContext>);
}

const SOURCE = "peloton" as const;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The stored cursor, or the start of a backfill. A completed backfill always reads as incremental. */
export function readPelotonCursor(raw: unknown, backfillComplete: boolean): PelotonCursor {
  const c = (raw ?? {}) as { mode?: unknown; page?: unknown; retry?: unknown };
  const retry = isStringArray(c.retry) ? [...c.retry] : [];
  if (backfillComplete) return { mode: "incremental", retry };
  const page = c.mode === "backfill" && typeof c.page === "number" && Number.isInteger(c.page) && c.page >= 0 ? c.page : 0;
  return { mode: "backfill", page, retry };
}

/** A failed provider call the run survives (CSV fallback, retry later). Auth failures are fatal. */
function recoverable(e: unknown): boolean {
  if (e instanceof PelotonHttpError) return e.status !== 401 && e.status !== 403;
  // fetch network failures are TypeErrors; a truncated body is a SyntaxError.
  return e instanceof TypeError || e instanceof SyntaxError;
}

/** Only cycling workouts with a usable start instant are ingested; the rest count as skipped. */
const ingestible = (w: PelotonWorkout) => w.fitness_discipline === "cycling" && Number.isFinite(w.start_time);

const errorMessage = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function runPeloton(client: PelotonClient, store: SyncStore, opts: PelotonRunOptions): Promise<SyncRunResult> {
  const state = await store.getSyncState(SOURCE);
  let backfillComplete = state?.backfillComplete ?? false;
  const startCursor = readPelotonCursor(state?.cursor, backfillComplete);
  let page = startCursor.mode === "backfill" ? startCursor.page : 0;
  const retry = new Set(startCursor.retry);

  let fetched = 0;
  let upserted = 0;
  let skipped = 0;
  let earliest: string | null = null;

  let ctx: IngestContext | null = null;
  const context = async (): Promise<IngestContext> => {
    if (!ctx) ctx = typeof opts.ingestContext === "function" ? await opts.ingestContext() : opts.ingestContext;
    return ctx;
  };

  /** workout id → startedAt, from list items seen in this run and (lazily) the stored Peloton rows. */
  const starts = new Map<string, string>();
  let storedStartsLoaded = false;
  const knownStarts = async () => {
    if (!storedStartsLoaded) {
      storedStartsLoaded = true;
      for (const a of await store.listAllActivities()) {
        if (a.source === SOURCE && !starts.has(a.sourceId)) starts.set(a.sourceId, a.startedAt);
      }
    }
    return starts;
  };
  const remember = (w: PelotonWorkout) => {
    if (Number.isFinite(w.start_time)) starts.set(w.id, new Date(w.start_time * 1000).toISOString());
  };

  let userId = "";
  let csvRows: Promise<PelotonCsvRow[]> | null = null;
  /** The CSV, fetched at most once per run; an unavailable CSV reads as no rows. */
  const csv = () =>
    (csvRows ??= client.workoutHistoryCsv(userId).then(
      (text) => {
        try {
          return parseWorkoutHistoryCsv(text);
        } catch {
          return []; // a changed CSV format must not fail the fallback
        }
      },
      (e: unknown) => {
        if (recoverable(e)) return [];
        throw e;
      },
    ));

  const pastDeadline = () => opts.now() >= opts.deadlineMs;

  async function isFtpTest(w: PelotonWorkout): Promise<boolean | null> {
    const rideId = w.ride?.id;
    if (!looksLikeFtpTest(w) || typeof rideId !== "string" || rideId === "") return null;
    try {
      const d = await client.rideDetails(rideId);
      return typeof d.is_ftp_test === "boolean" ? d.is_ftp_test : null;
    } catch (e) {
      if (recoverable(e)) return null;
      throw e;
    }
  }

  async function recordFtp(detail: PelotonWorkoutDetail, startedAt: string, c: IngestContext): Promise<void> {
    const entry = ftpFromWorkout(detail, startedAt, await knownStarts());
    if (!entry) return;
    // The history entry in force at the ride (manualFtpW deliberately ignored: this is history only).
    if (ftpAt(startedAt, { manualFtpW: null, history: c.ftpHistory }) === entry.ftpW) return;
    const added = await store.addFtpHistoryEntries([entry]);
    // An empty result means the store already had (effectiveFrom, source); mirror it in memory.
    const local: FtpHistoryEntry[] = added.length > 0 ? added : [{ ...entry, id: `peloton:${entry.source}:${entry.effectiveFrom}` }];
    c.ftpHistory = [...c.ftpHistory, ...local];
  }

  /** Ingests one cycling workout. `degraded`: detail or graph failed, so CSV values fill in and channels are null. */
  async function ingest(
    w: PelotonWorkout,
    detail: PelotonWorkoutDetail | null,
    graph: PelotonPerformanceGraph | null,
    degraded: boolean,
  ): Promise<void> {
    const ftpTest = await isFtpTest(detail ?? w);
    const csvRow = degraded ? matchCsvRow(w, await csv()) : null;
    const provider = pelotonToProvider(w, detail, graph, csvRow, ftpTest);
    const c = await context();
    if (detail) await recordFtp(detail, provider.startedAt, c);
    const result = ingestActivity(provider, degraded || !graph ? null : graphToChannels(graph), c);
    await persistActivity(store, result);
    upserted++;
    if (earliest === null || Date.parse(provider.startedAt) < Date.parse(earliest)) earliest = provider.startedAt;
  }

  /** A listed cycling workout: detail, graph, ingest; on a provider failure, the CSV fallback and a retry entry. */
  async function processListed(w: PelotonWorkout): Promise<void> {
    let detail: PelotonWorkoutDetail | null = null;
    let graph: PelotonPerformanceGraph | null = null;
    let degraded = false;
    try {
      detail = await client.workout(w.id);
      graph = await client.performanceGraph(w.id);
    } catch (e) {
      if (!recoverable(e)) throw e;
      degraded = true;
    }
    await ingest(w, detail, graph, degraded);
    if (degraded) retry.add(w.id);
    else retry.delete(w.id);
  }

  /** A workout from cursor.retry: refetched by id. False when it is still unavailable. */
  async function processRetry(id: string): Promise<boolean> {
    let detail: PelotonWorkoutDetail;
    let graph: PelotonPerformanceGraph;
    try {
      detail = await client.workout(id);
      fetched++;
      remember(detail);
      if (!ingestible(detail)) return true;
      graph = await client.performanceGraph(id);
    } catch (e) {
      if (!recoverable(e)) throw e;
      // A deleted workout will never come back.
      return e instanceof PelotonHttpError && e.status === 404;
    }
    await ingest(detail, detail, graph, false);
    return true;
  }

  async function finish(done: boolean, error: string | null): Promise<SyncRunResult> {
    const cursor: PelotonCursor = backfillComplete
      ? { mode: "incremental", retry: [...retry] }
      : { mode: "backfill", page, retry: [...retry] };
    const at = new Date(opts.now()).toISOString();
    await store.saveSyncState({
      source: SOURCE,
      cursor,
      lastRunAt: at,
      itemsFetched: fetched,
      itemsUpserted: upserted,
      lastError: error,
      backfillComplete,
      ...(error === null ? { lastSuccessAt: at, authStatus: "ok" as const } : {}),
    });
    return { source: SOURCE, fetched, upserted, skipped, done, earliestAffected: earliest, error };
  }

  try {
    userId = (await client.me()).id;

    for (const id of startCursor.retry) {
      if (pastDeadline()) return await finish(false, null);
      if (await processRetry(id)) retry.delete(id);
    }

    if (!backfillComplete) {
      for (;;) {
        if (pastDeadline()) return await finish(false, null);
        const list = await client.workouts(userId, page);
        const items = list.data ?? [];
        fetched += items.length;
        items.forEach(remember);
        for (const w of items) {
          if (pastDeadline()) return await finish(false, null);
          if (!ingestible(w) || (await store.hasActivity(SOURCE, w.id))) {
            skipped++;
            continue;
          }
          await processListed(w);
        }
        if (items.length === 0 || page >= list.page_count - 1) {
          backfillComplete = true;
          page = 0;
          break;
        }
        page++;
      }
    }

    // Incremental: collect the workouts newer than the newest stored cycling workout, then ingest
    // them oldest first, so a deadline never leaves an unstored workout behind a stored one.
    const pending: PelotonWorkout[] = [];
    collect: for (let p = 0; ; p++) {
      if (pastDeadline()) return await finish(false, null);
      const list = await client.workouts(userId, p);
      const items = list.data ?? [];
      fetched += items.length;
      items.forEach(remember);
      for (const w of items) {
        if (!ingestible(w)) {
          skipped++;
          continue;
        }
        if (await store.hasActivity(SOURCE, w.id)) break collect;
        pending.push(w);
      }
      if (items.length === 0 || p >= list.page_count - 1) break;
    }
    for (const w of pending.reverse()) {
      if (pastDeadline()) return await finish(false, null);
      await processListed(w);
    }
    return await finish(true, null);
  } catch (e) {
    return finish(false, errorMessage(e));
  }
}
