import { useState } from "react";
import type { SetEntry } from "../types";
import { expandLine } from "../lib/sets";

interface Props {
  initialWeight: number;
  initialSets: number;
  initialReps: number;
  initialEntries?: SetEntry[];
  onSave(sets: SetEntry[]): void;
}

type Row = { weight: number; reps: number };

const WEIGHT_OPTIONS = Array.from({ length: 101 }, (_, i) => i * 5); // 0..500 by 5
const REPS_OPTIONS = Array.from({ length: 40 }, (_, i) => i + 1); // 1..40
const SETS_OPTIONS = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10

export default function SetEditor({ initialWeight, initialSets, initialReps, initialEntries, onSave }: Props) {
  const seed = initialEntries && initialEntries.length > 0 ? initialEntries : null;
  const seedNonUniform = seed
    ? !seed.every((s) => s.weight === seed[0].weight && s.reps === seed[0].reps)
    : false;

  const [weight, setWeight] = useState(seed ? seed[0].weight : initialWeight);
  const [sets, setSets] = useState(seed ? seed.length : initialSets);
  const [reps, setReps] = useState(seed ? seed[0].reps : initialReps);
  const [perSet, setPerSet] = useState(seedNonUniform);
  const [rows, setRows] = useState<Row[]>(
    seed && seedNonUniform ? seed.map((s) => ({ weight: s.weight, reps: s.reps })) : [],
  );

  function expand() {
    setRows(expandLine(weight, sets, reps).map((s) => ({ weight: s.weight, reps: s.reps })));
    setPerSet(true);
  }
  function updateRow(i: number, field: "weight" | "reps", value: number) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, rs[rs.length - 1] ?? { weight, reps }]);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }
  function toEntries(rs: Row[]): SetEntry[] {
    return rs.map((r, i) => ({ setNumber: i + 1, weight: r.weight, reps: r.reps }));
  }

  if (perSet) {
    return (
      <div className="mt-2 space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-end gap-2">
            <span className="text-xs text-gray-500 w-10 pb-2">Set {i + 1}</span>
            <Field label={`set ${i + 1} weight`} display="weight" options={WEIGHT_OPTIONS} value={r.weight} onChange={(v) => updateRow(i, "weight", v)} />
            <Field label={`set ${i + 1} reps`} display="reps" options={REPS_OPTIONS} value={r.reps} onChange={(v) => updateRow(i, "reps", v)} />
            <button aria-label={`remove set ${i + 1}`} onClick={() => removeRow(i)} className="text-red-600 text-xl px-2 pb-1">−</button>
          </div>
        ))}
        <div className="flex gap-2">
          <button onClick={addRow} className="rounded-lg border px-3 py-2 text-sm">+ add set</button>
          <button onClick={() => onSave(toEntries(rows))} className="flex-1 rounded-lg bg-black text-white px-4 py-2 font-semibold">Log</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex items-end gap-2">
        <Field label="weight" options={WEIGHT_OPTIONS} value={weight} onChange={setWeight} />
        <Field label="sets" options={SETS_OPTIONS} value={sets} onChange={setSets} />
        <Field label="reps" options={REPS_OPTIONS} value={reps} onChange={setReps} />
        <button onClick={() => onSave(expandLine(weight, sets, reps))} className="rounded-lg bg-black text-white px-4 py-2 font-semibold">Log</button>
      </div>
      <button onClick={expand} className="mt-1 text-sm text-gray-500 underline">Adjust sets</button>
    </div>
  );
}

function Field({ label, display, value, options, onChange }: { label: string; display?: string; value: number; options?: number[]; onChange(n: number): void }) {
  if (options) {
    return (
      <label className="flex flex-col text-xs text-gray-500">
        {display ?? label}
        <select
          aria-label={label}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 rounded-lg border p-2 text-base text-black"
        >
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="flex flex-col text-xs text-gray-500">
      {display ?? label}
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
