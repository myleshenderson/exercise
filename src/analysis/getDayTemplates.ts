import type {
  ExerciseRow,
  JsonValue,
  ProgramRow,
  SessionRow,
  SessionSetRow,
  WorkoutDayExerciseRow,
  WorkoutDayRow,
} from "./rows";
import { ascNullsLast, compareNumbers, groupByUuid, uuidKey } from "./sqlSemantics";

export interface GetDayTemplatesTables {
  /** Include soft-deleted days and programs; they are filtered here as the SQL does. */
  workoutDays: readonly Pick<WorkoutDayRow, "id" | "name" | "position" | "deleted_at" | "program_id" | "program_position">[];
  programs: readonly Pick<ProgramRow, "id" | "name" | "deleted_at">[];
  workoutDayExercises: readonly Pick<WorkoutDayExerciseRow, "workout_day_id" | "exercise_id" | "position" | "target_sets">[];
  exercises: readonly Pick<
    ExerciseRow,
    "id" | "name" | "cue" | "default_sets" | "default_rep_low" | "default_rep_high"
  >[];
  sessions: readonly Pick<SessionRow, "id" | "workout_day_id">[];
  sessionSets: readonly Pick<SessionSetRow, "session_id">[];
}

export interface GetDayTemplatesResult {
  workout_day_id: string;
  workout_day_name: string;
  workout_day_position: number;
  program_id: string | null;
  program_name: string | null;
  program_position: number | null;
  is_available: boolean;
  exercise_id: string | null;
  exercise_name: string | null;
  exercise_cue: string | null;
  exercise_position: number | null;
  target_sets: JsonValue;
  uses_default_scheme: boolean;
  default_sets: number | null;
  default_rep_low: number | null;
  default_rep_high: number | null;
}

/**
 * Day templates with their ordered exercises: one row per (day, attached
 * exercise), or one exercise-less row for a day with none. Mirrors
 * `public.get_day_templates` as last redefined in
 * `supabase/migrations/20260906180100_day_sequencing.sql` (earlier versions:
 * `0008_full_dump_rpc.sql`, `20260906170000_workout_days_soft_delete.sql`).
 *
 * Postgres semantics reproduced:
 * - Soft-deleted days (`deleted_at` not null) are excluded. A soft-deleted
 *   program is treated as absent (`program_id`, `program_name`,
 *   `program_position` null, `is_available` true). Soft-deleted exercises
 *   are not filtered.
 * - A day is "done" when any session referencing it has at least one set
 *   (soft-deleted days included). A program's next position is the minimum
 *   non-null `program_position` among its non-deleted, not-done days.
 *   `is_available` is `coalesce(p.id is null or program_position =
 *   next_position, false)`, so a null position or a fully completed program
 *   gives false.
 * - `uses_default_scheme` is `wde.target_sets is null`, so it is true for an
 *   exercise-less day row as well. Exercise columns come from the joined
 *   exercise and are null if it is not in the input.
 * - `order by wd.position, wde.position`, nulls last. Rows tied on both
 *   keys have no SQL order; here they keep their relative order from
 *   `workoutDays`, then `workoutDayExercises` (stable sort). As in SQL, two
 *   days sharing a position are not kept contiguous: their rows interleave
 *   by exercise position.
 * - A `target_sets` that is the jsonb scalar `null` (not SQL NULL) gives
 *   `uses_default_scheme` false in SQL; PostgREST returns both as JSON null,
 *   so here both count as SQL NULL.
 */
export function getDayTemplates(tables: GetDayTemplatesTables): GetDayTemplatesResult[] {
  const sessionsWithSets = new Set(tables.sessionSets.map((ss) => uuidKey(ss.session_id)));
  const doneDays = new Set<string>();
  for (const s of tables.sessions) {
    if (s.workout_day_id != null && sessionsWithSets.has(uuidKey(s.id))) doneDays.add(uuidKey(s.workout_day_id));
  }

  const nextPosition = new Map<string, number | null>();
  for (const wd of tables.workoutDays) {
    if (wd.program_id == null || wd.deleted_at != null || doneDays.has(uuidKey(wd.id))) continue;
    const key = uuidKey(wd.program_id);
    const current = nextPosition.get(key) ?? null;
    const pos = wd.program_position;
    nextPosition.set(key, pos == null ? current : current == null ? pos : Math.min(current, pos));
  }

  const programs = new Map(tables.programs.filter((p) => p.deleted_at == null).map((p) => [uuidKey(p.id), p]));
  const exercises = new Map(tables.exercises.map((e) => [uuidKey(e.id), e]));
  const attachmentsByDay = groupByUuid(tables.workoutDayExercises, (wde) => wde.workout_day_id);

  const rows: GetDayTemplatesResult[] = [];
  for (const wd of tables.workoutDays) {
    if (wd.deleted_at != null) continue;
    const program = wd.program_id == null ? undefined : programs.get(uuidKey(wd.program_id));
    let isAvailable: boolean;
    if (program === undefined) {
      isAvailable = true;
    } else {
      const next = nextPosition.get(uuidKey(program.id)) ?? null;
      isAvailable = wd.program_position != null && next != null && wd.program_position === next;
    }
    const dayColumns = {
      workout_day_id: wd.id,
      workout_day_name: wd.name,
      workout_day_position: wd.position,
      program_id: program?.id ?? null,
      program_name: program?.name ?? null,
      program_position: program === undefined ? null : wd.program_position,
      is_available: isAvailable,
    };
    const attachments = attachmentsByDay.get(uuidKey(wd.id)) ?? [];
    if (attachments.length === 0) {
      rows.push({
        ...dayColumns,
        exercise_id: null,
        exercise_name: null,
        exercise_cue: null,
        exercise_position: null,
        target_sets: null,
        uses_default_scheme: true,
        default_sets: null,
        default_rep_low: null,
        default_rep_high: null,
      });
      continue;
    }
    for (const wde of attachments) {
      const e = exercises.get(uuidKey(wde.exercise_id));
      rows.push({
        ...dayColumns,
        exercise_id: e?.id ?? null,
        exercise_name: e?.name ?? null,
        exercise_cue: e?.cue ?? null,
        exercise_position: wde.position,
        target_sets: wde.target_sets ?? null,
        uses_default_scheme: wde.target_sets == null,
        default_sets: e?.default_sets ?? null,
        default_rep_low: e?.default_rep_low ?? null,
        default_rep_high: e?.default_rep_high ?? null,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      compareNumbers(a.workout_day_position, b.workout_day_position) ||
      ascNullsLast(a.exercise_position, b.exercise_position, compareNumbers),
  );
}
