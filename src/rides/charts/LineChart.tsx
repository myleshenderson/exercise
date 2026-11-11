import { XYChart, type XYChartProps } from "./XYChart";

export type { XYPoint, XYSeries, ReferenceLine } from "./XYChart";

/** Lines (or dots) on a linear x axis with one y axis, optional reference lines, crosshair tooltip. */
export function LineChart(props: Omit<XYChartProps, "xScale" | "bands">) {
  return <XYChart {...props} xScale="linear" />;
}
