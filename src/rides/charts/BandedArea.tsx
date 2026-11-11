import { TSB_BANDS, type TsbBand } from "../../metrics/display";
import { INK, STATUS } from "./palette";
import { XYChart, type Band, type XYChartProps } from "./XYChart";

export type { Band } from "./XYChart";

const TSB_BAND_COLORS: Record<TsbBand, string> = {
  overreaching: STATUS.critical,
  productive: STATUS.good,
  grey: INK.muted,
  fresh: "#2a78d6",
  transition: STATUS.warning,
};

/** The five TSB bands of `tsbBand`, ready for `BandedArea`. */
export const TSB_CHART_BANDS: readonly Band[] = TSB_BANDS.map((b) => ({ from: b.min, to: b.max, label: b.label, color: TSB_BAND_COLORS[b.band] }));

/** A line over shaded, labelled horizontal bands (e.g. TSB over the form bands). */
export function BandedArea({ bands, ...props }: Omit<XYChartProps, "xScale" | "bands"> & { bands: readonly Band[] }) {
  return <XYChart {...props} xScale="linear" bands={bands} />;
}
