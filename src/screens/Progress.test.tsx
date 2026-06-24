import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Progress from "./Progress";
import History from "./History";

test("lists exercises", async () => {
  render(<MemoryRouter><Progress /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  expect(screen.getByText("Chest Press")).toBeInTheDocument();
});

test("tapping an exercise opens its progress chart", async () => {
  render(
    <MemoryRouter initialEntries={["/progress"]}>
      <Routes>
        <Route path="/progress" element={<Progress />} />
        <Route path="/history/:exerciseId" element={<History />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  fireEvent.click(screen.getByText("Leg Press"));
  await waitFor(() => expect(screen.getByText(/volume per set/i)).toBeInTheDocument());
});
