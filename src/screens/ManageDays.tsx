import { useEffect, useState, useCallback } from "react";
import { db } from "../data";
import type { WorkoutDay, Exercise, SetEntry } from "../types";
import { formatSets } from "../lib/sets";

export default function ManageDays() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [exByDay, setExByDay] = useState<Record<string, Exercise[]>>({});
  const [confirming, setConfirming] = useState<{ dayId: string; exerciseId: string } | null>(null);
  const [allExercises, setAllExercises] = useState<Exercise[]>([]);
  const [addingDayId, setAddingDayId] = useState<string | null>(null);
  const [editingDayId, setEditingDayId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [addingDay, setAddingDay] = useState(false);
  const [newDayName, setNewDayName] = useState("");
  const [targetsByDay, setTargetsByDay] = useState<Record<string, Record<string, SetEntry[]>>>({});
  const [schemeEditing, setSchemeEditing] = useState<{ dayId: string; exerciseId: string } | null>(null);

  const load = useCallback(async () => {
    const d = await db.getWorkoutDays();
    setDays(d);
    const map: Record<string, Exercise[]> = {};
    const targets: Record<string, Record<string, SetEntry[]>> = {};
    for (const day of d) {
      map[day.id] = await db.getDayExercises(day.id);
      targets[day.id] = await db.getDayExerciseTargets(day.id);
    }
    setExByDay(map);
    setTargetsByDay(targets);
    setAllExercises(await db.listExercises());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(day: WorkoutDay, exerciseId: string) {
    const remaining = day.exerciseIds.filter((id) => id !== exerciseId);
    await db.updateDayExercises(day.id, remaining);
    setConfirming(null);
    setSchemeEditing(null);
    await load();
  }

  async function saveScheme(day: WorkoutDay, exerciseId: string, sets: SetEntry[]) {
    await db.setDayExerciseTarget(day.id, exerciseId, sets);
    setSchemeEditing(null);
    await load();
  }

  async function removeScheme(day: WorkoutDay, exerciseId: string) {
    await db.setDayExerciseTarget(day.id, exerciseId, null);
    setSchemeEditing(null);
    await load();
  }

  async function addExisting(day: WorkoutDay, exerciseId: string) {
    await db.updateDayExercises(day.id, [...day.exerciseIds, exerciseId]);
    setAddingDayId(null);
    await load();
  }

  async function createAndAdd(day: WorkoutDay, input: Omit<Exercise, "id">) {
    const ex = await db.createExercise(input);
    await db.updateDayExercises(day.id, [...day.exerciseIds, ex.id]);
    setAddingDayId(null);
    await load();
  }

  function startEdit(day: WorkoutDay) {
    setDraftName(day.name);
    setEditingDayId(day.id);
    setConfirming(null);
    setAddingDayId(null);
    setSchemeEditing(null);
  }

  function cancelEdit() {
    setEditingDayId(null);
    setDraftName("");
  }

  async function saveName(day: WorkoutDay) {
    const trimmed = draftName.trim();
    if (!trimmed) return;
    await db.updateDayName(day.id, trimmed);
    setEditingDayId(null);
    await load();
  }

  function startAddDay() {
    setNewDayName("");
    setAddingDay(true);
    setEditingDayId(null);
    setConfirming(null);
    setAddingDayId(null);
    setSchemeEditing(null);
  }

  function cancelAddDay() {
    setAddingDay(false);
    setNewDayName("");
  }

  async function createDay() {
    const trimmed = newDayName.trim();
    if (!trimmed) return;
    await db.createDay(trimmed);
    setAddingDay(false);
    setNewDayName("");
    await load();
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Manage Days</h1>
      {days.map((day) => (
        <div key={day.id} className="rounded-xl border p-4">
          <div className="flex items-center gap-2">
            {editingDayId === day.id ? (
              <>
                <input
                  aria-label={`day name for ${day.name}`}
                  value={draftName}
                  onChange={(ev) => setDraftName(ev.target.value)}
                  className="border rounded px-2 py-1 font-semibold flex-1"
                />
                <button
                  aria-label={`save name for ${day.name}`}
                  disabled={!draftName.trim()}
                  onClick={() => saveName(day)}
                  className="text-sm px-2 py-1 border rounded disabled:opacity-50">
                  Save
                </button>
                <button
                  aria-label={`cancel rename ${day.name}`}
                  onClick={cancelEdit}
                  className="text-sm px-2 text-gray-500">
                  Cancel
                </button>
              </>
            ) : (
              <>
                <h2 className="font-semibold">{day.name}</h2>
                <button
                  aria-label={`edit name of ${day.name}`}
                  onClick={() => startEdit(day)}
                  className="text-sm text-blue-600 px-2">
                  Edit
                </button>
              </>
            )}
          </div>
          <ul className="mt-2 space-y-1">
            {(exByDay[day.id] ?? []).map((e) => {
              const scheme = targetsByDay[day.id]?.[e.id] ?? null;
              return (
                <li key={e.id} className="py-1">
                  <div className="flex justify-between items-center">
                    <span>{e.name}</span>
                    {confirming?.dayId === day.id && confirming.exerciseId === e.id ? (
                      <span className="flex gap-2">
                        <button
                          aria-label={`confirm remove ${e.name}`}
                          onClick={() => remove(day, e.id)}
                          className="text-white bg-red-600 rounded text-sm px-2">
                          Confirm
                        </button>
                        <button
                          aria-label={`cancel remove ${e.name}`}
                          onClick={() => setConfirming(null)}
                          className="text-sm px-2 border rounded">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        aria-label={`remove ${e.name}`}
                        onClick={() => { setConfirming({ dayId: day.id, exerciseId: e.id }); setAddingDayId(null); setEditingDayId(null); setSchemeEditing(null); }}
                        className="text-red-600 text-sm px-2">
                        Remove
                      </button>
                    )}
                  </div>
                  {schemeEditing?.dayId === day.id && schemeEditing.exerciseId === e.id ? (
                    <SchemeEditor
                      day={day}
                      exercise={e}
                      initial={scheme}
                      onSave={(sets) => saveScheme(day, e.id, sets)}
                      onRemove={() => removeScheme(day, e.id)}
                      onCancel={() => setSchemeEditing(null)}
                    />
                  ) : (
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-gray-500">{scheme ? `Scheme: ${formatSets(scheme)}` : ""}</span>
                      <button
                        aria-label={`${scheme ? "edit" : "add"} scheme for ${e.name} on ${day.name}`}
                        onClick={() => { setSchemeEditing({ dayId: day.id, exerciseId: e.id }); setConfirming(null); setAddingDayId(null); setEditingDayId(null); }}
                        className="text-sm text-blue-600 px-2">
                        {scheme ? "Edit scheme" : "+ Scheme"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {addingDayId === day.id ? (
            <AddExerciseSection
              day={day}
              available={allExercises.filter((e) => !day.exerciseIds.includes(e.id))}
              onAdd={(exerciseId) => addExisting(day, exerciseId)}
              onCreate={(input) => createAndAdd(day, input)}
              onClose={() => setAddingDayId(null)}
            />
          ) : (
            <button
              aria-label={`add exercise to ${day.name}`}
              onClick={() => { setAddingDayId(day.id); setConfirming(null); setEditingDayId(null); setSchemeEditing(null); }}
              className="mt-2 text-sm text-blue-600 px-2">
              + Add exercise
            </button>
          )}
        </div>
      ))}
      {addingDay ? (
        <div className="rounded-xl border p-4 flex items-center gap-2">
          <input
            aria-label="new day name"
            value={newDayName}
            onChange={(ev) => setNewDayName(ev.target.value)}
            placeholder="Day name"
            className="border rounded px-2 py-1 flex-1"
          />
          <button
            aria-label="save new day"
            disabled={!newDayName.trim()}
            onClick={createDay}
            className="text-sm px-2 py-1 border rounded disabled:opacity-50">
            Add
          </button>
          <button
            aria-label="cancel add day"
            onClick={cancelAddDay}
            className="text-sm px-2 text-gray-500">
            Cancel
          </button>
        </div>
      ) : (
        <button
          aria-label="add day"
          onClick={startAddDay}
          className="text-sm text-blue-600 px-2">
          + Add day
        </button>
      )}
    </div>
  );
}

function AddExerciseSection({ day, available, onAdd, onCreate, onClose }: {
  day: WorkoutDay;
  available: Exercise[];
  onAdd: (exerciseId: string) => void;
  onCreate: (input: Omit<Exercise, "id">) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"pick" | "create">(available.length > 0 ? "pick" : "create");
  const [selectedId, setSelectedId] = useState(available[0]?.id ?? "");
  const [name, setName] = useState("");
  const [cue, setCue] = useState("");
  const [sets, setSets] = useState(3);
  const [repLow, setRepLow] = useState(8);
  const [repHigh, setRepHigh] = useState(12);
  const [submitting, setSubmitting] = useState(false);

  const createValid = name.trim().length > 0 && sets >= 1 && repLow >= 1 && repLow <= repHigh;

  if (mode === "pick") {
    return (
      <div className="mt-2 space-y-2">
        <div className="flex gap-2 items-center">
          <select
            aria-label={`exercise picker for ${day.name}`}
            value={selectedId}
            onChange={(ev) => setSelectedId(ev.target.value)}
            className="border rounded px-2 py-1 flex-1">
            {available.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <button
            aria-label={`add selected exercise to ${day.name}`}
            disabled={!selectedId || submitting}
            onClick={() => { setSubmitting(true); onAdd(selectedId); }}
            className="text-sm px-2 py-1 border rounded">
            Add
          </button>
        </div>
        <div className="flex gap-3">
          <button
            aria-label={`create new exercise for ${day.name}`}
            onClick={() => setMode("create")}
            className="text-sm px-2 text-blue-600">
            Create new exercise
          </button>
          <button onClick={onClose} className="text-sm px-2 text-gray-500">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <input
        aria-label="new exercise name"
        value={name}
        onChange={(ev) => setName(ev.target.value)}
        placeholder="Exercise name"
        className="border rounded px-2 py-1 w-full"
      />
      <input
        aria-label="new exercise cue"
        value={cue}
        onChange={(ev) => setCue(ev.target.value)}
        placeholder="Cue (optional)"
        className="border rounded px-2 py-1 w-full"
      />
      <div className="flex gap-2">
        <input
          aria-label="new exercise sets"
          type="number"
          value={sets}
          onChange={(ev) => setSets(Number(ev.target.value))}
          className="border rounded px-2 py-1 w-16"
        />
        <input
          aria-label="new exercise rep low"
          type="number"
          value={repLow}
          onChange={(ev) => setRepLow(Number(ev.target.value))}
          className="border rounded px-2 py-1 w-16"
        />
        <input
          aria-label="new exercise rep high"
          type="number"
          value={repHigh}
          onChange={(ev) => setRepHigh(Number(ev.target.value))}
          className="border rounded px-2 py-1 w-16"
        />
      </div>
      <div className="flex gap-3">
        <button
          aria-label={`create and add to ${day.name}`}
          disabled={!createValid || submitting}
          onClick={() => { setSubmitting(true); onCreate({ name: name.trim(), cue: cue.trim(), defaultSets: sets, defaultRepLow: repLow, defaultRepHigh: repHigh }); }}
          className="text-sm px-2 py-1 border rounded disabled:opacity-50">
          Create &amp; add
        </button>
        <button onClick={onClose} className="text-sm px-2 text-gray-500">Cancel</button>
      </div>
    </div>
  );
}

function SchemeEditor({ day, exercise, initial, onSave, onRemove, onCancel }: {
  day: WorkoutDay;
  exercise: Exercise;
  initial: SetEntry[] | null;
  onSave: (sets: SetEntry[]) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<{ weight: number; reps: number }[]>(
    initial && initial.length > 0
      ? initial.map((s) => ({ weight: s.weight, reps: s.reps }))
      : [{ weight: 0, reps: exercise.defaultRepLow }],
  );

  const valid = rows.length > 0 && rows.every((r) => r.weight >= 0 && r.reps >= 1);

  function updateRow(i: number, field: "weight" | "reps", value: number) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, rs[rs.length - 1] ?? { weight: 0, reps: exercise.defaultRepLow }]);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }
  function save() {
    onSave(rows.map((r, i) => ({ setNumber: i + 1, weight: r.weight, reps: r.reps })));
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border p-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-end gap-2">
          <span className="text-xs text-gray-500 w-10 pb-2 shrink-0">Set {i + 1}</span>
          <label className="flex flex-1 flex-col text-xs text-gray-500">
            weight
            <input
              aria-label={`scheme set ${i + 1} weight for ${exercise.name} on ${day.name}`}
              type="number"
              value={r.weight}
              onChange={(ev) => updateRow(i, "weight", Number(ev.target.value))}
              className="border rounded px-2 py-1 w-full"
            />
          </label>
          <label className="flex flex-1 flex-col text-xs text-gray-500">
            reps
            <input
              aria-label={`scheme set ${i + 1} reps for ${exercise.name} on ${day.name}`}
              type="number"
              value={r.reps}
              onChange={(ev) => updateRow(i, "reps", Number(ev.target.value))}
              className="border rounded px-2 py-1 w-full"
            />
          </label>
          {rows.length > 1 && (
            <button
              aria-label={`remove scheme set ${i + 1} for ${exercise.name} on ${day.name}`}
              onClick={() => removeRow(i)}
              className="shrink-0 text-red-600 text-xl px-2 pb-1">
              −
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-3">
        <button
          aria-label={`add scheme set for ${exercise.name} on ${day.name}`}
          onClick={addRow}
          className="text-sm px-2 py-1 border rounded">
          + add set
        </button>
        <button
          aria-label={`save scheme for ${exercise.name} on ${day.name}`}
          disabled={!valid}
          onClick={save}
          className="text-sm px-2 py-1 border rounded disabled:opacity-50">
          Save
        </button>
        {initial && initial.length > 0 && (
          <button
            aria-label={`remove scheme for ${exercise.name} on ${day.name}`}
            onClick={onRemove}
            className="text-sm px-2 text-red-600">
            Remove scheme
          </button>
        )}
        <button
          aria-label={`cancel scheme for ${exercise.name} on ${day.name}`}
          onClick={onCancel}
          className="text-sm px-2 text-gray-500">
          Cancel
        </button>
      </div>
    </div>
  );
}
