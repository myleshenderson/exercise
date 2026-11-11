/** Garmin rides: resumable newest-first backfill, then a daily incremental sync (AI-638). */
import { channelsFromFit } from "../fitChannels.js";
import { SyncDeadlineError } from "../http.js";
import { ingestActivity } from "../ingest.js";
import { persistActivity } from "../persist.js";
import type { SyncStore } from "../store.js";
import type { Channels, IngestContext, SyncRunResult } from "../types.js";
import { ACTIVITY_PAGE_SIZE, GarminAuthError, type GarminClient } from "./client.js";
import { garminToProvider } from "./normalize.js";
import { DAY_MS, LOOKBACK_DAYS, finishRun, successAdvances, utcDate } from "./runShared.js";
import type { GarminActivitiesCursor, GarminListItem } from "./types.js";

export interface GarminRunOptions {
  mode: "full" | "incremental";
  /** Epoch ms; no new item is started at or after it. */
  deadlineMs: number;
  now: () => number;
  ingestContext: () => Promise<IngestContext>;
}

const SOURCE = "garmin_activities" as const;

function readCursor(raw: unknown): GarminActivitiesCursor | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { mode?: unknown; start?: unknown };
  if (c.mode === "incremental") return { mode: "incremental" };
  if (c.mode === "backfill" && typeof c.start === "number" && Number.isInteger(c.start) && c.start >= 0) {
    return { mode: "backfill", start: c.start };
  }
  return null;
}

/**
 * One run. Backfill (while backfill_complete is false, in either mode) pages the whole history
 * newest first from the saved offset; incremental pages last_success_at − 3 days to today.
 * Stored rides are skipped. The deadline is checked before each item; the cursor then points
 * at the current page, so the next run re-reads it and skips what this one stored.
 */
export async function runGarminActivities(
  client: GarminClient,
  store: SyncStore,
  opts: GarminRunOptions,
): Promise<SyncRunResult> {
  const startedMs = opts.now();
  const state = await store.getSyncState(SOURCE);
  let backfillComplete = state?.backfillComplete ?? false;
  const saved = readCursor(state?.cursor);
  const backfill = !backfillComplete;
  let start = backfill && saved?.mode === "backfill" ? saved.start : 0;
  const cursorAt = (s: number): GarminActivitiesCursor =>
    backfillComplete ? { mode: "incremental" } : { mode: "backfill", start: s };

  let fetched = 0;
  let upserted = 0;
  let skipped = 0;
  let earliest: string | null = null;
  let tokenOk = false;

  const finish = (done: boolean, error: unknown) =>
    finishRun(store, opts.now, {
      source: SOURCE,
      cursor: cursorAt(start),
      backfillComplete,
      fetched,
      upserted,
      skipped,
      done,
      earliestAffected: earliest,
      error,
      tokenOk,
      startedMs,
      advanceSuccess: successAdvances(backfill, done, state?.lastSuccessAt),
    });

  async function processItem(item: GarminListItem): Promise<void> {
    if (typeof item.activityId !== "number") {
      skipped++;
      return;
    }
    const id = item.activityId;
    if (await store.hasActivity("garmin", String(id))) return;
    const detail = await client.activityDetail(id);
    let channels: Channels | null = null;
    try {
      channels = channelsFromFit(await client.activityFitZip(id), "zip");
    } catch (e) {
      // Auth and deadline refusals end the run: the ride stays unstored and the cursor stays on
      // this page, so the next run fetches it in full.
      if (e instanceof GarminAuthError || e instanceof SyncDeadlineError) throw e;
      // Summary only: no streams, flat TSS.
      skipped++;
    }
    const provider = garminToProvider(item, detail.timeZoneUnitDTO?.timeZone ?? null);
    const result = ingestActivity(provider, channels, await opts.ingestContext());
    await persistActivity(store, result);
    upserted++;
    if (earliest === null || Date.parse(provider.startedAt) < Date.parse(earliest)) earliest = provider.startedAt;
  }

  let done = false;
  let error: unknown = null;
  try {
    await client.token();
    tokenOk = true;

    let window: { startDate: string; endDate: string } | undefined;
    if (!backfill) {
      const nowMs = opts.now();
      const base = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : nowMs;
      window = { startDate: utcDate(base - LOOKBACK_DAYS * DAY_MS), endDate: utcDate(nowMs) };
    }

    pages: for (;;) {
      if (opts.now() >= opts.deadlineMs) break;
      const page = await client.searchActivities({ start, limit: ACTIVITY_PAGE_SIZE, ...window });
      fetched += page.length;
      if (page.length === 0) {
        if (backfill) backfillComplete = true;
        start = 0;
        done = true;
        break;
      }
      for (const item of page) {
        if (opts.now() >= opts.deadlineMs) break pages;
        await processItem(item);
      }
      start += page.length;
    }
  } catch (e) {
    error = e;
  }
  return finish(done, error);
}
