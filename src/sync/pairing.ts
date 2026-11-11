/**
 * Garmin + Peloton recordings of one ride (plan section 6, payload facts section 12): the two
 * rows point at each other, the daily load counts the primary only, and the primary takes the
 * partner's heart rate when it has none (Garmin has no HR, Peloton does).
 */
import type { ExternalActivity } from "../types.js";
import type { SyncStore } from "./store.js";

export const PAIR_WINDOW_S = 600;

type PairFields = Pick<ExternalActivity, "id" | "source" | "startedAt">;

function otherSource(source: ExternalActivity["source"]): ExternalActivity["source"] | null {
  if (source === "garmin") return "peloton";
  if (source === "peloton") return "garmin";
  return null;
}

/**
 * The candidate of the other source (garmin/peloton) whose start is nearest `a`'s and within
 * PAIR_WINDOW_S, or null. Ties go to the earlier start. strava_export never pairs.
 */
export function findPair<T extends PairFields>(a: PairFields, candidates: readonly T[]): T | null {
  const want = otherSource(a.source);
  const at = Date.parse(a.startedAt);
  if (want === null || Number.isNaN(at)) return null;
  let best: T | null = null;
  let bestGap = Infinity;
  let bestStart = Infinity;
  for (const c of candidates) {
    if (c.source !== want || c.id === a.id) continue;
    const start = Date.parse(c.startedAt);
    if (Number.isNaN(start)) continue;
    const gap = Math.abs(start - at);
    if (gap > PAIR_WINDOW_S * 1000) continue;
    if (gap < bestGap || (gap === bestGap && start < bestStart)) {
      best = c;
      bestGap = gap;
      bestStart = start;
    }
  }
  return best;
}

/** The row the daily load keeps (dedupePairs' rule): power TSS first, then earlier start, then smaller id. */
export function primaryOf<T extends Pick<ExternalActivity, "id" | "startedAt" | "tssSource">>(a: T, b: T): T {
  const ap = a.tssSource === "power";
  const bp = b.tssSource === "power";
  if (ap !== bp) return ap ? a : b;
  const as = Date.parse(a.startedAt);
  const bs = Date.parse(b.startedAt);
  const am = Number.isNaN(as) ? Infinity : as;
  const bm = Number.isNaN(bs) ? Infinity : bs;
  if (am !== bm) return am < bm ? a : b;
  return a.id < b.id ? a : b;
}

function shiftIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/**
 * Pairs a just-stored activity with its nearest partner (if any): sets pairedActivityId on
 * both, clears it on any former partner of either, and copies HR to the primary when only the
 * partner has it. Returns the activity as stored afterwards.
 */
export async function pairActivity(store: SyncStore, activity: ExternalActivity): Promise<ExternalActivity> {
  if (Number.isNaN(Date.parse(activity.startedAt))) return activity;
  // A former partner of the partner started within the window of the partner, so twice the
  // window around this activity covers every row that can point at either of them.
  const nearby = await store.listActivitiesBetween(
    shiftIso(activity.startedAt, -2 * PAIR_WINDOW_S),
    shiftIso(activity.startedAt, 2 * PAIR_WINDOW_S),
  );
  const fresh = nearby.find((r) => r.id === activity.id) ?? activity;
  const partner = findPair(fresh, nearby);
  const pairIds = new Set([fresh.id, ...(partner ? [partner.id] : [])]);

  // Clear stale links: rows pointing at either side that are not the other side.
  for (const row of nearby) {
    if (pairIds.has(row.id) || !row.pairedActivityId || !pairIds.has(row.pairedActivityId)) continue;
    await store.updateActivityDerived(row.id, { pairedActivityId: null });
  }

  if (!partner) {
    if (fresh.pairedActivityId === null) return fresh;
    return store.updateActivityDerived(fresh.id, { pairedActivityId: null });
  }

  let self = fresh.pairedActivityId === partner.id ? fresh : await store.updateActivityDerived(fresh.id, { pairedActivityId: partner.id });
  let other =
    partner.pairedActivityId === fresh.id ? partner : await store.updateActivityDerived(partner.id, { pairedActivityId: fresh.id });

  const primary = primaryOf(self, other);
  const secondary = primary.id === self.id ? other : self;
  if (!primary.hasHr && secondary.hasHr) {
    const updated = await store.updateActivityDerived(primary.id, {
      avgHrBpm: secondary.avgHrBpm,
      maxHrBpm: secondary.maxHrBpm,
      hasHr: true,
    });
    if (updated.id === self.id) self = updated;
    else other = updated;
  }
  return self;
}
