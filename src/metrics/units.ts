/** Unit conversion and display formatting. Storage is metric; display is imperial by default (decision 11). */

export type Units = "imperial" | "metric";
export const DEFAULT_UNITS: Units = "imperial";

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;
const KG_PER_LB = 0.45359237;
const MPH_PER_MPS = 2.2369362920544;
const KMH_PER_MPS = 3.6;
const EMPTY = "—";

export const mToMi = (m: number): number => m / M_PER_MI;
export const mToFt = (m: number): number => m / M_PER_FT;
export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const mpsToMph = (mps: number): number => mps * MPH_PER_MPS;
export const cToF = (c: number): number => (c * 9) / 5 + 32;

function fmt(value: number, digits: number, unit: string): string {
  const rounded = Number(value.toFixed(digits)) || 0; // `|| 0` turns -0 into 0
  const text = rounded.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${text} ${unit}`;
}

function missing(v: number | null | undefined): v is null | undefined {
  return typeof v !== "number" || !Number.isFinite(v);
}

/** Metres → "64.7 mi" or "104.1 km". */
export function formatDistance(m: number | null, units: Units = DEFAULT_UNITS): string {
  if (missing(m)) return EMPTY;
  return units === "imperial" ? fmt(mToMi(m), 1, "mi") : fmt(m / 1000, 1, "km");
}

/** Metres → "1,048 ft" or "319 m". */
export function formatElevation(m: number | null, units: Units = DEFAULT_UNITS): string {
  if (missing(m)) return EMPTY;
  return units === "imperial" ? fmt(mToFt(m), 0, "ft") : fmt(m, 0, "m");
}

/** m/s → "18.6 mph" or "30.0 km/h". */
export function formatSpeed(mps: number | null, units: Units = DEFAULT_UNITS): string {
  if (missing(mps)) return EMPTY;
  return units === "imperial" ? fmt(mpsToMph(mps), 1, "mph") : fmt(mps * KMH_PER_MPS, 1, "km/h");
}

/** kg → "176.4 lb" or "80.0 kg". */
export function formatWeight(kg: number | null, units: Units = DEFAULT_UNITS): string {
  if (missing(kg)) return EMPTY;
  return units === "imperial" ? fmt(kgToLb(kg), 1, "lb") : fmt(kg, 1, "kg");
}
