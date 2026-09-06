import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { db } from "../data";
import Home from "./Home";

test("lists workout days", async () => {
  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.getByText("Upper Day")).toBeInTheDocument();
});

test("shows when each day was last done", async () => {
  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText("Last done Thursday, Jun 18")).toBeInTheDocument());
  expect(screen.getByText("Last done Saturday, Jun 20")).toBeInTheDocument();
});

test("does not show a blank-session button", async () => {
  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.queryByText(/blank session/i)).not.toBeInTheDocument();
});

test("workout date defaults to today", () => {
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  const todayStr = new Date().toISOString().slice(0, 10);
  expect(screen.getByLabelText(/workout date/i)).toHaveValue(todayStr);
});

test("starts a session on the chosen date", async () => {
  const spy = vi.spyOn(db, "startSession");
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/workout date/i), { target: { value: "2026-05-01" } });
  fireEvent.click(screen.getByText("Leg Day"));
  await waitFor(() => expect(spy).toHaveBeenCalledWith("leg-day", "2026-05-01"));
  spy.mockRestore();
});

test("tapping the same day twice resumes the existing session instead of creating a new one", async () => {
  const startSpy = vi.spyOn(db, "startSession");
  const lookupSpy = vi.spyOn(db, "getSessionForDayAndDate");
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/workout date/i), { target: { value: "2026-05-02" } });
  await waitFor(() => expect(lookupSpy).toHaveBeenCalledWith("leg-day", "2026-05-02"));

  const legDayLookups = () =>
    lookupSpy.mock.calls.filter(([dayId, d]) => dayId === "leg-day" && d === "2026-05-02").length;

  const lookupsBeforeFirstClick = legDayLookups();
  fireEvent.click(screen.getByText("Leg Day"));
  await waitFor(() => expect(legDayLookups()).toBe(lookupsBeforeFirstClick + 1));

  const lookupsBeforeSecondClick = legDayLookups();
  fireEvent.click(screen.getByText("Leg Day"));
  await waitFor(() => expect(legDayLookups()).toBe(lookupsBeforeSecondClick + 1));

  expect(startSpy).toHaveBeenCalledTimes(1);
  startSpy.mockRestore();
  lookupSpy.mockRestore();
});

test("shows an in-progress indicator for a day with an empty session on the selected date", async () => {
  await db.startSession("leg-day", "2026-05-10");
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/workout date/i), { target: { value: "2026-05-10" } });
  await waitFor(() => expect(screen.getByText("In progress — resume")).toBeInTheDocument());
});

test("shows logged-exercise count for a day with a session that has logged exercises on the selected date", async () => {
  const session = await db.startSession("leg-day", "2026-05-11");
  await db.logExercise(session.id, "leg-press", [{ setNumber: 1, weight: 100, reps: 10 }]);
  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/workout date/i), { target: { value: "2026-05-11" } });
  await waitFor(() => expect(screen.getByText("Resume · 1 exercise logged")).toBeInTheDocument());
});

test("ignores a slow lookup for a date the user has already navigated away from", async () => {
  await db.startSession("leg-day", "2026-05-20");
  const original = db.getSessionForDayAndDate.bind(db);
  const lookupSpy = vi.spyOn(db, "getSessionForDayAndDate").mockImplementation(async (dayId, date) => {
    if (date === "2026-05-20") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return original(dayId, date);
  });

  render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());

  const dateInput = screen.getByLabelText(/workout date/i);
  fireEvent.change(dateInput, { target: { value: "2026-05-20" } }); // slow lookup, has a session
  await waitFor(() => expect(lookupSpy).toHaveBeenCalledWith("leg-day", "2026-05-20"));
  fireEvent.change(dateInput, { target: { value: "2026-05-21" } }); // fast lookup, no session

  await waitFor(() => expect(screen.getByText("Last done Thursday, Jun 18")).toBeInTheDocument());
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the slow 2026-05-20 lookups resolve (2 days x 50ms each, sequential)
  expect(screen.getByText("Last done Thursday, Jun 18")).toBeInTheDocument();
  expect(screen.queryByText("In progress — resume")).not.toBeInTheDocument();

  lookupSpy.mockRestore();
});

test("a day with no program renders exactly as before, with no grouping affordance", async () => {
  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.queryByText(/show all/i)).not.toBeInTheDocument();
});

test("a program shows its available day prominently and collapses the rest behind a toggle", async () => {
  const program = await db.createProgram("Prep Phase");
  const d1 = await db.createDay("Prep Week 1");
  const d2 = await db.createDay("Prep Week 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);

  render(<MemoryRouter><Home /></MemoryRouter>);

  await waitFor(() => expect(screen.getByText("Prep Week 1")).toBeInTheDocument());
  expect(screen.queryByText("Prep Week 2")).not.toBeInTheDocument();
  expect(screen.getByText(/show all 2 days in prep phase/i)).toBeInTheDocument();

  fireEvent.click(screen.getByText(/show all 2 days in prep phase/i));
  expect(screen.getByText("Prep Week 2")).toBeInTheDocument();
});

test("the non-suggested day in an expanded program group is still tappable to start a session", async () => {
  // Distinct program/day names from the previous test: this file's mock `db` is a
  // shared singleton that accumulates state across tests (same convention the
  // pre-existing tests in this file already rely on), so reusing "Prep Phase"/
  // "Prep Week 1" here would make screen.getByText match two elements ambiguously.
  const program = await db.createProgram("Push Progression");
  const d1 = await db.createDay("Push Block 1");
  const d2 = await db.createDay("Push Block 2");
  await db.addDayToProgram(d1.id, program.id);
  await db.addDayToProgram(d2.id, program.id);
  const spy = vi.spyOn(db, "startSession");

  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Push Block 1")).toBeInTheDocument());
  fireEvent.click(screen.getByText(/show all 2 days in push progression/i));
  fireEvent.click(screen.getByText("Push Block 2"));

  await waitFor(() => expect(spy).toHaveBeenCalledWith(d2.id, expect.any(String)));
  spy.mockRestore();
});
