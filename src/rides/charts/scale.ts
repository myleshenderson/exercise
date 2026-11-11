/** Scales and tick helpers shared by the inline SVG charts. */

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const s = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  s.domain = domain;
  s.range = range;
  return s;
}

/** Log10 scale; non-positive domain ends are clamped to 1e-9. */
export function logScale(domain: [number, number], range: [number, number]): Scale {
  const l0 = Math.log10(Math.max(domain[0], 1e-9));
  const l1 = Math.log10(Math.max(domain[1], 1e-9));
  const inner = linearScale([l0, l1], range);
  const s = ((v: number) => inner(Math.log10(Math.max(v, 1e-9)))) as Scale;
  s.domain = domain;
  s.range = range;
  return s;
}

/** About `count` round tick values covering [min, max] (1, 2, 2.5 or 5 × 10^k steps). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = Math.abs(max - min) / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.ceil(Math.min(min, max) / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = lo; v <= Math.max(min, max) + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** [min, max] of the finite values, padded to round ticks; `fallback` when there are none. */
export function niceDomain(values: readonly (number | null | undefined)[], opts: { zero?: boolean; fallback?: [number, number] } = {}): [number, number] {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return opts.fallback ?? [0, 1];
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (opts.zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const ticks = niceTicks(lo, hi);
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
  return [Math.min(lo, Math.floor(lo / step) * step), Math.max(hi, Math.ceil(hi / step) * step)];
}

/** Short duration label for a log time axis: 5s, 1m, 20m, 1h, 1.5h. */
export function durationTick(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = s / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

/** Converts a pointer's clientX to the SVG's viewBox x. */
export function viewBoxX(svg: SVGSVGElement, clientX: number, viewWidth: number): number {
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return 0;
  return ((clientX - rect.left) / rect.width) * viewWidth;
}

/** Index of the value in `xs` nearest `x` (xs ascending); -1 when empty. */
export function nearestIndex(xs: readonly number[], x: number): number {
  let best = -1;
  let bestGap = Infinity;
  xs.forEach((v, i) => {
    const gap = Math.abs(v - x);
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  });
  return best;
}
