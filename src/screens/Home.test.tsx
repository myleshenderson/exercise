import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
