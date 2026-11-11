import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requiredEnv } from "./_env.js";
import { resolveIdentity, type IdentityResult } from "./mcp-auth.js";
import {
  createDay,
  updateDayName,
  deleteDay,
  createExercise,
  updateExercise,
  listExercises,
  deleteExercise,
  addExerciseToDay,
  removeExerciseFromDay,
  updateDayExercises,
  setDayExerciseTarget,
  createProgram,
  renameProgram,
  deleteProgram,
  addDayToProgram,
  removeDayFromProgram,
  reorderProgramDays,
  listExternalActivities,
  getExternalActivity,
  getActivityStreams,
  listBodyWeights,
  getAthleteSettings,
  listFtpHistory,
  listDailyTrainingLoad,
  listSyncState,
} from "../src/data/supabase.js";
import { createRideToolHandlers, type RideReads } from "../src/analysis/rides/index.js";
import { withDefaultToolArguments } from "../src/mcp/defaults.js";
import { registerTools, type McpToolHandlers } from "../src/mcp/handlers.js";
import {
  catchToolError,
  invalidIdError,
  toolError,
  toolResult,
  UUID_PATTERN,
  validateReps,
  validateSets,
  validateWeight,
} from "../src/mcp/format.js";

// Vercel's Node runtime pre-parses JSON request bodies onto req.body before
// invoking the handler; the SDK's Node types don't know about that.
type VercelRequest = IncomingMessage & { body?: unknown };

function extractBearerToken(req: VercelRequest): string | undefined {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
}

// apikey only gates Supabase's API gateway; the Postgres role PostgREST assumes comes
// from the Authorization JWT. Presenting the resolved user's access_token there (while
// apikey stays the service-role key) makes auth.uid() and RLS on the security-invoker
// RPC functions scope every result to that user alone.
function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function findDay(
  client: SupabaseClient,
  dayId: string,
): Promise<{ id: string; name: string; position: number; program_id: string | null } | null> {
  const { data, error } = await client
    .from("workout_days")
    .select("id, name, position, program_id")
    .eq("id", dayId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; name: string; position: number; program_id: string | null } | null) ?? null;
}

async function findExercise(client: SupabaseClient, exerciseId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await client.from("exercises").select("id, name").eq("id", exerciseId).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  return (data as { id: string; name: string } | null) ?? null;
}

// delete_exercise's guardrail against the "confusing surprising state" the design
// explicitly calls out (see exercise-2bv): a soft-deleted exercise still visibly
// attached wherever it's referenced, but invisible from list_exercises. Checked as
// three independent existence probes rather than one query, since usage can come
// from any of workout_day_exercises (current attachment), session_sets, or
// workout_day_exercise_scheme_history (both historical, so detaching from days alone
// wouldn't clear them).
async function exerciseUsage(client: SupabaseClient, exerciseId: string): Promise<"day" | "history" | null> {
  const { data: attached } = await client.from("workout_day_exercises").select("id").eq("exercise_id", exerciseId).limit(1);
  if (attached && attached.length) return "day";
  const { data: loggedSets } = await client.from("session_sets").select("id").eq("exercise_id", exerciseId).limit(1);
  if (loggedSets && loggedSets.length) return "history";
  const { data: schemeHistory } = await client
    .from("workout_day_exercise_scheme_history")
    .select("id")
    .eq("exercise_id", exerciseId)
    .limit(1);
  if (schemeHistory && schemeHistory.length) return "history";
  return null;
}

async function findProgram(client: SupabaseClient, programId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await client
    .from("programs")
    .select("id, name")
    .eq("id", programId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { id: string; name: string } | null) ?? null;
}

// The ride analytics tools' reads (AI-654): the src/data/supabase.ts functions over a
// client scoped to the caller's access_token, so RLS confines every read to their rows.
// Plain table reads: no RPC.
function rideReads(client: SupabaseClient): RideReads {
  return {
    listExternalActivities: (f) => listExternalActivities(client, f),
    getExternalActivity: (id) => getExternalActivity(client, id),
    getActivityStreams: (activityId) => getActivityStreams(client, activityId),
    listBodyWeights: (from, to) => listBodyWeights(client, from, to),
    getAthleteSettings: () => getAthleteSettings(client),
    listFtpHistory: () => listFtpHistory(client),
    listDailyTrainingLoad: (from, to) => listDailyTrainingLoad(client, from, to),
    listSyncState: () => listSyncState(client),
  };
}

