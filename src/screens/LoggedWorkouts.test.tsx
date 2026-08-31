import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { db } from "../data";
import LoggedWorkouts from "./LoggedWorkouts";
import Summary from "./Summary";

// NOTE: the mocked `db` module is a singleton shared across every test in this
// file, so these tests are order-dependent and must not be reordered:
// - the "no empty sessions" check must run before any empty session exists
// - the per-row destructive delete targets the 2026-07-01 blank session
// - the bulk-delete tests create their own fixtures afterward

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/workouts"]}>
      <Routes>
        <Route path="/workouts" element={<LoggedWorkouts />} />
        <Route path="/session/:id/summary" element={<Summary />} />
      </Routes>
    </MemoryRouter>,
  );
}

test("hides the bulk delete-empty action when there are no empty sessions", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /delete all empty sessions/i })).not.toBeInTheDocument();
});

test("lists sessions newest first, showing date and day name", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  const rows = screen.getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("Saturday, Jun 20");
  expect(rows[0]).toHaveTextContent("Upper Day");
  expect(rows[1]).toHaveTextContent("Thursday, Jun 18");
  expect(rows[1]).toHaveTextContent("Leg Day");
});

test("shows 'Blank session' for a session with no workout day", async () => {
  await db.startSession(null, "2026-07-01");
  renderScreen();
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
  const row = screen.getAllByRole("listitem")[0];
  expect(row).toHaveTextContent("Wednesday, Jul 1");
  expect(row).toHaveTextContent("Blank session");
});

test("Detail button navigates to the session summary view", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getByText("Wednesday, Jul 1")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /detail for session on wednesday, jul 1/i }));
  await waitFor(() => expect(screen.getByText("Workout complete ✓")).toBeInTheDocument());
});

test("Done on the summary view returns to the workouts list when arrived from there", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getByText("Wednesday, Jul 1")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /detail for session on wednesday, jul 1/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /done/i }));
  await waitFor(() => expect(screen.getByText("Logged Workouts")).toBeInTheDocument());
});

test("first tap of per-row Delete shows Confirm/Cancel and does not delete", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getByText("Wednesday, Jul 1")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^delete session on wednesday, jul 1$/i }));
  expect(screen.getByText("Wednesday, Jul 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^confirm delete session on wednesday, jul 1$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^cancel delete session on wednesday, jul 1$/i })).toBeInTheDocument();
});

test("cancel keeps the session and restores the Delete button", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getByText("Wednesday, Jul 1")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^delete session on wednesday, jul 1$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^cancel delete session on wednesday, jul 1$/i }));
  expect(screen.getByText("Wednesday, Jul 1")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^confirm delete session on wednesday, jul 1$/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^delete session on wednesday, jul 1$/i })).toBeInTheDocument();
});

test("confirming per-row delete removes only that session synchronously, before deleteSession resolves", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getByText("Wednesday, Jul 1")).toBeInTheDocument());

  // Delay the real deleteSession so we can prove the row disappears from local
  // state before this promise settles, not after.
  const originalDeleteSession = db.deleteSession.bind(db);
  let settled = false;
  const spy = vi.spyOn(db, "deleteSession").mockImplementation(
    (id) =>
      new Promise<void>((resolve) =>
        setTimeout(() => originalDeleteSession(id).then(() => { settled = true; resolve(); }), 10),
      ),
  );

  fireEvent.click(screen.getByRole("button", { name: /^delete session on wednesday, jul 1$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm delete session on wednesday, jul 1$/i }));

  // Synchronous assertions: no waitFor, no await — the deleteSession promise
  // above has not resolved yet (it's waiting on a 10ms timer).
  expect(settled).toBe(false);
  expect(screen.queryByText("Wednesday, Jul 1")).not.toBeInTheDocument();
  expect(screen.getByText("Saturday, Jun 20")).toBeInTheDocument();
  expect(screen.getByText("Thursday, Jun 18")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledTimes(1);

  await waitFor(() => expect(settled).toBe(true));
  spy.mockRestore();

  // Reconciliation load() still runs afterward and the row stays gone.
  expect(screen.queryByText("Wednesday, Jul 1")).not.toBeInTheDocument();
});

test("bulk delete-empty action appears once an empty session exists", async () => {
  await db.startSession(null, "2026-07-05");
  renderScreen();
  await waitFor(() => expect(screen.getByText("Sunday, Jul 5")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /^delete all empty sessions$/i })).toBeInTheDocument();
});

test("bulk delete-empty confirm/cancel is independent of per-row confirm state", async () => {
  renderScreen();
  await waitFor(() => expect(screen.getByText("Sunday, Jul 5")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^delete session on saturday, jun 20$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^delete all empty sessions$/i }));
  expect(screen.getByRole("button", { name: /^confirm delete session on saturday, jun 20$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^confirm delete all empty sessions$/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^cancel delete all empty sessions$/i }));
  expect(screen.getByRole("button", { name: /^confirm delete session on saturday, jun 20$/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^confirm delete all empty sessions$/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^cancel delete session on saturday, jun 20$/i }));
});

test("confirming bulk delete removes all matching sessions synchronously, before the deletes resolve", async () => {
  const nonEmpty = await db.startSession("leg-day", "2026-07-06");
  await db.logExercise(nonEmpty.id, "leg-press", [{ setNumber: 1, weight: 100, reps: 10 }]);
  renderScreen();
  await waitFor(() => expect(screen.getByText("Monday, Jul 6")).toBeInTheDocument());

  // Delay the real deleteSession so we can prove the rows disappear from local
  // state before these promises settle, not after.
  const originalDeleteSession = db.deleteSession.bind(db);
  let settledCount = 0;
  const spy = vi.spyOn(db, "deleteSession").mockImplementation(
    (id) =>
      new Promise<void>((resolve) =>
        setTimeout(() => originalDeleteSession(id).then(() => { settledCount++; resolve(); }), 10),
      ),
  );

  fireEvent.click(screen.getByRole("button", { name: /^delete all empty sessions$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm delete all empty sessions$/i }));

  // Synchronous assertions: no waitFor, no await — none of the deleteSession
  // promises above have resolved yet (they're waiting on a 10ms timer).
  expect(settledCount).toBe(0);
  expect(screen.queryByText("Sunday, Jul 5")).not.toBeInTheDocument();
  expect(screen.getByText("Monday, Jul 6")).toBeInTheDocument();
  expect(screen.getByText("Saturday, Jun 20")).toBeInTheDocument();
  expect(screen.getByText("Thursday, Jun 18")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^delete all empty sessions$/i })).not.toBeInTheDocument();
  expect(spy).toHaveBeenCalledTimes(1);

  await waitFor(() => expect(settledCount).toBe(1));
  spy.mockRestore();

  // Reconciliation load() still runs afterward and the rows stay gone.
  expect(screen.queryByText("Sunday, Jul 5")).not.toBeInTheDocument();
});

test("marks a session with no logged exercises as Empty, but not one with exercises", async () => {
  await db.startSession(null, "2026-07-10");
  renderScreen();
  await waitFor(() => expect(screen.getByText("Friday, Jul 10")).toBeInTheDocument());
  const rows = screen.getAllByRole("listitem");
  const emptyRow = rows.find((r) => r.textContent?.includes("Friday, Jul 10"));
  const nonEmptyRow = rows.find((r) => r.textContent?.includes("Monday, Jul 6"));
  expect(emptyRow).toHaveTextContent("Empty");
  expect(nonEmptyRow).not.toHaveTextContent("Empty");
});
