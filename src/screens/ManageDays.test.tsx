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

test("adding a scheme to an exercise shows its summary", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Leg Curl")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add scheme for leg curl on leg day 2$/i }));
  fireEvent.change(screen.getByLabelText(/^scheme set 1 weight for leg curl on leg day 2$/i), { target: { value: "105" } });
  fireEvent.change(screen.getByLabelText(/^scheme set 1 reps for leg curl on leg day 2$/i), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /^add scheme set for leg curl on leg day 2$/i }));
  fireEvent.change(screen.getByLabelText(/^scheme set 2 weight for leg curl on leg day 2$/i), { target: { value: "115" } });
  fireEvent.change(screen.getByLabelText(/^scheme set 2 reps for leg curl on leg day 2$/i), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: /^save scheme for leg curl on leg day 2$/i }));
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
});

test("editing an existing scheme reopens pre-filled with its saved values", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit scheme for leg curl on leg day 2$/i }));
  expect(screen.getByLabelText(/^scheme set 2 weight for leg curl on leg day 2$/i)).toHaveValue(115);
});

test("canceling a scheme edit discards changes", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit scheme for leg curl on leg day 2$/i }));
  fireEvent.change(screen.getByLabelText(/^scheme set 1 weight for leg curl on leg day 2$/i), { target: { value: "999" } });
  fireEvent.click(screen.getByRole("button", { name: /^cancel scheme for leg curl on leg day 2$/i }));
  expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument();
});

test("removing a scheme clears the summary", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Scheme: 105×10, 115×8")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^edit scheme for leg curl on leg day 2$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^remove scheme for leg curl on leg day 2$/i }));
  await waitFor(() => expect(screen.queryByText(/Scheme:/)).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: /^add scheme for leg curl on leg day 2$/i })).toBeInTheDocument();
});

test("defining a scheme on one day doesn't affect the same exercise on another day", async () => {
  render(<MemoryRouter><ManageDays /></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("Upper Day")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /^add scheme for chest press on upper day$/i }));
  fireEvent.change(screen.getByLabelText(/^scheme set 1 weight for chest press on upper day$/i), { target: { value: "185" } });
  fireEvent.change(screen.getByLabelText(/^scheme set 1 reps for chest press on upper day$/i), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: /^add scheme set for chest press on upper day$/i }));
  fireEvent.change(screen.getByLabelText(/^scheme set 2 weight for chest press on upper day$/i), { target: { value: "205" } });
  fireEvent.change(screen.getByLabelText(/^scheme set 2 reps for chest press on upper day$/i), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: /^save scheme for chest press on upper day$/i }));
  // Two differing rows -> formatSets' "different weight and reps" branch: "185×5, 205×3".
  await waitFor(() => expect(screen.getByText("Scheme: 185×5, 205×3")).toBeInTheDocument());
  // Leg Curl on Leg Day 2 still has no scheme — unaffected by Chest Press's scheme on Upper Day.
  expect(screen.getByRole("button", { name: /^add scheme for leg curl on leg day 2$/i })).toBeInTheDocument();
});
