import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Session from "./Session";
import Summary from "./Summary";
import { db } from "../data";

async function renderSession() {
  const s = await db.startSession("leg-day", "2026-06-22");
  render(
    <MemoryRouter initialEntries={[`/session/${s.id}`]}>
      <Routes><Route path="/session/:id" element={<Session />} /></Routes>
    </MemoryRouter>,
  );
  return s;
}

test("renders day exercises with last-time numbers", async () => {
  await renderSession();
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getByText("Last: 150 × 3 × 12")).toBeInTheDocument();
});

test("logging an exercise marks it done", async () => {
  await renderSession();
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  const buttons = screen.getAllByRole("button", { name: /log/i });
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(screen.getAllByLabelText("logged").length).toBeGreaterThan(0));
});

test("Finish workout navigates to the summary", async () => {
  const s = await db.startSession("leg-day", "2026-06-22");
  render(
    <MemoryRouter initialEntries={[`/session/${s.id}`]}>
      <Routes>
        <Route path="/session/:id" element={<Session />} />
        <Route path="/session/:id/summary" element={<Summary />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /finish workout/i }));
  await waitFor(() => expect(screen.getByText(/complete ✓/)).toBeInTheDocument());
});

test("loads last time's weight as the editor default (even when last-sets load slowly)", async () => {
  // Force a delay so React renders once before lastByEx arrives — this reproduces
  // the race the synchronous mock would otherwise hide.
  const spy = vi.spyOn(db, "getLastSetsForExercise").mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve([
              { setNumber: 1, weight: 150, reps: 12 },
              { setNumber: 2, weight: 150, reps: 12 },
              { setNumber: 3, weight: 150, reps: 12 },
            ]),
          10,
        ),
      ),
  );
  const s = await db.startSession("leg-day", "2026-06-22");
  render(
    <MemoryRouter initialEntries={[`/session/${s.id}`]}>
      <Routes>
        <Route path="/session/:id" element={<Session />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getAllByLabelText("weight")[0]).toHaveValue("150");
  spy.mockRestore();
});

test("completed exercises load with their logged values", async () => {
  const s = await db.startSession("leg-day", "2026-06-22");
  await db.logExercise(s.id, "leg-press", [
    { setNumber: 1, weight: 160, reps: 10 },
    { setNumber: 2, weight: 160, reps: 10 },
    { setNumber: 3, weight: 160, reps: 10 },
  ]);
  render(
    <MemoryRouter initialEntries={[`/session/${s.id}`]}>
      <Routes>
        <Route path="/session/:id" element={<Session />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  // Logged → collapsed summary shows the logged values, not the defaults.
  expect(screen.getByText("160 × 3 × 10")).toBeInTheDocument();
});

test("a session for a day with a defined progressive scheme starts pre-filled per-set with the scheme's values", async () => {
  await db.setDayExerciseTarget("leg-day", "leg-press", [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
    { setNumber: 3, weight: 275, reps: 3 },
  ]);
  await renderSession();
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getByLabelText("set 3 weight")).toHaveValue("275");
  expect(screen.getByLabelText("set 3 reps")).toHaveValue("3");
  await db.setDayExerciseTarget("leg-day", "leg-press", null); // don't leak into other tests
});