// Just enough of the row to validate a rep-range patch against whichever bound the
// caller didn't supply, without pulling in supabase.ts's private toExercise mapping.
async function findExerciseRepRange(
  client: SupabaseClient,
  exerciseId: string,
): Promise<{ defaultRepLow: number; defaultRepHigh: number } | null> {
  const { data } = await client
    .from("exercises")
    .select("default_rep_low, default_rep_high")
    .eq("id", exerciseId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { default_rep_low: number; default_rep_high: number };
  return { defaultRepLow: row.default_rep_low, defaultRepHigh: row.default_rep_high };
}

// The Supabase-backed implementation of every tool in src/mcp/tools.ts. Each handler
// resolves the caller's identity (via the shared, memoized getIdentity) and reads or
// writes through a client scoped to that user's access_token, so RLS confines it to
// their rows.
function createSupabaseHandlers(getIdentity: () => Promise<IdentityResult>): McpToolHandlers {
  async function withIdentity(run: (accessToken: string) => Promise<CallToolResult>): Promise<CallToolResult> {
    const identity = await getIdentity();
    if (!identity.ok) return toolError(identity.error);
    return run(identity.accessToken);
  }

  function withWriteTool(
    toolName: string,
    run: (accessToken: string) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    return withIdentity((accessToken) => catchToolError(toolName, () => run(accessToken)));
  }

  return {
    // The seven ride analytics read tools, shared with Starkeep (src/analysis/rides).
    ...createRideToolHandlers((run) => withIdentity((accessToken) => run(rideReads(createUserScopedClient(accessToken))))),
    progression_for_exercise: async ({ exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("progression_for_exercise", {
          exercise_name,
        });
        if (error) return toolError(`progression_for_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
    sets_for_exercise: async ({ exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("sets_for_exercise", {
          exercise_name,
        });
        if (error) return toolError(`sets_for_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
    weekly_volume: async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("weekly_volume");
        if (error) return toolError(`weekly_volume failed: ${error.message}`);
        return toolResult(data);
      }),
    training_gaps: async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("training_gaps");
        if (error) return toolError(`training_gaps failed: ${error.message}`);
        return toolResult(data);
      }),
    get_day_templates: async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("get_day_templates");
        if (error) return toolError(`get_day_templates failed: ${error.message}`);
        return toolResult(data);
      }),
    get_workout_history: async ({ start_date, end_date, exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("get_workout_history", {
          start_date: start_date ?? null,
          end_date: end_date ?? null,
          exercise_name: exercise_name ?? null,
        });
        if (error) return toolError(`get_workout_history failed: ${error.message}`);
        return toolResult(data);
      }),
    scheme_history_for_day_exercise: async ({ workout_day_id, exercise_id }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("scheme_history_for_day_exercise", {
          workout_day_id,
          exercise_id,
        });
        if (error) return toolError(`scheme_history_for_day_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
    adherence_for_day: async ({ workout_day_id, start_date, end_date }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("adherence_for_day", {
          for_workout_day_id: workout_day_id ?? null,
          start_date: start_date ?? null,
          end_date: end_date ?? null,
        });
        if (error) return toolError(`adherence_for_day failed: ${error.message}`);
        return toolResult(data);
      }),
    create_day_template: async ({ name, program_id }) =>
      withWriteTool("create_day_template", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        if (program_id) {
          const program = await findProgram(client, program_id);
          if (!program) return toolError(`create_day_template failed: Program ${program_id} not found.`);
        }
        const day = await createDay(client, name);
        if (program_id) await addDayToProgram(client, day.id, program_id);
        // Explicit subset, not the raw `day` object: `day.programPosition`/`programName`/
        // `isAvailable` reflect its state from BEFORE the addDayToProgram call above (createDay
        // always returns an untracked day), so they'd be stale/wrong here. programId is the one
        // piece of program state worth echoing back, and is known directly from the input.
        return toolResult({ id: day.id, name: day.name, position: day.position, exerciseIds: day.exerciseIds, programId: program_id ?? null });
      }),
    rename_day_template: async ({ day_id, name }) =>
      withWriteTool("rename_day_template", async (accessToken) => {
        const dayIdError = invalidIdError("rename_day_template", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`rename_day_template failed: Day template ${day_id} not found.`);
        await updateDayName(client, day_id, name);
        return toolResult({ id: day.id, name, position: day.position });
      }),
    delete_day_template: async ({ day_id }) =>
      withWriteTool("delete_day_template", async (accessToken) => {
        const dayIdError = invalidIdError("delete_day_template", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`delete_day_template failed: Day template ${day_id} not found.`);
        await deleteDay(client, day_id);
        return toolResult({ id: day.id, name: day.name, deleted: true });
      }),
    create_exercise: async ({ name, cue, default_sets, default_rep_low, default_rep_high }) =>
      withWriteTool("create_exercise", async (accessToken) => {
        const repLow = default_rep_low ?? 10;
        const repHigh = default_rep_high ?? 12;
        const sets = default_sets ?? 3;
        const repLowError = validateReps(repLow);
        if (repLowError) return toolError(`create_exercise failed: default_rep_low ${repLowError}`);
        const repHighError = validateReps(repHigh);
        if (repHighError) return toolError(`create_exercise failed: default_rep_high ${repHighError}`);
        const setsError = validateSets(sets);
        if (setsError) return toolError(`create_exercise failed: default_sets ${setsError}`);

        const exercise = await createExercise(createUserScopedClient(accessToken), {
          name,
          cue: cue ?? "",
          defaultSets: sets,
          defaultRepLow: repLow,
          defaultRepHigh: repHigh,
        });
        return toolResult(exercise);
      }),
    update_exercise: async ({ id, name, cue, default_sets, default_rep_low, default_rep_high }) =>
      withWriteTool("update_exercise", async (accessToken) => {
        const idError = invalidIdError("update_exercise", "id", id);
        if (idError) return idError;
        if (
          name === undefined &&
          cue === undefined &&
          default_sets === undefined &&
          default_rep_low === undefined &&
          default_rep_high === undefined
        ) {
          return toolError("update_exercise failed: must provide at least one field to update.");
        }

        if (default_rep_low !== undefined) {
          const repLowError = validateReps(default_rep_low);
          if (repLowError) return toolError(`update_exercise failed: default_rep_low ${repLowError}`);
        }
        if (default_rep_high !== undefined) {
          const repHighError = validateReps(default_rep_high);
          if (repHighError) return toolError(`update_exercise failed: default_rep_high ${repHighError}`);
        }
        if (default_sets !== undefined) {
          const setsError = validateSets(default_sets);
          if (setsError) return toolError(`update_exercise failed: default_sets ${setsError}`);
        }

        const client = createUserScopedClient(accessToken);
        const existing = await findExerciseRepRange(client, id);
        if (!existing) return toolError(`update_exercise failed: Exercise ${id} not found.`);

        const nextRepLow = default_rep_low ?? existing.defaultRepLow;
        const nextRepHigh = default_rep_high ?? existing.defaultRepHigh;
        if (nextRepLow > nextRepHigh) {
          return toolError(
            `update_exercise failed: default_rep_low (${nextRepLow}) must be less than or equal to default_rep_high (${nextRepHigh}).`,
          );
        }

        const exercise = await updateExercise(client, id, {
          name,
          cue,
          defaultSets: default_sets,
          defaultRepLow: default_rep_low,
          defaultRepHigh: default_rep_high,
        });
        return toolResult(exercise);
      }),
    list_exercises: async () =>
      withIdentity(async (accessToken) => {
        const exercises = await listExercises(createUserScopedClient(accessToken));
        return toolResult(exercises);
      }),
    delete_exercise: async ({ exercise_id }) =>
      withWriteTool("delete_exercise", async (accessToken) => {
        const exerciseIdError = invalidIdError("delete_exercise", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const client = createUserScopedClient(accessToken);
        const exercise = await findExercise(client, exercise_id);
        if (!exercise) return toolError(`delete_exercise failed: Exercise ${exercise_id} not found.`);

        const usage = await exerciseUsage(client, exercise_id);
        if (usage === "day") {
          return toolError(
            `delete_exercise failed: Exercise ${exercise_id} is attached to one or more days; use remove_exercise_from_day to detach it first.`,
          );
        }
        if (usage === "history") {
          return toolError(`delete_exercise failed: Exercise ${exercise_id} has logged sets or scheme history and cannot be deleted.`);
        }

        await deleteExercise(client, exercise_id);
        return toolResult({ id: exercise.id, name: exercise.name, deleted: true });
      }),
    add_exercise_to_day: async ({ day_id, exercise_id }) =>
      withWriteTool("add_exercise_to_day", async (accessToken) => {
        const dayIdError = invalidIdError("add_exercise_to_day", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const exerciseIdError = invalidIdError("add_exercise_to_day", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`add_exercise_to_day failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(client, exercise_id);
        if (!exercise) return toolError(`add_exercise_to_day failed: Exercise ${exercise_id} not found.`);

        const { data: existing, error: existingError } = await client
          .from("workout_day_exercises")
          .select("id")
          .eq("workout_day_id", day_id)
          .eq("exercise_id", exercise_id)
          .maybeSingle();
        if (existingError) return toolError(`add_exercise_to_day failed: ${existingError.message}`);
        if (existing) return toolError(`add_exercise_to_day failed: Exercise ${exercise_id} is already on day ${day_id}.`);

        await addExerciseToDay(client, day_id, exercise_id);
        return toolResult({ day_id, exercise_id });
      }),
    remove_exercise_from_day: async ({ day_id, exercise_id }) =>
      withWriteTool("remove_exercise_from_day", async (accessToken) => {
        const dayIdError = invalidIdError("remove_exercise_from_day", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const exerciseIdError = invalidIdError("remove_exercise_from_day", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`remove_exercise_from_day failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(client, exercise_id);
        if (!exercise) return toolError(`remove_exercise_from_day failed: Exercise ${exercise_id} not found.`);

        await removeExerciseFromDay(client, day_id, exercise_id);
        return toolResult({ day_id, exercise_id, removed: true });
      }),
    reorder_day_exercises: async ({ day_id, exercise_ids }) =>
      withWriteTool("reorder_day_exercises", async (accessToken) => {
        const dayIdError = invalidIdError("reorder_day_exercises", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const invalidExerciseIds = exercise_ids.filter((id) => !UUID_PATTERN.test(id));
        if (invalidExerciseIds.length) {
          return toolError(
            `reorder_day_exercises failed: expected UUIDs for exercise_ids, got ${invalidExerciseIds.map((id) => `"${id}"`).join(", ")}.`,
          );
        }

        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`reorder_day_exercises failed: Day template ${day_id} not found.`);

        if (new Set(exercise_ids).size !== exercise_ids.length) {
          return toolError(`reorder_day_exercises failed: exercise_ids contains duplicate ids.`);
        }

        const { data: current, error: selectError } = await client
          .from("workout_day_exercises")
          .select("exercise_id")
          .eq("workout_day_id", day_id);
        if (selectError) return toolError(`reorder_day_exercises failed: ${selectError.message}`);

        const currentIds = new Set((current ?? []).map((r: { exercise_id: string }) => r.exercise_id));
        const requestedIds = new Set(exercise_ids);
        const missing = [...currentIds].filter((id) => !requestedIds.has(id));
        const extra = [...requestedIds].filter((id) => !currentIds.has(id));
        if (missing.length || extra.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`missing [${missing.join(", ")}]`);
          if (extra.length) parts.push(`unexpected [${extra.join(", ")}]`);
          return toolError(
            `reorder_day_exercises failed: exercise_ids ${parts.join(" and ")}. Use add_exercise_to_day/remove_exercise_from_day to change membership instead.`,
          );
        }

        await updateDayExercises(client, day_id, exercise_ids);
        return toolResult({ day_id, exercise_ids });
      }),
    set_day_exercise_scheme: async ({ day_id, exercise_id, sets }) =>
      withWriteTool("set_day_exercise_scheme", async (accessToken) => {
        const dayIdError = invalidIdError("set_day_exercise_scheme", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const exerciseIdError = invalidIdError("set_day_exercise_scheme", "exercise_id", exercise_id);
        if (exerciseIdError) return exerciseIdError;
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`set_day_exercise_scheme failed: Day template ${day_id} not found.`);
        const exercise = await findExercise(client, exercise_id);
        if (!exercise) return toolError(`set_day_exercise_scheme failed: Exercise ${exercise_id} not found.`);

        const { data: attachment, error: attachmentError } = await client
          .from("workout_day_exercises")
          .select("id")
          .eq("workout_day_id", day_id)
          .eq("exercise_id", exercise_id)
          .maybeSingle();
        if (attachmentError) return toolError(`set_day_exercise_scheme failed: ${attachmentError.message}`);
        if (!attachment) return toolError(`set_day_exercise_scheme failed: Exercise ${exercise_id} is not on day ${day_id}.`);

        if (sets) {
          for (const [i, s] of sets.entries()) {
            const weightError = validateWeight(s.weight);
            if (weightError) return toolError(`set_day_exercise_scheme failed: set ${i + 1} weight ${weightError}`);
            const repsError = validateReps(s.reps);
            if (repsError) return toolError(`set_day_exercise_scheme failed: set ${i + 1} reps ${repsError}`);
          }
        }

        const setEntries =
          sets && sets.length > 0 ? sets.map((s, i) => ({ setNumber: i + 1, weight: s.weight, reps: s.reps })) : null;
        await setDayExerciseTarget(client, day_id, exercise_id, setEntries);
        return toolResult({ day_id, exercise_id, sets: setEntries });
      }),
    create_program: async ({ name }) =>
      withWriteTool("create_program", async (accessToken) => {
        const program = await createProgram(createUserScopedClient(accessToken), name);
        return toolResult(program);
      }),
    rename_program: async ({ program_id, name }) =>
      withWriteTool("rename_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`rename_program failed: Program ${program_id} not found.`);
        await renameProgram(client, program_id, name);
        return toolResult({ id: program.id, name });
      }),
    delete_program: async ({ program_id }) =>
      withWriteTool("delete_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`delete_program failed: Program ${program_id} not found.`);
        await deleteProgram(client, program_id);
        return toolResult({ id: program.id, name: program.name, deleted: true });
      }),
    add_day_to_program: async ({ day_id, program_id }) =>
      withWriteTool("add_day_to_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`add_day_to_program failed: Day template ${day_id} not found.`);
        if (day.program_id) {
          return toolError(`add_day_to_program failed: Day ${day_id} is already in program ${day.program_id}; remove it first.`);
        }
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`add_day_to_program failed: Program ${program_id} not found.`);
        await addDayToProgram(client, day_id, program_id);
        return toolResult({ day_id, program_id });
      }),
    remove_day_from_program: async ({ day_id }) =>
      withWriteTool("remove_day_from_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`remove_day_from_program failed: Day template ${day_id} not found.`);
        await removeDayFromProgram(client, day_id);
        return toolResult({ day_id, removed: true });
      }),
    reorder_program_days: async ({ program_id, day_ids }) =>
      withWriteTool("reorder_program_days", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`reorder_program_days failed: Program ${program_id} not found.`);

        if (new Set(day_ids).size !== day_ids.length) {
          return toolError(`reorder_program_days failed: day_ids contains duplicate ids.`);
        }

        const { data: current, error: selectError } = await client
          .from("workout_days")
          .select("id")
          .eq("program_id", program_id)
          .is("deleted_at", null);
        if (selectError) return toolError(`reorder_program_days failed: ${selectError.message}`);

        const currentIds = new Set((current ?? []).map((r: { id: string }) => r.id));
        const requestedIds = new Set(day_ids);
        const missing = [...currentIds].filter((id) => !requestedIds.has(id));
        const extra = [...requestedIds].filter((id) => !currentIds.has(id));
        if (missing.length || extra.length) {
          const parts: string[] = [];
          if (missing.length) parts.push(`missing [${missing.join(", ")}]`);
          if (extra.length) parts.push(`unexpected [${extra.join(", ")}]`);
          return toolError(
            `reorder_program_days failed: day_ids ${parts.join(" and ")}. Use add_day_to_program/remove_day_from_program to change membership instead.`,
          );
        }

        await reorderProgramDays(client, program_id, day_ids);
        return toolResult({ program_id, day_ids });
      }),
  };
}

function createMcpServer(bearerToken: string | undefined): McpServer {
  const server = new McpServer({ name: "exercise-mcp", version: "0.1.0" });

  // Resolved lazily, on the first tool call, rather than eagerly for every request:
  // initialize and tools/list never need a user identity (and shouldn't need Supabase
  // env configured to succeed), and resolving one rotates the caller's stored
  // refresh_token — so doing it eagerly would burn a rotation for requests that never
  // needed one. Memoized so that if a single invocation calls more than one tool (e.g.
  // a batched JSON-RPC request), they share one resolution instead of each rotating
  // the refresh_token out from under the others.
  let identityPromise: Promise<IdentityResult> | undefined;
  function getIdentity(): Promise<IdentityResult> {
    if (!identityPromise) {
      const url = requiredEnv("SUPABASE_URL");
      const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
      // Two separate client instances, not one shared: resolveIdentity calls
      // .auth.refreshSession() on authClient, which would otherwise silently swap
      // the service-role identity for the refreshed user's on every subsequent
      // .from() call on the same client (see mcp-auth.ts's AuthDeps comment).
      identityPromise = resolveIdentity(bearerToken, {
        client: createClient(url, key),
        authClient: createClient(url, key),
      });
    }
    return identityPromise;
  }

  registerTools(server, createSupabaseHandlers(getIdentity));
  return server;
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  // The standalone GET stream is for server-initiated notifications over a
  // long-lived connection, which doesn't fit a serverless function's
  // per-invocation lifetime. Reject it instead of hanging until the
  // platform's function timeout kills the invocation.
  if (req.method === "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return;
  }

  // Stateless per the SDK's serverless pattern: a fresh server + transport
  // per invocation, since Vercel gives no guarantee of process reuse between
  // requests and a stateless transport can't be reused across requests anyway.
  const server = createMcpServer(extractBearerToken(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Return the JSON-RPC response directly instead of opening an SSE
    // stream, since a serverless invocation ends once the response is sent.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, withDefaultToolArguments(req.body));
}
