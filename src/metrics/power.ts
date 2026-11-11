/**
 * Power-stream metrics: Normalized Power, IF, TSS, work and the mean-max power curve.
 * Inputs are 1 Hz arrays indexed by second; `null` is a missing sample.
 */

export type Stream = readonly (number | null)[];

/** Durations (seconds) of the standard power-bests table. */
export const STANDARD_DURATIONS_S: readonly number[] = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

const NP_WINDOW_S = 30;

function sample(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Normalized Power: 30-sample trailing rolling mean (first value at the 30th sample),
 * fourth power, mean, fourth root. Null samples count as 0 W. `null` under 30 samples.
 */
export function normalizedPower(power: Stream): number | null {
  if (power.length < NP_WINDOW_S) return null;
  let windowSum = 0;
  let sumFourth = 0;
  let count = 0;
  for (let i = 0; i < power.length; i++) {
    windowSum += sample(power[i]);
    if (i >= NP_WINDOW_S) windowSum -= sample(power[i - NP_WINDOW_S]);
    if (i >= NP_WINDOW_S - 1) {
      const rolling = windowSum / NP_WINDOW_S;
      sumFourth += rolling ** 4;
      count++;
    }
  }
  return (sumFourth / count) ** 0.25;
}

/** IF = NP / FTP; `null` when either is missing or FTP is not positive. */
export function intensityFactor(np: number | null, ftp: number | null): number | null {
  if (np === null || ftp === null || !(ftp > 0) || !Number.isFinite(np)) return null;
  return np / ftp;
}

/** TSS = seconds / 3600 × IF² × 100; `null` when IF cannot be computed. */
export function tssFromPower(np: number | null, ftp: number | null, seconds: number): number | null {
  const intensity = intensityFactor(np, ftp);
  if (intensity === null || !Number.isFinite(seconds)) return null;
  return (seconds / 3600) * intensity * intensity * 100;
}

/** Work in kJ: sum of non-null samples (1 s each) / 1000; `null` when no sample is present. */
export function workKj(power: Stream): number | null {
  let sum = 0;
  let any = false;
  for (const v of power) {
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum / 1000 : null;
}

/**
 * Mean-max power for each duration (seconds) via prefix sums; nulls count as 0 W.
 * Durations longer than the ride (or not a positive integer) are omitted.
 */
export function meanMaxPower(
  power: Stream,
  durations: readonly number[] = STANDARD_DURATIONS_S,
): Record<number, number> {
  const n = power.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + sample(power[i]);
  const result: Record<number, number> = {};
  for (const d of durations) {
    if (!Number.isInteger(d) || d < 1 || d > n) continue;
    let best = -Infinity;
    for (let i = 0; i + d <= n; i++) {
      const s = prefix[i + d] - prefix[i];
      if (s > best) best = s;
    }
    result[d] = best / d;
  }
  return result;
}
