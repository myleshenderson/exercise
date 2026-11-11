/** FTP in use for the Power curve, Weight and Settings screens (AI-652, decision 10). */
import { eftp } from "../../metrics/ftp";
import type { AthleteSettings, ExternalActivity } from "../../types";

/**
 * The 20-minute best of a stored power curve (`powerCurve["1200"]`), or null. Same rule as
 * `src/sync/recompute.ts`'s `mmp20`, kept here so the app bundle does not pull in the sync code.
 */
export function mmp20(r: Pick<ExternalActivity, "powerCurve">): number | null {
  const curve = r.powerCurve;
  if (typeof curve !== "object" || curve === null || Array.isArray(curve)) return null;
  const w = (curve as Record<string, unknown>)["1200"];
  return typeof w === "number" && Number.isFinite(w) ? w : null;
}

/**
 * eFTP at instant `asOf` (the screens pass now) from the rides' stored 20-minute bests. An instant,
 * not a local date: `eftp` reads a date-only `asOf` as the end of that UTC day, which would cut or
 * add rides by the host's UTC offset; the sync runner also passes an instant.
 */
export function eftpOf(rides: readonly Pick<ExternalActivity, "startedAt" | "powerCurve">[], asOf: Date): number | null {
  return eftp(
    rides.map((r) => ({ startedAt: r.startedAt, mmp20minW: mmp20(r) })),
    asOf,
  );
}

/** The FTP in use: the manual FTP when set, else eFTP. */
export function ftpInUse(settings: Pick<AthleteSettings, "manualFtpW">, eftpW: number | null): { ftpW: number | null; manual: boolean } {
  const m = settings.manualFtpW;
  if (typeof m === "number" && Number.isFinite(m) && m > 0) return { ftpW: m, manual: true };
  return { ftpW: eftpW, manual: false };
}
