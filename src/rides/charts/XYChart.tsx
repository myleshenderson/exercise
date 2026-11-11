import { useId, useState, type PointerEvent } from "react";
import { Axis, Legend, Tooltip, frameOf } from "./Axis";
import { INK, seriesColor } from "./palette";
import { linearScale, logScale, nearestIndex, niceDomain, niceTicks, viewBoxX, type Scale } from "./scale";

export interface XYPoint {
  x: number;
  /** null breaks the line (a gap). */
  y: number | null;
}

export interface XYSeries {
  name: string;
  points: readonly XYPoint[];
  /** Defaults to the next categorical slot. */
  color?: string;
  dashed?: boolean;
  /** Draw a dot per point instead of a line (e.g. weigh-ins). */
  dots?: boolean;
}

export interface ReferenceLine {
  y: number;
  label: string;
  dashed?: boolean;
  color?: string;
  /** Label above (default) or below the line. */
  labelPosition?: "above" | "below";
}

export interface Band {
  /** Value range, clamped to the y domain; ±Infinity allowed. */
  from: number;
  to: number;
  label: string;
  color: string;
}

export interface XYChartProps {
  ariaLabel: string;
  series: readonly XYSeries[];
  xScale?: "linear" | "log";
  width?: number;
  height?: number;
  xDomain?: [number, number];
  yDomain?: [number, number];
  xTicks?: readonly number[];
  yTicks?: readonly number[];
  xFormat?: (x: number) => string;
  yFormat?: (y: number) => string;
  referenceLines?: readonly ReferenceLine[];
  bands?: readonly Band[];
}

function pathFor(points: readonly XYPoint[], x: Scale, y: Scale): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y) || !Number.isFinite(p.x)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** The engine behind LineChart, LogAxisLine and BandedArea: one y-axis, lines or dots, crosshair hover. */
export function XYChart({
  ariaLabel,
  series,
  xScale = "linear",
  width,
  height,
  xDomain,
  yDomain,
  xTicks,
  yTicks,
  xFormat = (v) => String(v),
  yFormat = (v) => String(Math.round(v)),
  referenceLines = [],
  bands = [],
}: XYChartProps) {
  const titleId = useId();
  const frame = frameOf(width, height);
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const allX = colored.flatMap((s) => s.points.map((p) => p.x));
  const allY = [...colored.flatMap((s) => s.points.map((p) => p.y)), ...referenceLines.map((r) => r.y)];
  const xd: [number, number] = xDomain ?? (allX.length ? [Math.min(...allX), Math.max(...allX)] : [0, 1]);
  const yd = yDomain ?? niceDomain(allY);
  const xRange: [number, number] = [frame.left, frame.width - frame.right];
  const yRange: [number, number] = [frame.height - frame.bottom, frame.top];
  const x = xScale === "log" ? logScale(xd, xRange) : linearScale(xd, xRange);
  const y = linearScale(yd, yRange);
  const xt = xTicks ?? (xScale === "log" ? [] : niceTicks(xd[0], xd[1], 4));
  const yt = yTicks ?? niceTicks(yd[0], yd[1], 4).filter((t) => t >= yd[0] && t <= yd[1]);

  // Hover: the x nearest the pointer across every series.
  const xs = [...new Set(allX)].sort((a, b) => a - b);
  const [hover, setHover] = useState<number | null>(null);
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg || xs.length === 0) return;
    const vx = viewBoxX(svg, e.clientX, frame.width);
    const i = nearestIndex(xs.map((v) => x(v)), vx);
    setHover(i >= 0 ? xs[i] : null);
  };
  const hoverLines =
    hover === null
      ? []
      : [
          xFormat(hover),
          ...colored.flatMap((s) => {
            const p = s.points.find((pt) => pt.x === hover);
            return p && p.y !== null ? [`${s.name}: ${yFormat(p.y)}`] : [];
          }),
        ];

  const clamp = (v: number) => Math.min(Math.max(v, yd[0]), yd[1]);

  return (
    <figure className="m-0">
      <Legend items={colored.map((s) => ({ name: s.name, color: s.color, dashed: s.dashed }))} />
      <svg
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        width="100%"
        role="img"
        aria-labelledby={titleId}
        style={{ display: "block", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}
      >
        <title id={titleId}>{ariaLabel}</title>
        {bands.map((b) => {
          const top = y(clamp(b.to));
          const bottom = y(clamp(b.from));
          if (bottom - top <= 0) return null;
          return (
            <g key={b.label} data-band={b.label}>
              <rect x={frame.left} y={top} width={frame.width - frame.left - frame.right} height={bottom - top} fill={b.color} fillOpacity={0.12} />
              {bottom - top >= 9 && (
                <text x={frame.width - frame.right - 3} y={top + 8} fontSize={8} textAnchor="end" fill={INK.secondary}>
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
        <Axis orientation="left" scale={y} ticks={yt} format={yFormat} frame={frame} />
        <Axis orientation="bottom" scale={x} ticks={xt} format={xFormat} frame={frame} grid={false} />
        {referenceLines.map((r) => (
          <g key={r.label} data-reference={r.label}>
            <line
              x1={frame.left}
              x2={frame.width - frame.right}
              y1={y(r.y)}
              y2={y(r.y)}
              stroke={r.color ?? INK.secondary}
              strokeWidth={1.5}
              strokeDasharray={r.dashed ? "4 3" : undefined}
            />
            <text
              x={frame.left + 3}
              y={r.labelPosition === "below" ? y(r.y) + 3 : y(r.y) - 3}
              dy={r.labelPosition === "below" ? "0.71em" : undefined}
              fontSize={9}
              fill={INK.secondary}
            >
              {r.label}
            </text>
          </g>
        ))}
        {colored.map((s) =>
          s.dots ? (
            <g key={s.name} data-series={s.name} fill={s.color}>
              {s.points.map((p, i) =>
                p.y === null ? null : <circle key={i} cx={x(p.x)} cy={y(p.y)} r={2.5} stroke={INK.surface} strokeWidth={1} />,
              )}
            </g>
          ) : (
            <path
              key={s.name}
              data-series={s.name}
              d={pathFor(s.points, x, y)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? "5 3" : undefined}
            />
          ),
        )}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={frame.top} y2={frame.height - frame.bottom} stroke={INK.muted} strokeWidth={1} pointerEvents="none" />
            <Tooltip x={x(hover)} frame={frame} lines={hoverLines} />
          </>
        )}
        <rect
          x={frame.left}
          y={frame.top}
          width={frame.width - frame.left - frame.right}
          height={frame.height - frame.top - frame.bottom}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
    </figure>
  );
}
