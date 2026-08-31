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

  fireEvent.click(screen.getByText("Leg Day"));
  await waitFor(() => expect(lookupSpy).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByText("Leg Day"));
  await waitFor(() => expect(lookupSpy).toHaveBeenCalledTimes(2));

  expect(startSpy).toHaveBeenCalledTimes(1);
  startSpy.mockRestore();
  lookupSpy.mockRestore();
});
