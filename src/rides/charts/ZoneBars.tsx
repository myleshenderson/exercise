import { useId } from "react";
import { formatDuration } from "../../metrics/display";
import { INK, zoneColors } from "./palette";

/**
 * Horizontal bars of time in each zone (lowest zone on top), with the time and share as text.
 * Pair with `zoneSeconds(stream, threshold, TABLE)` and the table's zone labels.
 */
export function ZoneBars({
  ariaLabel,
  zones,
  width = 360,
}: {
  ariaLabel: string;
  zones: readonly { label: string; seconds: number }[];
  width?: number;
}) {
  const titleId = useId();
  const colors = zoneColors(zones.length);
  const total = zones.reduce((s, z) => s + Math.max(z.seconds, 0), 0);
  const max = Math.max(...zones.map((z) => z.seconds), 1);
  const row = 18;
  const labelW = 110;
  const valueW = 72;
  const barMax = width - labelW - valueW;
  const height = zones.length * row + 4;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-labelledby={titleId} style={{ display: "block" }}>
      <title id={titleId}>{ariaLabel}</title>
      {zones.map((z, i) => {
        const y = 2 + i * row;
        const w = z.seconds > 0 ? Math.max((z.seconds / max) * barMax, 2) : 0;
        const pct = total > 0 ? Math.round((z.seconds / total) * 100) : 0;
        return (
          <g key={z.label} data-zone={z.label}>
            <text x={0} y={y + row / 2} dy="0.32em" fontSize={10} fill={INK.secondary}>
              {z.label}
            </text>
            <rect x={labelW} y={y + 3} width={w} height={row - 6} rx={2} fill={colors[i]}>
              <title>{`${z.label}: ${formatDuration(z.seconds, "clock")} (${pct}%)`}</title>
            </rect>
            <text x={width} y={y + row / 2} dy="0.32em" fontSize={10} textAnchor="end" fill={INK.primary} style={{ fontVariantNumeric: "tabular-nums" }}>
              {`${formatDuration(z.seconds, "clock")} · ${pct}%`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
