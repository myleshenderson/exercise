import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import History from "./History";

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/history/:exerciseId" element={<History />} />
      </Routes>
    </MemoryRouter>,
  );
}

test("renders one bar per logged set for the exercise", async () => {
  renderAt("/history/leg-press");
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getAllByLabelText(/^set \d+ volume /).length).toBe(3);
});

test("shows an empty state for an exercise with no logged sets", async () => {
  renderAt("/history/lateral-raise");
  await waitFor(() => expect(screen.getByText("Lateral Raise")).toBeInTheDocument());
  expect(screen.getByText(/no sets logged yet/i)).toBeInTheDocument();
});
