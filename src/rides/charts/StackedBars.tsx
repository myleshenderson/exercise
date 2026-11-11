import { useId } from "react";
import { Axis, Legend, frameOf } from "./Axis";
import { INK, seriesColor } from "./palette";
import { linearScale, niceDomain, niceTicks } from "./scale";

export interface BarSeries {
  name: string;
  /** One value per category; null/negative count as 0. */
  values: readonly (number | null)[];
  color?: string;
}

const GAP = 2; // surface gap between stacked segments and between bars

/**
 * Vertical bars, one per category, stacked by series bottom-up in series order. `percent` scales
 * every bar to 100% (time in zone per week). Each segment carries a `<title>` tooltip.
 */
export function StackedBars({
  ariaLabel,
  categories,
  series,
  percent = false,
  width,
  height,
  yFormat = (v) => String(Math.round(v)),
  maxLabels = 6,
}: {
  ariaLabel: string;
  categories: readonly string[];
  series: readonly BarSeries[];
  percent?: boolean;
  width?: number;
  height?: number;
  yFormat?: (v: number) => string;
  maxLabels?: number;
}) {
  const titleId = useId();
  const frame = frameOf(width, height);
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const val = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const totals = categories.map((_, c) => colored.reduce((sum, s) => sum + val(s.values[c]), 0));
  const yd: [number, number] = percent ? [0, 100] : niceDomain(totals, { zero: true });
  const y = linearScale(yd, [frame.height - frame.bottom, frame.top]);
  const yt = percent ? [0, 50, 100] : niceTicks(yd[0], yd[1], 4).filter((t) => t >= yd[0] && t <= yd[1]);
  const plotW = frame.width - frame.left - frame.right;
  const slot = categories.length ? plotW / categories.length : plotW;
  const barW = Math.max(slot - GAP * 2, 1);
  const every = Math.max(1, Math.ceil(categories.length / maxLabels));
  const fmtY = percent ? (v: number) => `${v}%` : yFormat;

  return (
    <figure className="m-0">
      <Legend items={colored.map((s) => ({ name: s.name, color: s.color }))} />
      <svg viewBox={`0 0 ${frame.width} ${frame.height}`} width="100%" role="img" aria-labelledby={titleId} style={{ display: "block" }}>
        <title id={titleId}>{ariaLabel}</title>
        <Axis orientation="left" scale={y} ticks={yt} format={fmtY} frame={frame} />
        <line x1={frame.left} x2={frame.width - frame.right} y1={y(0)} y2={y(0)} stroke={INK.baseline} />
        {categories.map((cat, c) => {
          const x = frame.left + c * slot + GAP;
          let acc = 0;
          const total = totals[c];
          return (
            <g key={`${cat}-${c}`} data-category={cat}>
              {colored.map((s) => {
                const raw = val(s.values[c]);
                if (raw === 0) return null;
                const v = percent ? (total > 0 ? (raw / total) * 100 : 0) : raw;
                const top = y(acc + v);
                const bottom = y(acc);
                acc += v;
                const h = Math.max(bottom - top - GAP, 0.5);
                return (
                  <rect key={s.name} data-series={s.name} x={x} y={top} width={barW} height={h} rx={1.5} fill={s.color}>
                    <title>{`${cat} · ${s.name}: ${percent ? `${Math.round(v)}%` : yFormat(raw)}`}</title>
                  </rect>
                );
              })}
              {c % every === 0 && (
                <text x={x + barW / 2} y={frame.height - frame.bottom + 12} fontSize={9} textAnchor="middle" fill={INK.muted}>
                  {cat}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
