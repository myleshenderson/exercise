import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ManageDays from "./ManageDays";

// NOTE: the mocked `db` module is a singleton shared across every test in this
// file, so these tests are order-dependent and must not be reordered. The
// non-destructive tests use Leg Curl; the destructive removal test uses Leg
// Press; later tests rely on mutations made by earlier ones.

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
  // wait for the section to close, since the picker's own option would
  // otherwise satisfy a "Bicep Curl" text match before the add completes
  await waitFor(() => expect(screen.queryByRole("combobox", { name: /exercise picker for leg day/i })).not.toBeInTheDocument());
  expect(screen.getByText("Bicep Curl")).toBeInTheDocument();
});

test("creating a new exercise adds it to the day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to upper day$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^create new exercise for upper day$/i }));
  fireEvent.change(screen.getByRole("textbox", { name: /new exercise name/i }), { target: { value: "Face Pull" } });
  fireEvent.click(screen.getByRole("button", { name: /^create and add to upper day$/i }));
  await waitFor(() => expect(screen.getByText("Face Pull")).toBeInTheDocument());
});

test("create button is disabled until the name is filled in", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add exercise to upper day$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^create new exercise for upper day$/i }));
  expect(screen.getByRole("button", { name: /^create and add to upper day$/i })).toBeDisabled();
});

test("save is disabled until the new name is non-empty", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit name of upper day$/i }));
  const input = screen.getByRole("textbox", { name: /day name for upper day/i });
  fireEvent.change(input, { target: { value: "   " } });
  expect(screen.getByRole("button", { name: /^save name for upper day$/i })).toBeDisabled();
});

test("canceling a rename restores the original name with no write", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit name of upper day$/i }));
  const input = screen.getByRole("textbox", { name: /day name for upper day/i });
  fireEvent.change(input, { target: { value: "Push Day" } });
  fireEvent.click(screen.getByRole("button", { name: /^cancel rename upper day$/i }));
  expect(screen.getByText("Upper Day")).toBeInTheDocument();
  expect(screen.queryByText("Push Day")).not.toBeInTheDocument();
});

test("renaming a day persists the new name", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit name of leg day$/i }));
  const input = screen.getByRole("textbox", { name: /day name for leg day/i });
  fireEvent.change(input, { target: { value: "Leg Day 2" } });
  fireEvent.click(screen.getByRole("button", { name: /^save name for leg day$/i }));
  await waitFor(() => expect(screen.getByText("Leg Day 2")).toBeInTheDocument());
});

test("creating a new day adds it to the list", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add day$/i }));
  const input = screen.getByRole("textbox", { name: /new day name/i });
  fireEvent.change(input, { target: { value: "Pull Day" } });
  fireEvent.click(screen.getByRole("button", { name: /^save new day$/i }));
  await waitFor(() => expect(screen.getByText("Pull Day")).toBeInTheDocument());
});

test("save new day is disabled until the name is non-empty", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add day$/i }));
  const input = screen.getByRole("textbox", { name: /new day name/i });
  fireEvent.change(input, { target: { value: "   " } });
  expect(screen.getByRole("button", { name: /^save new day$/i })).toBeDisabled();
});
