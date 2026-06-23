import { render, screen, waitFor } from "@testing-library/react";
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
