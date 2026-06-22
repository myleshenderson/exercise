import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { WorkoutDay } from "../types";

const today = () => new Date().toISOString().slice(0, 10);

export default function Home() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const navigate = useNavigate();

  useEffect(() => { db.getWorkoutDays().then(setDays); }, []);

  async function start(dayId: string | null) {
    const session = await db.startSession(dayId, today());
    navigate(`/session/${session.id}`);
  }

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-2xl font-bold">Today's Workout</h1>
      {days.map((d) => (
        <button key={d.id} onClick={() => start(d.id)}
          className="w-full text-left text-lg font-semibold rounded-xl border p-4 active:bg-gray-100">
          {d.name}
        </button>
      ))}
      <button onClick={() => start(null)}
        className="w-full text-left text-gray-600 rounded-xl border border-dashed p-4">
        Start blank session
      </button>
    </div>
  );
}
