import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createMockDataLayer } from "../../data/mock";
import type { DataLayer } from "../../data/DataLayer";
import { formatDistance } from "../../metrics/units";
import { periodTotals, visibleActivities } from "../../metrics/display";
import type { ExternalActivity, Session } from "../../types";
import { RideDbProvider } from "../RideDb";
import { RIDE_FIXTURE_IDS, buildRideFixtures, createRideFixtureDb, type RideFixtures } from "../testing/fixtures";
import MyStats from "./MyStats";

// Wednesday 2026-11-11, noon in New York (the fixtures' zone) and the same date in UTC.
const NOW = new Date("2026-11-11T17:00:00.000Z");
const DAY_MS = 86_400_000;

const BEST_EFFORT_ROWS = [
  "Longest ride",
  "Biggest climb",
  "Most elevation",
  "5 mile",
  "10K",
  "10 mile",
  "20K",
  "30K",
  "40K",
  "50K",
  "80K",
  "50 mile",
  "90K",
  "100K",
  "100 mile",
];

function renderStats(db: DataLayer, route = "/stats") {
  return render(
    <RideDbProvider db={db}>
      <MemoryRouter initialEntries={[route]}>
        <MyStats now={NOW} />
      </MemoryRouter>
    </RideDbProvider>,
  );
}

async function ready(name: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`[data-ready="${name}"]`)).not.toBeNull());
  return document.querySelector(`[data-ready="${name}"]`) as HTMLElement;
}

function dbWith(over: Partial<RideFixtures>): DataLayer {
  return createMockDataLayer({ rides: { ...buildRideFixtures(NOW), ...over } });
}

/** A ride cloned from the fixtures' estimated outdoor ride, with overrides. */
function ride(over: Partial<ExternalActivity> & Pick<ExternalActivity, "id">): ExternalActivity {
  const template = buildRideFixtures(NOW).activities.find((a) => a.id === RIDE_FIXTURE_IDS.estimated)!;
  return { ...template, sourceId: `src-${over.id}`, pairedActivityId: null, ...over };
}

const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS).toISOString();

