import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { db } from "../data";
import type { Session, Exercise } from "../types";
import { exerciseSetSeries } from "../lib/progress";
import { formatSessionDate } from "../lib/date";

export default function History() {
  const { exerciseId } = useParams();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [exercise, setExercise] = useState<Exercise | null>(null);

  useEffect(() => {
    if (!exerciseId) return;
    db.getExercise(exerciseId).then(setExercise);
    db.getExerciseHistory(exerciseId).then(setSessions);
  }, [exerciseId]);

  const series = exerciseId ? exerciseSetSeries(sessions, exerciseId) : [];
  const max = Math.max(1, ...series.flatMap((p) => p.setVolumes));

  return (
    <div className="p-4 space-y-3">
      <h1 className="text-xl font-bold">{exercise?.name ?? "Progress"}</h1>
      <p className="text-sm text-gray-500">Volume per set (weight × reps)</p>
      {series.length === 0 ? (
        <p className="text-gray-500">No sets logged yet.</p>
      ) : (
        <div className="flex items-end gap-4 overflow-x-auto pb-2">
          {series.map((point, i) => (
            <div key={i} className="flex shrink-0 flex-col items-center gap-1">
              <div className="flex items-end gap-1" style={{ height: "10rem" }}>
                {point.setVolumes.map((v, j) => (
                  <div
                    key={j}
                    aria-label={`set ${j + 1} volume ${v}`}
                    title={`${v}`}
                    className="w-3 rounded-t bg-black"
                    style={{ height: `${(v / max) * 100}%` }}
                  />
                ))}
              </div>
              <span className="whitespace-nowrap text-xs text-gray-500">
                {formatSessionDate(point.performedOn)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
