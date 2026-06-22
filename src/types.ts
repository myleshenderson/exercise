export interface Exercise {
  id: string;
  name: string;
  cue: string;
  defaultSets: number;
  defaultRepLow: number;
  defaultRepHigh: number;
}

export interface WorkoutDay {
  id: string;
  name: string;
  position: number;
  exerciseIds: string[]; // ordered
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
