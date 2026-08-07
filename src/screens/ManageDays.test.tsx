import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ManageDays from "./ManageDays";

test("shows days and their exercises", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  expect(screen.getByText("Leg Press")).toBeInTheDocument();
});

test("first tap of Remove shows Confirm/Cancel and does not delete", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Curl")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^remove leg curl$/i }));
  expect(screen.getByText("Leg Curl")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^confirm remove leg curl$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^cancel remove leg curl$/i })).toBeInTheDocument();
});

test("cancel keeps the exercise and restores the Remove button", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Curl")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^remove leg curl$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^cancel remove leg curl$/i }));
  expect(screen.getByText("Leg Curl")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^confirm remove leg curl$/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^remove leg curl$/i })).toBeInTheDocument();
});

test("confirming removes the exercise", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Press")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^remove leg press$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^confirm remove leg press$/i }));
  await waitFor(() => expect(screen.queryByText("Leg Press")).not.toBeInTheDocument());
});

test("picker excludes exercises already in the day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to leg day$/i }));
  const picker = screen.getByRole("combobox", { name: /exercise picker for leg day/i });
  const options = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
  expect(options).toContain("Bicep Curl");
  expect(options).not.toContain("Leg Curl");
});

test("adding an existing exercise puts it in the day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to leg day$/i }));
  const picker = screen.getByRole("combobox", { name: /exercise picker for leg day/i });
  fireEvent.change(picker, { target: { value: "bicep-curl" } });
  fireEvent.click(screen.getByRole("button", { name: /^add selected exercise to leg day$/i }));
  await waitFor(() => expect(screen.getByText("Bicep Curl")).toBeInTheDocument());
  // section closes after adding
  expect(screen.queryByRole("combobox", { name: /exercise picker for leg day/i })).not.toBeInTheDocument();
});
