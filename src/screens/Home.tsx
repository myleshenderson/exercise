import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { WorkoutDay } from "../types";
import { formatSessionDate } from "../lib/date";

const today = () => new Date().toISOString().slice(0, 10);

export default function Home() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [lastByDay, setLastByDay] = useState<Record<string, string | null>>({});
  const [date, setDate] = useState(today());
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const ds = await db.getWorkoutDays();
      setDays(ds);
      const map: Record<string, string | null> = {};
      for (const d of ds) {
        const last = await db.getLastSessionForDay(d.id);
        map[d.id] = last ? last.performedOn : null;
      }
      setLastByDay(map);
    })();
  }, []);

  async function start(dayId: string) {
    const existing = await db.getSessionForDayAndDate(dayId, date);
    const session = existing ?? (await db.startSession(dayId, date));
    navigate(`/session/${session.id}`);
  }

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-2xl font-bold">Today's Workout</h1>
      <label className="block text-sm text-gray-500">
        Workout date
        <input
          aria-label="Workout date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onClick={(e) => {
            // Open the native picker when tapping anywhere in the field, not just the icon.
            try {
              e.currentTarget.showPicker?.();
            } catch {
              /* showPicker unsupported / not allowed — fall back to default behavior */
            }
          }}
          className="mt-1 block w-full rounded-lg border p-2 text-base text-black"
        />
      </label>
      {days.map((d) => (
        <button
          key={d.id}
          onClick={() => start(d.id)}
          className="w-full rounded-xl border p-4 text-left active:bg-gray-100"
        >
          <span className="block text-lg font-semibold">{d.name}</span>
          <span className="block text-sm text-gray-500">
            {lastByDay[d.id] ? `Last done ${formatSessionDate(lastByDay[d.id]!)}` : "Not done yet"}
          </span>
        </button>
      ))}
    </div>
  );
}
