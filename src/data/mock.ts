import type { DataLayer } from "./DataLayer";
import type { Exercise, WorkoutDay, Session, SetEntry, Program } from "../types";
import { seedExercises, seedDays, seedSessions } from "./seed";
import { findLastSetsForExercise } from "../lib/lastSession";
import { nextAvailablePositionByProgram, isDayAvailable } from "../lib/programAvailability";

type StoredDay = Omit<WorkoutDay, "programName" | "isAvailable">;

export function createMockDataLayer(opts?: { seed?: boolean }): DataLayer {
  const useSeed = opts?.seed !== false;
  const exercises: Exercise[] = useSeed ? structuredClone(seedExercises) : [];
  const days: StoredDay[] = useSeed ? structuredClone(seedDays) : [];
  const programs: Program[] = [];
  const sessions: Session[] = useSeed ? structuredClone(seedSessions) : [];
  const targets: Record<string, Record<string, SetEntry[]>> = {};
  const schemeHistory: Record<string, { targetSets: SetEntry[] | null; recordedAt: string }[]> = {};
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  let seedClaimed = false;

  return {
    async claimSeed() {
      if (seedClaimed) return false;
      seedClaimed = true;
      return true;
    },
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
    async updateExercise(id, patch) {
      const ex = exercises.find((e) => e.id === id);
      if (!ex) throw new Error(`Exercise ${id} not found`);
      if (patch.name !== undefined) ex.name = patch.name;
      if (patch.cue !== undefined) ex.cue = patch.cue;
      if (patch.defaultSets !== undefined) ex.defaultSets = patch.defaultSets;
      if (patch.defaultRepLow !== undefined) ex.defaultRepLow = patch.defaultRepLow;
      if (patch.defaultRepHigh !== undefined) ex.defaultRepHigh = patch.defaultRepHigh;
      return { ...ex };
    },
    async deleteExercise(id) {
      // The mock has no soft-delete column; dropping the exercise is what makes
      // it disappear from listExercises, as Supabase's deleted_at does.
      const idx = exercises.findIndex((e) => e.id === id);
      if (idx !== -1) exercises.splice(idx, 1);
    },
    async findDayByName(name) {
      const d = days.find((day) => day.name === name);
      return d ? { id: d.id, name: d.name, position: d.position, programId: d.programId, programPosition: d.programPosition } : null;
    },
    async findExerciseByName(name) {
      return exercises.find((e) => e.name === name) ?? null;
    },
    async findProgramByName(name) {
      return programs.find((p) => p.name === name) ?? null;
    },
    async getWorkoutDays() {
      const completed = new Set(
        sessions.filter((s) => s.workoutDayId !== null && s.exercises.length > 0).map((s) => s.workoutDayId as string),
      );
      const livingProgramIds = new Set(programs.map((p) => p.id));
      const effectiveProgramIdByDay = new Map(
        days.map((d) => [d.id, d.programId && livingProgramIds.has(d.programId) ? d.programId : null]),
      );
      const availabilityInput = days.map((d) => ({ id: d.id, programId: effectiveProgramIdByDay.get(d.id)!, programPosition: d.programPosition }));
      const nextByProgram = nextAvailablePositionByProgram(availabilityInput, completed);
      return days
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((d) => {
          const effectiveProgramId = effectiveProgramIdByDay.get(d.id)!;
          const program = effectiveProgramId ? programs.find((p) => p.id === effectiveProgramId) ?? null : null;
          return {
            ...d,
            // Override, don't just spread ...d: once a program is deleted, its former
            // days must report programId/programPosition null too (matching
            // src/data/supabase.ts's getWorkoutDays, which nulls these the same way for
            // a day whose program_id points at a soft-deleted row) — not just programName.
            programId: effectiveProgramId,
            programPosition: effectiveProgramId ? d.programPosition : null,
            programName: program ? program.name : null,
            isAvailable: isDayAvailable({ id: d.id, programId: effectiveProgramId, programPosition: d.programPosition }, nextByProgram),
          };
        });
    },
    async getDayExercises(dayId) {
      const day = days.find((d) => d.id === dayId);
      if (!day) return [];
      return day.exerciseIds
        .map((id) => exercises.find((e) => e.id === id))
        .filter((e): e is Exercise => !!e);
    },
    async createDay(name) {
      const day: StoredDay = { id: nextId("day"), name, position: days.length, exerciseIds: [], programId: null, programPosition: null };
      days.push(day);
      return { ...day, programName: null, isAvailable: true };
    },
    async deleteDay(dayId) {
      const idx = days.findIndex((d) => d.id === dayId);
      if (idx !== -1) days.splice(idx, 1);
      delete targets[dayId];
    },
    async addExerciseToDay(dayId, exerciseId) {
      const day = days.find((d) => d.id === dayId);
      if (day && !day.exerciseIds.includes(exerciseId)) day.exerciseIds.push(exerciseId);
    },
    async removeExerciseFromDay(dayId, exerciseId) {
      const day = days.find((d) => d.id === dayId);
      if (day) day.exerciseIds = day.exerciseIds.filter((id) => id !== exerciseId);
      const dayTargets = targets[dayId];
      if (dayTargets) delete dayTargets[exerciseId];
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
    async createProgram(name) {
      const program: Program = { id: nextId("program"), name };
      programs.push(program);
      return program;
    },
    async renameProgram(programId, name) {
      const program = programs.find((p) => p.id === programId);
      if (program) program.name = name;
    },
    async deleteProgram(programId) {
      const idx = programs.findIndex((p) => p.id === programId);
      if (idx !== -1) programs.splice(idx, 1);
    },
    async addDayToProgram(dayId, programId) {
      const day = days.find((d) => d.id === dayId);
      if (!day) return;
      const maxPosition = days
        .filter((d) => d.programId === programId)
        .reduce((max, d) => Math.max(max, d.programPosition ?? -1), -1);
      day.programId = programId;
      day.programPosition = maxPosition + 1;
    },
    async removeDayFromProgram(dayId) {
      const day = days.find((d) => d.id === dayId);
      if (day) {
        day.programId = null;
        day.programPosition = null;
      }
    },
    async reorderProgramDays(programId, dayIds) {
      dayIds.forEach((dayId, index) => {
        const day = days.find((d) => d.id === dayId && d.programId === programId);
        if (day) day.programPosition = index;
      });
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
