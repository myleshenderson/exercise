import type { SupabaseClient } from "@supabase/supabase-js";
import type { DataLayer } from "./DataLayer.js";
import type { Exercise, WorkoutDay, Session, SetEntry } from "../types.js";
import { getSupabase } from "./supabaseClient.js";

interface ExerciseRow {
  id: string;
  name: string;
  cue: string;
  default_sets: number;
  default_rep_low: number;
  default_rep_high: number;
}

const toExercise = (r: ExerciseRow): Exercise => ({
  id: r.id,
  name: r.name,
  cue: r.cue,
  defaultSets: r.default_sets,
  defaultRepLow: r.default_rep_low,
  defaultRepHigh: r.default_rep_high,
});

export async function createDay(client: SupabaseClient, name: string): Promise<WorkoutDay> {
  const { data, error } = await client.from("workout_days").insert({ name }).select("*").single();
  if (error) throw error;
  return { id: data.id, name: data.name, position: data.position, exerciseIds: [] };
}

export async function updateDayName(client: SupabaseClient, dayId: string, name: string): Promise<void> {
  const { error } = await client.from("workout_days").update({ name }).eq("id", dayId);
  if (error) throw error;
}

export async function updateDayExercises(client: SupabaseClient, dayId: string, exerciseIds: string[]): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_day_exercises")
    .select("exercise_id, target_sets")
    .eq("workout_day_id", dayId);
  if (selectError) throw selectError;
  const targetsByExercise: Record<string, unknown> = {};
  for (const row of existing ?? []) {
    if (row.target_sets) targetsByExercise[row.exercise_id] = row.target_sets;
  }
  await client.from("workout_day_exercises").delete().eq("workout_day_id", dayId);
  if (exerciseIds.length) {
    await client.from("workout_day_exercises").insert(
      exerciseIds.map((exercise_id, position) => ({
        workout_day_id: dayId,
        exercise_id,
        position,
        target_sets: targetsByExercise[exercise_id] ?? null,
      })),
    );
  }
}

export async function setDayExerciseTarget(
  client: SupabaseClient,
  dayId: string,
  exerciseId: string,
  sets: SetEntry[] | null,
): Promise<void> {
  const target_sets = sets && sets.length > 0 ? sets.map((s) => ({ weight: s.weight, reps: s.reps })) : null;
  const { error } = await client
    .from("workout_day_exercises")
    .update({ target_sets })
    .eq("workout_day_id", dayId)
    .eq("exercise_id", exerciseId);
  if (error) throw error;

  const { error: historyError } = await client.from("workout_day_exercise_scheme_history").insert({
    workout_day_id: dayId,
    exercise_id: exerciseId,
    target_sets,
  });
  if (historyError) throw historyError;
}

