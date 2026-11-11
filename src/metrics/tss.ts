/** Per-activity TSS rules (decisions 7 and 16 of AI-627). */
import { normalizedPower, tssFromPower, type Stream } from "./power.js";

export type TssSource = "power" | "estimated_flat" | "strength_fixed";

export interface TssResult {
  tss: number;
  source: TssSource;
}

export const DEFAULT_NO_POWER_TSS_PER_HOUR = 55;
export const DEFAULT_STRENGTH_SESSION_TSS = 50;

export interface ActivityTssInput {
  power?: Stream;
  hasPower: boolean;
  movingSeconds: number;
  elapsedSeconds: number;
  ftpW: number | null;
}

export interface ActivityTssSettings {
  noPowerTssPerHour: number;
}

/**
 * TSS from power when the ride has power and an FTP is known; otherwise a flat
 * rate per moving hour (`estimated_flat`). Heart rate is deliberately not an input.
 * A ride flagged `hasPower` whose stream is too short for NP also falls back to the flat rate.
 */
export function tssForActivity(
  a: ActivityTssInput,
  s: ActivityTssSettings = { noPowerTssPerHour: DEFAULT_NO_POWER_TSS_PER_HOUR },
): TssResult {
  if (a.hasPower && a.ftpW !== null && a.power) {
    const tss = tssFromPower(normalizedPower(a.power), a.ftpW, a.elapsedSeconds);
    if (tss !== null) return { tss, source: "power" };
  }
  const moving = Number.isFinite(a.movingSeconds) && a.movingSeconds > 0 ? a.movingSeconds : 0;
  return { tss: (moving / 3600) * s.noPowerTssPerHour, source: "estimated_flat" };
}

/** Fixed TSS per strength session (decision 7). */
export function strengthSessionTss(
  s: { strengthSessionTss: number } = { strengthSessionTss: DEFAULT_STRENGTH_SESSION_TSS },
): TssResult {
  return { tss: s.strengthSessionTss, source: "strength_fixed" };
}
