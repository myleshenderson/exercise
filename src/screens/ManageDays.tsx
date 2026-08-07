import { useEffect, useState, useCallback } from "react";
import { db } from "../data";
import type { WorkoutDay, Exercise } from "../types";

export default function ManageDays() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [exByDay, setExByDay] = useState<Record<string, Exercise[]>>({});
  const [confirming, setConfirming] = useState<{ dayId: string; exerciseId: string } | null>(null);

  const load = useCallback(async () => {
    const d = await db.getWorkoutDays();
    setDays(d);
    const map: Record<string, Exercise[]> = {};
    for (const day of d) map[day.id] = await db.getDayExercises(day.id);
    setExByDay(map);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(day: WorkoutDay, exerciseId: string) {
    const remaining = day.exerciseIds.filter((id) => id !== exerciseId);
    await db.updateDayExercises(day.id, remaining);
    setConfirming(null);
    await load();
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Manage Days</h1>
      {days.map((day) => (
        <div key={day.id} className="rounded-xl border p-4">
          <h2 className="font-semibold">{day.name}</h2>
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
                    onClick={() => setConfirming({ dayId: day.id, exerciseId: e.id })}
                    className="text-red-600 text-sm px-2">
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
