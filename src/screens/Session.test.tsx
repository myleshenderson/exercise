import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Session from "./Session";
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
  expect(screen.getByText(/Last: 150 × 3 × 12/)).toBeInTheDocument();
});

test("logging an exercise marks it done", async () => {
  await renderSession();
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  const buttons = screen.getAllByRole("button", { name: /log/i });
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(screen.getAllByLabelText("logged").length).toBeGreaterThan(0));
});