export async function createExercise(client: SupabaseClient, input: Omit<Exercise, "id">): Promise<Exercise> {
  const { data, error } = await client
    .from("exercises")
    .insert({
      name: input.name,
      cue: input.cue,
      default_sets: input.defaultSets,
      default_rep_low: input.defaultRepLow,
      default_rep_high: input.defaultRepHigh,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toExercise(data);
}

export async function deleteDay(client: SupabaseClient, dayId: string): Promise<void> {
  const { error } = await client.from("workout_days").delete().eq("id", dayId);
  if (error) throw error;
}

export async function addExerciseToDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void> {
  const { data: existing, error: selectError } = await client
    .from("workout_day_exercises")
    .select("position")
    .eq("workout_day_id", dayId)
    .order("position", { ascending: false })
    .limit(1);
  if (selectError) throw selectError;
  const nextPosition = existing && existing.length > 0 ? (existing[0].position as number) + 1 : 0;
  const { error } = await client
    .from("workout_day_exercises")
    .insert({ workout_day_id: dayId, exercise_id: exerciseId, position: nextPosition });
  if (error) throw error;
}

export async function removeExerciseFromDay(client: SupabaseClient, dayId: string, exerciseId: string): Promise<void> {
  const { error } = await client
    .from("workout_day_exercises")
    .delete()
    .eq("workout_day_id", dayId)
    .eq("exercise_id", exerciseId);
  if (error) throw error;
}

export function createSupabaseDataLayer(): DataLayer {
  const supabase = getSupabase();

  async function fetchExercise(id: string): Promise<Exercise | null> {
    const { data } = await supabase.from("exercises").select("*").eq("id", id).maybeSingle();
    return data ? toExercise(data) : null;
  }

  async function loadSession(id: string): Promise<Session | null> {
    const { data: s } = await supabase.from("sessions").select("*").eq("id", id).maybeSingle();
    if (!s) return null;
    const { data: sets } = await supabase
      .from("session_sets")
      .select("*")
      .eq("session_id", id)
      .order("set_number");
    const byExercise: Record<string, SetEntry[]> = {};
    for (const row of sets ?? []) {
      (byExercise[row.exercise_id] ??= []).push({
        setNumber: row.set_number,
        weight: Number(row.weight),
        reps: row.reps,
      });
    }
    return {
      id: s.id,
      workoutDayId: s.workout_day_id,
      performedOn: s.performed_on,
      exercises: Object.entries(byExercise).map(([exerciseId, exSets]) => ({ exerciseId, sets: exSets })),
    };
  }

  return {
    async listExercises() {
      const { data } = await supabase.from("exercises").select("*").order("name");
      return (data ?? []).map(toExercise);
    },
    getExercise: (id) => fetchExercise(id),
    createExercise: (input) => createExercise(supabase, input),
    async getWorkoutDays() {
      const { data } = await supabase.from("workout_days").select("*").order("position");
      const days: WorkoutDay[] = [];
      for (const d of data ?? []) {
        const { data: links } = await supabase
          .from("workout_day_exercises")
          .select("exercise_id, position")
          .eq("workout_day_id", d.id)
          .order("position");
        days.push({
          id: d.id,
          name: d.name,
          position: d.position,
          exerciseIds: (links ?? []).map((l) => l.exercise_id),
        });
      }
      return days;
    },
    async getDayExercises(dayId) {
      const { data: links } = await supabase
        .from("workout_day_exercises")
        .select("exercise_id, position")
        .eq("workout_day_id", dayId)
        .order("position");
      const out: Exercise[] = [];
      for (const l of links ?? []) {
        const ex = await fetchExercise(l.exercise_id);
        if (ex) out.push(ex);
      }
      return out;
    },
    createDay: (name) => createDay(supabase, name),
    deleteDay: (id) => deleteDay(supabase, id),
    addExerciseToDay: (dayId, exerciseId) => addExerciseToDay(supabase, dayId, exerciseId),
    removeExerciseFromDay: (dayId, exerciseId) => removeExerciseFromDay(supabase, dayId, exerciseId),
    updateDayExercises: (dayId, exerciseIds) => updateDayExercises(supabase, dayId, exerciseIds),
    updateDayName: (dayId, name) => updateDayName(supabase, dayId, name),
    async getDayExerciseTargets(dayId) {
      const { data } = await supabase
        .from("workout_day_exercises")
        .select("exercise_id, target_sets")
        .eq("workout_day_id", dayId);
      const out: Record<string, SetEntry[]> = {};
      for (const row of data ?? []) {
        const raw = row.target_sets as { weight: number; reps: number }[] | null;
        if (raw && raw.length > 0) {
          out[row.exercise_id] = raw.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps }));
        }
      }
      return out;
    },
    setDayExerciseTarget: (dayId, exerciseId, sets) => setDayExerciseTarget(supabase, dayId, exerciseId, sets),
    async getSchemeHistory(dayId, exerciseId) {
      const { data, error } = await supabase
        .from("workout_day_exercise_scheme_history")
        .select("target_sets, recorded_at")
        .eq("workout_day_id", dayId)
        .eq("exercise_id", exerciseId)
        .order("recorded_at");
      if (error) throw error;
      return (data ?? []).map((row) => {
        const raw = row.target_sets as { weight: number; reps: number }[] | null;
        const targetSets = raw && raw.length > 0 ? raw.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps })) : null;
        return { targetSets, recordedAt: row.recorded_at as string };
      });
    },
    async getLastSetsForExercise(exerciseId, beforeDate) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id, performed_on")
        .lt("performed_on", beforeDate)
        .order("performed_on", { ascending: false })
        .order("created_at", { ascending: false });
      for (const sess of s ?? []) {
        const { data: sets } = await supabase
          .from("session_sets")
          .select("*")
          .eq("session_id", sess.id)
          .eq("exercise_id", exerciseId)
          .order("set_number");
        if (sets && sets.length) {
          return sets.map((row) => ({ setNumber: row.set_number, weight: Number(row.weight), reps: row.reps }));
        }
      }
      return [];
    },
    async startSession(workoutDayId, date) {
      const { data, error } = await supabase
        .from("sessions")
        .insert({ workout_day_id: workoutDayId, performed_on: date })
        .select("*")
        .single();
      if (error) throw error;
      return { id: data.id, workoutDayId: data.workout_day_id, performedOn: data.performed_on, exercises: [] };
    },
    getSession: (id) => loadSession(id),
    async getLastSessionForDay(workoutDayId) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .eq("workout_day_id", workoutDayId)
        .order("performed_on", { ascending: false })
        .order("created_at", { ascending: false });
      for (const sess of s ?? []) {
        const full = await loadSession(sess.id);
        if (full && full.exercises.length > 0) return full;
      }
      return null;
    },
    async getSessionForDayAndDate(workoutDayId, date) {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .eq("workout_day_id", workoutDayId)
        .eq("performed_on", date)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!s) return null;
      return loadSession(s.id);
    },
    async logExercise(sessionId, exerciseId, sets) {
      await supabase.from("session_sets").delete().eq("session_id", sessionId).eq("exercise_id", exerciseId);
      if (sets.length) {
        await supabase.from("session_sets").insert(
          sets.map((s) => ({
            session_id: sessionId,
            exercise_id: exerciseId,
            set_number: s.setNumber,
            weight: s.weight,
            reps: s.reps,
          })),
        );
      }
    },
    async getExerciseHistory(exerciseId) {
      const { data: setRows } = await supabase
        .from("session_sets")
        .select("session_id")
        .eq("exercise_id", exerciseId);
      const ids = [...new Set((setRows ?? []).map((r) => r.session_id))];
      const sessions: Session[] = [];
      for (const id of ids) {
        const sess = await loadSession(id);
        if (sess) sessions.push(sess);
      }
      return sessions.sort((a, b) => (a.performedOn < b.performedOn ? 1 : -1));
    },
    async listSessions() {
      const { data: s } = await supabase
        .from("sessions")
        .select("id")
        .order("performed_on", { ascending: false })
        .order("created_at", { ascending: false });
      const sessions: Session[] = [];
      for (const row of s ?? []) {
        const sess = await loadSession(row.id);
        if (sess) sessions.push(sess);
      }
      return sessions;
    },
    async deleteSession(id) {
      const { error } = await supabase.from("sessions").delete().eq("id", id);
      if (error) throw error;
    },
  };
}
