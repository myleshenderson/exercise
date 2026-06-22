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
  const lastLine = formatSets(lastSets);
  const lastWeight = lastSets[0]?.weight ?? 0;
  return (
    <div className="rounded-xl border p-4">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-lg">{exercise.name}</h2>
        {loggedSets && <span aria-label="logged" className="text-green-600">✓</span>}
      </div>
      {exercise.cue && <p className="text-sm text-gray-500">{exercise.cue}</p>}
      <p className="text-sm text-gray-600">
        Target: {exercise.defaultSets} × {exercise.defaultRepLow}–{exercise.defaultRepHigh}
      </p>
      <p className="text-sm font-medium">Last: {lastLine || "—"}</p>
      {loggedSets ? (
        <p className="text-sm text-green-700 mt-1">Logged: {formatSets(loggedSets)}</p>
      ) : (
        <SetEditor
          initialWeight={lastWeight}
          initialSets={exercise.defaultSets}
          initialReps={exercise.defaultRepLow}
          onSave={onLog}
        />
      )}
    </div>
  );
}
