import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createMockDataLayer } from "../../data/mock";
import type { DataLayer } from "../../data/DataLayer";
import type { ExternalActivity } from "../../types";
import { RideDbProvider } from "../RideDb";
import { RIDE_FIXTURE_IDS, buildRideFixtures, type RideFixtures } from "../testing/fixtures";
import ActivityDetail from "./ActivityDetail";

const NOW = new Date("2026-11-11T17:00:00.000Z");

function renderDetail(db: DataLayer, id: string) {
  return render(
    <RideDbProvider db={db}>
      <MemoryRouter initialEntries={[`/activities/${id}`]}>
        <Routes>
          <Route path="/activities/:id" element={<ActivityDetail />} />
        </Routes>
      </MemoryRouter>
    </RideDbProvider>,
  );
}

async function ready(value: string) {
  await waitFor(() => expect(document.querySelector(`[data-ready="${value}"]`)).not.toBeNull());
}

function fixtureDb(edit: (fx: RideFixtures) => void = () => {}): DataLayer {
  const fx = buildRideFixtures(NOW);
  edit(fx);
  return createMockDataLayer({ rides: fx });
}

const find = (fx: RideFixtures, id: string) => fx.activities.find((a) => a.id === id) as ExternalActivity;

test("outdoor ride: header, stats, three charts on one axis, zones, PR mark and the Garmin link", async () => {
  renderDetail(
    fixtureDb((fx) => {
      // 10K: faster than every other ride (PR); 20K: slower than the estimated ride's (not a PR).
      find(fx, RIDE_FIXTURE_IDS.outdoor).bestEfforts = [
        { label: "10K", distanceM: 10000, seconds: 600 },
        { label: "20K", distanceM: 20000, seconds: 99999 },
      ];
    }),
    RIDE_FIXTURE_IDS.outdoor,
  );
  await ready("activity-outdoor");
  expect(screen.getByRole("heading", { level: 1, name: "Saturday hills" })).toBeInTheDocument();
  expect(screen.getByText("Wed, Nov 11, 2026 · 09:00")).toBeInTheDocument();
  expect(screen.queryByText("Estimated TSS (no power or HR)")).not.toBeInTheDocument();

  const stats = within(screen.getByRole("region", { name: "Stats" }));
  for (const label of ["Distance", "Moving time", "Elevation", "Avg HR", "Max HR", "Avg speed", "Avg power", "NP", "IF", "TSS", "Work", "Calories"]) {
    expect(stats.getByText(label)).toBeInTheDocument();
  }
  expect(stats.getByText(/^\d+\.\d\d$/)).toBeInTheDocument(); // IF, two decimals
  expect(stats.getByText(/^\d+\.\d mph$/)).toBeInTheDocument();

  const charts = [...document.querySelectorAll("[data-channel]")].map((c) => c.getAttribute("data-channel"));
  expect(charts).toEqual(["altitude", "power", "heart_rate"]);
  expect(screen.getByRole("img", { name: "Altitude (ft) by minute from start" })).toBeInTheDocument();

  expect(document.querySelector('[data-zone-table="Coggan power"]')).not.toBeNull();
  expect(document.querySelector('[data-zone-table="Friel heart rate"]')).not.toBeNull();
  expect(screen.getByText("Power zones (FTP 250 W)")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /Power zones.*time in zone/ }).querySelectorAll("g[data-zone]")).toHaveLength(7);

  const tenK = document.querySelector('[data-effort="10K"]') as HTMLElement;
  expect(tenK).toHaveAttribute("data-pr", "true");
  expect(within(tenK).getByText("PR")).toBeInTheDocument();
  const twentyK = document.querySelector('[data-effort="20K"]') as HTMLElement;
  expect(twentyK).toHaveAttribute("data-pr", "false");
  expect(within(twentyK).queryByText("PR")).not.toBeInTheDocument();
  expect(within(twentyK).getByRole("link")).toHaveAttribute("href", expect.stringMatching(/^\/activities\//));
  expect(screen.getByTestId("biggest-climb")).toHaveTextContent(/Biggest climb: [\d,]+ ft/);

  const garmin = screen.getByRole("link", { name: "View on Garmin Connect" });
  expect(garmin).toHaveAttribute("href", "https://connect.garmin.com/modern/activity/src-outdoor-1");
  expect(garmin).toHaveAttribute("target", "_blank");
  expect(garmin).toHaveAttribute("rel", "noopener noreferrer");
});

