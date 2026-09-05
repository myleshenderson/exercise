import type { DataLayer } from "./DataLayer";
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";
import { seedExercises, seedDays, seedSessions } from "./seed";
import { findLastSetsForExercise } from "../lib/lastSession";

export function createMockDataLayer(opts?: { seed?: boolean }): DataLayer {
  const useSeed = opts?.seed !== false;
  const exercises: Exercise[] = useSeed ? structuredClone(seedExercises) : [];
  const days: WorkoutDay[] = useSeed ? structuredClone(seedDays) : [];
  const sessions: Session[] = useSeed ? structuredClone(seedSessions) : [];
  const targets: Record<string, Record<string, SetEntry[]>> = {};
  const schemeHistory: Record<string, { targetSets: SetEntry[] | null; recordedAt: string }[]> = {};
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  return {
    async listExercises() {
      return exercises.slice();
    },
    async getExercise(id) {
      return exercises.find((e) => e.id === id) ?? null;
    },
    async createExercise(input) {
      const ex: Exercise = { ...input, id: nextId("ex") };
      exercises.push(ex);
      return ex;
    },
    async getWorkoutDays() {
      return days.slice().sort((a, b) => a.position - b.position);
    },
    async getDayExercises(dayId) {
      const day = days.find((d) => d.id === dayId);
      if (!day) return [];
      return day.exerciseIds
        .map((id) => exercises.find((e) => e.id === id))
        .filter((e): e is Exercise => !!e);
    },
    async createDay(name) {
      const day: WorkoutDay = { id: nextId("day"), name, position: days.length, exerciseIds: [] };
      days.push(day);
      return day;
    },
    async updateDayExercises(dayId, exerciseIds) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.exerciseIds = exerciseIds.slice();
      const dayTargets = targets[dayId];
      if (dayTargets) {
        for (const exId of Object.keys(dayTargets)) {
          if (!exerciseIds.includes(exId)) delete dayTargets[exId];
        }
      }
    },
    async updateDayName(dayId, name) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.name = name;
    },
    async getDayExerciseTargets(dayId) {
      return { ...(targets[dayId] ?? {}) };
    },
    async setDayExerciseTarget(dayId, exerciseId, sets) {
      const dayTargets = (targets[dayId] ??= {});
      if (sets && sets.length > 0) dayTargets[exerciseId] = sets.slice();
      else delete dayTargets[exerciseId];

      const key = `${dayId}:${exerciseId}`;
      (schemeHistory[key] ??= []).push({
        targetSets: sets && sets.length > 0 ? sets.slice() : null,
        recordedAt: new Date().toISOString(),
      });
    },
    async getSchemeHistory(dayId, exerciseId) {
      return (schemeHistory[`${dayId}:${exerciseId}`] ?? []).slice();
    },
    async getLastSetsForExercise(exerciseId, beforeDate) {
      return findLastSetsForExercise(sessions, exerciseId, beforeDate);
    },
    async startSession(workoutDayId, date) {
      const session: Session = { id: nextId("session"), workoutDayId, performedOn: date, exercises: [] };
      sessions.push(session);
      return session;
    },
    async getSession(id) {
      return sessions.find((s) => s.id === id) ?? null;
    },
    async logExercise(sessionId, exerciseId, sets) {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const existing = session.exercises.find((e) => e.exerciseId === exerciseId);
      if (existing) existing.sets = sets.slice();
      else session.exercises.push({ exerciseId, sets: sets.slice() });
    },
    async getExerciseHistory(exerciseId) {
      return sessions
        .filter((s) => s.exercises.some((e) => e.exerciseId === exerciseId))
        .sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
    async getLastSessionForDay(workoutDayId) {
      let best: Session | null = null;
      for (const s of sessions) {
        if (s.workoutDayId !== workoutDayId || s.exercises.length === 0) continue;
        if (!best || s.performedOn >= best.performedOn) best = s;
      }
      return best;
    },
    async getSessionForDayAndDate(workoutDayId, date) {
      for (let i = sessions.length - 1; i >= 0; i--) {
        const s = sessions[i];
        if (s.workoutDayId === workoutDayId && s.performedOn === date) return s;
      }
      return null;
    },
    async listSessions() {
      return sessions
        .slice()
        .reverse()
        .sort((a, b) => (a.performedOn < b.performedOn ? 1 : a.performedOn > b.performedOn ? -1 : 0));
    },
    async deleteSession(id) {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx !== -1) sessions.splice(idx, 1);
    },
  };
}
