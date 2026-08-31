import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Summary from "./Summary";

test("shows the day name, logged exercises, and total volume", async () => {
  render(
    <MemoryRouter initialEntries={["/session/seed-leg/summary"]}>
      <Routes>
        <Route path="/session/:id/summary" element={<Summary />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day complete ✓")).toBeInTheDocument());
  expect(screen.getByText("Leg Press")).toBeInTheDocument();
  expect(screen.getByText(/Total volume:/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
});

test("Done returns home when there is no origin state", async () => {
  render(
    <MemoryRouter initialEntries={["/session/seed-leg/summary"]}>
      <Routes>
        <Route path="/session/:id/summary" element={<Summary />} />
        <Route path="/" element={<div>Home screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day complete ✓")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /done/i }));
  await waitFor(() => expect(screen.getByText("Home screen")).toBeInTheDocument());
});

test("Done returns to the origin screen when arrived with a 'from' location state", async () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/session/seed-leg/summary", state: { from: "/workouts" } }]}>
      <Routes>
        <Route path="/session/:id/summary" element={<Summary />} />
        <Route path="/workouts" element={<div>Workouts screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Day complete ✓")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /done/i }));
  await waitFor(() => expect(screen.getByText("Workouts screen")).toBeInTheDocument());
});
