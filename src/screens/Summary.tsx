import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { db } from "../data";
import type { Session } from "../types";
import { formatSets } from "../lib/sets";
import { totalVolume } from "../lib/volume";
import { formatSessionDate } from "../lib/date";

export default function Summary() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/";
  const [session, setSession] = useState<Session | null>(null);
  const [dayName, setDayName] = useState("Workout");
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    (async () => {
      const s = await db.getSession(id);
      if (!s) return;
      setSession(s);
      if (s.workoutDayId) {
        const days = await db.getWorkoutDays();
        const day = days.find((d) => d.id === s.workoutDayId);
        if (day) setDayName(day.name);
      }
      const exercises = await db.listExercises();
      const map: Record<string, string> = {};
      for (const e of exercises) map[e.id] = e.name;
      setNames(map);
    })();
  }, [id]);

  if (!session) return <div className="p-4">Loading…</div>;

  return (
    <div className="p-4 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{dayName} complete ✓</h1>
        <p className="text-gray-500">{formatSessionDate(session.performedOn)}</p>
      </div>
      <div className="space-y-1">
        {session.exercises.map((ex) => (
          <div key={ex.exerciseId} className="flex justify-between border-b py-2">
            <span>{names[ex.exerciseId] ?? ex.exerciseId}</span>
            <span className="font-medium tabular-nums">{formatSets(ex.sets)}</span>
          </div>
        ))}
        {session.exercises.length === 0 && <p className="text-gray-500">No exercises logged.</p>}
      </div>
      <p className="text-lg font-semibold">Total volume: {totalVolume(session).toLocaleString()} lb</p>
      <button
        onClick={() => navigate(returnTo)}
        className="w-full rounded-xl bg-black text-white p-4 font-semibold"
      >
        Done
      </button>
    </div>
  );
}
