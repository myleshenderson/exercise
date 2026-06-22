import { useState } from "react";
import type { SetEntry } from "../types";
import { expandLine } from "../lib/sets";

interface Props {
  initialWeight: number;
  initialSets: number;
  initialReps: number;
  onSave(sets: SetEntry[]): void;
}

export default function SetEditor({ initialWeight, initialSets, initialReps, onSave }: Props) {
  const [weight, setWeight] = useState(initialWeight);
  const [sets, setSets] = useState(initialSets);
  const [reps, setReps] = useState(initialReps);

  return (
    <div className="flex items-end gap-2 mt-2">
      <Field label="weight" value={weight} onChange={setWeight} />
      <Field label="sets" value={sets} onChange={setSets} />
      <Field label="reps" value={reps} onChange={setReps} />
      <button
        onClick={() => onSave(expandLine(weight, sets, reps))}
        className="rounded-lg bg-black text-white px-4 py-2 font-semibold">
        Log
      </button>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange(n: number): void }) {
  return (
    <label className="flex flex-col text-xs text-gray-500">
      {label}
      <input
        aria-label={label}
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 rounded-lg border p-2 text-base text-black"
      />
    </label>
  );
}
