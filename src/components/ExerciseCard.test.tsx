import { render, screen, fireEvent } from "@testing-library/react";
import ExerciseCard from "./ExerciseCard";
import type { Exercise } from "../types";

const ex: Exercise = { id: "leg-press", name: "Leg Press", cue: "main driver", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 };

test("shows last time formatted", () => {
  render(<ExerciseCard exercise={ex} lastSets={[{ setNumber: 1, weight: 150, reps: 12 }, { setNumber: 2, weight: 150, reps: 12 }, { setNumber: 3, weight: 150, reps: 12 }]} loggedSets={null} onLog={() => {}} />);
  expect(screen.getByText("Last: 150 × 3 × 12")).toBeInTheDocument();
});

test("logging one line calls onLog with expanded sets", () => {
  const onLog = vi.fn();
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} onLog={onLog} />);
  fireEvent.change(screen.getByLabelText("weight"), { target: { value: "155" } });
  fireEvent.change(screen.getByLabelText("sets"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("reps"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /log/i }));
  expect(onLog).toHaveBeenCalledWith([
    { setNumber: 1, weight: 155, reps: 10 },
    { setNumber: 2, weight: 155, reps: 10 },
    { setNumber: 3, weight: 155, reps: 10 },
  ]);
});

test("logged exercise shows a collapsed summary, check, and no target", () => {
  const logged = [
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 150, reps: 12 },
    { setNumber: 3, weight: 140, reps: 8 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={logged} onLog={() => {}} />);
  expect(screen.getByLabelText("logged")).toBeInTheDocument();
  expect(screen.getByText("150×12, 150×12, 140×8")).toBeInTheDocument();
  expect(screen.queryByText(/Target:/)).not.toBeInTheDocument();
});

test("editing a logged exercise reopens the editor and re-logs", () => {
  const onLog = vi.fn();
  const logged = [
    { setNumber: 1, weight: 150, reps: 12 },
    { setNumber: 2, weight: 150, reps: 12 },
    { setNumber: 3, weight: 150, reps: 12 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={logged} onLog={onLog} />);
  fireEvent.click(screen.getByRole("button", { name: /edit/i }));
  fireEvent.change(screen.getByLabelText("reps"), { target: { value: "10" } });
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onLog).toHaveBeenCalledWith([
    { setNumber: 1, weight: 150, reps: 10 },
    { setNumber: 2, weight: 150, reps: 10 },
    { setNumber: 3, weight: 150, reps: 10 },
  ]);
});

test("does not render the exercise cue", () => {
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} onLog={() => {}} />);
  expect(screen.queryByText("main driver")).not.toBeInTheDocument();
});

test("the adjust-sets header icon expands the editor to per-set rows", () => {
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} onLog={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /adjust sets/i }));
  expect(screen.getByLabelText("set 1 weight")).toBeInTheDocument();
});

test("seeds per-set mode from a day's target scheme when nothing is logged yet", () => {
  const targetSets = [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
    { setNumber: 3, weight: 275, reps: 3 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} targetSets={targetSets} onLog={() => {}} />);
  expect(screen.getByLabelText("set 3 weight")).toHaveValue("275");
  expect(screen.getByLabelText("set 3 reps")).toHaveValue("3");
});

test("logging a targetSets-seeded exercise logs the scheme's values unless edited", () => {
  const onLog = vi.fn();
  const targetSets = [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} targetSets={targetSets} onLog={onLog} />);
  fireEvent.click(screen.getByRole("button", { name: /^log$/i }));
  expect(onLog).toHaveBeenCalledWith(targetSets);
});

test("a logged exercise ignores the day's target scheme and reopens with its logged values", () => {
  const onLog = vi.fn();
  const logged = [
    { setNumber: 1, weight: 200, reps: 5 },
    { setNumber: 2, weight: 200, reps: 5 },
  ];
  const targetSets = [
    { setNumber: 1, weight: 225, reps: 5 },
    { setNumber: 2, weight: 225, reps: 5 },
  ];
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={logged} targetSets={targetSets} onLog={onLog} />);
  fireEvent.click(screen.getByRole("button", { name: /edit/i }));
  // logged is uniform, so it reopens in line mode (not per-set) — "weight", not "set 1 weight".
  expect(screen.getByLabelText("weight")).toHaveValue("200");
});

test("no target scheme behaves exactly as before (uniform line mode)", () => {
  render(<ExerciseCard exercise={ex} lastSets={[]} loggedSets={null} targetSets={null} onLog={() => {}} />);
  expect(screen.getByLabelText("weight")).toBeInTheDocument();
  expect(screen.queryByLabelText("set 1 weight")).not.toBeInTheDocument();
});
