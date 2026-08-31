import type { Exercise, WorkoutDay, Session, SetEntry } from "../types";

export interface DataLayer {
  listExercises(): Promise<Exercise[]>;
  getExercise(id: string): Promise<Exercise | null>;
  createExercise(input: Omit<Exercise, "id">): Promise<Exercise>;

  getWorkoutDays(): Promise<WorkoutDay[]>;
  getDayExercises(dayId: string): Promise<Exercise[]>;
  createDay(name: string): Promise<WorkoutDay>;
  updateDayExercises(dayId: string, exerciseIds: string[]): Promise<void>;
  updateDayName(dayId: string, name: string): Promise<void>;

  getLastSetsForExercise(exerciseId: string, beforeDate: string): Promise<SetEntry[]>;

  startSession(workoutDayId: string | null, date: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  getLastSessionForDay(workoutDayId: string): Promise<Session | null>;
  getSessionForDayAndDate(workoutDayId: string, date: string): Promise<Session | null>;
  logExercise(sessionId: string, exerciseId: string, sets: SetEntry[]): Promise<void>;
  getExerciseHistory(exerciseId: string): Promise<Session[]>;
  listSessions(): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
}
