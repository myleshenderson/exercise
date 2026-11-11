/** Garmin rides: resumable newest-first backfill, then a daily incremental sync (AI-638). */
import { channelsFromFitWithStart } from "../fitChannels.js";
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

/** A FIT whose first record is further than this from beginTimestamp has a corrupt header (AI-645). */
export const MAX_FIT_START_OFFSET_S = 3600;

/**
 * Seconds from the activity's start to the FIT's first record, floored; 0 without a FIT start.
 * `ok` is false when the gap exceeds MAX_FIT_START_OFFSET_S (the offset is then 0).
 */
export function fitStartOffsetS(startedAt: string, fitStartTime: string | null): { offsetS: number; ok: boolean } {
  if (fitStartTime === null) return { offsetS: 0, ok: true };
  const offsetS = Math.floor((Date.parse(fitStartTime) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(offsetS) || Math.abs(offsetS) > MAX_FIT_START_OFFSET_S) return { offsetS: 0, ok: false };
  return { offsetS, ok: true };
}

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
  const notes: string[] = [];

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
      notes,
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
    let fitStartTime: string | null = null;
    try {
      ({ channels, startTime: fitStartTime } = channelsFromFitWithStart(await client.activityFitZip(id), "zip"));
    } catch (e) {
      // Auth and deadline refusals end the run: the ride stays unstored and the cursor stays on
      // this page, so the next run fetches it in full.
      if (e instanceof GarminAuthError || e instanceof SyncDeadlineError) throw e;
      // Summary only: no streams, flat TSS.
      skipped++;
    }
    const provider = garminToProvider(item, detail.timeZoneUnitDTO?.timeZone ?? null);
    // Slot 0 of the channels is the FIT's first record, which can trail beginTimestamp (GPS lock,
    // auto-start). The streams keep startedAt and carry the gap as start_offset_s.
    const offset = fitStartOffsetS(provider.startedAt, fitStartTime);
    const result = ingestActivity(provider, channels, await opts.ingestContext(), offset.offsetS);
    await persistActivity(store, result);
    upserted++;
    if (!offset.ok) {
      // A corrupt FIT header: the streams are stored at offset 0 and the ride is flagged.
      skipped++;
      notes.push(
        `activity ${id}: FIT start ${fitStartTime} is more than ${MAX_FIT_START_OFFSET_S} s from ${provider.startedAt}; streams stored at offset 0`,
      );
    }
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
