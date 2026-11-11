import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";

test("renders home route", () => {
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  expect(screen.getAllByText("Home")[0]).toBeInTheDocument();
});

test("/sign-in sends an already-usable app to the Home screen", async () => {
  // The cloud redirects a signed-out browser here; once a session exists (or the
  // backend needs none) the path should not strand the person on an empty shell.
  render(<MemoryRouter initialEntries={["/sign-in"]}><App /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
});
