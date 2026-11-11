import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createMockDataLayer } from "../../data/mock";
import type { DataLayer } from "../../data/DataLayer";
import { formatDuration, periodTotals, visibleActivities } from "../../metrics/display";
import { RideDbProvider } from "../RideDb";
import { RIDE_FIXTURE_IDS, buildRideFixtures, createRideFixtureDb } from "../testing/fixtures";
import ActivitiesFeed from "./ActivitiesFeed";

// Wednesday 2026-11-11, noon in New York (the fixtures' zone). The current week starts Monday Nov 9.
const NOW = new Date("2026-11-11T17:00:00.000Z");

function renderFeed(db: DataLayer) {
  return render(
    <RideDbProvider db={db}>
      <MemoryRouter initialEntries={["/activities"]}>
        <ActivitiesFeed now={NOW} />
      </MemoryRouter>
    </RideDbProvider>,
  );
}

async function ready() {
  await waitFor(() => expect(document.querySelector('[data-ready="activities"]')).not.toBeNull());
}

const row = (id: string) => document.querySelector(`[data-activity-id="${id}"]`);

/** The fixture db plus a Leg Day strength session on Tuesday Nov 10 (2 exercises, 5 sets). */
async function dbWithStrength(): Promise<{ db: DataLayer; sessionId: string }> {
  const db = createRideFixtureDb(NOW);
  const s = await db.startSession("leg-day", "2026-11-10");
  await db.logExercise(s.id, "leg-press", [
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 150, reps: 12 },
    { setNumber: 3, weight: 150, reps: 12 },
  ]);
  await db.logExercise(s.id, "leg-curl", [
    { setNumber: 1, weight: 105, reps: 10 },
    { setNumber: 2, weight: 105, reps: 10 },
  ]);
  return { db, sessionId: s.id };
}

test("hides the Garmin fragment and shows a Garmin+Peloton pair once, as the Peloton row with the note", async () => {
  renderFeed(createRideFixtureDb(NOW));
  await ready();
  expect(row(RIDE_FIXTURE_IDS.fragment)).toBeNull();
  expect(row(RIDE_FIXTURE_IDS.pairedGarmin)).toBeNull();
  const pair = row(RIDE_FIXTURE_IDS.indoor) as HTMLElement;
  expect(pair).not.toBeNull();
  expect(document.querySelectorAll(`[data-activity-id="${RIDE_FIXTURE_IDS.indoor}"]`)).toHaveLength(1);
  expect(pair).toHaveAttribute("href", `/activities/${RIDE_FIXTURE_IDS.indoor}`);
  expect(within(pair).getByText("Peloton")).toBeInTheDocument();
  expect(within(pair).getByText("HR and elevation from Garmin")).toBeInTheDocument();
  expect(within(pair).getByText("45 min Power Zone Ride")).toBeInTheDocument();
  expect(screen.getAllByText("HR and elevation from Garmin")).toHaveLength(1);
});

test("an outdoor row shows its local date and time, distance, moving time and elevation", async () => {
  renderFeed(createRideFixtureDb(NOW));
  await ready();
  const outdoor = row(RIDE_FIXTURE_IDS.outdoor) as HTMLElement;
  // Started 14:00Z, 09:00 in New York.
  expect(outdoor).toHaveTextContent("Wed, Nov 11, 2026 · 09:00");
  expect(within(outdoor).getByText("Garmin")).toBeInTheDocument();
  expect(outdoor).toHaveTextContent(/\d+\.\d mi · 2h 0m · [\d,]+ ft/);
  const indoor = row(RIDE_FIXTURE_IDS.indoor) as HTMLElement;
  expect(indoor).toHaveTextContent(/45m · [\d,]+ kJ · \d+ W/);
});

test("the estimated-TSS ride carries the estimated chip", async () => {
  renderFeed(createRideFixtureDb(NOW));
  await ready();
  const est = row(RIDE_FIXTURE_IDS.estimated) as HTMLElement;
  expect(within(est).getByText(/TSS est\./)).toHaveAttribute("data-estimated", "true");
  const power = row(RIDE_FIXTURE_IDS.outdoor) as HTMLElement;
  expect(within(power).getByText(/TSS$/)).toHaveAttribute("data-estimated", "false");
});

test("a strength session is one row with the day name, exercises and sets, fixed TSS and the summary link", async () => {
  const { db, sessionId } = await dbWithStrength();
  renderFeed(db);
  await ready();
  const s = document.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement;
  expect(s).toHaveAttribute("href", `/session/${sessionId}/summary`);
  expect(within(s).getByText("Leg Day")).toBeInTheDocument();
  expect(within(s).getByText("Strength")).toBeInTheDocument();
  expect(s).toHaveTextContent("2 exercises · 5 sets");
  expect(s).toHaveTextContent("Tue, Nov 10, 2026");
  expect(within(s).getByText("50 TSS")).toBeInTheDocument();
});

