import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../data";
import type { Session, WorkoutDay } from "../types";
import { formatSessionDate } from "../lib/date";
import ThisWeekStrip from "../rides/ThisWeekStrip";

const today = () => new Date().toISOString().slice(0, 10);

export default function Home() {
  const [days, setDays] = useState<WorkoutDay[]>([]);
  const [lastByDay, setLastByDay] = useState<Record<string, string | null>>({});
  const [sessionForDate, setSessionForDate] = useState<Record<string, Session | null>>({});
  const [date, setDate] = useState(today());
  const [expandedPrograms, setExpandedPrograms] = useState<Record<string, boolean>>({});
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

  useEffect(() => {
    let cancelled = false;
    setSessionForDate({});
    (async () => {
      const entries = await Promise.all(
        days.map(async (d) => [d.id, await db.getSessionForDayAndDate(d.id, date)] as const),
      );
      if (cancelled) return;
      setSessionForDate(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [days, date]);

  async function start(dayId: string) {
    const existing = await db.getSessionForDayAndDate(dayId, date);
    const session = existing ?? (await db.startSession(dayId, date));
    navigate(`/session/${session.id}`);
  }

  function dayCard(d: WorkoutDay) {
    const existing = sessionForDate[d.id];
    const loggedCount = existing?.exercises.length ?? 0;

    let cardClass = "w-full rounded-xl border p-4 text-left active:bg-gray-100";
    let subtitleClass = "text-sm text-gray-500";
    let subtitle = lastByDay[d.id] ? `Last done ${formatSessionDate(lastByDay[d.id]!)}` : "Not done yet";
    let indicator: ReactNode = null;

    if (existing && loggedCount > 0) {
      cardClass = "w-full rounded-xl border border-green-200 bg-green-50 p-4 text-left active:bg-green-100";
      subtitleClass = "text-sm text-green-800";
      subtitle = `Resume · ${loggedCount} exercise${loggedCount === 1 ? "" : "s"} logged`;
      indicator = (
        <span aria-label="logged" className="shrink-0 text-green-600">
          ✓
        </span>
      );
    } else if (existing) {
      cardClass = "w-full rounded-xl border border-blue-200 bg-blue-50 p-4 text-left active:bg-blue-100";
      subtitleClass = "text-sm text-blue-800";
      subtitle = "In progress — resume";
      indicator = (
        <span aria-label="in progress" className="shrink-0 text-blue-600">
          ●
        </span>
      );
    }

    return (
      <button key={d.id} onClick={() => start(d.id)} className={cardClass}>
        <span className="flex items-center gap-2">
          <span className="block flex-1 text-lg font-semibold">{d.name}</span>
          {indicator}
        </span>
        <span className={`block ${subtitleClass}`}>{subtitle}</span>
      </button>
    );
  }

  const untracked = days.filter((d) => d.programId === null);
  const programGroups = new Map<string, { name: string; days: WorkoutDay[] }>();
  for (const d of days) {
    if (d.programId === null) continue;
    const group = programGroups.get(d.programId) ?? { name: d.programName ?? "", days: [] };
    group.days.push(d);
    programGroups.set(d.programId, group);
  }

  return (
    <div className="p-4 space-y-3">
      <ThisWeekStrip />
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

      {[...programGroups.entries()].map(([programId, group]) => {
        const suggested = group.days.find((d) => d.isAvailable);
        const rest = group.days.filter((d) => d !== suggested).sort((a, b) => (a.programPosition ?? 0) - (b.programPosition ?? 0));
        const expanded = expandedPrograms[programId] ?? false;
        return (
          <div key={programId} className="space-y-2">
            {suggested && dayCard(suggested)}
            {rest.length > 0 && (
              <>
                <button
                  className="text-sm text-gray-500 underline"
                  onClick={() => setExpandedPrograms((prev) => ({ ...prev, [programId]: !expanded }))}
                >
                  {expanded ? "hide" : `show all ${group.days.length} days in ${group.name}`}
                </button>
                {expanded && <div className="space-y-2 opacity-70">{rest.map(dayCard)}</div>}
              </>
            )}
          </div>
        );
      })}

      {untracked.map(dayCard)}
    </div>
  );
}
