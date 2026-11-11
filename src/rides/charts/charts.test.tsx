import { fireEvent, render, screen } from "@testing-library/react";
import { COGGAN_POWER_ZONES } from "../../metrics";
import {
  BandedArea,
  LineChart,
  LogAxisLine,
  StackedBars,
  TSB_CHART_BANDS,
  ZoneBars,
  durationTick,
  linearScale,
  logScale,
  niceDomain,
  niceTicks,
  seriesColor,
  zoneColors,
  SERIES,
} from ".";
import { nearestIndex, noNegZero, viewBoxX } from "./scale";

describe("scales", () => {
  test("linear and log", () => {
    const x = linearScale([0, 10], [0, 100]);
    expect(x(5)).toBe(50);
    expect(linearScale([3, 3], [0, 10])(3)).toBe(0);
    const l = logScale([1, 100], [0, 100]);
    expect(l(10)).toBeCloseTo(50);
    expect(l(0)).toBeLessThan(0);
  });
  test("ticks and domains", () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0, 7, 4)).toEqual([0, 2, 4, 6]);
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(NaN, 1)).toEqual([]);
    expect(niceDomain([3, 97])).toEqual([0, 100]);
    expect(niceDomain([null, undefined])).toEqual([0, 1]);
    expect(niceDomain([4, 4])).toEqual([3, 5]);
    expect(niceDomain([10, 20], { zero: true })[0]).toBe(0);
  });
  test("an all-zero or all-null series gets the domain [0, 1] with ticks [0, 1] (AI-672)", () => {
    expect(niceDomain([0, 0, 0])).toEqual([0, 1]);
    expect(niceDomain([0, 0, 0], { zero: true })).toEqual([0, 1]);
    expect(niceDomain([0, null, 0], { zero: true })).toEqual([0, 1]);
    expect(niceDomain([null, null], { zero: true })).toEqual([0, 1]);
    expect(niceTicks(0, 1, 4)).toEqual([0, 1]);
    // Non-zero constant series keep their padded domain.
    expect(niceDomain([4, 4])).toEqual([3, 5]);
  });
  test("ticks never contain -0 (AI-672)", () => {
    expect(Object.is(noNegZero(-0), 0)).toBe(true);
    expect(noNegZero(-1)).toBe(-1);
    for (const [lo, hi] of [[-1, 1], [-0.3, 0.3], [-30, 25], [-0, 0], [-0.1 - 0.2, 0.3]] as const) {
      for (const t of niceTicks(lo, hi, 4)) expect(Object.is(t, -0)).toBe(false);
    }
  });
  test("StackedBars over all-zero totals labels the y axis 0 and 1 only (AI-672)", () => {
    const { container } = render(
      <StackedBars ariaLabel="Volume" categories={["a", "b", "c"]} series={[{ name: "Volume", values: [0, 0, 0] }]} yFormat={(v) => Math.round(v).toLocaleString("en-US")} />,
    );
    const labels = [...container.querySelectorAll('[data-axis="left"] text')].map((t) => t.textContent);
    expect(labels).toEqual(["0", "1"]);
  });
  test("helpers", () => {
    expect(durationTick(5)).toBe("5s");
    expect(durationTick(300)).toBe("5m");
    expect(durationTick(3600)).toBe("1h");
    expect(durationTick(5400)).toBe("1.5h");
    expect(nearestIndex([0, 10, 20], 12)).toBe(1);
    expect(nearestIndex([], 1)).toBe(-1);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    expect(viewBoxX(svg, 10, 360)).toBe(0); // jsdom has no layout
  });
  test("palette slots are fixed and never cycled", () => {
    expect(seriesColor(0)).toBe(SERIES[0]);
    expect(() => seriesColor(8)).toThrow(RangeError);
    expect(zoneColors(7)).toHaveLength(7);
    expect(new Set(zoneColors(5)).size).toBe(5);
    expect(zoneColors(1)).toHaveLength(1);
  });
});

test("LineChart renders a titled SVG, a legend for two series, gaps for nulls, and reference lines", () => {
  const { container } = render(
    <LineChart
      ariaLabel="Fitness and fatigue"
      series={[
        { name: "CTL", points: [{ x: 0, y: 40 }, { x: 1, y: null }, { x: 2, y: 42 }, { x: 3, y: 43 }] },
        { name: "ATL", points: [{ x: 0, y: 50 }, { x: 1, y: 55 }, { x: 2, y: 48 }, { x: 3, y: 47 }], dashed: true },
      ]}
      referenceLines={[{ y: 45, label: "Target", dashed: true }]}
    />,
  );
  expect(screen.getByRole("img", { name: "Fitness and fatigue" })).toBeInTheDocument();
  expect(container.querySelector("title")?.textContent).toBe("Fitness and fatigue");
  expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("CTLATL");
  const ctl = container.querySelector('path[data-series="CTL"]')!.getAttribute("d")!;
  expect(ctl.match(/M/g)).toHaveLength(2); // the null breaks the line
  expect(container.querySelector('[data-reference="Target"]')).not.toBeNull();

  // Hover shows a tooltip; leaving clears it.
  const overlay = container.querySelector('rect[fill="transparent"]')!;
  fireEvent.pointerMove(overlay, { clientX: 0 });
  expect(container.querySelector("[data-tooltip]")).not.toBeNull();
  fireEvent.pointerLeave(overlay);
  expect(container.querySelector("[data-tooltip]")).toBeNull();
});

