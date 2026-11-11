import { INK } from "./palette";
import { noNegZero, type Scale } from "./scale";

/** Chart frame shared by every chart: the viewBox and plot margins, in viewBox units. */
export interface Frame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_FRAME: Frame = { width: 360, height: 160, left: 36, right: 8, top: 8, bottom: 20 };

export function frameOf(width = DEFAULT_FRAME.width, height = DEFAULT_FRAME.height, over: Partial<Frame> = {}): Frame {
  return { ...DEFAULT_FRAME, width, height, ...over };
}

/**
 * A recessive axis: tick labels in muted ink, hairline gridlines across the plot for the value
 * axis (`left`), a baseline and labels for the category/time axis (`bottom`).
 */
export function Axis({
  orientation,
  scale,
  ticks,
  format = (v) => String(v),
  frame,
  grid = orientation === "left",
}: {
  orientation: "left" | "bottom";
  scale: Scale;
  ticks: readonly number[];
  format?: (v: number) => string;
  frame: Frame;
  grid?: boolean;
}) {
  const x0 = frame.left;
  const x1 = frame.width - frame.right;
  const y0 = frame.top;
  const y1 = frame.height - frame.bottom;
  if (orientation === "left") {
    return (
      <g data-axis="left" fontSize={9} fill={INK.muted}>
        {ticks.map((t) => {
          const y = scale(t);
          return (
            <g key={t}>
              {grid && <line x1={x0} x2={x1} y1={y} y2={y} stroke={INK.grid} strokeWidth={1} />}
              <text x={x0 - 4} y={y} dy="0.32em" textAnchor="end" style={{ fontVariantNumeric: "tabular-nums" }}>
                {format(noNegZero(t))}
              </text>
            </g>
          );
        })}
      </g>
    );
  }
  return (
    <g data-axis="bottom" fontSize={9} fill={INK.muted}>
      <line x1={x0} x2={x1} y1={y1} y2={y1} stroke={INK.baseline} strokeWidth={1} />
      {ticks.map((t) => {
        const x = scale(t);
        return (
          <g key={t}>
            {grid && <line x1={x} x2={x} y1={y0} y2={y1} stroke={INK.grid} strokeWidth={1} />}
            <text x={x} y={y1 + 12} textAnchor="middle">
              {format(noNegZero(t))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Legend row (HTML) for charts with two or more series; a dashed series shows a dashed swatch. */
export function Legend({ items }: { items: readonly { name: string; color: string; dashed?: boolean }[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="m-0 mb-1 list-none p-0 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600" aria-label="Legend">
      {items.map((it) => (
        <li key={it.name} className="flex items-center gap-1">
          <svg width="14" height="8" aria-hidden="true">
            <line x1="0" x2="14" y1="4" y2="4" stroke={it.color} strokeWidth="3" strokeDasharray={it.dashed ? "3 2" : undefined} />
          </svg>
          {it.name}
        </li>
      ))}
    </ul>
  );
}

/** A small tooltip box drawn inside the SVG, kept within the frame. */
export function Tooltip({ x, frame, lines }: { x: number; frame: Frame; lines: readonly string[] }) {
  const w = Math.max(...lines.map((l) => l.length)) * 5.4 + 10;
  const h = lines.length * 12 + 6;
  const left = x + 6 + w > frame.width - frame.right ? x - 6 - w : x + 6;
  return (
    <g data-tooltip="" pointerEvents="none">
      <rect x={left} y={frame.top} width={w} height={h} rx={4} fill="#ffffff" stroke={INK.grid} />
      {lines.map((l, i) => (
        <text key={i} x={left + 5} y={frame.top + 13 + i * 12} fontSize={9} fill={i === 0 ? INK.secondary : INK.primary}>
          {l}
        </text>
      ))}
    </g>
  );
}
