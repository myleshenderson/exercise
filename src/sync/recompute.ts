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

function mmp20(powerCurve: unknown): number | null {
  if (!powerCurve || typeof powerCurve !== "object") return null;
  const w = (powerCurve as Record<string, unknown>)["1200"];
  return typeof w === "number" && Number.isFinite(w) ? w : null;
}

function changed(stored: TssFields, next: TssFields): boolean {
  return (Object.keys(next) as (keyof TssFields)[]).some((k) => stored[k] !== next[k]);
}

/** Returns the number of activities visited and of daily rows written. */
export async function recomputeAll(
  store: SyncStore,
  opts: { defaultTimeZone: string; today: string },
): Promise<{ activities: number; days: number }> {
  const [settings, ftpHistory, activities, sessions] = await Promise.all([
    store.getAthleteSettings(),
    store.listFtpHistory(),
    store.listAllActivities(),
    store.listStrengthSessions(),
  ]);

  const priorRides: EftpRide[] = [];
  let earliest: string | null = null;
  for (const a of activities) {
    const power = a.hasPower ? ((await store.getStream(a.id, "power"))?.values ?? null) : null;
    const ftp = resolveFtp(a.startedAt, { settings, ftpHistory, priorRides });
    const next = tssFields(power, { movingS: a.movingS, elapsedS: a.elapsedS }, ftp, settings);
    if (changed(a, next)) await store.updateActivityDerived(a.id, next);
    priorRides.push({ startedAt: a.startedAt, mmp20minW: mmp20(a.powerCurve) });
    const date = localDate(a.startedAt, a.timezone ?? opts.defaultTimeZone);
    if (date !== null && (earliest === null || date < earliest)) earliest = date;
  }
  // Strength sessions count too: a strength-TSS change moves days before the first ride.
  for (const s of sessions) if (earliest === null || s.performedOn < earliest) earliest = s.performedOn;

  if (earliest === null || earliest > opts.today) return { activities: activities.length, days: 0 };
  const days = await recomputeDailyLoad(store, earliest, opts.today, {
    defaultTimeZone: opts.defaultTimeZone,
    // Nothing precedes the earliest item, so a stored row before it is stale: start from zero.
    fromZero: true,
  });
  return { activities: activities.length, days };
}
