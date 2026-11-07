import type { Exercise, WorkoutDay, Session, SetEntry, Program } from "../types.js";

/** A live (not soft-deleted) workout day as the name lookups return it. */
export type DayLookup = Pick<WorkoutDay, "id" | "name" | "position" | "programId" | "programPosition">;

export interface DataLayer {
  listExercises(): Promise<Exercise[]>;
  getExercise(id: string): Promise<Exercise | null>;
  createExercise(input: Omit<Exercise, "id">): Promise<Exercise>;
  // Only fields present (non-undefined) in `patch` change. Throws when no
  // exercise has that id.
  updateExercise(id: string, patch: Partial<Omit<Exercise, "id">>): Promise<Exercise>;
  // Soft-deletes the exercise (it drops out of listExercises). The Starkeep
  // backend refuses (ExerciseInUseError) while the exercise is attached to a
  // day or has logged sets or scheme history; Supabase leaves that check to
  // its MCP caller (api/mcp.ts exerciseUsage).
  deleteExercise(id: string): Promise<void>;

  // Exact, case-sensitive name lookups over live (not soft-deleted) rows. With
  // several matches, the earliest created wins. null when nothing matches.
  findDayByName(name: string): Promise<DayLookup | null>;
  findExerciseByName(name: string): Promise<Exercise | null>;
  findProgramByName(name: string): Promise<Program | null>;

  // Atomically claims the right to run first-login seeding for the current
  // user: returns true for exactly one caller among any concurrent callers,
  // false for every other one (they must not seed). Guards against the
  // ensureSeeded() race — see exercise-c9l and 0014_seed_claims.sql.
  claimSeed(): Promise<boolean>;

  getWorkoutDays(): Promise<WorkoutDay[]>;
  getDayExercises(dayId: string): Promise<Exercise[]>;
  createDay(name: string): Promise<WorkoutDay>;
  deleteDay(id: string): Promise<void>;
  addExerciseToDay(dayId: string, exerciseId: string): Promise<void>;
  removeExerciseFromDay(dayId: string, exerciseId: string): Promise<void>;
  updateDayExercises(dayId: string, exerciseIds: string[]): Promise<void>;
  updateDayName(dayId: string, name: string): Promise<void>;
  createProgram(name: string): Promise<Program>;
  renameProgram(programId: string, name: string): Promise<void>;
  deleteProgram(programId: string): Promise<void>;
  addDayToProgram(dayId: string, programId: string): Promise<void>;
  removeDayFromProgram(dayId: string): Promise<void>;
  reorderProgramDays(programId: string, dayIds: string[]): Promise<void>;
  getDayExerciseTargets(dayId: string): Promise<Record<string, SetEntry[]>>;
  setDayExerciseTarget(dayId: string, exerciseId: string, sets: SetEntry[] | null): Promise<void>;
  getSchemeHistory(dayId: string, exerciseId: string): Promise<{ targetSets: SetEntry[] | null; recordedAt: string }[]>;

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
