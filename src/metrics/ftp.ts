/** FTP resolution (decision 10): manual FTP wins, else history; eFTP from 90-day 20-minute bests. */
import { DAY_MS } from "./dates.js";

export interface FtpHistoryEntry {
  /** `YYYY-MM-DD` or ISO instant. */
  effectiveFrom: string;
  ftpW: number;
}

export interface FtpSettings {
  manualFtpW: number | null | undefined;
  history: readonly FtpHistoryEntry[];
}

export const EFTP_WINDOW_DAYS = 90;
export const EFTP_FACTOR = 0.95;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * FTP in force on `date`: `manualFtpW` when set (a positive number), else the latest history
 * entry with `effectiveFrom <= date`, else `null`. Pass the activity's local `YYYY-MM-DD` date
 * when `effectiveFrom` values are dates, so the change takes effect on the rider's local day.
 */
export function ftpAt(date: string | Date, { manualFtpW, history }: FtpSettings): number | null {
  if (typeof manualFtpW === "number" && Number.isFinite(manualFtpW) && manualFtpW > 0) return manualFtpW;
  const at = toMs(date);
  if (Number.isNaN(at)) return null;
  let bestFrom = -Infinity;
  let ftp: number | null = null;
  for (const entry of history) {
    const from = toMs(entry.effectiveFrom);
    if (Number.isNaN(from) || from > at) continue;
    if (from >= bestFrom) {
      bestFrom = from;
      ftp = entry.ftpW;
    }
  }
  return ftp;
}

export interface EftpRide {
  startedAt: string;
  mmp20minW: number | null;
}

/**
 * 0.95 × the best 20-minute power among rides started in `(asOf − 90 days, asOf]`; `null` when none.
 * A date-only `asOf` (`YYYY-MM-DD`) means the end of that UTC day, so rides on that day count.
 */
export function eftp(rides: readonly EftpRide[], asOf: string | Date): number | null {
  const isDay = typeof asOf === "string" && DATE_ONLY.test(asOf);
  const end = toMs(asOf) + (isDay ? DAY_MS - 1 : 0);
  if (Number.isNaN(end)) return null;
  const start = end - EFTP_WINDOW_DAYS * DAY_MS;
  let best: number | null = null;
  for (const ride of rides) {
    const w = ride.mmp20minW;
    if (typeof w !== "number" || !Number.isFinite(w)) continue;
    const t = Date.parse(ride.startedAt);
    if (Number.isNaN(t) || t <= start || t > end) continue;
    if (best === null || w > best) best = w;
  }
  return best === null ? null : EFTP_FACTOR * best;
}
