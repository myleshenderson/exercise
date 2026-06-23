import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { db } from "../data";
import type { Exercise, Session as SessionT, SetEntry } from "../types";
import ExerciseCard from "../components/ExerciseCard";

export default function Session() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionT | null>(null);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [lastByEx, setLastByEx] = useState<Record<string, SetEntry[]>>({});

  useEffect(() => {
    if (!id) return;
    (async () => {
      const s = await db.getSession(id);
      if (!s) return;
      setSession(s);
      const ex = s.workoutDayId ? await db.getDayExercises(s.workoutDayId) : [];
      setExercises(ex);
      const last: Record<string, SetEntry[]> = {};
      for (const e of ex) {
        last[e.id] = await db.getLastSetsForExercise(e.id, s.performedOn);
      }
      setLastByEx(last);
    })();
  }, [id]);

  async function log(exerciseId: string, sets: SetEntry[]) {
    if (!session) return;
    await db.logExercise(session.id, exerciseId, sets);
    const updated = await db.getSession(session.id);
    setSession(updated ? { ...updated } : null);
  }

  if (!session) return <div className="p-4">Loading…</div>;

  const loggedFor = (exId: string) =>
    session.exercises.find((e) => e.exerciseId === exId)?.sets ?? null;

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-bold">Session — {session.performedOn}</h1>
      {exercises.map((e) => (
        <ExerciseCard
          key={e.id}
          exercise={e}
          lastSets={lastByEx[e.id] ?? []}
          loggedSets={loggedFor(e.id)}
          onLog={(sets) => log(e.id, sets)}
        />
      ))}
      <button
        onClick={() => navigate(`/session/${session.id}/summary`)}
        className="w-full rounded-xl border-2 border-black p-4 font-semibold"
      >
        Finish workout
      </button>
    </div>
  );
}
