import { z } from "zod";

// The 25 MCP tools exposed by every backend (the Vercel/Supabase server in
// api/mcp.ts today, Starkeep next): name, title, description and zod input shape.
// Data access lives in each backend's McpToolHandlers (see ./handlers.ts); nothing
// here may import from api/, src/data/ or @supabase/*.
//
// Array order is registration order, which is the order tools/list returns them in.
// A tool with `inputSchema: undefined` is registered with no input schema at all
// (not an empty shape): the SDK then skips argument validation for it, which is
// how these tools have always behaved.
//
// Every *_id parameter targets a Postgres `uuid` column, but the schemas stay plain
// z.string(): malformed ids are rejected by the handlers with a tool error (see
// invalidIdError in ./format.ts), not by schema validation.
export const TOOL_DEFINITIONS = [
  {
    name: "progression_for_exercise",
    title: "Progression for exercise",
    description:
      "Per-session set count, top weight, and volume for an exercise (matched by partial name), for the authenticated user.",
    inputSchema: { exercise_name: z.string() },
  },
  {
    name: "sets_for_exercise",
    title: "Sets for exercise",
    description:
      "Every individual logged set for an exercise (matched by partial name), ungrouped — performed_on, set_number, weight, and reps — for the authenticated user.",
    inputSchema: { exercise_name: z.string() },
  },
  {
    name: "weekly_volume",
    title: "Weekly volume",
    description: "Sessions and total volume per week for the authenticated user.",
    inputSchema: undefined,
  },
  {
    name: "training_gaps",
    title: "Training gaps",
    description: "Days elapsed between consecutive training sessions for the authenticated user.",
    inputSchema: undefined,
  },
  {
    name: "get_day_templates",
    title: "Day templates",
    description:
      "The authenticated user's day templates with their ordered exercises and each exercise's day-specific progressive scheme, or its uniform defaults when none is set.",
    inputSchema: undefined,
  },
  {
    name: "get_workout_history",
    title: "Workout history",
    description:
      "The authenticated user's full raw session history: every session with its date, associated day, and every logged set, unaggregated. Optionally filter by date range (start_date/end_date) and/or a partial exercise-name match; omit all filters for the full history.",
    inputSchema: {
      start_date: z.string().optional().describe("Only include sessions performed on or after this date (YYYY-MM-DD)."),
      end_date: z.string().optional().describe("Only include sessions performed on or before this date (YYYY-MM-DD)."),
      exercise_name: z.string().optional().describe("Only include sets for exercises whose name partially matches this (case-insensitive)."),
    },
  },
  {
    name: "scheme_history_for_day_exercise",
    title: "Scheme history for day/exercise",
    description:
      "Every recorded progressive-scheme version for a (workout_day_id, exercise_id) pair, ordered by recorded_at, for the authenticated user — use a <= filter on recorded_at and take the latest row to find which scheme was in effect at or before a given date.",
    inputSchema: { workout_day_id: z.string(), exercise_id: z.string() },
  },
  {
    name: "adherence_for_day",
    title: "Adherence for day",
    description:
      "Compares the authenticated user's actual logged sets against the prescribed target for the same (day, exercise) pairing and session date - the scheme actually in effect on that date (via point-in-time history), falling back to the exercise's uniform defaults when no scheme was ever defined. Flags under-/over-shooting on sets, reps, and weight. Optionally filter by workout_day_id and/or a date range (start_date/end_date); omit all filters for every day and date.",
    inputSchema: {
      workout_day_id: z.string().optional().describe("Only include sessions for this workout day."),
      start_date: z.string().optional().describe("Only include sessions performed on or after this date (YYYY-MM-DD)."),
      end_date: z.string().optional().describe("Only include sessions performed on or before this date (YYYY-MM-DD)."),
    },
  },
  {
    name: "create_day_template",
    title: "Create day template",
    description:
      "Creates a new, empty day template for the authenticated user. Returns the new day, including its id. If program_id is given, appends the day to the end of that program.",
    inputSchema: { name: z.string(), program_id: z.string().optional() },
  },
  {
    name: "rename_day_template",
    title: "Rename day template",
    description: "Renames an existing day template belonging to the authenticated user, targeted by id.",
    inputSchema: { day_id: z.string(), name: z.string() },
  },
  {
    name: "delete_day_template",
    title: "Delete day template",
    description:
      "Soft-deletes a day template belonging to the authenticated user, targeted by id: marks it deleted so it no longer appears in get_day_templates or accepts further edits, but its exercise attachments, scheme history, and any sessions that referenced it are left untouched — historical scheme_history_for_day_exercise/adherence_for_day lookups keep working.",
    inputSchema: { day_id: z.string() },
  },
  {
    name: "create_exercise",
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
  {
    name: "update_exercise",
    title: "Update exercise",
    description:
      "Partially updates a catalog exercise belonging to the authenticated user, targeted by id. Only the fields supplied are changed; any field left out keeps its current value.",
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      cue: z.string().optional(),
      default_sets: z.number().optional(),
      default_rep_low: z.number().optional(),
      default_rep_high: z.number().optional(),
    },
  },
  {
    name: "list_exercises",
    title: "List exercises",
    description:
      "Every catalog exercise for the authenticated user, including ones not attached to any day. Excludes soft-deleted exercises.",
    inputSchema: undefined,
  },
  {
    name: "delete_exercise",
    title: "Delete exercise",
    description:
      "Soft-deletes a catalog exercise belonging to the authenticated user, targeted by id: marks it deleted so it no longer appears in list_exercises. Rejected outright if the exercise is still attached to any day or referenced by logged sets/scheme history — detach it from days first via remove_exercise_from_day.",
    inputSchema: { exercise_id: z.string() },
  },
  {
    name: "add_exercise_to_day",
    title: "Add exercise to day",
    description: "Appends an existing catalog exercise to the end of a day template's exercise list, for the authenticated user.",
    inputSchema: { day_id: z.string(), exercise_id: z.string() },
  },
  {
    name: "remove_exercise_from_day",
    title: "Remove exercise from day",
    description: "Removes one exercise from a day template, for the authenticated user. Touches only that one attachment.",
    inputSchema: { day_id: z.string(), exercise_id: z.string() },
  },
  {
    name: "reorder_day_exercises",
    title: "Reorder day exercises",
    description:
      "Rewrites a day template's exercise order for the authenticated user. exercise_ids must be exactly the day's current exercise-id set (same members, any order); membership changes must go through add_exercise_to_day/remove_exercise_from_day instead.",
    inputSchema: { day_id: z.string(), exercise_ids: z.array(z.string()) },
  },
  {
    name: "set_day_exercise_scheme",
    title: "Set day exercise scheme",
    description:
      "Sets the day-specific rep/weight scheme for one exercise on one day, for the authenticated user. null (or an empty array) clears it, reverting that exercise to its own uniform defaults on that day.",
    inputSchema: {
      day_id: z.string(),
      exercise_id: z.string(),
      sets: z.array(z.object({ weight: z.number(), reps: z.number() })).nullable(),
    },
  },
  {
    name: "create_program",
    title: "Create program",
    description: "Creates a new, empty program for the authenticated user. Returns it, including its id.",
    inputSchema: { name: z.string() },
  },
  {
    name: "rename_program",
    title: "Rename program",
    description: "Renames an existing program belonging to the authenticated user, targeted by id.",
    inputSchema: { program_id: z.string(), name: z.string() },
  },
  {
    name: "delete_program",
    title: "Delete program",
    description:
      "Soft-deletes a program belonging to the authenticated user, targeted by id: it's no longer a valid target for other program tools, but member days keep their program_id/program_position (not unassigned), so the program's structure and completion history survive and get_day_templates treats its former days as untracked (always available) in the meantime.",
    inputSchema: { program_id: z.string() },
  },
  {
    name: "add_day_to_program",
    title: "Add day to program",
    description:
      "Assigns an existing day template to a program, appended at the end. Errors if the day already belongs to a program; use remove_day_from_program first to reassign it.",
    inputSchema: { day_id: z.string(), program_id: z.string() },
  },
  {
    name: "remove_day_from_program",
    title: "Remove day from program",
    description: "Clears a day template's program assignment, reverting it to untracked (always available).",
    inputSchema: { day_id: z.string() },
  },
  {
    name: "reorder_program_days",
    title: "Reorder program days",
    description:
      "Rewrites a program's day order for the authenticated user. day_ids must be exactly the program's current membership (same members, any order); membership changes must go through add_day_to_program/remove_day_from_program instead.",
    inputSchema: { program_id: z.string(), day_ids: z.array(z.string()) },
  },
] as const satisfies readonly ToolDefinition[];

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape | undefined;
};

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

type InputShapeOf<K extends ToolName> = Extract<(typeof TOOL_DEFINITIONS)[number], { name: K }>["inputSchema"];

// The parsed arguments a tool's handler receives: the zod output of its input
// shape, or an empty object for a tool registered without one.
export type ToolInput<K extends ToolName> =
  InputShapeOf<K> extends infer S extends z.ZodRawShape ? z.infer<z.ZodObject<S>> : Record<string, never>;
