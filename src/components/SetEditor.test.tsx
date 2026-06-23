import { render, screen, fireEvent } from "@testing-library/react";
import SetEditor from "./SetEditor";

test("one-line Log saves uniform expanded sets", () => {
  const onSave = vi.fn();
  render(<SetEditor initialWeight={150} initialSets={3} initialReps={12} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onSave).toHaveBeenCalledWith([
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 150, reps: 12 },
    { setNumber: 3, weight: 150, reps: 12 },
  ]);
});

test("expand to per-set, drop weight/reps on last set, Log saves per-set values", () => {
  const onSave = vi.fn();
  render(<SetEditor initialWeight={150} initialSets={3} initialReps={12} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /adjust sets/i }));
  fireEvent.change(screen.getByLabelText("set 3 weight"), { target: { value: "140" } });
  fireEvent.change(screen.getByLabelText("set 3 reps"), { target: { value: "8" } });
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onSave).toHaveBeenCalledWith([
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 150, reps: 12 },
    { setNumber: 3, weight: 140, reps: 8 },
  ]);
});

test("add set adds a row", () => {
  const onSave = vi.fn();
  render(<SetEditor initialWeight={100} initialSets={2} initialReps={10} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /adjust sets/i }));
  fireEvent.click(screen.getByRole("button", { name: /add set/i }));
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onSave).toHaveBeenCalledWith([
    { setNumber: 1, weight: 100, reps: 10 },
    { setNumber: 2, weight: 100, reps: 10 },
    { setNumber: 3, weight: 100, reps: 10 },
  ]);
});

test("remove set removes a row", () => {
  const onSave = vi.fn();
  render(<SetEditor initialWeight={100} initialSets={3} initialReps={10} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /adjust sets/i }));
  fireEvent.click(screen.getByLabelText("remove set 2"));
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onSave).toHaveBeenCalledWith([
    { setNumber: 1, weight: 100, reps: 10 },
    { setNumber: 2, weight: 100, reps: 10 },
  ]);
});

test("seeds line mode from uniform initialEntries", () => {
  const onSave = vi.fn();
  render(<SetEditor initialWeight={0} initialSets={1} initialReps={1}
    initialEntries={[{ setNumber: 1, weight: 100, reps: 10 }, { setNumber: 2, weight: 100, reps: 10 }]}
    onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onSave).toHaveBeenCalledWith([
    { setNumber: 1, weight: 100, reps: 10 },
    { setNumber: 2, weight: 100, reps: 10 },
  ]);
});

test("opens per-set mode for non-uniform initialEntries and Log preserves them", () => {
  const onSave = vi.fn();
  const entries = [
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 140, reps: 8 },
  ];
  render(<SetEditor initialWeight={0} initialSets={1} initialReps={1} initialEntries={entries} onSave={onSave} />);
  expect(screen.getByLabelText("set 2 weight")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onSave).toHaveBeenCalledWith([
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 140, reps: 8 },
  ]);
});

test("weight uses a native select picker", () => {
  render(<SetEditor initialWeight={100} initialSets={3} initialReps={10} onSave={() => {}} />);
  expect(screen.getByLabelText("weight").tagName).toBe("SELECT");
});

test("reps uses a native select picker", () => {
  render(<SetEditor initialWeight={100} initialSets={3} initialReps={10} onSave={() => {}} />);
  expect(screen.getByLabelText("reps").tagName).toBe("SELECT");
});

test("sets uses a native select picker", () => {
  render(<SetEditor initialWeight={100} initialSets={3} initialReps={10} onSave={() => {}} />);
  expect(screen.getByLabelText("sets").tagName).toBe("SELECT");
});

test("removing sets down to one returns to the single-set line view", () => {
  const onSave = vi.fn();
  render(<SetEditor initialWeight={100} initialSets={3} initialReps={10} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: /adjust sets/i }));
  expect(screen.getByLabelText("set 3 weight")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("remove set 3"));
  fireEvent.click(screen.getByLabelText("remove set 2"));
  // back to line view: per-set rows gone, line fields + Adjust sets present
  expect(screen.queryByLabelText("set 1 weight")).not.toBeInTheDocument();
  expect(screen.getByLabelText("weight")).toBeInTheDocument();
  expect(screen.getByLabelText("sets")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /adjust sets/i })).toBeInTheDocument();
  // logging now saves a single set seeded from the remaining row
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onSave).toHaveBeenCalledWith([{ setNumber: 1, weight: 100, reps: 10 }]);
});