test("header links and the Cycling tab is the default", async () => {
  renderStats(createRideFixtureDb(NOW));
  await ready("stats-cycling");
  expect(screen.getByRole("heading", { name: "My Stats" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  expect(screen.getByRole("link", { name: "Training" })).toHaveAttribute("href", "/training");
  expect(screen.getByRole("link", { name: "Power" })).toHaveAttribute("href", "/power");
  expect(screen.getByRole("tab", { name: "Cycling" })).toHaveAttribute("aria-selected", "true");
});

test("best efforts: the 15 rows in order, each record links to its ride, an indoor ride never holds one", async () => {
  const fx = buildRideFixtures(NOW);
  const monster = ride({
    id: "ride-indoor-monster",
    source: "peloton",
    environment: "indoor",
    startedAt: daysAgo(2),
    distanceM: 500_000,
    elevationGainM: 9_000,
    biggestClimbM: 3_000,
    bestEfforts: (fx.activities.find((a) => a.id === RIDE_FIXTURE_IDS.outdoor)!.bestEfforts as { label: string; distanceM: number }[]).map((e) => ({ ...e, seconds: 1 })),
  });
  renderStats(dbWith({ activities: [...fx.activities, monster] }));
  await ready("stats-cycling");
  const section = screen.getByRole("region", { name: "Best efforts" });
  const rows = section.querySelectorAll("tr[data-record]");
  expect([...rows].map((r) => r.getAttribute("data-record"))).toEqual(BEST_EFFORT_ROWS);
  for (const link of within(section).getAllByRole("link")) {
    expect(link.getAttribute("href")).toMatch(/^\/activities\/ride-outdoor-/);
  }
  expect(section.querySelector('a[href="/activities/ride-indoor-monster"]')).toBeNull();
  // The 5 mile time is a clock duration.
  expect(within(section.querySelector('tr[data-record="5 mile"]') as HTMLElement).getByRole("link").textContent).toMatch(/^\d+:\d\d$/);
});

test("a best-effort row with no record shows the empty mark", async () => {
  renderStats(dbWith({ activities: [ride({ id: "ride-short", startedAt: daysAgo(1), distanceM: 9_000, bestEfforts: [{ label: "5 mile", distanceM: 8046.72, seconds: 900 }] })] }));
  await ready("stats-cycling");
  const section = screen.getByRole("region", { name: "Best efforts" });
  expect(within(section.querySelector('tr[data-record="5 mile"]') as HTMLElement).getByRole("link")).toHaveTextContent("15:00");
  expect(section.querySelector('tr[data-record="100 mile"] td')).toHaveTextContent("—");
});

test("year to date and all-time show the indoor distance on a sub-line", async () => {
  const fx = buildRideFixtures(NOW);
  renderStats(createRideFixtureDb(NOW));
  await ready("stats-cycling");
  const all = periodTotals(visibleActivities(fx.activities));
  expect(all.indoorDistanceM).toBeGreaterThan(0);
  const allTime = screen.getByRole("region", { name: "All-time" });
  expect(within(allTime).getByText(formatDistance(all.distanceM, "imperial"))).toBeInTheDocument();
  expect(within(allTime).getByText(`incl. ${formatDistance(all.indoorDistanceM, "imperial")} indoor`)).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Year to date" })).getByText(/^incl\. .* mi indoor$/)).toBeInTheDocument();
});

test("last 4 weeks: the 28 days ending today as weekly averages", async () => {
  renderStats(
    dbWith({
      activities: [
        ride({ id: "ride-a", startedAt: daysAgo(1), distanceM: 10_000, elevationGainM: 100, movingS: 3_600 }),
        ride({ id: "ride-b", startedAt: daysAgo(20), distanceM: 30_000, elevationGainM: 300, movingS: 7_200 }),
        ride({ id: "ride-old", startedAt: daysAgo(40), distanceM: 99_000, elevationGainM: 900, movingS: 9_000 }),
      ],
    }),
  );
  await ready("stats-cycling");
  const card = within(screen.getByRole("region", { name: "Last 4 weeks" }));
  expect(card.getByText("0.5")).toBeInTheDocument(); // 2 rides / 4
  expect(card.getByText("6.2 mi")).toBeInTheDocument(); // 40 km / 4
  expect(card.getByText("328 ft")).toBeInTheDocument(); // 400 m / 4
  expect(card.getByText("45m")).toBeInTheDocument(); // 3 h / 4
});

test("power bests strip: 5 durations from all rides, indoor included, linking to the ride", async () => {
  renderStats(
    dbWith({
      activities: [
        ride({ id: "ride-out", startedAt: daysAgo(1), environment: "outdoor", powerCurve: { "5": 800, "60": 400, "300": 300 } }),
        ride({ id: "ride-in", source: "peloton", environment: "indoor", startedAt: daysAgo(2), powerCurve: { "5": 950, "60": 380, "1200": 260 } }),
      ],
    }),
  );
  await ready("stats-cycling");
  const strip = screen.getByRole("region", { name: "Power bests" });
  const items = [...strip.querySelectorAll("li[data-power]")];
  expect(items.map((li) => li.getAttribute("data-power"))).toEqual(["5 s", "1 min", "5 min", "20 min", "1 h"]);
  expect(within(items[0] as HTMLElement).getByRole("link", { name: "950 W" })).toHaveAttribute("href", "/activities/ride-in");
  expect(within(items[1] as HTMLElement).getByRole("link", { name: "400 W" })).toHaveAttribute("href", "/activities/ride-out");
  expect(within(items[3] as HTMLElement).getByRole("link", { name: "260 W" })).toHaveAttribute("href", "/activities/ride-in");
  expect(items[4]).toHaveTextContent("—");
});

test("weight card shows latest, 7-day average and 4-week change, and links to /weight", async () => {
  renderStats(createRideFixtureDb(NOW));
  await ready("stats-cycling");
  const card = screen.getByTestId("weight-card");
  expect(card).toHaveAttribute("href", "/weight");
  expect(within(card).getByText("Latest")).toBeInTheDocument();
  expect(within(card).getByText("7-day average")).toBeInTheDocument();
  // The fixtures drift down ~1.7 kg over 120 days, so the 4-week change is a loss.
  expect(within(card).getByText(/^−\d+\.\d lb$/)).toBeInTheDocument();
});

test("weight card is hidden without weigh-ins", async () => {
  renderStats(dbWith({ bodyWeights: [] }));
  await ready("stats-cycling");
  expect(screen.queryByTestId("weight-card")).toBeNull();
});

test("an empty account shows the EmptyState", async () => {
  renderStats(createMockDataLayer({ seed: false }));
  await ready("stats-cycling");
  expect(screen.getByText(/No rides yet/)).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Best efforts" })).toBeNull();
  expect(screen.queryByTestId("weight-card")).toBeNull();
});

function session(id: string, performedOn: string, sets: [number, number][][]): Session {
  return {
    id,
    workoutDayId: null,
    performedOn,
    exercises: sets.map((s, i) => ({ exerciseId: `ex-${i}`, sets: s.map(([weight, reps], k) => ({ setNumber: k + 1, weight, reps })) })),
  };
}

test("strength tab (?tab=strength): sessions, sets and volume per week and all time", async () => {
  const db = createRideFixtureDb(NOW);
  db.listSessions = async () => [
    // Week of Mon 2026-11-09: 2 sessions, 5 sets, 100×10×2 + 50×12 + 80×8×2 = 3,880 lb
    session("s1", "2026-11-09", [[[100, 10], [100, 10]], [[50, 12]]]),
    session("s2", "2026-11-11", [[[80, 8], [80, 8]]]),
    // Week of Mon 2026-11-02: 1 session, 1 set, 200 lb
    session("s3", "2026-11-08", [[[20, 10]]]),
    // Outside the 12 weeks: counts all-time only.
    session("s4", "2026-01-05", [[[10, 10], [10, 10], [10, 10]]]),
  ];
  renderStats(db, "/stats?tab=strength");
  await ready("stats-strength");
  expect(screen.getByRole("tab", { name: "Strength" })).toHaveAttribute("aria-selected", "true");
  const table = screen.getByRole("table", { name: "Strength per week" });
  const rows = table.querySelectorAll("tbody tr");
  expect(rows).toHaveLength(12);
  const cells = (week: string) => [...table.querySelector(`tr[data-week="${week}"]`)!.querySelectorAll("td")].map((td) => td.textContent);
  expect(cells("2026-11-09")).toEqual(["Nov 9", "2", "5", "3,880 lb"]);
  expect(cells("2026-11-02")).toEqual(["Nov 2", "1", "1", "200 lb"]);
  expect(table.querySelector('tr[data-week="2026-08-24"]')).not.toBeNull(); // oldest of the 12
  const allTime = within(screen.getByRole("region", { name: "All-time" }));
  expect(allTime.getByText("4")).toBeInTheDocument();
  expect(allTime.getByText("9")).toBeInTheDocument();
  expect(allTime.getByText("4,380 lb")).toBeInTheDocument();
  const chart = screen.getByRole("img", { name: "Strength volume per week, lb" });
  expect(chart.querySelectorAll('rect[data-series="Volume (lb)"]')).toHaveLength(2);
});

test("switching tabs sets data-ready from the active tab", async () => {
  renderStats(createRideFixtureDb(NOW));
  await ready("stats-cycling");
  fireEvent.click(screen.getByRole("tab", { name: "Strength" }));
  await ready("stats-strength");
  expect(document.querySelector('[data-ready="stats-cycling"]')).toBeNull();
});
