/**
 * Chart colours from the dataviz skill's reference palette (light mode; the app has no dark
 * theme). Categorical slots are assigned in this fixed order, never cycled.
 */
export const SERIES = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#6250d6", // 7 violet
  "#e34948", // 8 red
] as const;

/** Sequential blue ramp (steps 250 → 650), for ordered marks such as zones 1 → 7. */
export const SEQUENTIAL_BLUE = ["#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281"] as const;

export const INK = {
  surface: "#fcfcfb",
  primary: "#0b0b0b",
  secondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  baseline: "#c3c2b7",
  /** "No data" segments (e.g. rides without power). */
  neutral: "#c3c2b7",
} as const;

/** Status colours (reserved for state, always shown with a label). */
export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" } as const;

/** The categorical colour of slot `i` (0-based); throws past slot 8 rather than inventing a hue. */
export function seriesColor(i: number): string {
  const c = SERIES[i];
  if (!c) throw new RangeError(`Only ${SERIES.length} categorical slots exist; fold extra series into "Other"`);
  return c;
}

/**
 * Zone colours for an n-zone table (n ≤ 9): evenly spaced steps of the sequential ramp, light to
 * dark, so higher zones read as more intense.
 */
export function zoneColors(n: number): string[] {
  if (n <= 1) return [SEQUENTIAL_BLUE[4]];
  const last = SEQUENTIAL_BLUE.length - 1;
  return Array.from({ length: n }, (_, i) => SEQUENTIAL_BLUE[Math.round((i * last) / (n - 1))]);
}
