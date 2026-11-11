/**
 * Full recompute after FTP, the flat no-power rate or strength TSS changes: every activity's
 * NP/IF/TSS/FTP columns (oldest first, so eFTP sees only earlier rides), then the daily load.
 * Writes go through updateActivityDerived because an upsert would null provider_payload,
 * which reads never return.
 */
import { localDate, type EftpRide } from "../metrics/index.js";
import { resolveFtp } from "./ftp.js";
import { tssFields, type TssFields } from "./ingest.js";
import { recomputeDailyLoad } from "./load.js";
import type { SyncStore } from "./store.js";

/** A stored ride's best 20-minute power (`powerCurve["1200"]`), for eFTP. */
export function mmp20(powerCurve: unknown): number | null {
  if (!powerCurve || typeof powerCurve !== "object") return null;
  const w = (powerCurve as Record<string, unknown>)["1200"];
  return typeof w === "number" && Number.isFinite(w) ? w : null;
}

function changed(stored: TssFields, next: TssFields): boolean {
  return (Object.keys(next) as (keyof TssFields)[]).some((k) => stored[k] !== next[k]);
}

export interface RecomputeAllOptions {
  defaultTimeZone: string;
  today: string;
  /** Epoch ms; checked before each activity. Absent: run to the end (the CLI). */
  deadlineMs?: number;
  /** Index of the first activity to process, in the order below; earlier ones only seed eFTP. */
  offset?: number;
  now?: () => number;
}

export interface RecomputeAllResult {
  /** Activities processed in this pass. */
  activities: number;
  /** Daily rows written; 0 when the pass stopped at its deadline. */
  days: number;
  /** True when every activity is done and the daily load was rebuilt. */
  done: boolean;
  /** Where the next pass starts (`offset`) when `done` is false, else null. */
  nextOffset: number | null;
}

/** Oldest `startedAt` first, then id, so an offset means the same activity on every pass. */
function byStartThenId(a: { startedAt: string; id: string }, b: { startedAt: string; id: string }): number {
  const t = Date.parse(a.startedAt) - Date.parse(b.startedAt);
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Recomputes activities from `offset` on. With `deadlineMs`, it stops before the first activity
 * it reaches at or after the deadline and returns `done: false` with the offset to resume at;
 * the daily load is rebuilt only by the pass that reaches the end.
 */
export async function recomputeAll(store: SyncStore, opts: RecomputeAllOptions): Promise<RecomputeAllResult> {
  const now = opts.now ?? Date.now;
  const offset = opts.offset ?? 0;
  const [settings, ftpHistory, listed, sessions] = await Promise.all([
    store.getAthleteSettings(),
    store.listFtpHistory(),
    store.listAllActivities(),
    store.listStrengthSessions(),
  ]);
  const activities = [...listed].sort(byStartThenId);

  const priorRides: EftpRide[] = [];
  let earliest: string | null = null;
  for (const [i, a] of activities.entries()) {
    if (i >= offset) {
      if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
        return { activities: i - offset, days: 0, done: false, nextOffset: i };
      }
      const power = a.hasPower ? ((await store.getStream(a.id, "power"))?.values ?? null) : null;
      const ftp = resolveFtp(a.startedAt, { settings, ftpHistory, priorRides });
      const next = tssFields(power, { movingS: a.movingS, elapsedS: a.elapsedS }, ftp, settings);
      if (changed(a, next)) await store.updateActivityDerived(a.id, next);
    }
    // Earlier passes recomputed these; their power curve still seeds eFTP and their date the load.
    priorRides.push({ startedAt: a.startedAt, mmp20minW: mmp20(a.powerCurve) });
    const date = localDate(a.startedAt, a.timezone ?? opts.defaultTimeZone);
    if (date !== null && (earliest === null || date < earliest)) earliest = date;
  }
  const processed = Math.max(0, activities.length - offset);
  // Strength sessions count too: a strength-TSS change moves days before the first ride.
  for (const s of sessions) if (earliest === null || s.performedOn < earliest) earliest = s.performedOn;

  if (earliest === null || earliest > opts.today) return { activities: processed, days: 0, done: true, nextOffset: null };
  const days = await recomputeDailyLoad(store, earliest, opts.today, {
    defaultTimeZone: opts.defaultTimeZone,
    // Nothing precedes the earliest item, so a stored row before it is stale: start from zero.
    fromZero: true,
  });
  return { activities: processed, days, done: true, nextOffset: null };
}
