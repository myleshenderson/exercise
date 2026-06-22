import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Home from "./Home";

test("lists workout days", async () => {
  render(<MemoryRouter><Home /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.getByText("Upper Day")).toBeInTheDocument();
});
