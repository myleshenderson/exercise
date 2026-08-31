import { useState } from "react";
import type { Exercise, SetEntry } from "../types";
import { formatSets } from "../lib/sets";
import SetEditor from "./SetEditor";

interface Props {
  exercise: Exercise;
  lastSets: SetEntry[];
  loggedSets: SetEntry[] | null;
  targetSets?: SetEntry[] | null;
  onLog(sets: SetEntry[]): void;
}

function isUniform(sets: SetEntry[]): boolean {
  return sets.every((s) => s.weight === sets[0].weight && s.reps === sets[0].reps);
}

export default function ExerciseCard({ exercise, lastSets, loggedSets, targetSets, onLog }: Props) {
  const [editing, setEditing] = useState(false);
  const [perSet, setPerSet] = useState(() => {
    if (loggedSets) return !isUniform(loggedSets);
    return !!targetSets && targetSets.length > 0;
  });

  if (loggedSets && !editing) {
    return (
      <button
        type="button"
        aria-label={`edit ${exercise.name}`}
        onClick={() => setEditing(true)}
        className="flex w-full items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-left active:bg-green-100"
      >
        <span className="min-w-0 flex-1 truncate font-semibold">{exercise.name}</span>
        <span className="shrink-0 text-sm text-green-800 tabular-nums">{formatSets(loggedSets)}</span>
        <span aria-label="logged" className="shrink-0 text-green-600">✓</span>
        <span className="shrink-0 text-sm text-gray-500 underline">Edit</span>
      </button>
    );
  }

  const lastLine = formatSets(lastSets);
  const seedEntries = loggedSets ?? (targetSets && targetSets.length > 0 ? targetSets : null);
  return (
    <div className="rounded-xl border p-4">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-lg">{exercise.name}</h2>
        <div className="flex items-center gap-2">
          {loggedSets && <span aria-label="logged" className="text-green-600">✓</span>}
          {!perSet && (
            <button
              type="button"
              aria-label="adjust sets"
              title="Adjust sets"
              onClick={() => setPerSet(true)}
              className="text-gray-400 hover:text-gray-700 p-1"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="9" x2="20" y2="9" />
                <circle cx="9" cy="9" r="2.5" fill="white" />
                <line x1="4" y1="16" x2="20" y2="16" />
                <circle cx="15" cy="16" r="2.5" fill="white" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between text-sm">
        <span className="text-gray-500">
          Target: {exercise.defaultSets} × {exercise.defaultRepLow}–{exercise.defaultRepHigh}
        </span>
        <span className="font-medium text-gray-900">Last: {lastLine || "—"}</span>
      </div>
      <SetEditor
        initialWeight={(seedEntries ?? lastSets)[0]?.weight ?? 0}
        initialSets={seedEntries?.length ?? exercise.defaultSets}
        initialReps={(seedEntries ?? lastSets)[0]?.reps ?? exercise.defaultRepLow}
        initialEntries={seedEntries ?? undefined}
        perSet={perSet}
        onPerSetChange={setPerSet}
        onSave={(sets) => {
          onLog(sets);
          setEditing(false);
        }}
      />
    </div>
  );
}
