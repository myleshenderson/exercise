export interface Exercise {
  id: string;
  name: string;
  cue: string;
  defaultSets: number;
  defaultRepLow: number;
  defaultRepHigh: number;
}

export interface Program {
  id: string;
  name: string;
}

export interface WorkoutDay {
  id: string;
  name: string;
  position: number;
  exerciseIds: string[]; // ordered
  programId: string | null;
  programPosition: number | null;
  programName: string | null; // null when programId is null, or when the program is soft-deleted
  isAvailable: boolean; // always true when programId is null; for a programmed day, true only for that program's current suggested day
}

export interface SetEntry {
  setNumber: number; // 1-based
  weight: number;
  reps: number;
}

export interface SessionExercise {
  exerciseId: string;
  sets: SetEntry[];
}

export interface Session {
  id: string;
  workoutDayId: string | null;
  performedOn: string; // "YYYY-MM-DD"
  exercises: SessionExercise[];
}
