import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { Exercise } from "../types";

export default function Progress() {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    db.listExercises().then(setExercises);
  }, []);

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-2xl font-bold">Progress</h1>
      {exercises.map((e) => (
        <button
          key={e.id}
          onClick={() => navigate(`/history/${e.id}`)}
          className="w-full rounded-xl border p-4 text-left text-lg font-semibold active:bg-gray-100"
        >
          {e.name}
        </button>
      ))}
      {exercises.length === 0 && <p className="text-gray-500">No exercises yet.</p>}
    </div>
  );
}
