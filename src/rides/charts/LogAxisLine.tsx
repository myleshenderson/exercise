import { durationTick } from "./scale";
import { XYChart, type XYChartProps } from "./XYChart";

/** Default ticks for a power curve: 5 s, 1 min, 5 min, 20 min, 1 h. */
export const POWER_CURVE_TICKS_S: readonly number[] = [5, 60, 300, 1200, 3600];

/** Lines over a log x axis (seconds by default), e.g. the power curve. */
export function LogAxisLine({ xTicks = POWER_CURVE_TICKS_S, xFormat = durationTick, ...props }: Omit<XYChartProps, "xScale" | "bands">) {
  return <XYChart {...props} xScale="log" xTicks={xTicks} xFormat={xFormat} />;
}