test("a session without a workout day is titled Strength", async () => {
  const db = createRideFixtureDb(NOW);
  const s = await db.startSession(null, "2026-11-10");
  await db.logExercise(s.id, "leg-press", [{ setNumber: 1, weight: 150, reps: 12 }]);
  renderFeed(db);
  await ready();
  const el = document.querySelector(`[data-session-id="${s.id}"]`) as HTMLElement;
  expect(within(el).getAllByText("Strength")).toHaveLength(2); // badge and title
  expect(el).toHaveTextContent("1 exercise · 1 set");
});

test("sport chips filter rows in memory", async () => {
  const { db, sessionId } = await dbWithStrength();
  renderFeed(db);
  await ready();
  const strength = () => document.querySelector(`[data-session-id="${sessionId}"]`);
  fireEvent.click(screen.getByRole("tab", { name: "Outdoor" }));
  expect(row(RIDE_FIXTURE_IDS.outdoor)).not.toBeNull();
  expect(row(RIDE_FIXTURE_IDS.indoor)).toBeNull();
  expect(strength()).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Indoor" }));
  expect(row(RIDE_FIXTURE_IDS.outdoor)).toBeNull();
  expect(row(RIDE_FIXTURE_IDS.indoor)).not.toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Strength" }));
  expect(document.querySelectorAll("[data-activity-id]")).toHaveLength(0);
  expect(strength()).not.toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Rides" }));
  expect(row(RIDE_FIXTURE_IDS.outdoor)).not.toBeNull();
  expect(row(RIDE_FIXTURE_IDS.indoor)).not.toBeNull();
  expect(strength()).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "All" }));
  expect(strength()).not.toBeNull();
  expect(row(RIDE_FIXTURE_IDS.outdoor)).not.toBeNull();
});

test("week headers total rides, hours, TSS (strength included) and kJ for the week", async () => {
  const { db } = await dbWithStrength();
  renderFeed(db);
  await ready();
  const week = document.querySelector('[data-week="2026-11-09"]') as HTMLElement;
  expect(within(week).getByText("Week of Nov 9")).toBeInTheDocument();
  const fx = buildRideFixtures(NOW);
  const rides = visibleActivities(fx.activities).filter((a) => [RIDE_FIXTURE_IDS.outdoor, RIDE_FIXTURE_IDS.indoor].includes(a.id as never));
  const t = periodTotals(rides);
  expect(t.count).toBe(2);
  expect(within(week).getByTestId("week-totals")).toHaveTextContent(
    `2 rides · ${formatDuration(t.movingS)} · ${Math.round(t.tss + 50)} TSS · ${Math.round(t.workKj).toLocaleString("en-US")} kJ · 1 strength`,
  );
  // Weeks are newest first; the previous week holds the estimated ride (Sun Nov 8).
  const weeks = [...document.querySelectorAll("[data-week]")].map((w) => w.getAttribute("data-week"));
  expect(weeks[0]).toBe("2026-11-09");
  expect(weeks[1]).toBe("2026-11-02");
  expect(document.querySelector('[data-week="2026-11-02"]')!.querySelector(`[data-activity-id="${RIDE_FIXTURE_IDS.estimated}"]`)).not.toBeNull();
});

test("loads 12 weeks first and Load earlier extends the window by 12 weeks", async () => {
  renderFeed(createRideFixtureDb(NOW));
  await ready();
  const weeks = () => [...document.querySelectorAll("[data-week]")].map((w) => w.getAttribute("data-week")!);
  expect(weeks().length).toBeLessThanOrEqual(12);
  expect(weeks()[weeks().length - 1] >= "2026-08-24").toBe(true); // Monday 11 weeks before Nov 9
  const before = document.querySelectorAll("[data-activity-id]").length;
  fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
  await waitFor(() => expect(document.querySelectorAll("[data-activity-id]").length).toBeGreaterThan(before));
  expect(weeks()[weeks().length - 1] < "2026-08-24").toBe(true);
  // 24 weeks reach June: the seed's two strength sessions appear and nothing is older.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument());
  expect(document.querySelectorAll("[data-session-id]")).toHaveLength(2);
});

test("an empty account shows the empty state", async () => {
  renderFeed(createMockDataLayer({ seed: false }));
  await ready();
  expect(screen.getByText(/No rides yet/)).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "All" })).not.toBeInTheDocument();
});

test("Load earlier is hidden when only hidden Garmin fragments are older than the window", async () => {
  const fx = buildRideFixtures(NOW);
  const fragment = fx.activities.find((a) => a.id === RIDE_FIXTURE_IDS.fragment)!;
  const recent = fx.activities.filter((a) => a.startedAt >= "2026-08-25");
  const oldFragment = { ...fragment, id: "old-fragment", sourceId: "src-old-fragment", startedAt: "2026-06-01T12:00:00.000Z" };
  renderFeed(createMockDataLayer({ seed: false, rides: { ...fx, activities: [...recent, oldFragment] } }));
  await ready();
  expect(row(RIDE_FIXTURE_IDS.outdoor)).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Load earlier" })).not.toBeInTheDocument();
});
