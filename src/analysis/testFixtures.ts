// Row builders for the src/analysis tests. Every field not under test gets a
// fixed default so fixtures stay short.
import type {
  ExerciseRow,
  JsonValue,
  ProgramRow,
  SchemeHistoryRow,
  SessionRow,
  SessionSetRow,
  WorkoutDayExerciseRow,
  WorkoutDayRow,
} from "./rows.js";

const CREATED = "2026-01-01T00:00:00+00:00";

export function exercise(id: string, name: string, extra: Partial<ExerciseRow> = {}): ExerciseRow {
  return {
    id,
    name,
    cue: "",
    default_sets: 3,
    default_rep_low: 10,
    default_rep_high: 12,
    created_at: CREATED,
    deleted_at: null,
    ...extra,
  };
}

export function session(id: string, performed_on: string, workout_day_id: string | null = null): SessionRow {
  return { id, performed_on, workout_day_id, created_at: CREATED };
}

let setCounter = 0;
export function set(session_id: string, exercise_id: string, set_number: number, weight: number, reps: number): SessionSetRow {
  setCounter += 1;
  return { id: `set-${setCounter}`, session_id, exercise_id, set_number, weight, reps };
}

export function day(id: string, name: string, position: number, extra: Partial<WorkoutDayRow> = {}): WorkoutDayRow {
  return {
    id,
    name,
    position,
    created_at: CREATED,
    deleted_at: null,
    program_id: null,
    program_position: null,
    ...extra,
  };
}

export function program(id: string, name: string, deleted_at: string | null = null): ProgramRow {
  return { id, name, deleted_at, created_at: CREATED };
}

export function dayExercise(
  workout_day_id: string,
  exercise_id: string,
  position: number,
  target_sets: JsonValue = null,
): WorkoutDayExerciseRow {
  return { id: `${workout_day_id}/${exercise_id}`, workout_day_id, exercise_id, position, target_sets };
}

export function history(
  workout_day_id: string,
  exercise_id: string,
  recorded_at: string,
  target_sets: JsonValue,
): SchemeHistoryRow {
  return { id: `${workout_day_id}/${exercise_id}@${recorded_at}`, workout_day_id, exercise_id, recorded_at, target_sets };
}
