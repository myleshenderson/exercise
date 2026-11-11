import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DataLayer } from "../../data/DataLayer";
import { createMockDataLayer } from "../../data/mock";
import { W_PER_KG_BANDS, weightRatePerWeek, weightSeries, wPerKgBand } from "../../metrics/display";
import { weightTrend } from "../../metrics/weight";
import { formatWeight } from "../../metrics/units";
import { RideDbProvider } from "../RideDb";
import { eftpOf } from "../settings/ftp";
import { localToday } from "../stats/time";
import { buildRideFixtures, createRideFixtureDb, type RideFixtures } from "../testing/fixtures";
import Weight from "./Weight";

const NOW = new Date("2026-11-11T17:00:00.000Z");
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function renderWeight(db: DataLayer) {
  return render(
    <RideDbProvider db={db}>
      <MemoryRouter initialEntries={["/weight"]}>
        <Weight now={NOW} />
      </MemoryRouter>
    </RideDbProvider>,
  );
}

async function ready() {
  await waitFor(() => expect(document.querySelector('[data-ready="weight"]')).not.toBeNull());
}

const dbWith = (over: Partial<RideFixtures>) => createMockDataLayer({ rides: { ...buildRideFixtures(NOW), ...over } });
const weighIns = (fx: RideFixtures) => fx.bodyWeights.map((w) => ({ measuredAt: w.measuredAt, timezone: TZ, weightKg: w.weightKg }));
const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement;

test("readouts: latest, 7-day average, 4-week change, rate and W/kg at the manual FTP with its band", async () => {
  const fx = buildRideFixtures(NOW);
  const trend = weightTrend(weighIns(fx), localToday(NOW));
  renderWeight(createRideFixtureDb(NOW));
  await ready();
  const latest = fx.bodyWeights[fx.bodyWeights.length - 1];
  expect(tile("Latest weigh-in")).toHaveTextContent(formatWeight(latest.weightKg, "imperial"));
  expect(tile("7-day average")).toHaveTextContent(formatWeight(trend.avg7Kg, "imperial"));
  expect(trend.change4wKg).toBeLessThan(0);
  expect(tile("4-week change")).toHaveTextContent(`−${formatWeight(-trend.change4wKg!, "imperial")}`);
  expect(tile("Rate")).toHaveTextContent(`−${formatWeight(-weightRatePerWeek(trend)!, "imperial")} / wk`);
  const wkg = 250 / trend.avg7Kg!;
  const band = W_PER_KG_BANDS.find((b) => b.band === wPerKgBand(wkg))!.label;
  expect(tile("W/kg")).toHaveTextContent(wkg.toFixed(2));
  expect(tile("W/kg")).toHaveTextContent(`${band} · FTP 250 W (manual)`);
});

test("W/kg uses eFTP without a manual FTP, and metric units show kg", async () => {
  const fx = buildRideFixtures(NOW);
  const trend = weightTrend(weighIns(fx), localToday(NOW));
  const e = eftpOf(fx.activities, NOW)!;
  renderWeight(dbWith({ settings: { ...fx.settings, manualFtpW: null, units: "metric" } }));
  await ready();
  expect(tile("7-day average")).toHaveTextContent(formatWeight(trend.avg7Kg, "metric"));
  expect(tile("7-day average").textContent).toMatch(/kg$/);
  expect(tile("W/kg")).toHaveTextContent((e / trend.avg7Kg!).toFixed(2));
  expect(tile("W/kg")).toHaveTextContent(`FTP ${Math.round(e)} W (eFTP)`);
});

test("W/kg shows the empty mark when FTP or weight is missing", async () => {
  const fx = buildRideFixtures(NOW);
  renderWeight(dbWith({ settings: { ...fx.settings, manualFtpW: null }, activities: [] }));
  await ready();
  expect(tile("W/kg")).toHaveTextContent("—");
  expect(tile("W/kg")).toHaveTextContent("No FTP or eFTP");
});

test("range tabs: 90 d by default, dots and the 7-day mean, switching changes the points", async () => {
  const fx = buildRideFixtures(NOW);
  renderWeight(createRideFixtureDb(NOW));
  await ready();
  expect(screen.getByRole("tab", { name: "90 d" })).toHaveAttribute("aria-selected", "true");
  const chart = () => screen.getByRole("img", { name: /Body weight, lb/ });
  const dots = () => chart().querySelectorAll('g[data-series="Weigh-ins"] circle').length;
  expect(chart().querySelector('path[data-series="7-day mean"]')?.getAttribute("d")).toMatch(/^M/);
  const at90 = dots();
  fireEvent.click(screen.getByRole("tab", { name: "30 d" }));
  const at30 = dots();
  fireEvent.click(screen.getByRole("tab", { name: "All" }));
  const atAll = dots();
  expect(at30).toBeLessThan(at90);
  expect(at90).toBeLessThan(atAll);
  expect(atAll).toBe(weightSeries(weighIns(fx)).reduce((n, d) => n + d.weighInsKg.length, 0));
  expect(within(screen.getByRole("region", { name: "Trend" })).getByText("7-day mean")).toBeInTheDocument();
});
