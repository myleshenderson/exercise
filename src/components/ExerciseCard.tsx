import { useState } from "react";
import type { Exercise, SetEntry } from "../types";
import { formatSets } from "../lib/sets";
import SetEditor from "./SetEditor";

interface Props {
  exercise: Exercise;
  lastSets: SetEntry[];
  loggedSets: SetEntry[] | null;
  onLog(sets: SetEntry[]): void;
}

export default function ExerciseCard({ exercise, lastSets, loggedSets, onLog }: Props) {
  const [editing, setEditing] = useState(false);

  if (loggedSets && !editing) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-green-200 bg-green-50 p-3">
        <div className="min-w-0">
          <span className="font-semibold">{exercise.name}</span>
          <span className="ml-2 text-sm text-green-800">{formatSets(loggedSets)}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span aria-label="logged" className="text-green-600">✓</span>
          <button onClick={() => setEditing(true)} className="text-sm text-gray-600 underline">Edit</button>
        </div>
      </div>
    );
  }

  const lastLine = formatSets(lastSets);
  return (
    <div className="rounded-xl border p-4">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-lg">{exercise.name}</h2>
        {loggedSets && <span aria-label="logged" className="text-green-600">✓</span>}
      </div>
      <p className="text-sm text-gray-500">
        Target: {exercise.defaultSets} × {exercise.defaultRepLow}–{exercise.defaultRepHigh}
        {" · "}
        <span className="font-medium text-gray-900">Last: {lastLine || "—"}</span>
      </p>
      <SetEditor
        initialWeight={(loggedSets ?? lastSets)[0]?.weight ?? 0}
        initialSets={loggedSets?.length ?? exercise.defaultSets}
        initialReps={(loggedSets ?? lastSets)[0]?.reps ?? exercise.defaultRepLow}
        initialEntries={loggedSets ?? undefined}
        onSave={(sets) => {
          onLog(sets);
          setEditing(false);
        }}
      />
    </div>
  );
}
