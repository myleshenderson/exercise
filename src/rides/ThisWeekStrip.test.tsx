import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createMockDataLayer } from "../data/mock";
import { RideDbProvider } from "./RideDb";
import ThisWeekStrip, { loadThisWeek } from "./ThisWeekStrip";
import { buildRideFixtures, createRideFixtureDb } from "./testing/fixtures";
import { periodTotals, visibleActivities, weekStartOf, localDate } from "../metrics";

const NOW = new Date("2026-11-11T17:00:00Z"); // a Wednesday
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

test("loadThisWeek sums the visible rides, the daily TSS and the latest weigh-in for the week", async () => {
  const fx = buildRideFixtures(NOW);
  const db = createRideFixtureDb(NOW);
  const week = await loadThisWeek(db, NOW);
  const today = localDate(NOW.toISOString(), tz)!;
  const start = weekStartOf(today, "monday");
  expect(week?.weekStart).toBe(start);
  const inWeek = fx.activities.filter((a) => {
    const day = localDate(a.startedAt, a.timezone!)!;
    return day >= start && day <= today && Date.parse(a.startedAt) <= NOW.getTime();
  });
  const expected = periodTotals(visibleActivities(inWeek));
  expect(week?.rides).toBe(expected.count);
  expect(week?.rides).toBeGreaterThan(0);
  expect(week?.movingS).toBe(expected.movingS);
  const tss = fx.dailyLoad.filter((r) => r.date >= start && r.date <= today).reduce((s, r) => s + r.tssTotal, 0);
  expect(week?.tss).toBeCloseTo(tss, 6);
  expect(week?.latestWeightKg).toBe(fx.bodyWeights[fx.bodyWeights.length - 1].weightKg);
  expect(week?.units).toBe("imperial");
});

test("an activity counts in the week of its own local date, like its TSS", async () => {
  const db = createMockDataLayer();
  // Monday 2026-11-09 02:00 UTC is Sunday 22:00 in New York: last week for a Monday week start.
  const base = { source: "garmin" as const, sport: "cycling", environment: "outdoor" as const, movingS: 3600, providerPayload: {} };
  await db.upsertExternalActivities([
    { ...base, sourceId: "sun-ny", startedAt: "2026-11-09T02:00:00Z", timezone: "America/New_York" },
    { ...base, sourceId: "mon-ny", startedAt: "2026-11-09T15:00:00Z", timezone: "America/New_York" },
  ]);
  const week = await loadThisWeek(db, new Date("2026-11-11T12:00:00Z"));
  expect(week?.weekStart).toBe(weekStartOf(localDate("2026-11-11T12:00:00Z", tz)!, "monday"));
  if (week?.weekStart === "2026-11-09") expect(week.rides).toBe(1);
});

test("loadThisWeek follows settings.weekStart", async () => {
  const db = createRideFixtureDb(NOW);
  await db.saveAthleteSettings({ weekStart: "sunday" });
  const today = localDate(NOW.toISOString(), tz)!;
  expect((await loadThisWeek(db, NOW))?.weekStart).toBe(weekStartOf(today, "sunday"));
});

test("loadThisWeek is null without activities or weigh-ins, and shown with only an old weigh-in", async () => {
  const db = createMockDataLayer();
  expect(await loadThisWeek(db, NOW)).toBeNull();
  await db.upsertBodyWeights([{ source: "garmin", sourceId: "w1", measuredAt: "2026-01-01T12:00:00Z", weightKg: 80, providerPayload: {} }]);
  const week = await loadThisWeek(db, NOW);
  expect(week).toMatchObject({ rides: 0, movingS: 0, tss: 0, latestWeightKg: null });
});

test("the strip links to /activities and shows the four numbers", async () => {
  const { container } = render(
    <MemoryRouter>
      <RideDbProvider db={createRideFixtureDb(NOW)}>
        <ThisWeekStrip now={NOW} />
      </RideDbProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(container.querySelector('[data-ready="home-strip"]')).not.toBeNull());
  const link = screen.getByRole("link", { name: /This week/ });
  expect(link).toHaveAttribute("href", "/activities");
  expect(link).toHaveTextContent(/Rides\d+/);
  expect(link).toHaveTextContent(/Hours\d+h \d+m|Hours\d+m/);
  expect(link).toHaveTextContent(/lb/);
});

test("the strip renders nothing when a read fails", async () => {
  const db = createMockDataLayer();
  db.listExternalActivities = () => Promise.reject(new Error("offline"));
  const { container } = render(
    <MemoryRouter>
      <RideDbProvider db={db}>
        <ThisWeekStrip now={NOW} />
      </RideDbProvider>
    </MemoryRouter>,
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(container).toBeEmptyDOMElement();
});