test("LineChart with one series has no legend and supports dots", () => {
  const { container } = render(<LineChart ariaLabel="Weigh-ins" series={[{ name: "kg", dots: true, points: [{ x: 1, y: 80 }, { x: 2, y: null }, { x: 3, y: 79 }] }]} />);
  expect(screen.queryByRole("list", { name: "Legend" })).not.toBeInTheDocument();
  expect(container.querySelectorAll("circle")).toHaveLength(2);
});

test("LogAxisLine puts duration ticks on a log axis", () => {
  const { container } = render(
    <LogAxisLine
      ariaLabel="Power curve"
      series={[{ name: "All-time", points: [{ x: 1, y: 700 }, { x: 60, y: 400 }, { x: 3600, y: 240 }] }]}
      referenceLines={[{ y: 241, label: "eFTP 241 W", dashed: true }]}
    />,
  );
  expect(screen.getByRole("img", { name: "Power curve" })).toBeInTheDocument();
  const ticks = Array.from(container.querySelectorAll('[data-axis="bottom"] text')).map((t) => t.textContent);
  expect(ticks).toEqual(["5s", "1m", "5m", "20m", "1h"]);
});

test("BandedArea shades the TSB bands that fall inside the domain", () => {
  const { container } = render(
    <BandedArea
      ariaLabel="Form"
      yDomain={[-40, 30]}
      bands={TSB_CHART_BANDS}
      series={[{ name: "TSB", points: [{ x: 0, y: -12 }, { x: 1, y: 3 }] }]}
    />,
  );
  expect(TSB_CHART_BANDS.map((b) => b.label)).toEqual(["Overreaching", "Productive", "Grey zone", "Fresh", "Transition"]);
  expect(container.querySelectorAll("[data-band]")).toHaveLength(5);
  const narrow = render(<BandedArea ariaLabel="Form narrow" yDomain={[0, 10]} bands={TSB_CHART_BANDS} series={[]} />);
  expect(Array.from(narrow.container.querySelectorAll("[data-band]")).map((b) => b.getAttribute("data-band"))).toEqual(["Grey zone", "Fresh"]);
});

test("StackedBars stacks series per category and supports 100% bars", () => {
  const { container } = render(
    <StackedBars
      ariaLabel="Weekly TSS"
      categories={["Nov 2", "Nov 9"]}
      series={[
        { name: "Garmin", values: [100, 50] },
        { name: "Peloton", values: [80, null] },
      ]}
    />,
  );
  expect(screen.getByRole("img", { name: "Weekly TSS" })).toBeInTheDocument();
  expect(container.querySelectorAll('rect[data-series="Garmin"]')).toHaveLength(2);
  expect(container.querySelectorAll('rect[data-series="Peloton"]')).toHaveLength(1);
  expect(container.querySelector('[data-category="Nov 2"] rect title')?.textContent).toBe("Nov 2 · Garmin: 100");

  const pct = render(
    <StackedBars ariaLabel="Zones" percent categories={["W1"]} series={[{ name: "Z1", values: [30] }, { name: "Z2", values: [90] }]} />,
  );
  expect(pct.container.querySelector('rect[data-series="Z2"] title')?.textContent).toBe("W1 · Z2: 75%");
});

test("ZoneBars shows each zone's time and share", () => {
  const zones = COGGAN_POWER_ZONES.zones.map((z, i) => ({ label: z.label, seconds: i === 1 ? 1800 : i === 3 ? 600 : 0 }));
  const { container } = render(<ZoneBars ariaLabel="Power zones" zones={zones} />);
  expect(screen.getByRole("img", { name: "Power zones" })).toBeInTheDocument();
  expect(container.querySelectorAll("[data-zone]")).toHaveLength(7);
  expect(container.querySelector('[data-zone="Z2 Endurance"]')).toHaveTextContent("30:00 · 75%");
  expect(container.querySelector('[data-zone="Z1 Active recovery"]')).toHaveTextContent("0:00 · 0%");
});
