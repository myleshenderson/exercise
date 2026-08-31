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
