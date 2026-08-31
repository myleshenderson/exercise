import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { Session, WorkoutDay } from "../types";
import { formatSessionDate } from "../lib/date";

export default function LoggedWorkouts() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [bulkConfirming, setBulkConfirming] = useState(false);

  const load = useCallback(async () => {
    setSessions(await db.listSessions());
    setDays(await db.getWorkoutDays());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function dayName(workoutDayId: string | null) {
    if (!workoutDayId) return "Blank session";
    return days.find((d) => d.id === workoutDayId)?.name ?? "Blank session";
  }

  const emptySessions = sessions.filter((s) => s.exercises.length === 0);

  async function confirmDelete(id: string) {
    await db.deleteSession(id);
    setConfirmingId(null);
    await load();
  }

  async function confirmBulkDelete() {
    for (const s of emptySessions) {
      await db.deleteSession(s.id);
    }
    setBulkConfirming(false);
    await load();
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Logged Workouts</h1>
      {emptySessions.length > 0 &&
        (bulkConfirming ? (
          <div className="flex gap-2 items-center">
            <span className="text-sm text-gray-600">
              Delete {emptySessions.length} empty session{emptySessions.length === 1 ? "" : "s"}?
            </span>
            <button
              aria-label="confirm delete all empty sessions"
              onClick={confirmBulkDelete}
              className="text-white bg-red-600 rounded text-sm px-2 py-1"
            >
              Confirm
            </button>
            <button
              aria-label="cancel delete all empty sessions"
              onClick={() => setBulkConfirming(false)}
              className="text-sm px-2 border rounded"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            aria-label="delete all empty sessions"
            onClick={() => setBulkConfirming(true)}
            className="text-sm text-red-600 px-2"
          >
            Delete all empty sessions
          </button>
        ))}
      <ul className="space-y-2">
        {sessions.map((s) => {
          const label = formatSessionDate(s.performedOn);
          return (
            <li key={s.id} className="flex justify-between items-center border-b py-2">
              <div>
                <div className="font-medium">{label}</div>
                <div className="text-sm text-gray-500">{dayName(s.workoutDayId)}</div>
              </div>
              {confirmingId === s.id ? (
                <span className="flex gap-2">
                  <button
                    aria-label={`confirm delete session on ${label}`}
                    onClick={() => confirmDelete(s.id)}
                    className="text-white bg-red-600 rounded text-sm px-2 py-1"
                  >
                    Confirm
                  </button>
                  <button
                    aria-label={`cancel delete session on ${label}`}
                    onClick={() => setConfirmingId(null)}
                    className="text-sm px-2 border rounded"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <span className="flex gap-2">
                  <button
                    aria-label={`detail for session on ${label}`}
                    onClick={() => navigate(`/session/${s.id}/summary`, { state: { from: "/workouts" } })}
                    className="text-sm px-2 py-1 border rounded"
                  >
                    Detail
                  </button>
                  <button
                    aria-label={`delete session on ${label}`}
                    onClick={() => setConfirmingId(s.id)}
                    className="text-red-600 text-sm px-2"
                  >
                    Delete
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {sessions.length === 0 && <p className="text-gray-500">No logged sessions yet.</p>}
    </div>
  );
}
