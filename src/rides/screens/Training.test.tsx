import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createMockDataLayer } from "../../data/mock";
import type { DataLayer } from "../../data/DataLayer";
import { dateFromDayNumber, dayNumber } from "../../metrics/dates";
import type { ActivityStream, DailyTrainingLoad } from "../../types";
import { RideDbProvider } from "../RideDb";
import { buildRideFixtures, createRideFixtureDb } from "../testing/fixtures";
import Training from "./Training";

// Wednesday 2026-11-11, noon in New York (the fixtures' zone) and the same date in UTC.
const NOW = new Date("2026-11-11T17:00:00.000Z");
const TODAY = "2026-11-11";

function renderTraining(db: DataLayer) {
  return render(
    <RideDbProvider db={db}>
      <MemoryRouter initialEntries={["/training"]}>
        <Training now={NOW} />
      </MemoryRouter>
    </RideDbProvider>,
  );
}

async function ready() {
  await waitFor(() => expect(document.querySelector('[data-ready="training"]')).not.toBeNull());
}

const shift = (date: string, days: number) => dateFromDayNumber(dayNumber(date)! + days);

/** 85 days of load ending `last`, CTL rising 1 a day from 0, ATL = CTL + 15 (TSB −15). */
function loadRows(last: string, bySource: DailyTrainingLoad["tssBySource"] = { garmin: 40 }): DailyTrainingLoad[] {
  return Array.from({ length: 85 }, (_, i) => {
    const ctl = i * 0.75;
    const tssTotal = Object.values(bySource).reduce((s, v) => s + (v ?? 0), 0);
    return { date: shift(last, i - 84), tssTotal, tssBySource: bySource, ctl, atl: ctl + 15, tsb: -15 };
  });
}

function dbWithLoad(rows: DailyTrainingLoad[]): DataLayer {
  return createMockDataLayer({ rides: { ...buildRideFixtures(NOW), dailyLoad: rows } });
}

test("today's TSB and band, and the ramp rate with its caption", async () => {
  renderTraining(dbWithLoad(loadRows(TODAY)));
  await ready();
  const form = screen.getByTestId("form-readout");
  expect(form).toHaveTextContent("Today: −15.0 Productive");
  expect(form).toHaveAttribute("data-band", "productive");
  expect(screen.getByTestId("ramp-rate")).toHaveTextContent("+5.3 CTL/week"); // 7 × 0.75
  expect(screen.getByText("+4 to +8 a week is a steady build")).toBeInTheDocument();
  const bands = screen.getByRole("img", { name: /Form \(TSB\)/ }).querySelectorAll("g[data-band]");
  expect([...bands].map((b) => b.getAttribute("data-band"))).toEqual(["Overreaching", "Productive", "Grey zone", "Fresh", "Transition"]);
});

test("without a row for today the readout shows the latest earlier row, labelled with its date", async () => {
  const rows = loadRows("2026-11-09").map((r) => ({ ...r, ctl: 50, atl: 30, tsb: 20 }));
  renderTraining(dbWithLoad(rows));
  await ready();
  expect(screen.getByTestId("form-readout")).toHaveTextContent("On Nov 9: +20.0 Fresh");
  expect(screen.getByTestId("ramp-rate")).toHaveTextContent("—");
});

test("weekly TSS stacks by stored source over 12 weeks", async () => {
  renderTraining(dbWithLoad(loadRows(TODAY, { garmin: 40, strength: 50 })));
  await ready();
  const chart = screen.getByRole("img", { name: /Weekly TSS by source/ });
  expect(chart.querySelectorAll("g[data-category]")).toHaveLength(12);
  const current = chart.querySelectorAll("g[data-category]")[11];
  expect(current.getAttribute("data-category")).toBe("Nov 9");
  // Mon 9 → Wed 11: 3 days.
  expect(current.querySelector('rect[data-series="Garmin"] title')).toHaveTextContent("Nov 9 · Garmin: 120");
  expect(current.querySelector('rect[data-series="Strength"] title')).toHaveTextContent("Nov 9 · Strength: 150");
  expect(chart.querySelector('rect[data-series="Peloton"]')).toBeNull();
  const legend = within(screen.getByRole("region", { name: "Weekly TSS" }));
  expect(legend.getByText("Garmin")).toBeInTheDocument();
  expect(legend.getByText("Strength")).toBeInTheDocument();
});

test("fitness and fatigue lines", async () => {
  renderTraining(createRideFixtureDb(NOW));
  await ready();
  const chart = screen.getByRole("img", { name: /Fitness \(CTL\) and fatigue/ });
  expect(chart.querySelector('path[data-series="Fitness (CTL)"]')?.getAttribute("d")).toMatch(/^M/);
  expect(chart.querySelector('path[data-series="Fatigue (ATL)"]')?.getAttribute("d")).toMatch(/^M/);
});

test("time in power zone: one 100% bar per week from streams, rides without power as No power", async () => {
  const db = createRideFixtureDb(NOW);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = db.getActivityStreams.bind(db);
  const asked: string[] = [];
  db.getActivityStreams = async (id: string): Promise<ActivityStream[]> => {
    asked.push(id);
    await gate;
    return original(id);
  };
  renderTraining(db);
  // The rest of the page renders before the streams are in; data-ready waits for them.
  await screen.findByRole("img", { name: /Weekly TSS by source/ });
  expect(screen.getByText("Loading ride streams…")).toBeInTheDocument();
  expect(document.querySelector('[data-ready="training"]')).toBeNull();
  release();
  await ready();

  expect(asked).toContain("ride-outdoor-1");
  expect(asked).toContain("ride-indoor-1");
  expect(asked).not.toContain("ride-outdoor-estimated-1"); // no power: no stream fetch
  const chart = screen.getByRole("img", { name: /power zone per week/ });
  const weeks = chart.querySelectorAll("g[data-category]");
  expect(weeks).toHaveLength(6);
  const current = weeks[5];
  // This week holds the streamed outdoor ride (today) and Peloton class (yesterday).
  expect(current.querySelector('rect[data-series="Z2 Endurance"]')).not.toBeNull();
  // The estimated ride (Sun Nov 8) has no power: grey "No power" in the week of Nov 2.
  const lastWeek = weeks[4];
  expect(lastWeek.getAttribute("data-category")).toBe("Nov 2");
  expect(lastWeek.querySelector('rect[data-series="No power"]')).not.toBeNull();
  // Each bar sums to 100%.
  for (const week of weeks) {
    const pct = [...week.querySelectorAll("rect title")].reduce((s, t) => s + Number(/: (\d+)%$/.exec(t.textContent ?? "")?.[1] ?? 0), 0);
    if (week.querySelectorAll("rect").length) expect(pct).toBeGreaterThanOrEqual(97);
  }
});

test("an empty account shows the EmptyState", async () => {
  renderTraining(createMockDataLayer({ seed: false }));
  await ready();
  expect(screen.getByText(/No rides yet/)).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: /Weekly TSS/ })).toBeNull();
});

test("a ride whose streams fail to load counts as No power instead of blanking the chart", async () => {
  const db = createRideFixtureDb(NOW);
  db.getActivityStreams = () => Promise.reject(new Error("offline"));
  renderTraining(db);
  await ready();
  const chart = screen.getByRole("img", { name: /power zone per week/ });
  const current = chart.querySelectorAll("g[data-category]")[5];
  expect(current.querySelector('rect[data-series="No power"]')).not.toBeNull();
  expect(current.querySelector('rect[data-series="Z2 Endurance"]')).toBeNull();
});
