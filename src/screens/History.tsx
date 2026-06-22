import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { db } from "../data";
import type { Session, Exercise } from "../types";
import { formatSets } from "../lib/sets";

export default function History() {
  const { exerciseId } = useParams();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [exercise, setExercise] = useState<Exercise | null>(null);

  useEffect(() => {
    if (!exerciseId) return;
    db.getExercise(exerciseId).then(setExercise);
    db.getExerciseHistory(exerciseId).then(setSessions);
  }, [exerciseId]);

  return (
    <div className="p-4 space-y-2">
      <h1 className="text-xl font-bold">{exercise?.name ?? "History"}</h1>
      {sessions.map((s) => {
        const sets = s.exercises.find((e) => e.exerciseId === exerciseId)?.sets ?? [];
        return (
          <div key={s.id} className="flex justify-between border-b py-2">
            <span className="text-gray-600">{s.performedOn}</span>
            <span className="font-medium">{formatSets(sets)}</span>
          </div>
        );
      })}
      {sessions.length === 0 && <p className="text-gray-500">No history yet.</p>}
    </div>
  );
}
