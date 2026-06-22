import { render, screen, fireEvent } from "@testing-library/react";
import ExerciseCard from "./ExerciseCard";
import type { Exercise } from "../types";

const ex: Exercise = { id: "leg-press", name: "Leg Press", cue: "main driver", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 };

test("shows last time formatted", () => {
  render(<ExerciseCard exercise={ex} lastSets={[{ setNumber: 1, weight: 150, reps: 12 }, { setNumber: 2, weight: 150, reps: 12 }, { setNumber: 3, weight: 150, reps: 12 }]} loggedSets={null} onLog={() => {}} />);
  expect(screen.getByText(/Last: 150 × 3 × 12/)).toBeInTheDocument();
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