test("indoor ride: power, cadence and HR charts, class stats with average resistance, paired note, Peloton link", async () => {
  const fx = buildRideFixtures(NOW);
  renderDetail(createMockDataLayer({ rides: fx }), RIDE_FIXTURE_IDS.indoor);
  await ready("activity-indoor");
  const charts = [...document.querySelectorAll("[data-channel]")].map((c) => c.getAttribute("data-channel"));
  expect(charts).toEqual(["power", "cadence", "heart_rate"]);

  const resistance = fx.streams.find((s) => s.activityId === RIDE_FIXTURE_IDS.indoor && s.channel === "resistance")!.values as number[];
  const mean = Math.round(resistance.reduce((a, b) => a + b, 0) / resistance.length);
  expect(screen.getByTestId("indoor-avg-resistance")).toHaveTextContent(`Avg resistance${mean}%`);
  const ride = find(fx, RIDE_FIXTURE_IDS.indoor);
  expect(screen.getByTestId("indoor-class")).toHaveTextContent("45 min Power Zone Ride");
  expect(screen.getByTestId("indoor-total-output")).toHaveTextContent(`${Math.round(ride.workKj!)} kJ`);
  expect(screen.getByTestId("indoor-distance")).toHaveTextContent(/\d+\.\d mi indoor/);
  expect(screen.queryByText("Best efforts")).not.toBeInTheDocument();

  // The Garmin partner started two minutes before the class; times are New York local.
  const partner = find(fx, RIDE_FIXTURE_IDS.pairedGarmin);
  const hhmm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(partner.startedAt),
  );
  expect(screen.getByTestId("paired-note")).toHaveTextContent(`Paired with the Garmin recording that started at ${hhmm}`);

  const peloton = screen.getByRole("link", { name: "View on Peloton" });
  expect(peloton).toHaveAttribute("href", "https://members.onepeloton.com/profile/workouts/src-indoor-1");
  expect(peloton).toHaveAttribute("target", "_blank");
  expect(peloton).toHaveAttribute("rel", "noopener noreferrer");
});

test("HR zones fall back to max HR, then to the Settings line", async () => {
  const { unmount } = renderDetail(
    fixtureDb((fx) => {
      fx.settings = { ...fx.settings, lthrBpm: null };
    }),
    RIDE_FIXTURE_IDS.outdoor,
  );
  await ready("activity-outdoor");
  expect(document.querySelector('[data-zone-table="Garmin heart rate"]')).not.toBeNull();
  unmount();

  renderDetail(
    fixtureDb((fx) => {
      fx.settings = { ...fx.settings, lthrBpm: null, maxHrBpm: null };
    }),
    RIDE_FIXTURE_IDS.outdoor,
  );
  await ready("activity-outdoor");
  expect(screen.getByText("Set threshold or max HR in Settings for HR zones")).toBeInTheDocument();
  expect(document.querySelector('[data-zone-table="Friel heart rate"]')).toBeNull();
  expect(document.querySelector('[data-zone-table="Garmin heart rate"]')).toBeNull();
});

test("a ride without streams or power: estimated TSS line, missing channel lines, empty marks not zeros", async () => {
  renderDetail(fixtureDb(), RIDE_FIXTURE_IDS.estimated);
  await ready("activity-outdoor");
  expect(screen.getByText("Estimated TSS (no power or HR)")).toBeInTheDocument();
  expect(document.querySelectorAll("[data-channel]")).toHaveLength(0);
  expect(screen.getByText("No altitude recorded")).toBeInTheDocument();
  expect(screen.getAllByText("No power recorded").length).toBeGreaterThan(0);
  expect(screen.getAllByText("No heart rate recorded").length).toBeGreaterThan(0);
  const stats = within(screen.getByRole("region", { name: "Stats" }));
  const value = (label: string) => stats.getByText(label).nextElementSibling;
  expect(value("Avg power")).toHaveTextContent("—");
  expect(value("NP")).toHaveTextContent("—");
  expect(value("IF")).toHaveTextContent("—");
  expect(value("Avg HR")).toHaveTextContent("—");
  expect(value("Work")).toHaveTextContent("—");
});

test("an unknown id shows Activity not found with a link back", async () => {
  renderDetail(fixtureDb(), "no-such-ride");
  await ready("activity");
  expect(screen.getByText("Activity not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to Activities" })).toHaveAttribute("href", "/activities");
});
