/** Altitude smoothing, elevation gain (2 m hysteresis) and biggest continuous climb. */
import type { Stream } from "./power.js";

const SMOOTH_HALF_WINDOW = 2;
const GAIN_HYSTERESIS_M = 2;
const CLIMB_DIP_M = 10;

function present(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Centred 5-sample mean over the non-null neighbours; `null` where none of the five is present. */
export function smoothAltitude(alt: Stream): (number | null)[] {
  return alt.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = i - SMOOTH_HALF_WINDOW; k <= i + SMOOTH_HALF_WINDOW; k++) {
      const v = alt[k];
      if (present(v)) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  });
}

/** Total ascent with 2 m hysteresis; null samples skipped; `null` when no sample is present. */
export function elevationGainM(smoothed: Stream): number | null {
  let ref: number | null = null;
  let gain = 0;
  for (const a of smoothed) {
    if (!present(a)) continue;
    if (ref === null) {
      ref = a;
    } else if (a - ref >= GAIN_HYSTERESIS_M) {
      gain += a - ref;
      ref = a;
    } else if (ref - a >= GAIN_HYSTERESIS_M) {
      ref = a;
    }
  }
  return ref === null ? null : gain;
}

/**
 * Largest continuous ascent: a dip of more than 10 m below the peak, or a drop below
 * the climb's start, closes the climb. No minimum grade. `null` when no sample is present.
 */
export function biggestClimbM(smoothed: Stream): number | null {
  let start: number | null = null;
  let peak = 0;
  let best = 0;
  for (const a of smoothed) {
    if (!present(a)) continue;
    if (start === null) {
      start = peak = a;
    } else if (a > peak) {
      peak = a;
    } else if (peak - a > CLIMB_DIP_M || a < start) {
      best = Math.max(best, peak - start);
      start = peak = a;
    }
  }
  if (start === null) return null;
  return Math.max(best, peak - start);
}
