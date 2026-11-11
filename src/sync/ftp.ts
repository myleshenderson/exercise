/** FTP for one ride: manual, else history, else eFTP from earlier rides (decision 10). */
import { eftp, ftpAt } from "../metrics/index.js";
import type { IngestContext } from "./types.js";

export interface ResolvedFtp {
  /** Whole watts, or null when no FTP is known. */
  ftpW: number | null;
  /** "manual", a history entry's source, "estimated", or null. */
  source: string | null;
}

function isManual(w: number | null | undefined): w is number {
  return typeof w === "number" && Number.isFinite(w) && w > 0;
}

/** The source of the history entry `ftpAt` picks: the latest with `effectiveFrom <= startedAt`. */
function historySource(startedAt: string, ctx: IngestContext): string | null {
  const at = Date.parse(startedAt);
  if (Number.isNaN(at)) return null;
  let bestFrom = -Infinity;
  let source: string | null = null;
  for (const entry of ctx.ftpHistory) {
    const from = Date.parse(entry.effectiveFrom);
    if (Number.isNaN(from) || from > at) continue;
    if (from >= bestFrom) {
      bestFrom = from;
      source = entry.source;
    }
  }
  return source;
}

export function resolveFtp(startedAt: string, ctx: IngestContext): ResolvedFtp {
  const manualFtpW = ctx.settings.manualFtpW;
  const fromSettings = ftpAt(startedAt, { manualFtpW, history: ctx.ftpHistory });
  if (fromSettings !== null) {
    return {
      ftpW: Math.round(fromSettings),
      source: isManual(manualFtpW) ? "manual" : historySource(startedAt, ctx),
    };
  }
  const estimated = eftp(ctx.priorRides, startedAt);
  if (estimated === null) return { ftpW: null, source: null };
  return { ftpW: Math.round(estimated), source: "estimated" };
}
