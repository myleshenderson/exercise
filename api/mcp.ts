import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requiredEnv } from "./_env.js";
import { resolveIdentity, type IdentityResult } from "./mcp-auth.js";
import {
  createDay,
  updateDayName,
  deleteDay,
  createExercise,
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
} from "../src/data/supabase.js";

// Vercel's Node runtime pre-parses JSON request bodies onto req.body before
// invoking the handler; the SDK's Node types don't know about that.
type VercelRequest = IncomingMessage & { body?: unknown };

function extractBearerToken(req: VercelRequest): string | undefined {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every *_id parameter on these tools targets a Postgres `uuid` column (see
// supabase/migrations/0001_init.sql), so a non-UUID value can never match a row. Rejecting
// it up front lets us say so plainly, instead of running the lookup and reporting a
// misleading "not found" for what's actually a malformed argument (e.g. a name passed
// where an id was expected).
function invalidIdError(toolName: string, paramName: string, value: string): CallToolResult | undefined {
  if (UUID_PATTERN.test(value)) return undefined;
  return toolError(`${toolName} failed: expected a UUID for ${paramName}, got "${value}".`);
}

function toolResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// The MCP spec makes a tools/call request's `arguments` field optional, so a
// spec-compliant client calling a tool whose schema is all-optional fields (e.g.
// get_workout_history's filters) may omit it entirely rather than sending `{}`.
// The SDK's zod-based validation requires an actual object once a tool has any
// inputSchema, though, and rejects `undefined` even when every field is optional -
// so default it here before it reaches that validation. Handles both a single
// JSON-RPC message and a batched array of them.
function withDefaultToolArguments(body: unknown): unknown {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (message && typeof message === "object" && (message as Record<string, unknown>).method === "tools/call") {
      const params = (message as Record<string, unknown>).params;
      if (params && typeof params === "object" && (params as Record<string, unknown>).arguments === undefined) {
        (params as Record<string, unknown>).arguments = {};
      }
    }
  }
  return body;
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
  const { data } = await client
    .from("workout_days")
    .select("id, name, position, program_id")
    .eq("id", dayId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as { id: string; name: string; position: number; program_id: string | null } | null) ?? null;
}

async function findExercise(client: SupabaseClient, exerciseId: string): Promise<{ id: string; name: string } | null> {
  const { data } = await client.from("exercises").select("id, name").eq("id", exerciseId).is("deleted_at", null).maybeSingle();
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

function validateReps(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 40) return "must be an integer between 1 and 40.";
  return undefined;
}

function validateWeight(value: number): string | undefined {
  if (!(value >= 0 && value <= 500)) return "must be between 0 and 500.";
  return undefined;
}

function validateSets(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 10) return "must be an integer between 1 and 10.";
  return undefined;
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

  async function withIdentity(run: (accessToken: string) => Promise<CallToolResult>): Promise<CallToolResult> {
    const identity = await getIdentity();
    if (!identity.ok) return toolError(identity.error);
    return run(identity.accessToken);
  }

  function withWriteTool(
    toolName: string,
    run: (accessToken: string) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    return withIdentity(async (accessToken) => {
      try {
        return await run(accessToken);
      } catch (e) {
        const message = e instanceof Error ? e.message : ((e as { message?: string })?.message ?? String(e));
        return toolError(`${toolName} failed: ${message}`);
      }
    });
  }

  server.registerTool(
    "progression_for_exercise",
    {
      title: "Progression for exercise",
      description:
        "Per-session set count, top weight, and volume for an exercise (matched by partial name), for the authenticated user.",
      inputSchema: { exercise_name: z.string() },
    },
    async ({ exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("progression_for_exercise", {
          exercise_name,
        });
        if (error) return toolError(`progression_for_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "sets_for_exercise",
    {
      title: "Sets for exercise",
      description:
        "Every individual logged set for an exercise (matched by partial name), ungrouped — performed_on, set_number, weight, and reps — for the authenticated user.",
      inputSchema: { exercise_name: z.string() },
    },
    async ({ exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("sets_for_exercise", {
          exercise_name,
        });
        if (error) return toolError(`sets_for_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "weekly_volume",
    {
      title: "Weekly volume",
      description: "Sessions and total volume per week for the authenticated user.",
    },
    async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("weekly_volume");
        if (error) return toolError(`weekly_volume failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "training_gaps",
    {
      title: "Training gaps",
      description: "Days elapsed between consecutive training sessions for the authenticated user.",
    },
    async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("training_gaps");
        if (error) return toolError(`training_gaps failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "get_day_templates",
    {
      title: "Day templates",
      description:
        "The authenticated user's day templates with their ordered exercises and each exercise's day-specific progressive scheme, or its uniform defaults when none is set.",
    },
    async () =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("get_day_templates");
        if (error) return toolError(`get_day_templates failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "get_workout_history",
    {
      title: "Workout history",
      description:
        "The authenticated user's full raw session history: every session with its date, associated day, and every logged set, unaggregated. Optionally filter by date range (start_date/end_date) and/or a partial exercise-name match; omit all filters for the full history.",
      inputSchema: {
        start_date: z.string().optional().describe("Only include sessions performed on or after this date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("Only include sessions performed on or before this date (YYYY-MM-DD)."),
        exercise_name: z.string().optional().describe("Only include sets for exercises whose name partially matches this (case-insensitive)."),
      },
    },
    async ({ start_date, end_date, exercise_name }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("get_workout_history", {
          start_date: start_date ?? null,
          end_date: end_date ?? null,
          exercise_name: exercise_name ?? null,
        });
        if (error) return toolError(`get_workout_history failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "scheme_history_for_day_exercise",
    {
      title: "Scheme history for day/exercise",
      description:
        "Every recorded progressive-scheme version for a (workout_day_id, exercise_id) pair, ordered by recorded_at, for the authenticated user — use a <= filter on recorded_at and take the latest row to find which scheme was in effect at or before a given date.",
      inputSchema: { workout_day_id: z.string(), exercise_id: z.string() },
    },
    async ({ workout_day_id, exercise_id }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("scheme_history_for_day_exercise", {
          workout_day_id,
          exercise_id,
        });
        if (error) return toolError(`scheme_history_for_day_exercise failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "adherence_for_day",
    {
      title: "Adherence for day",
      description:
        "Compares the authenticated user's actual logged sets against the prescribed target for the same (day, exercise) pairing and session date - the scheme actually in effect on that date (via point-in-time history), falling back to the exercise's uniform defaults when no scheme was ever defined. Flags under-/over-shooting on sets, reps, and weight. Optionally filter by workout_day_id and/or a date range (start_date/end_date); omit all filters for every day and date.",
      inputSchema: {
        workout_day_id: z.string().optional().describe("Only include sessions for this workout day."),
        start_date: z.string().optional().describe("Only include sessions performed on or after this date (YYYY-MM-DD)."),
        end_date: z.string().optional().describe("Only include sessions performed on or before this date (YYYY-MM-DD)."),
      },
    },
    async ({ workout_day_id, start_date, end_date }) =>
      withIdentity(async (accessToken) => {
        const { data, error } = await createUserScopedClient(accessToken).rpc("adherence_for_day", {
          for_workout_day_id: workout_day_id ?? null,
          start_date: start_date ?? null,
          end_date: end_date ?? null,
        });
        if (error) return toolError(`adherence_for_day failed: ${error.message}`);
        return toolResult(data);
      }),
  );

  server.registerTool(
    "create_day_template",
    {
      title: "Create day template",
      description:
        "Creates a new, empty day template for the authenticated user. Returns the new day, including its id. If program_id is given, appends the day to the end of that program.",
      inputSchema: { name: z.string(), program_id: z.string().optional() },
    },
    async ({ name, program_id }) =>
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
  );

  server.registerTool(
    "rename_day_template",
    {
      title: "Rename day template",
      description: "Renames an existing day template belonging to the authenticated user, targeted by id.",
      inputSchema: { day_id: z.string(), name: z.string() },
    },
    async ({ day_id, name }) =>
      withWriteTool("rename_day_template", async (accessToken) => {
        const dayIdError = invalidIdError("rename_day_template", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`rename_day_template failed: Day template ${day_id} not found.`);
        await updateDayName(client, day_id, name);
        return toolResult({ id: day.id, name, position: day.position });
      }),
  );

  server.registerTool(
    "delete_day_template",
    {
      title: "Delete day template",
      description:
        "Soft-deletes a day template belonging to the authenticated user, targeted by id: marks it deleted so it no longer appears in get_day_templates or accepts further edits, but its exercise attachments, scheme history, and any sessions that referenced it are left untouched — historical scheme_history_for_day_exercise/adherence_for_day lookups keep working.",
      inputSchema: { day_id: z.string() },
    },
    async ({ day_id }) =>
      withWriteTool("delete_day_template", async (accessToken) => {
        const dayIdError = invalidIdError("delete_day_template", "day_id", day_id);
        if (dayIdError) return dayIdError;
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`delete_day_template failed: Day template ${day_id} not found.`);
        await deleteDay(client, day_id);
        return toolResult({ id: day.id, name: day.name, deleted: true });
      }),
  );

  server.registerTool(
    "create_exercise",
    {
      title: "Create exercise",
      description:
        "Creates a catalog exercise not yet attached to any day, for the authenticated user. Omitted optionals fall back to the same defaults as the exercises table's own column defaults.",
      inputSchema: {
        name: z.string(),
        cue: z.string().optional(),
        default_sets: z.number().optional(),
        default_rep_low: z.number().optional(),
        default_rep_high: z.number().optional(),
      },
    },
    async ({ name, cue, default_sets, default_rep_low, default_rep_high }) =>
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
  );

  server.registerTool(
    "list_exercises",
    {
      title: "List exercises",
      description:
        "Every catalog exercise for the authenticated user, including ones not attached to any day. Excludes soft-deleted exercises.",
    },
    async () =>
      withIdentity(async (accessToken) => {
        const exercises = await listExercises(createUserScopedClient(accessToken));
        return toolResult(exercises);
      }),
  );

  server.registerTool(
    "delete_exercise",
    {
      title: "Delete exercise",
      description:
        "Soft-deletes a catalog exercise belonging to the authenticated user, targeted by id: marks it deleted so it no longer appears in list_exercises. Rejected outright if the exercise is still attached to any day or referenced by logged sets/scheme history — detach it from days first via remove_exercise_from_day.",
      inputSchema: { exercise_id: z.string() },
    },
    async ({ exercise_id }) =>
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
  );

  server.registerTool(
    "add_exercise_to_day",
    {
      title: "Add exercise to day",
      description: "Appends an existing catalog exercise to the end of a day template's exercise list, for the authenticated user.",
      inputSchema: { day_id: z.string(), exercise_id: z.string() },
    },
    async ({ day_id, exercise_id }) =>
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
  );

  server.registerTool(
    "remove_exercise_from_day",
    {
      title: "Remove exercise from day",
      description: "Removes one exercise from a day template, for the authenticated user. Touches only that one attachment.",
      inputSchema: { day_id: z.string(), exercise_id: z.string() },
    },
    async ({ day_id, exercise_id }) =>
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
  );

  server.registerTool(
    "reorder_day_exercises",
    {
      title: "Reorder day exercises",
      description:
        "Rewrites a day template's exercise order for the authenticated user. exercise_ids must be exactly the day's current exercise-id set (same members, any order); membership changes must go through add_exercise_to_day/remove_exercise_from_day instead.",
      inputSchema: { day_id: z.string(), exercise_ids: z.array(z.string()) },
    },
    async ({ day_id, exercise_ids }) =>
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
  );

  server.registerTool(
    "set_day_exercise_scheme",
    {
      title: "Set day exercise scheme",
      description:
        "Sets the day-specific rep/weight scheme for one exercise on one day, for the authenticated user. null (or an empty array) clears it, reverting that exercise to its own uniform defaults on that day.",
      inputSchema: {
        day_id: z.string(),
        exercise_id: z.string(),
        sets: z.array(z.object({ weight: z.number(), reps: z.number() })).nullable(),
      },
    },
    async ({ day_id, exercise_id, sets }) =>
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
  );

  server.registerTool(
    "create_program",
    {
      title: "Create program",
      description: "Creates a new, empty program for the authenticated user. Returns it, including its id.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) =>
      withWriteTool("create_program", async (accessToken) => {
        const program = await createProgram(createUserScopedClient(accessToken), name);
        return toolResult(program);
      }),
  );

  server.registerTool(
    "rename_program",
    {
      title: "Rename program",
      description: "Renames an existing program belonging to the authenticated user, targeted by id.",
      inputSchema: { program_id: z.string(), name: z.string() },
    },
    async ({ program_id, name }) =>
      withWriteTool("rename_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`rename_program failed: Program ${program_id} not found.`);
        await renameProgram(client, program_id, name);
        return toolResult({ id: program.id, name });
      }),
  );

  server.registerTool(
    "delete_program",
    {
      title: "Delete program",
      description:
        "Soft-deletes a program belonging to the authenticated user, targeted by id: it's no longer a valid target for other program tools, but member days keep their program_id/program_position (not unassigned), so the program's structure and completion history survive and get_day_templates treats its former days as untracked (always available) in the meantime.",
      inputSchema: { program_id: z.string() },
    },
    async ({ program_id }) =>
      withWriteTool("delete_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const program = await findProgram(client, program_id);
        if (!program) return toolError(`delete_program failed: Program ${program_id} not found.`);
        await deleteProgram(client, program_id);
        return toolResult({ id: program.id, name: program.name, deleted: true });
      }),
  );

  server.registerTool(
    "add_day_to_program",
    {
      title: "Add day to program",
      description:
        "Assigns an existing day template to a program, appended at the end. Errors if the day already belongs to a program; use remove_day_from_program first to reassign it.",
      inputSchema: { day_id: z.string(), program_id: z.string() },
    },
    async ({ day_id, program_id }) =>
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
  );

  server.registerTool(
    "remove_day_from_program",
    {
      title: "Remove day from program",
      description: "Clears a day template's program assignment, reverting it to untracked (always available).",
      inputSchema: { day_id: z.string() },
    },
    async ({ day_id }) =>
      withWriteTool("remove_day_from_program", async (accessToken) => {
        const client = createUserScopedClient(accessToken);
        const day = await findDay(client, day_id);
        if (!day) return toolError(`remove_day_from_program failed: Day template ${day_id} not found.`);
        await removeDayFromProgram(client, day_id);
        return toolResult({ day_id, removed: true });
      }),
  );

  server.registerTool(
    "reorder_program_days",
    {
      title: "Reorder program days",
      description:
        "Rewrites a program's day order for the authenticated user. day_ids must be exactly the program's current membership (same members, any order); membership changes must go through add_day_to_program/remove_day_from_program instead.",
      inputSchema: { program_id: z.string(), day_ids: z.array(z.string()) },
    },
    async ({ program_id, day_ids }) =>
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
  );

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
