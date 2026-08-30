import { useEffect, useState, useCallback } from "react";
import { db } from "../data";
import type { WorkoutDay, Exercise } from "../types";

export default function ManageDays() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [exByDay, setExByDay] = useState<Record<string, Exercise[]>>({});
  const [confirming, setConfirming] = useState<{ dayId: string; exerciseId: string } | null>(null);
  const [allExercises, setAllExercises] = useState<Exercise[]>([]);
  const [addingDayId, setAddingDayId] = useState<string | null>(null);
  const [editingDayId, setEditingDayId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const load = useCallback(async () => {
    const d = await db.getWorkoutDays();
    setDays(d);
    const map: Record<string, Exercise[]> = {};
    for (const day of d) map[day.id] = await db.getDayExercises(day.id);
    setExByDay(map);
    setAllExercises(await db.listExercises());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(day: WorkoutDay, exerciseId: string) {
    const remaining = day.exerciseIds.filter((id) => id !== exerciseId);
    await db.updateDayExercises(day.id, remaining);
    setConfirming(null);
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
            {(exByDay[day.id] ?? []).map((e) => (
              <li key={e.id} className="flex justify-between items-center">
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
                    onClick={() => { setConfirming({ dayId: day.id, exerciseId: e.id }); setAddingDayId(null); setEditingDayId(null); }}
                    className="text-red-600 text-sm px-2">
                    Remove
                  </button>
                )}
              </li>
            ))}
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
              onClick={() => { setAddingDayId(day.id); setConfirming(null); setEditingDayId(null); }}
              className="mt-2 text-sm text-blue-600 px-2">
              + Add exercise
            </button>
          )}
        </div>
      ))}
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
