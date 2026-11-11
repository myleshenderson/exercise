/** Garmin weigh-ins: a backfill by calendar year, then a daily incremental sync (AI-638). */
import type { SyncStore } from "../store.js";
import type { SyncRunResult } from "../types.js";
import type { GarminClient } from "./client.js";
import { garminWeighIns } from "./normalize.js";
import type { GarminRunOptions } from "./runActivities.js";
import { DAY_MS, LOOKBACK_DAYS, finishRun, successAdvances, utcDate } from "./runShared.js";
import type { GarminWeightCursor } from "./types.js";

const SOURCE = "garmin_weight" as const;
/** The backfill stops after this many consecutive years without a weigh-in. */
export const EMPTY_YEARS_TO_STOP = 3;
/** The last year the backfill reads. */
export const OLDEST_YEAR = 2000;

function readCursor(raw: unknown): GarminWeightCursor | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { mode?: unknown; year?: unknown; emptyYears?: unknown };
  if (c.mode === "incremental") return { mode: "incremental" };
  if (c.mode === "backfill" && Number.isInteger(c.year) && Number.isInteger(c.emptyYears)) {
    return { mode: "backfill", year: c.year as number, emptyYears: c.emptyYears as number };
  }
  return null;
}

/**
 * One run. Backfill (while backfill_complete is false, in either mode) reads one calendar year
 * per request from the current year down, until three empty years in a row or year 2000.
 * Incremental reads last_success_at − 3 days to today. `ingestContext` is not used.
 * earliestAffected stays null: weigh-ins do not feed the daily load.
 */
export async function runGarminWeight(
  client: GarminClient,
  store: SyncStore,
  opts: GarminRunOptions,
): Promise<SyncRunResult> {
  const startedMs = opts.now();
  const state = await store.getSyncState(SOURCE);
  let backfillComplete = state?.backfillComplete ?? false;
  const backfill = !backfillComplete;
  const saved = readCursor(state?.cursor);
  let year = backfill && saved?.mode === "backfill" ? saved.year : new Date(opts.now()).getUTCFullYear();
  let emptyYears = backfill && saved?.mode === "backfill" ? saved.emptyYears : 0;

  let fetched = 0;
  let upserted = 0;
  let tokenOk = false;
  let done = false;
  let error: unknown = null;

  try {
    await client.token();
    tokenOk = true;
    if (backfill) {
      for (;;) {
        if (emptyYears >= EMPTY_YEARS_TO_STOP || year < OLDEST_YEAR) {
          backfillComplete = true;
          done = true;
          break;
        }
        if (opts.now() >= opts.deadlineMs) break;
        const rows = garminWeighIns(await client.weightRange(`${year}-01-01`, `${year}-12-31`));
        fetched += rows.length;
        if (rows.length > 0) {
          await store.upsertBodyWeights(rows);
          upserted += rows.length;
          emptyYears = 0;
        } else {
          emptyYears++;
        }
        year--;
      }
    } else {
      const nowMs = opts.now();
      const base = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : nowMs;
      const rows = garminWeighIns(await client.weightRange(utcDate(base - LOOKBACK_DAYS * DAY_MS), utcDate(nowMs)));
      fetched += rows.length;
      if (rows.length > 0) await store.upsertBodyWeights(rows);
      upserted += rows.length;
      done = true;
    }
  } catch (e) {
    error = e;
  }

  const cursor: GarminWeightCursor = backfillComplete ? { mode: "incremental" } : { mode: "backfill", year, emptyYears };
  return finishRun(store, opts.now, {
    source: SOURCE,
    cursor,
    backfillComplete,
    fetched,
    upserted,
    skipped: 0,
    done,
    earliestAffected: null,
    error,
    tokenOk,
    startedMs,
    advanceSuccess: successAdvances(backfill, done, state?.lastSuccessAt),
  });
}
