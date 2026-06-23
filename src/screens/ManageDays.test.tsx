import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ManageDays from "./ManageDays";

test("shows days and their exercises", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.getByText("Leg Press")).toBeInTheDocument();
});

test("removing an exercise updates the list", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  const removeButtons = screen.getAllByRole("button", { name: /remove leg press/i });
  fireEvent.click(removeButtons[0]);
  await waitFor(() => expect(screen.queryByText("Leg Press")).not.toBeInTheDocument());
});
