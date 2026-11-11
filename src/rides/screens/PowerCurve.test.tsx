import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createMockDataLayer } from "../../data/mock";
import type { DataLayer } from "../../data/DataLayer";
import { bestPowerCurve } from "../../metrics/display";
import { weightTrend } from "../../metrics/weight";
import { RideDbProvider } from "../RideDb";
import { eftpOf } from "../settings/ftp";
import { localToday } from "../stats/time";
import { RIDE_FIXTURE_IDS, buildRideFixtures, createRideFixtureDb, type RideFixtures } from "../testing/fixtures";
import PowerCurve from "./PowerCurve";

const NOW = new Date("2026-11-11T17:00:00.000Z");
const DAY_MS = 86_400_000;

function renderPower(db: DataLayer) {
  return render(
    <RideDbProvider db={db}>
      <MemoryRouter initialEntries={["/power"]}>
        <PowerCurve now={NOW} />
      </MemoryRouter>
    </RideDbProvider>,
  );
}

async function ready() {
  await waitFor(() => expect(document.querySelector('[data-ready="power"]')).not.toBeNull());
}

const dbWith = (over: Partial<RideFixtures>) => createMockDataLayer({ rides: { ...buildRideFixtures(NOW), ...over } });

test("both curves, the dashed eFTP line and the solid manual FTP line", async () => {
  const fx = buildRideFixtures(NOW);
  renderPower(createRideFixtureDb(NOW));
  await ready();
  const chart = screen.getByRole("img", { name: /Best power per duration, W$/ });
  expect(chart.querySelector('path[data-series="All-time"]')?.getAttribute("d")).toMatch(/^M/);
  expect(chart.querySelector('path[data-series="Last 90 days"]')?.getAttribute("d")).toMatch(/^M/);
  expect(screen.getByText("All-time", { selector: "figure *" })).toBeInTheDocument();

  const e = eftpOf(fx.activities, NOW)!;
  expect(e).toBeGreaterThan(0);
  const eLine = chart.querySelector(`g[data-reference="eFTP ${Math.round(e)} W"]`);
  expect(eLine).not.toBeNull();
  expect(eLine!.querySelector("line")?.getAttribute("stroke-dasharray")).toBe("4 3");
  const ftp = chart.querySelector('g[data-reference="FTP 250 W (manual)"]');
  expect(ftp).not.toBeNull();
  expect(ftp!.querySelector("line")?.getAttribute("stroke-dasharray")).toBeNull();
});

test("no manual FTP: only the eFTP line", async () => {
  const fx = buildRideFixtures(NOW);
  renderPower(dbWith({ settings: { ...fx.settings, manualFtpW: null } }));
  await ready();
  const chart = screen.getByRole("img", { name: /Best power per duration/ });
  expect(chart.querySelectorAll("g[data-reference]")).toHaveLength(1);
  expect(chart.querySelector("g[data-reference]")?.getAttribute("data-reference")).toMatch(/^eFTP \d+ W$/);
});

test("W/kg toggle divides by the 7-day average weight", async () => {
  const fx = buildRideFixtures(NOW);
  const kg = weightTrend(
    fx.bodyWeights.map((w) => ({ measuredAt: w.measuredAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, weightKg: w.weightKg })),
    localToday(NOW),
  ).avg7Kg!;
  renderPower(createRideFixtureDb(NOW));
  await ready();
  fireEvent.click(screen.getByRole("tab", { name: "W/kg" }));
  const chart = screen.getByRole("img", { name: /Best power per duration, W\/kg/ });
  expect(chart.querySelector(`g[data-reference="FTP ${(250 / kg).toFixed(2)} W/kg (manual)"]`)).not.toBeNull();
  const best5 = bestPowerCurve(fx.activities).find((p) => p.durationS === 5)!;
  const row = screen.getByRole("row", { name: /^5 s/ });
  expect(within(row).getAllByRole("link")[0]).toHaveTextContent(`${(best5.watts / kg).toFixed(2)} W/kg`);
});

test("W/kg is disabled with a caption when there is no weigh-in in the last 7 days", async () => {
  const fx = buildRideFixtures(NOW);
  const old = fx.bodyWeights.filter((w) => Date.parse(w.measuredAt) < NOW.getTime() - 10 * DAY_MS);
  renderPower(dbWith({ bodyWeights: old }));
  await ready();
  expect(screen.getByRole("tab", { name: "W/kg" })).toBeDisabled();
  expect(screen.getByText("No weigh-ins in the last 7 days")).toBeInTheDocument();
});

test("key-duration table: five rows, all-time and 90-day cells link to the ride holding them with its date", async () => {
  const fx = buildRideFixtures(NOW);
  const all = bestPowerCurve(fx.activities);
  const recent = bestPowerCurve(fx.activities, new Date(NOW.getTime() - 90 * DAY_MS).toISOString());
  renderPower(createRideFixtureDb(NOW));
  await ready();
  const table = screen.getByRole("table", { name: "Key durations" });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((r) => r.getAttribute("data-duration"))).toEqual(["5 s", "1 min", "5 min", "20 min", "1 h"]);
  for (const [i, d] of [5, 60, 300, 1200, 3600].entries()) {
    const a = all.find((p) => p.durationS === d);
    const r = recent.find((p) => p.durationS === d);
    const links = within(rows[i]).queryAllByRole("link");
    const expected = [a, r].filter(Boolean);
    expect(links).toHaveLength(expected.length);
    expected.forEach((p, j) => {
      expect(links[j]).toHaveAttribute("href", `/activities/${p!.activityId}`);
      expect(links[j]).toHaveTextContent(`${Math.round(p!.watts)} W`);
      expect(links[j].textContent).toMatch(/[A-Z][a-z]{2} \d{1,2}$/);
    });
  }
});

test("a hidden row (the Garmin half of a Peloton pair, a fragment) never holds a best", async () => {
  const fx = buildRideFixtures(NOW);
  const activities = fx.activities.map((a) =>
    a.id === RIDE_FIXTURE_IDS.pairedGarmin || a.id === RIDE_FIXTURE_IDS.fragment ? { ...a, powerCurve: { "5": 5000, "60": 4000 } } : a,
  );
  renderPower(dbWith({ activities }));
  await ready();
  const table = screen.getByRole("table", { name: "Key durations" });
  for (const link of within(table).getAllByRole("link")) {
    expect(link.getAttribute("href")).not.toMatch(new RegExp(`${RIDE_FIXTURE_IDS.pairedGarmin}|${RIDE_FIXTURE_IDS.fragment}`));
  }
  expect(table).not.toHaveTextContent("5000 W");
});

test("an account without power shows the EmptyState", async () => {
  renderPower(createMockDataLayer({ seed: false }));
  await ready();
  expect(screen.getByText(/No rides yet/)).toBeInTheDocument();
});
